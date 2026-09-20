import type { LLMChunk, LLMProvider, LLMRequest } from "./types.js";

export interface MockProviderOptions {
  /** Delay between streamed chunks, to make streaming visible in a UI. Default 0. */
  delayMs?: number;
  /** Maximum characters of the user's message echoed back. Default 200. */
  echoLimit?: number;
}

const DEFAULT_ECHO_LIMIT = 200;

/**
 * MockProvider — the offline provider.
 *
 * It is the only provider this checkout ships, so it is what `npm start` uses
 * by default (README: "Mock — offline rehearsal of the whole loop — no key, no
 * network"). It never performs network I/O and never calls a tool: it streams
 * a short, clearly-labelled reply that echoes the latest user message, then a
 * usage chunk, and honours the abort signal between chunks. That is enough to
 * exercise the real session, turn, persistence and SSE machinery end to end
 * without an API key — which is what the startup smoke test relies on.
 *
 * Replies always start with "[mock]" so nobody mistakes them for model output.
 */
export class MockProvider implements LLMProvider {
  readonly name = "mock";
  private readonly delayMs: number;
  private readonly echoLimit: number;

  constructor(options: MockProviderOptions = {}) {
    this.delayMs = Math.max(0, options.delayMs ?? 0);
    this.echoLimit = Math.max(0, options.echoLimit ?? DEFAULT_ECHO_LIMIT);
  }

  async *stream(request: LLMRequest, options: { signal: AbortSignal }): AsyncIterable<LLMChunk> {
    const { signal } = options;
    const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
    const echoed = truncate(lastUser?.content ?? "", this.echoLimit);

    const reply =
      `[mock] Windows Runner is running with the offline mock provider: no model was called ` +
      `and no network request was made. ` +
      (echoed ? `You said: "${echoed}"` : `Your message was empty.`);

    let outputChars = 0;
    for (const piece of splitForStreaming(reply)) {
      throwIfAborted(signal);
      if (this.delayMs > 0) await sleep(this.delayMs, signal);
      outputChars += piece.length;
      yield { type: "text_delta", text: piece };
    }

    throwIfAborted(signal);
    const inputChars = request.messages.reduce((n, m) => n + m.content.length, 0);
    const inputTokens = estimateTokens(inputChars);
    const outputTokens = estimateTokens(outputChars);
    yield { type: "usage", usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } };
  }
}

function truncate(text: string, limit: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= limit) return singleLine;
  return `${singleLine.slice(0, Math.max(0, limit - 1))}…`;
}

/** Split on word boundaries so a UI sees several deltas rather than one blob. */
function splitForStreaming(text: string): string[] {
  const pieces = text.match(/\S+\s*/g);
  return pieces ?? [text];
}

/** Rough 4-chars-per-token estimate — this is a mock, not a tokenizer. */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw (signal as { reason?: unknown }).reason ?? new Error("aborted");
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject((signal as { reason?: unknown }).reason ?? new Error("aborted"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
