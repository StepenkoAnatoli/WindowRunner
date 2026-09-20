/**
 * Anthropic Messages API adapter (streaming).
 *
 * `POST {baseUrl}/messages` with `stream: true`; the response is SSE with typed
 * events (`message_start`, `content_block_start`, `content_block_delta`,
 * `content_block_stop`, `message_delta`, `message_stop`, `ping`, `error`).
 *
 * Mapping onto the provider-neutral contract (providers/types.ts):
 * - `text_delta` blocks → text deltas as they arrive;
 * - `tool_use` blocks → `input_json_delta` fragments are accumulated per block
 *   index and yielded as one tool call at `content_block_stop`, with parsed JSON
 *   input — or `inputError` when the fragments do not form valid JSON;
 * - usage: `message_start` carries input tokens, `message_delta` output tokens;
 *   one `usage` chunk is yielded at the end;
 * - transcript: the system message goes in the top-level `system` field; tool
 *   results become `tool_result` blocks inside a `user` message (consecutive
 *   tool results are merged into one user message, as the API requires);
 * - HTTP errors → ProviderError with the same stable codes as the
 *   openai-compatible adapter (401/403 MODEL_AUTH, 429 MODEL_RATE_LIMITED,
 *   529/5xx MODEL_UNAVAILABLE, prompt-too-long 400 MODEL_CONTEXT_EXHAUSTED,
 *   other 4xx MODEL_BAD_REQUEST); a stream that ends without `message_stop`
 *   → MODEL_STREAM_BROKEN (retryable). Retry-After is surfaced as retryAfterMs.
 * - the abort signal is passed straight to `fetch`; Stop tears the stream down.
 *
 * This adapter does not retry itself; providers/retry.ts wraps it. The key is
 * read once at construction and never logged or included in error messages.
 */
import { readSseEvents } from "./sse.js";
import { parseRetryAfter } from "./retry.js";
import { ProviderError, type LLMChunk, type LLMMessage, type LLMProvider, type LLMRequest, type LLMToolCall, type LLMToolSpec } from "./types.js";

export interface AnthropicOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Required by the API. Default 4096. */
  maxTokens?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  systemPrompt?: string;
  temperature?: number;
  /** Sent as `anthropic-version`. */
  apiVersion?: string;
}

