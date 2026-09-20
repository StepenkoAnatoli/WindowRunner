import type { LLMProvider, LLMRequest, LLMToolCall } from "./types.js";
import { runWithDeadline, DeadlineError } from "../deadline.js";

export interface ModelCallResult {
  text: string;
  toolCalls: LLMToolCall[];
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  partialText?: string;
  partialToolCalls?: LLMToolCall[];
  partialUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

export async function runModelCall(
  provider: LLMProvider,
  request: LLMRequest,
  signal: AbortSignal,
  timeoutMs: number,
  clock?: any,
  shutdownGraceMs = 1000
): Promise<ModelCallResult> {
  let partialText = "";
  let partialToolCalls: LLMToolCall[] = [];
  let partialUsage: ModelCallResult["usage"] | undefined;

  try {
    const result = await runWithDeadline(
      async (childSignal) => {
        let text = "";
        const toolCalls: LLMToolCall[] = [];
        let usage: ModelCallResult["usage"] | undefined;

        const stream = provider.stream(request, { signal: childSignal });

        for await (const chunk of stream) {
          if (childSignal.aborted) {
            // Throw abort reason to trigger abort-and-await
            throw (childSignal as any).reason ?? new Error("aborted");
          }
          if (chunk.type === "text_delta") {
            text += chunk.text;
            partialText = text;
          } else if (chunk.type === "tool_call") {
            toolCalls.push(chunk.call);
            partialToolCalls = [...toolCalls];
          } else if (chunk.type === "usage") {
            usage = chunk.usage;
            partialUsage = usage;
          }
        }

        return { text, toolCalls, usage };
      },
      {
        parentSignal: signal,
        timeoutMs,
        kind: "model",
        clock,
        shutdownGraceMs,
      }
    );
    return result;
  } catch (err: any) {
    if (err instanceof DeadlineError) {
      // Preserve partial data on deadline errors
      err.partialText = partialText || err.partialText;
      err.partialToolCalls = partialToolCalls;
      err.partialUsage = partialUsage;
      throw err;
    }
    // For other errors, attach partial data
    const modelErr = err instanceof Error ? err : new Error(String(err));
    (modelErr as any).partialText = partialText || (err as any).partialText;
    (modelErr as any).partialToolCalls = partialToolCalls;
    (modelErr as any).partialUsage = partialUsage;
    (modelErr as any).code = (err as any).code ?? "MODEL_FAILED";
    throw modelErr;
  }
}
