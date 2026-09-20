export interface LLMRequest {
  messages: Array<{
    role: "user" | "assistant" | "tool" | "system";
    content: string;
    toolCallId?: string;
    toolName?: string;
  }>;
  tools: Array<{ name: string; description: string }>;
}

export type LLMChunk =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; call: { id: string; name: string; input: unknown } }
  | { type: "usage"; usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } };

export interface LLMProvider {
  stream(request: LLMRequest, options: { signal: AbortSignal }): AsyncIterable<LLMChunk>;
}
