/**
 * One-shot provider model discovery (B4.1).
 *
 * `POST /api/providers/discover-models` asks the SERVER to probe a provider's
 * model listing once, with the user's freshly typed key, so the browser never
 * talks to the provider directly. The raw key is transient only: it arrives in
 * this request's body, sits in request-handling memory, and travels once more
 * in the Authorization header of the single outbound probe. It must never
 * enter a response, an error, a log, a metric, a URL, browser storage, the
 * workspace catalog, or the provider-profiles store — nothing here writes.
 *
 * Per kind:
 * - `mock`               → `{ models: ["mock"] }`; no network request.
 * - `openai-compatible`  → `GET {baseUrl}/models` with `Authorization: Bearer
 *                          <key>` (omitted when no key), a short timeout, no
 *                          redirect following, a bounded accepted-shape
 *                          normalization (dedupe → deterministic sort → cap).
 * - `anthropic`          → 501 `DISCOVERY_UNAVAILABLE` with the documented
 *                          message: no live listing is implemented by the
 *                          adapter yet, and no static list is ever passed off
 *                          as live provider data.
 *
 * Errors are `DiscoveryError` (code + HTTP status) with secret-free messages:
 * upstream response bodies are never included in any message, and the route
 * additionally scrubs the request key out of every message as defense in
 * depth (`redactKey`).
 */
import { KINDS, type ProviderKind } from "./provider-profiles.js";

export class DiscoveryError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "DiscoveryError";
    this.code = code;
    this.status = status;
  }
}

/** The documented anthropic fallback message — exact text, surfaced in the UI. */
export const DISCOVERY_UNAVAILABLE_MESSAGE = "model discovery unavailable for this provider";

/** One probe, one short wait. 5 s like the existing /test probe. */
export const DISCOVERY_TIMEOUT_MS = 5_000;
/** Hard cap on the upstream response body (2 MiB) before reading aborts. */
export const MAX_DISCOVERY_BODY_BYTES = 2 * 1024 * 1024;
/** Model list is truncated to this many ids after dedupe + sort. */
export const MAX_DISCOVERED_MODELS = 500;
/** A single model id longer than this is dropped as non-conforming. */
export const MAX_DISCOVERY_MODEL_ID_LENGTH = 256;
/** Base URL length cap (mirrors the profile baseUrl budget, with headroom). */
export const MAX_DISCOVERY_BASE_URL_LENGTH = 2048;

function invalidRequest(message: string): DiscoveryError {
  return new DiscoveryError("DISCOVERY_INVALID_REQUEST", 400, message);
}

function printableAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.codePointAt(i)!;
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/**
 * Belt-and-braces scrub: discovery messages never contain the key by
 * construction; this guarantees it even if a message is ever edited into
 * carrying one. Applied by the route before any message leaves the process.
 */
export function redactKey(text: string, key: string | undefined): string {
  if (!key || key.length < 4 || !text) return text;
  return text.split(key).join("****");
}

function validateKind(value: unknown): ProviderKind {
  if (typeof value !== "string" || !KINDS.includes(value as ProviderKind)) {
    throw invalidRequest(`kind must be one of: ${KINDS.join(" | ")}`);
  }
  return value as ProviderKind;
}

/**
 * A key is optional (local Ollama-style endpoints need none) and required by
 * nothing here — we cannot know which provider demands one, so we never force
 * it. When present it must be transmit-safe in a header, mirroring
 * `validateProfile`'s rules.
 */
function validateApiKey(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw invalidRequest("apiKey must be a string");
  if (value.length > 512) throw invalidRequest("apiKey too long (max 512 chars)");
  if (/\s/.test(value)) throw invalidRequest("apiKey must not contain whitespace");
  if (!printableAscii(value)) throw invalidRequest("apiKey must contain only printable ASCII characters");
  return value;
}

