import type { LLMChunk, LLMProvider, LLMRequest } from "../../src/providers/types.js";
import type { FakeClock } from "./fake-clock.js";

export type ProviderStepResult = {
  chunks?: LLMChunk[];
  error?: Error;
  hang?: boolean;
  ignoreAbort?: boolean;
  delayMs?: number;
};

export type ProviderStep = (request: LLMRequest) => ProviderStepResult | Promise<ProviderStepResult> | AsyncIterable<LLMChunk>;

export interface FakeProviderOpts {
  clock?: FakeClock;
}

export class FakeProvider implements LLMProvider {
  public requests: LLMRequest[] = [];
  public lastSignal?: AbortSignal;
  public lastSignals: AbortSignal[] = [];

  private stepIndex = 0;

  constructor(
    private steps: ProviderStep[],
    private opts: FakeProviderOpts = {}
  ) {}

  async *stream(request: LLMRequest, options: { signal: AbortSignal }): AsyncIterable<LLMChunk> {
    // Record request (deep clone to avoid mutation)
    this.requests.push(structuredClone(request));
    this.lastSignal = options.signal;
    this.lastSignals.push(options.signal);

    if (this.stepIndex >= this.steps.length) {
      throw new Error(`FakeProvider: no more steps, requested step ${this.stepIndex}, have ${this.steps.length}`);
    }

    const step = this.steps[this.stepIndex++];
    const result = await step(request);

    // Handle AsyncIterable case directly
    if (result && typeof (result as any)[Symbol.asyncIterator] === "function") {
      for await (const chunk of result as AsyncIterable<LLMChunk>) {
        if (options.signal.aborted) {
          throw new Error("aborted");
        }
        yield chunk;
      }
      return;
    }

    const { chunks = [], error, hang, ignoreAbort, delayMs } = result as ProviderStepResult;

    for (const chunk of chunks) {
      if (options.signal.aborted && !ignoreAbort) {
        throw new Error("aborted");
      }
      if (delayMs && this.opts.clock) {
        await this.opts.clock.sleep(delayMs);
      } else if (delayMs) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      yield chunk;
    }

    if (error) {
      throw error;
    }

    if (hang) {
      await new Promise<void>((resolve, reject) => {
        if (options.signal.aborted && !ignoreAbort) {
          reject(new Error("aborted"));
          return;
        }
        const onAbort = () => {
          if (!ignoreAbort) {
            reject(new Error("aborted"));
          }
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
      });
    }
  }

  // For compatibility with old tests that used flat list
  static fromChunks(chunks: LLMChunk[], opts?: { waitForAbort?: boolean }): FakeProvider {
    if (opts?.waitForAbort) {
      return new FakeProvider([
        () => ({ chunks, hang: true }),
      ]);
    }
    return new FakeProvider([() => ({ chunks })]);
  }
}

// Helpers for readable tests
export const Steps = {
  toolCall: (id: string, name: string, input: unknown): ProviderStep =>
    () => ({ chunks: [{ type: "tool_call", call: { id, name, input } }] }),

  text: (text: string): ProviderStep =>
    () => ({ chunks: [{ type: "text_delta", text }] }),

  failAfterPartialText: (partial: string, error: Error): ProviderStep =>
    () => ({ chunks: [{ type: "text_delta", text: partial }], error }),

  hang: (): ProviderStep =>
    () => ({ hang: true }),

  ignoreAbort: (): ProviderStep =>
    () => ({ hang: true, ignoreAbort: true }),

  malformedInput: (id: string, name: string, badInput: unknown): ProviderStep =>
    () => ({ chunks: [{ type: "tool_call", call: { id, name, input: badInput } }] }),

  unknownTool: (id: string, name: string): ProviderStep =>
    () => ({ chunks: [{ type: "tool_call", call: { id, name, input: {} } }] }),

  assertThen: (assertFn: (req: LLMRequest) => void, next: ProviderStep): ProviderStep =>
    (req) => {
      assertFn(req);
      return next(req);
    },
};
