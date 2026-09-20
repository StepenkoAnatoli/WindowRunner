/**
 * Retry wrapper for any LLMProvider.
 *
 * Rules (deliberately narrow so retries can never duplicate visible output):
 * - Only `ProviderError`s with `retryable: true` are retried
 *   (429, 5xx, connection failures, broken streams). Auth, bad-request and
 *   context-exhausted errors surface immediately.
 * - Only when NOTHING has been yielded from the current attempt yet. Once a
 *   text delta or tool call reached the loop, a retry would replay the
 *   beginning of the answer, so the error is passed through instead.
 * - Backoff: `Retry-After` (seconds or HTTP date) when the error carries one,
 *   otherwise exponential from `baseDelayMs` with full jitter, capped at
 *   `maxDelayMs`. The wait aborts immediately when the turn is cancelled.
 * - `maxRetries` extra attempts (default 2 → at most 3 requests per step).
 */
import { ProviderError, type LLMChunk, type LLMProvider, type LLMRequest } from "./types.js";

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  /** Called before each retry; used for the server log. */
  onRetry?: (info: { attempt: number; delayMs: number; error: ProviderError }) => void;
}

export const DEFAULT_MODEL_MAX_RETRIES = 2;

export class RetryingProvider implements LLMProvider {
  readonly name: string;
  private readonly inner: LLMProvider;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly onRetry?: RetryOptions["onRetry"];

  constructor(inner: LLMProvider, options: RetryOptions = {}) {
    this.inner = inner;
    this.name = (inner as any).name ?? "provider";
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? DEFAULT_MODEL_MAX_RETRIES));
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 8_000;
    this.sleep = options.sleep ?? abortableSleep;
    this.random = options.random ?? Math.random;
    this.onRetry = options.onRetry;
  }

  /** Pass through the inner adapter's secret-free description for the boot banner. */
  describe(): unknown {
    return typeof (this.inner as any).describe === "function" ? (this.inner as any).describe() : undefined;
  }

  async *stream(request: LLMRequest, options: { signal: AbortSignal }): AsyncIterable<LLMChunk> {
    const { signal } = options;
    for (let attempt = 0; ; attempt++) {
      let yielded = false;
      try {
        for await (const chunk of this.inner.stream(request, options)) {
          yielded = true;
          yield chunk;
        }
        return;
      } catch (err) {
        if (yielded || signal.aborted || attempt >= this.maxRetries || !isRetryable(err)) throw err;
        const delayMs = this.delayFor(err, attempt);
        this.onRetry?.({ attempt: attempt + 1, delayMs, error: err });
        await this.sleep(delayMs, signal);
        if (signal.aborted) throw signal.reason ?? err;
      }
    }
  }

  private delayFor(err: ProviderError, attempt: number): number {
    const hinted = err.retryAfterMs;
    if (hinted !== undefined && hinted >= 0) return Math.min(hinted, this.maxDelayMs);
    const ceiling = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempt);
    return Math.floor(this.random() * ceiling);
  }
}

export function withRetry(provider: LLMProvider, options: RetryOptions = {}): LLMProvider {
  if ((options.maxRetries ?? DEFAULT_MODEL_MAX_RETRIES) <= 0) return provider;
  return new RetryingProvider(provider, options);
}

function isRetryable(err: unknown): err is ProviderError {
  return err instanceof ProviderError && err.retryable;
}

/** Parse an HTTP Retry-After header (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