/**
 * The probe target must be an absolute http(s) URL with a host and no
 * embedded credentials (they would silently override the Authorization
 * header). Any path/query the caller includes is kept for the probe except a
 * trailing slash; query/hash are dropped — a model listing lives at a plain
 * `{base}/models`.
 */
export function validateDiscoveryBaseUrl(value: unknown): URL {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidRequest("baseUrl is required for openai-compatible");
  }
  if (value.length > MAX_DISCOVERY_BASE_URL_LENGTH) {
    throw invalidRequest(`baseUrl is too long (max ${MAX_DISCOVERY_BASE_URL_LENGTH} chars)`);
  }
  if (!printableAscii(value)) {
    throw invalidRequest("baseUrl must contain only printable ASCII characters");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidRequest("baseUrl must be a valid absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalidRequest("baseUrl must start with http:// or https://");
  }
  if (!url.hostname) throw invalidRequest("baseUrl must include a host");
  if (url.username || url.password) {
    throw invalidRequest("baseUrl must not contain user:password credentials");
  }
  return url;
}

/**
 * Accepts ONLY bounded shapes — never arbitrary nesting:
 * - `{ data: [ { id: "…" } | "…" ] }` (OpenAI and most compatible gateways);
 * - `[ { id: "…" } | "…" ]` (a bare array);
 * - `{ models: [ "…" ] }` (a plain id list).
 * Non-conforming ITEMS are dropped (trimmed, non-empty, ≤ 256 chars); a
 * non-conforming SHAPE is an error, not a guess. Result is deduplicated,
 * sorted with plain UTF-16 `<` (locale-independent, identical everywhere),
 * and capped at MAX_DISCOVERED_MODELS.
 */
export function normalizeDiscoveredModels(payload: unknown): string[] {
  const items = extractModelItems(payload);
  const seen = new Set<string>();
  for (const item of items) {
    const id = normalizeModelId(item);
    if (id !== undefined) seen.add(id);
  }
  return [...seen].sort().slice(0, MAX_DISCOVERED_MODELS);
}

function extractModelItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload !== null && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.data)) return record.data;
    if (Array.isArray(record.models)) return record.models;
  }
  throw new DiscoveryError(
    "DISCOVERY_BAD_RESPONSE",
    502,
    "model discovery: the provider response shape was not recognized"
  );
}

function normalizeModelId(item: unknown): string | undefined {
  let raw: unknown = item;
  if (item !== null && typeof item === "object" && !Array.isArray(item)) {
    raw = (item as Record<string, unknown>).id;
  }
  if (typeof raw !== "string") return undefined;
  const id = raw.trim();
  if (id.length === 0 || id.length > MAX_DISCOVERY_MODEL_ID_LENGTH) return undefined;
  return id;
}

export interface ModelDiscoveryOptions {
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Probe timeout. Default DISCOVERY_TIMEOUT_MS (5 s). */
  timeoutMs?: number;
}

/**
 * Validate the request and run the one probe. Throws `DiscoveryError` with a
 * secret-free message on every failure path; resolves `{ models }` (possibly
 * empty) on success. Pure with respect to process state: nothing is written,
 * logged, or persisted.
 */
export async function discoverModels(input: unknown, options: ModelDiscoveryOptions = {}): Promise<{ models: string[] }> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalidRequest("request body must be a JSON object");
  }
  const body = input as Record<string, unknown>;
  const kind = validateKind(body.kind);
  if (kind === "mock") return { models: ["mock"] };
  if (kind === "anthropic") {
    throw new DiscoveryError("DISCOVERY_UNAVAILABLE", 501, DISCOVERY_UNAVAILABLE_MESSAGE);
  }
  const baseUrl = validateDiscoveryBaseUrl(body.baseUrl);
  const apiKey = validateApiKey(body.apiKey);
  return { models: await probeOpenAICompatibleModels(baseUrl, apiKey, options) };
}

