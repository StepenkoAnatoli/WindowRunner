import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RetryingProvider, parseRetryAfter, withRetry } from "../src/providers/retry.js";
import { ProviderError, type LLMChunk, type LLMProvider } from "../src/providers/types.js";

type Attempt = LLMChunk[] | ProviderError | Error | ((chunks: LLMChunk[]) => AsyncGenerator<LLMChunk>);

function scripted(attempts: Attempt[]): LLMProvider & { calls: number } {
  const p = {
    calls: 0,
    async *stream(_req: any, { signal }: { signal: AbortSignal }): AsyncIterable<LLMChunk> {
      const a = attempts[p.calls++];
      if (a === undefined) throw new Error("no more scripted attempts");
      if (a instanceof Error) throw a;
      if (typeof a === "function") {
        yield* a([]);
        return;
      }
      for (const c of a) {
        if (signal.aborted) throw signal.reason;
        yield c;
      }
    },
  };
  return p;
}

const text = (t: string): LLMChunk => ({ type: "text_delta", text: t });
const rateLimited = (retryAfterMs?: number) => new ProviderError("MODEL_RATE_LIMITED", "429", { retryable: true, status: 429, retryAfterMs });
const unavailable = () => new ProviderError("MODEL_UNAVAILABLE", "503", { retryable: true, status: 503 });

async function collect(p: LLMProvider, signal = new AbortController().signal): Promise<LLMChunk[]> {
  const out: LLMChunk[] = [];
  for await (const c of p.stream({ messages: [], tools: [] }, { signal })) out.push(c);
  return out;
}

const noSleep = { sleep: async () => {}, random: () => 0.5 };

describe("RetryingProvider", () => {
  it("retries retryable errors that happen before any chunk and returns the successful attempt", async () => {
    const inner = scripted([rateLimited(), unavailable(), [text("ok")]]);
    const retries: number[] = [];
    const p = new RetryingProvider(inner, { ...noSleep, maxRetries: 2, onRetry: (i) => retries.push(i.attempt) });
    assert.deepEqual(await collect(p), [text("ok")]);
    assert.equal(inner.calls, 3);
    assert.deepEqual(retries, [1, 2]);
  });

  it("gives up after maxRetries and rethrows the last error", async () => {
    const inner = scripted([rateLimited(), rateLimited(), rateLimited(), [text("never")]]);
    const p = new RetryingProvider(inner, { ...noSleep, maxRetries: 2 });
    await assert.rejects(collect(p), (e: any) => e instanceof ProviderError && e.code === "MODEL_RATE_LIMITED");
    assert.equal(inner.calls, 3);
  });

  it("does not retry non-retryable errors", async () => {
    const inner = scripted([new ProviderError("MODEL_AUTH", "401", { status: 401 }), [text("never")]]);
    const p = new RetryingProvider(inner, { ...noSleep, maxRetries: 3 });
    await assert.rejects(collect(p), (e: any) => e.code === "MODEL_AUTH");
    assert.equal(inner.calls, 1);
  });

  it("does not retry once output has been yielded (would duplicate visible text)", async () => {
    const broken = async function* (): AsyncGenerator<LLMChunk> {
      yield text("partial ");
      throw new ProviderError("MODEL_STREAM_BROKEN", "cut", { retryable: true });
    };
    const inner = scripted([broken, [text("never")]]);
    const p = new RetryingProvider(inner, { ...noSleep, maxRetries: 3 });
    const seen: LLMChunk[] = [];
    await assert.rejects(
      (async () => {
        for await (const c of p.stream({ messages: [], tools: [] }, { signal: new AbortController().signal })) seen.push(c);
      })(),
      (e: any) => e.code === "MODEL_STREAM_BROKEN"
    );
    assert.deepEqual(seen, [text("partial ")]);
    assert.equal(inner.calls, 1);
  });

  it("honours Retry-After (capped) and otherwise uses jittered exponential backoff", async () => {
    const delays: number[] = [];
    const sleep = async (ms: number) => {
      delays.push(ms);
    };
    const inner = scripted([rateLimited(1500), unavailable(), unavailable(), rateLimited(60_000), [text("ok")]]);
    const p = new RetryingProvider(inner, { sleep, random: () => 0.5, maxRetries: 4, baseDelayMs: 500, maxDelayMs: 8000 });
    await collect(p);
    // attempt0: hinted 1500; attempt1: 0.5*1000; attempt2: 0.5*2000; attempt3: hinted 60000 capped to 8000
    assert.deepEqual(delays, [1500, 500, 1000, 8000]);
  });

  it("stops waiting and rethrows when the turn is cancelled during backoff", async () => {
    const ac = new AbortController();
    const inner = scripted([unavailable(), [text("never")]]);
    const sleep = async (_ms: number, signal: AbortSignal) => {
      ac.abort(new Error("stopped by user"));
      assert.ok(signal.aborted);
    };
    const p = new RetryingProvider(inner, { sleep, maxRetries: 2 });
    await assert.rejects(collect(p, ac.signal), /stopped by user/);
    assert.equal(inner.calls, 1);
  });

  it("withRetry returns the bare provider when retries are disabled", () => {
    const inner = scripted([]);
    assert.equal(withRetry(inner, { maxRetries: 0 }), inner);
    assert.ok(withRetry(inner, { maxRetries: 1 }) instanceof RetryingProvider);
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds, HTTP dates and rejects garbage", () => {
    assert.equal(parseRetryAfter("3"), 3000);
    const now = Date.parse("Sat, 20 Sep 2026 10:00:00 GMT");
    assert.equal(parseRetryAfter("Sat, 20 Sep 2026 10:00:05 GMT", now), 5000);
    assert.equal(parseRetryAfter("Sat, 20 Sep 2026 09:00:00 GMT", now), 0);
    assert.equal(parseRetryAfter("soon"), undefined);
    assert.equal(parseRetryAfter(null), undefined);
  });
});
