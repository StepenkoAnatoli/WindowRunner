/**
 * Provider-neutral model contract. Adapters (mock, openai-compatible) map
 * their wire formats onto these shapes; the agent loop never sees a provider's
 * native payload.
 */
export interface LLMToolCall {
  id: string;
  name: string;
  /** Parsed JSON arguments. `undefined` when the model produced unparsable JSON — see `inputError`. */
  input: unknown;
  /**
   * Set when the provider streamed arguments that were not valid JSON. The loop
   * turns this into a controlled TOOL_FAILED result (fed back to the model)
   * instead of executing the tool with garbage or crashing the turn.
   */
  inputError?: string;
  /** The raw argument text, kept for transcripts when `inputError` is set. */
  rawInput?: string;
}

export interface LLMMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  /** tool role: the call this message answers. */
  toolCallId?: string;
  toolName?: string;
  /** assistant role: calls the model made in this message (wire formats need them echoed back). */
  toolCalls?: LLMToolCall[];
}

export interface LLMToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool input. Omitted = any object. */
  parameters?: Record<string, unknown>;
}

export interface LLMRequest {
  messages: LLMMessage[];
  tools: LLMToolSpec[];
}

export type LLMChunk =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; call: LLMToolCall }
  | { type: "usage"; usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } };

export interface LLMProvider {
  stream(request: LLMRequest, options: { signal: AbortSignal }): AsyncIterable<LLMChunk>;
}

/**
 * Thrown by adapters for failures the loop should report with a stable code.
 * `retryable` says whether a later turn might succeed unchanged (rate limit,
 * transient upstream error) as opposed to a configuration problem (bad key,
 * unknown model).
 */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  /** Server-suggested wait before retrying (from Retry-After), when known. */
  readonly retryAfterMs?: number;
  constructor(code: ProviderErrorCode, message: string, opts: { retryable?: boolean; status?: number; cause?: unknown; retryAfterMs?: number } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "ProviderError";
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export type ProviderErrorCode =
  | "MODEL_AUTH"
  | "MODEL_RATE_LIMITED"
  | "MODEL_UNAVAILABLE"
  | "MODEL_BAD_REQUEST"
  | "MODEL_CONTEXT_EXHAUSTED"
  | "MODEL_STREAM_BROKEN"
  | "MODEL_FAILED";