/**
 * Read the upstream body with a hard byte cap. The moment the stream exceeds
 * MAX_DISCOVERY_BODY_BYTES the probe's AbortController fires (tearing down the
 * socket) and the probe fails DISCOVERY_BAD_RESPONSE — a huge or endless body
 * can never buffer unbounded into memory. A mid-body connection failure maps
 * to DISCOVERY_UPSTREAM, not a raw fetch error.
 */
async function readBodyCapped(res: Response, controller: AbortController): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DISCOVERY_BODY_BYTES) {
        controller.abort();
        throw new DiscoveryError(
          "DISCOVERY_BAD_RESPONSE",
          502,
          `model discovery: the provider response exceeded the body-size limit (${MAX_DISCOVERY_BODY_BYTES} bytes)`
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (err) {
    if (err instanceof DiscoveryError) throw err;
    throw new DiscoveryError("DISCOVERY_UPSTREAM", 502, "model discovery: the provider connection failed before the body was complete");
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}

/**
 * `GET {baseUrl}/models` with a short timeout and `redirect: "error"` — a
 * redirect is refused outright rather than followed (even once), so a base
 * URL can never bounce the key somewhere the user did not type. Maps every
 * failure to a `DiscoveryError`; upstream response bodies are never part of
 * any message.
 */
async function probeOpenAICompatibleModels(baseUrl: URL, apiKey: string | undefined, options: ModelDiscoveryOptions): Promise<string[]> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const target = baseUrl.origin + baseUrl.pathname.replace(/\/+$/, "") + "/models";
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetchImpl(target, { method: "GET", headers, redirect: "error", signal: controller.signal });
    } catch (err) {
      if (timedOut || controller.signal.aborted) {
        throw new DiscoveryError("DISCOVERY_TIMEOUT", 504, `model discovery timed out after ${timeoutMs}ms`);
      }
      if (err instanceof TypeError) {
        // Node's undici reports a refused redirect as `TypeError: fetch
        // failed` with the real reason in the cause chain ("unexpected
        // redirect"), so the classification looks at both.
        const cause = (err as { cause?: unknown })?.cause;
        const causeMessage = cause instanceof Error ? cause.message : String((cause as { message?: unknown })?.message ?? "");
        if (/redirect/i.test(String((err as Error).message ?? "")) || /redirect/i.test(causeMessage)) {
          throw new DiscoveryError(
            "DISCOVERY_BAD_RESPONSE",
            502,
            "model discovery: the provider answered with a redirect; redirects are not followed"
          );
        }
        const code = typeof (cause as { code?: unknown })?.code === "string" && /^[A-Z0-9_-]{1,64}$/.test((cause as { code: string }).code) ? (cause as { code: string }).code : undefined;
        throw new DiscoveryError(
          "DISCOVERY_UPSTREAM",
          502,
          code ? `model discovery: the provider could not be reached (${code})` : "model discovery: the provider could not be reached"
        );
      }
      throw new DiscoveryError("DISCOVERY_UPSTREAM", 502, "model discovery: the provider could not be reached");
    }
    if (!res.ok) {
      try {
        await res.body?.cancel();
      } catch {}
      throw new DiscoveryError("DISCOVERY_UPSTREAM", 502, `model discovery: the provider answered HTTP ${res.status}`);
    }
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_DISCOVERY_BODY_BYTES) {
      try {
        await res.body?.cancel();
      } catch {}
      throw new DiscoveryError("DISCOVERY_BAD_RESPONSE", 502, `model discovery: the provider response exceeded the body-size limit (${MAX_DISCOVERY_BODY_BYTES} bytes)`);
    }
    const text = await readBodyCapped(res, controller);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new DiscoveryError("DISCOVERY_BAD_RESPONSE", 502, "model discovery: the provider response was not valid JSON");
    }
    return normalizeDiscoveredModels(payload);
  } finally {
    clearTimeout(timer);
  }
}
