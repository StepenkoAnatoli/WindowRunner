import type { SkillsIndex, StreamEvent } from "@windows-runner/shared";
import type { CreateProviderInput, UpdateProviderInput } from "./provider-types.js";

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

// ---- Provider dashboard (GET /dashboard) ----

export interface ProviderLastTest {
  at: number;
  ok: boolean;
  latencyMs?: number;
  code?: string;
  message?: string;
}

/** One profile as returned by the API — the key is masked, never raw. */
export interface ProviderProfileView {
  id: string;
  label: string;
  kind: string;
  baseUrl?: string;
  model: string;
  apiKeyMasked?: string;
  createdAt: number;
  updatedAt: number;
  lastTest?: ProviderLastTest;
  active?: boolean;
}

export interface ProviderListResult {
  activeProfileId: string | null;
  profiles: ProviderProfileView[];
}

export interface ProviderTestResult {
  ok: boolean;
  latencyMs: number;
  /** The model's reply (truncated), on success only. */
  reply?: string;
  code?: string;
  message?: string;
}

/** Input for one-shot model discovery (POST /api/providers/discover-models). */
export interface DiscoverModelsInput {
  kind: string;
  baseUrl?: string;
  /** Transient: rides only in this request body, never stored anywhere. */
  apiKey?: string;
}

/** The server's normalized, deduplicated, deterministically sorted model ids. */
export interface ModelDiscoveryResult {
  models: string[];
}

export interface TurnUsageView {
  at: number;
  providerId: string;
  model: string;
  turnId: string;
  sessionId?: string;
  status: "completed" | "failed" | "cancelled" | (string & {});
  code?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Present only when a price table entry exists for the exact model id. */
  estCostUsd?: number;
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

/**
 * A client-side configuration fault: the request was never sent because
 * something the caller supplied cannot be transmitted. Distinct from
 * `ApiRequestError` (the server answered) and from a transport failure, so the
 * stream reconnect loop can fail fast instead of retrying six times.
 */
export class ApiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiConfigError";
  }
}

/**
 * A header value must be printable ASCII (0x20-0x7E). Anything else — most
 * often a U+2022 bullet or a smart quote that arrived via copy/paste — makes
 * `fetch` itself throw a `TypeError` about invalid header characters before the
 * request is ever sent, which reads as a network failure. Rejecting here turns
 * that into a message that says what to fix.
 */