export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
export const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly maxTokens: number;
  private readonly fetchImpl: typeof fetch;
  private readonly systemPrompt?: string;
  private readonly temperature?: number;
  private readonly apiVersion: string;

  constructor(options: AnthropicOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.apiKey = options.apiKey && options.apiKey.length > 0 ? options.apiKey : undefined;
    this.maxTokens = options.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.systemPrompt = options.systemPrompt;
    this.temperature = options.temperature;
    this.apiVersion = options.apiVersion ?? DEFAULT_ANTHROPIC_VERSION;
    if (!this.model) throw new ProviderError("MODEL_BAD_REQUEST", "anthropic: a model name is required");
  }

  /** Secret-free description for the boot banner. */
  describe(): { baseUrl: string; model: string; hasApiKey: boolean } {
    return { baseUrl: this.baseUrl, model: this.model, hasApiKey: this.apiKey !== undefined };
  }

  async *stream(request: LLMRequest, { signal }: { signal: AbortSignal }): AsyncIterable<LLMChunk> {
    const body = this.buildBody(request);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      "anthropic-version": this.apiVersion,
    };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/messages`, { method: "POST", headers, body: JSON.stringify(body), signal });
    } catch (err: any) {
      if (signal.aborted) throw signal.reason ?? err;
      throw new ProviderError("MODEL_UNAVAILABLE", `anthropic: request to ${this.baseUrl} failed: ${err?.message ?? err}`, { retryable: true, cause: err });
    }
    if (!res.ok) throw await this.httpError(res);
    if (!res.body) throw new ProviderError("MODEL_STREAM_BROKEN", "anthropic: response had no body", { retryable: true, status: res.status });

    const blocks = new Map<number, { id: string; name: string; json: string }>();
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let stopped = false;

    const events = guard(readSseEvents(res.body, signal), signal);
    for await (const { event, data } of events) {
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        throw new ProviderError("MODEL_STREAM_BROKEN", "anthropic: malformed JSON in stream", { retryable: true });
      }
      const type: string = json?.type ?? event;
      switch (type) {
        case "message_start":
          inputTokens = numberOrUndefined(json?.message?.usage?.input_tokens);
          break;
        case "content_block_start": {
          const cb = json?.content_block;
          if (cb?.type === "tool_use") {
            blocks.set(json.index, { id: typeof cb.id === "string" ? cb.id : "", name: typeof cb.name === "string" ? cb.name : "", json: "" });
          } else if (cb?.type === "text" && typeof cb.text === "string" && cb.text.length > 0) {
            yield { type: "text_delta", text: cb.text };
          }
          break;
        }
        case "content_block_delta": {
          const d = json?.delta;
          if (d?.type === "text_delta" && typeof d.text === "string" && d.text.length > 0) {
            yield { type: "text_delta", text: d.text };
          } else if (d?.type === "input_json_delta") {
            const acc = blocks.get(json.index);
            if (acc && typeof d.partial_json === "string") acc.json += d.partial_json;
          }
          break;
        }
        case "content_block_stop": {
          const acc = blocks.get(json?.index);
          if (acc) {
            blocks.delete(json.index);
            yield { type: "tool_call", call: toToolCall(acc, json.index) };
          }
          break;
        }
        case "message_delta":
          outputTokens = numberOrUndefined(json?.usage?.output_tokens) ?? outputTokens;
          break;
        case "message_stop":
          stopped = true;
          break;
        case "error":
          throw this.errorFromPayload(json?.error, res.status);
        default:
          break; // ping and unknown future events
      }
      if (stopped) break;
    }

    if (signal.aborted) throw signal.reason ?? new Error("aborted");
    if (!stopped) throw new ProviderError("MODEL_STREAM_BROKEN", "anthropic: stream ended before message_stop", { retryable: true });
    // A tool_use block without content_block_stop would be lost; flush defensively.
    for (const [index, acc] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) yield { type: "tool_call", call: toToolCall(acc, index) };
    if (inputTokens !== undefined || outputTokens !== undefined) {
      const total = inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined;
      yield { type: "usage", usage: { inputTokens, outputTokens, totalTokens: total } };
    }
  }

  private buildBody(request: LLMRequest): Record<string, unknown> {
    const systemParts: string[] = [];
    if (this.systemPrompt) systemParts.push(this.systemPrompt);
    const messages: Array<{ role: "user" | "assistant"; content: any }> = [];
    const push = (role: "user" | "assistant", content: any[]) => {
      const last = messages[messages.length - 1];
      if (last && last.role === role) last.content.push(...content);
      else messages.push({ role, content });
    };
    for (const m of request.messages) {
      switch (m.role) {
        case "system":
          systemParts.push(m.content);
          break;
        case "user":
          push("user", [{ type: "text", text: m.content }]);
          break;
        case "tool":
          push("user", [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }]);
          break;
        case "assistant": {
          const content: any[] = [];
          if (m.content !== "") content.push({ type: "text", text: m.content });
          for (const c of m.toolCalls ?? []) content.push({ type: "tool_use", id: c.id, name: c.name, input: safeInput(c) });
          if (content.length === 0) content.push({ type: "text", text: "(no content)" });
          push("assistant", content);
          break;
        }
      }
    }
    const body: Record<string, unknown> = { model: this.model, max_tokens: this.maxTokens, stream: true, messages };
    if (systemParts.length > 0) body.system = systemParts.join("\n\n");
    if (this.temperature !== undefined) body.temperature = this.temperature;
    if (request.tools.length > 0) body.tools = request.tools.map(toWireTool);
    return body;
  }

  private async httpError(res: Response): Promise<ProviderError> {
    let payload: any;
    let text = "";
    try {
      text = await res.text();
      payload = JSON.parse(text);
    } catch {}
    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
    if (payload?.error) return this.errorFromPayload(payload.error, res.status, retryAfterMs);
    return this.errorFromStatus(res.status, text.slice(0, 300) || res.statusText, retryAfterMs);
  }

  private errorFromPayload(error: any, status: number, retryAfterMs?: number): ProviderError {
    const message: string = typeof error === "string" ? error : error?.message ?? JSON.stringify(error ?? null).slice(0, 300);
    const type: string | undefined = typeof error === "object" && error ? error.type : undefined;
    if (type === "authentication_error" || type === "permission_error") return new ProviderError("MODEL_AUTH", this.msg(status, message), { status });
    if (type === "rate_limit_error") return new ProviderError("MODEL_RATE_LIMITED", this.msg(status, message), { status, retryable: true, retryAfterMs });
    if (type === "overloaded_error" || type === "api_error") return new ProviderError("MODEL_UNAVAILABLE", this.msg(status, message), { status, retryable: true, retryAfterMs });
    if (/prompt is too long|too many tokens|context/i.test(message)) return new ProviderError("MODEL_CONTEXT_EXHAUSTED", this.msg(status, message), { status });
    if (type === "not_found_error") return new ProviderError("MODEL_BAD_REQUEST", `${this.msg(status, message)} (unknown model or wrong base URL?)`, { status });
    return this.errorFromStatus(status, message, retryAfterMs);
  }

  private errorFromStatus(status: number, detail: string, retryAfterMs?: number): ProviderError {
    const msg = this.msg(status, detail);
    if (status === 401 || status === 403) return new ProviderError("MODEL_AUTH", msg, { status });
    if (status === 429) return new ProviderError("MODEL_RATE_LIMITED", msg, { status, retryable: true, retryAfterMs });
    if (status === 404) return new ProviderError("MODEL_BAD_REQUEST", `${msg} (unknown model or wrong base URL?)`, { status });
    if (status >= 500) return new ProviderError("MODEL_UNAVAILABLE", msg, { status, retryable: true, retryAfterMs });
    if (status === 400 && /prompt is too long|too many tokens|context/i.test(detail)) return new ProviderError("MODEL_CONTEXT_EXHAUSTED", msg, { status });
    if (status >= 400) return new ProviderError("MODEL_BAD_REQUEST", msg, { status });
    return new ProviderError("MODEL_FAILED", msg, { status });
  }

  private msg(status: number, detail: string): string {
    const safe = this.apiKey && this.apiKey.length >= 8 ? detail.split(this.apiKey).join("[redacted]") : detail;
    return `anthropic: HTTP ${status} from ${this.baseUrl}: ${safe}`;
  }
}

function toToolCall(acc: { id: string; name: string; json: string }, index: number): LLMToolCall {
  const call: LLMToolCall = { id: acc.id || `toolu_${index}`, name: acc.name, input: undefined };
  if (acc.json.trim() === "") {
    call.input = {};
  } else {
    try {
      call.input = JSON.parse(acc.json);
    } catch (err: any) {
      call.inputError = `arguments are not valid JSON (${err?.message ?? "parse error"})`;
      call.rawInput = acc.json;
    }
  }
  return call;
}

/** tool_use.input must be an object; a call with unparsable input is echoed back as an empty object plus the raw text. */
function safeInput(c: LLMToolCall): Record<string, unknown> {
  if (c.input && typeof c.input === "object" && !Array.isArray(c.input)) return c.input as Record<string, unknown>;
  return c.rawInput !== undefined ? { _raw: c.rawInput } : {};
}

function toWireTool(t: LLMToolSpec): Record<string, unknown> {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.parameters ?? { type: "object", properties: {}, additionalProperties: true },
  };
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

async function* guard<T>(source: AsyncGenerator<T>, signal: AbortSignal): AsyncGenerator<T> {
  try {
    for await (const item of source) yield item;
  } catch (err: any) {
    if (signal.aborted) throw signal.reason ?? err;
    if (err instanceof ProviderError) throw err;
    throw new ProviderError("MODEL_STREAM_BROKEN", `anthropic: stream failed: ${err?.message ?? err}`, { retryable: true, cause: err });
  }
}

export type { LLMMessage };
