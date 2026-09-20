import type { StreamEvent } from "@windows-runner/shared";

/**
 * Browser client for the Windows Runner HTTP API.
 *
 * Every request carries `Authorization: Bearer <token>`; the server refuses
 * anything under /api without it (P0-01). SSE is consumed with `fetch` and a
 * streaming body reader rather than `EventSource`, because `EventSource`
 * cannot send headers. Reconnects resume from the last applied `seq` via the
 * `Last-Event-ID` header, exactly as a browser `EventSource` would.
 *
 * Dependency-free and DOM-free so it can be unit-tested under Node with a
 * fake `fetch`.
 */

export interface ApiError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

export class ApiRequestError extends Error implements ApiError {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
  /** True for 401s: the token is missing or wrong and the user must re-enter it. */
  get isAuth(): boolean {
    return this.status === 401;
  }
}

export interface ApiClientOptions {
  /** Base URL without trailing slash; empty string = same origin. */
  baseUrl?: string;
  token: string;
  fetch?: typeof fetch;
}

export interface TrustGrant {
  realRoot: string;
  canonicalRoot: string;
  configHash: string;
  grantedAt: number;
  source?: string;
}

export interface TrustStatus {
  sessionId: string;
  realRoot: string;
  canonicalRoot: string;
  grant: TrustGrant | null;
}

export interface HealthSummary {
  status: string;
  security?: { mode: string };
  persistence?: { mode: string; dataDir?: string };
  diagnostics?: { boot?: { auth?: { mode: string; tokenSource?: string } } };
}

export interface StreamHandlers {
  onEvent: (event: StreamEvent) => void;
  /** Called on each transport drop before a retry; `attempt` starts at 1. */
  onReconnect?: (attempt: number, delayMs: number) => void;
  onError?: (err: unknown) => void;
}

export interface StreamOptions {
  /** Resume after this seq (0 = from the start). */
  afterSeq?: number;
  signal?: AbortSignal;
  /** Base backoff; doubles per attempt up to 8x. Default 500ms. */
  reconnectBaseMs?: number;
  /** Give up after this many consecutive failed attempts. Default 6. */
  maxAttempts?: number;
}

export interface StreamResult {
  /** Last seq applied. */
  seq: number;
  /** True when the stream ended on a terminal event. */
  terminal: boolean;
  /** Set when the stream ended for another reason (aborted or gave up). */
  reason?: "aborted" | "gave_up";
}

const TERMINAL = new Set(["turn_completed", "turn_cancelled", "turn_failed"]);