export function invalidHeaderCharacter(value: string): string | undefined {
  for (let i = 0; i < value.length; i++) {
    const code = value.codePointAt(i)!;
    if (code < 0x20 || code > 0x7e) return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return undefined;
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
    const bad = invalidHeaderCharacter(this.token);
    if (bad) {
      throw new ApiConfigError(`the token contains a character that cannot be sent in an HTTP header (${bad}); retype it instead of pasting, or paste through a plain-text editor first`);
    }
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
      // The whole body is carried as `details`: validation failures put their
      // per-field list in a top-level `errors` array (see the provider routes),
      // so reading only `parsed.details` here dropped every one of them.
      throw new ApiRequestError(res.status, code, parsed?.error ?? `${method} ${path} failed with ${res.status}`, parsed);
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

  // ---- Provider dashboard endpoints (all require the same bearer token) ----
  // Create/update accept the typed input contracts from provider-types.ts (or
  // a plain record for compatibility); the typed contracts are what the
  // provider controller sends.

  async listProviders(): Promise<ProviderListResult> {
    return (await this.request<ProviderListResult>("GET", "/api/providers")).body;
  }

  /**
   * The skills a session's project ships (ADR 003). Index only — names,
   * descriptions, paths, plus why any skill was excluded. Bodies are never
   * returned; the agent loads those on demand with `read_skill`.
   */
  async listSkills(sessionId: string): Promise<SkillsIndex> {
    return (await this.request<SkillsIndex>("GET", `/api/sessions/${encodeURIComponent(sessionId)}/skills`)).body;
  }

  async createProfile(input: CreateProviderInput | Record<string, unknown>): Promise<ProviderProfileView> {
    return (await this.request<ProviderProfileView>("POST", "/api/providers", input)).body;
  }

  async updateProfile(id: string, patch: UpdateProviderInput | Record<string, unknown>): Promise<ProviderProfileView> {
    return (await this.request<ProviderProfileView>("PATCH", `/api/providers/${encodeURIComponent(id)}`, patch)).body;
  }

  async deleteProfile(id: string): Promise<void> {
    await this.request("DELETE", `/api/providers/${encodeURIComponent(id)}`);
  }

  async activateProfile(id: string): Promise<{ activeProfileId: string; profile: ProviderProfileView }> {
    return (await this.request<{ activeProfileId: string; profile: ProviderProfileView }>("POST", `/api/providers/${encodeURIComponent(id)}/activate`)).body;
  }

  async testProfile(id: string): Promise<ProviderTestResult> {
    return (await this.request<ProviderTestResult>("POST", `/api/providers/${encodeURIComponent(id)}/test`)).body;
  }

  /**
   * One-shot model discovery. The freshly typed key rides ONLY in this
   * request body to THIS server (which forwards it once as the upstream
   * probe's Authorization header); it is never persisted anywhere by the
   * client. Errors map to ApiRequestError with the server's DISCOVERY_* code.
   */
  async discoverModels(input: DiscoverModelsInput): Promise<ModelDiscoveryResult> {
    return (await this.request<ModelDiscoveryResult>("POST", "/api/providers/discover-models", input)).body;
  }

  /**
   * Recent turns, newest first. `retained` is how many records the server
   * holds and `bounded` is its flag for "older records existed and are no
   * longer available" — the ring is capped, the boot read is a bounded tail of
   * usage.jsonl, and the file rotates. Both optional, so a server that answers
   * with `records` only still parses.
   */
  async usage(limit = 50): Promise<{ records: TurnUsageView[]; retained?: number; bounded?: boolean }> {
    return (await this.request<{ records: TurnUsageView[]; retained?: number; bounded?: boolean }>("GET", `/api/usage?limit=${limit}`)).body;
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
        if (err instanceof ApiConfigError) {
          // Nothing about retrying will make a malformed header valid.
          handlers.onError?.(err);
          throw err;
        }
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
 * Host-shell bootstrap for embedded deployments (the Electron desktop shell).
 * When a shell publishes `{baseUrl, token}` on this global before the app
 * loads, the token lives in memory only: `loadToken` returns it, `saveToken`/
 * `clearToken` are no-ops, and nothing is ever written to the URL or web
 * storage. Must match `BOOTSTRAP_GLOBAL` in packages/desktop/src/renderer.ts.
 */
const BOOTSTRAP_GLOBAL = "__WINDOWS_RUNNER_BOOTSTRAP__";

export interface ApiClientBootstrap {
  baseUrl: string;
  token: string;
}

export function getApiClientBootstrap(): ApiClientBootstrap | undefined {
  if (typeof globalThis === "undefined") return undefined;
  const raw = (globalThis as Record<string, unknown>)[BOOTSTRAP_GLOBAL];
  if (!raw || typeof raw !== "object") return undefined;
  const b = raw as Partial<ApiClientBootstrap>;
  if (typeof b.baseUrl !== "string" || typeof b.token !== "string" || b.token.length === 0) return undefined;
  return { baseUrl: b.baseUrl, token: b.token };
}

/**
 * Publish a host bootstrap into memory. The desktop shell does this from
 * `/desktop` before loading the app; a refresh of an allowlisted deep route
 * loads `index.html` directly (renderer.ts does not run), so the app entry
 * republishes the preload bridge the same way. Either path keeps `saveToken`
 * a no-op — the token is never written to the URL or web storage.
 */
export function publishApiClientBootstrap(bootstrap: ApiClientBootstrap): void {
  (globalThis as Record<string, unknown>)[BOOTSTRAP_GLOBAL] = {
    baseUrl: bootstrap.baseUrl,
    token: bootstrap.token,
  };
}

/**
 * Token comes from, in order: the in-memory host bootstrap (desktop shell),
 * then `#token=…` in the URL fragment (what the banner prints in memory mode;
 * stripped from the address bar immediately and never sent to the server),
 * then sessionStorage. It is kept in sessionStorage, not localStorage, so it
 * dies with the tab.
 */
export function loadToken(): string | null {
  const bootstrap = getApiClientBootstrap();
  if (bootstrap) return bootstrap.token;
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
  if (getApiClientBootstrap()) return; // in-memory mode: never persist
  try {
    window.sessionStorage.setItem(TOKEN_KEY, token);
  } catch {}
}

export function clearToken(): void {
  if (getApiClientBootstrap()) return; // in-memory mode: nothing to clear
  try {
    window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {}
}