export function isTerminalEvent(event: { type: string }): boolean {
  return TERMINAL.has(event.type);
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ApiClientOptions) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }

  private async request<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; body: T }> {
    const init: RequestInit = { method, headers: this.headers(extra) };
    if (body !== undefined) {
      (init.headers as Record<string, string>)["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await this.fetchImpl(this.baseUrl + path, init);
    const text = await res.text();
    let parsed: any = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: text };
      }
    }
    if (!res.ok) {
      const code = parsed?.code ?? (res.status === 401 ? "AUTH_REQUIRED" : `HTTP_${res.status}`);
      throw new ApiRequestError(res.status, code, parsed?.error ?? `${method} ${path} failed with ${res.status}`, parsed?.details);
    }
    return { status: res.status, body: parsed as T };
  }

  /** Cheap credential check; also tells the UI which auth/persistence mode the server runs. */
  async health(): Promise<HealthSummary> {
    return (await this.request<HealthSummary>("GET", "/api/health")).body;
  }

  async createSession(sessionId: string, cwd: string): Promise<{ sessionId: string; root: string }> {
    return (await this.request<{ sessionId: string; root: string }>("POST", `/api/sessions/${encodeURIComponent(sessionId)}`, { cwd })).body;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request("DELETE", `/api/sessions/${encodeURIComponent(sessionId)}`);
  }

  async startTurn(sessionId: string, message: string, cwd?: string): Promise<{ turnId: string }> {
    const body: Record<string, unknown> = { message };
    if (cwd) body.cwd = cwd;
    return (await this.request<{ turnId: string }>("POST", `/api/sessions/${encodeURIComponent(sessionId)}/turns`, body)).body;
  }

  async cancelTurn(sessionId: string, turnId: string, reason?: string): Promise<void> {
    await this.request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/cancel`, reason ? { reason } : {});
  }

  async approve(sessionId: string, requestId: string, decision: "approve" | "deny"): Promise<void> {
    await this.request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/approve`, { requestId, decision });
  }

  async getTrust(sessionId: string): Promise<TrustStatus> {
    return (await this.request<TrustStatus>("GET", `/api/sessions/${encodeURIComponent(sessionId)}/trust`)).body;
  }

  async grantTrust(sessionId: string, configHash: string, source?: string): Promise<TrustGrant> {
    return (await this.request<{ grant: TrustGrant }>("POST", `/api/sessions/${encodeURIComponent(sessionId)}/trust`, { configHash, source })).body.grant;
  }

  async revokeTrust(sessionId: string): Promise<void> {
    await this.request("DELETE", `/api/sessions/${encodeURIComponent(sessionId)}/trust`);
  }

  /**
   * Follow a turn's event stream until its terminal event, reconnecting on
   * transport failure with `Last-Event-ID` set to the last applied seq.
   * Events are delivered in order and never twice (the server replays only
   * after the cursor; `seq <= last` is dropped defensively anyway).
   */
  async streamTurn(sessionId: string, turnId: string, handlers: StreamHandlers, options: StreamOptions = {}): Promise<StreamResult> {
    let seq = options.afterSeq ?? 0;
    const base = options.reconnectBaseMs ?? 500;
    const maxAttempts = options.maxAttempts ?? 6;
    let attempt = 0;
    const url = `${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/events`;

    for (;;) {
      if (options.signal?.aborted) return { seq, terminal: false, reason: "aborted" };
      try {
        const res = await this.fetchImpl(url, {
          headers: this.headers(seq > 0 ? { "last-event-id": String(seq) } : {}),
          signal: options.signal,
        });
        if (!res.ok) {
          // A non-2xx here is a server decision (401/400/404), not a transport blip: surface it.
          const text = await res.text();
          let parsed: any = {};
          try { parsed = JSON.parse(text); } catch {}
          throw new ApiRequestError(res.status, parsed.code ?? `HTTP_${res.status}`, parsed.error ?? `stream failed with ${res.status}`);
        }
        if (!res.body) throw new Error("stream has no body");
        attempt = 0;
        const outcome = await readSse(res.body, (event) => {
          if (typeof event.seq !== "number" || event.seq <= seq) return false;
          seq = event.seq;
          handlers.onEvent(event);
          return isTerminalEvent(event);
        });
        if (outcome === "terminal") return { seq, terminal: true };
        // Stream ended without a terminal event: server closed it early. Fall through to reconnect.
      } catch (err: any) {
        if (options.signal?.aborted || err?.name === "AbortError") return { seq, terminal: false, reason: "aborted" };
        if (err instanceof ApiRequestError) {
          handlers.onError?.(err);
          throw err;
        }
        handlers.onError?.(err);
      }
      attempt += 1;
      if (attempt > maxAttempts) return { seq, terminal: false, reason: "gave_up" };
      const delay = Math.min(base * 2 ** (attempt - 1), base * 8);
      handlers.onReconnect?.(attempt, delay);
      await sleep(delay, options.signal);
    }
  }
}

/**
 * Minimal SSE parser over a byte stream. Handles `id:`/`data:` lines, multi-line
 * data, both `\n\n` and `\r\n\r\n` frame separators, and partial chunks. The
 * server puts the whole event JSON in one `data:` line, so `data` is parsed
 * as JSON once per frame. Returns "terminal" when `onEvent` says to stop,
 * "ended" when the stream closes first.
 */
export async function readSse(body: ReadableStream<Uint8Array>, onEvent: (event: any) => boolean): Promise<"terminal" | "ended"> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data) continue;
        let event: any;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        if (onEvent(event)) return "terminal";
      }
    }
    return "ended";
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ---- Token storage (browser only; guarded so Node tests can import this module) ----

const TOKEN_KEY = "windows-runner.token";

/**
 * Token comes from, in order: `#token=…` in the URL fragment (what the banner
 * prints in memory mode; stripped from the address bar immediately and never
 * sent to the server), then sessionStorage. It is kept in sessionStorage, not
 * localStorage, so it dies with the tab.
 */
export function loadToken(): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash;
  const m = /[#&]token=([^&]+)/.exec(hash);
  if (m) {
    const token = decodeURIComponent(m[1]);
    saveToken(token);
    const cleaned = hash.replace(/[#&]token=[^&]+/, "").replace(/^&/, "#");
    window.history.replaceState(null, "", window.location.pathname + window.location.search + (cleaned === "#" ? "" : cleaned));
    return token;
  }
  try {
    return window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function saveToken(token: string): void {
  try {
    window.sessionStorage.setItem(TOKEN_KEY, token);
  } catch {}
}

export function clearToken(): void {
  try {
    window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {}
}
