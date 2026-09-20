/**
 * OpenAI-compatible chat-completions adapter (streaming).
 *
 * One adapter covers OpenAI, OpenRouter, Ollama, LM Studio, vLLM, Groq,
 * Gemini's OpenAI endpoint and similar: anything that speaks
 * `POST {baseUrl}/chat/completions` with `stream: true` and SSE `data:` lines.
 *
 * Contract with the loop (providers/types.ts):
 * - text deltas are yielded as they arrive;
 * - tool calls are accumulated per index until the stream ends, then yielded
 *   with parsed JSON arguments — or with `inputError` when the arguments are
 *   not valid JSON, so the loop can answer the model with a controlled error;
 * - a `usage` chunk is yielded when the server reports it
 *   (`stream_options.include_usage`);
 * - the abort signal is passed straight to `fetch`, so Stop tears down the
 *   HTTP stream immediately;
 * - HTTP errors become `ProviderError`s with stable codes: 401/403 → MODEL_AUTH,
 *   429 → MODEL_RATE_LIMITED (retryable), 5xx → MODEL_UNAVAILABLE (retryable),
 *   context-length 400s → MODEL_CONTEXT_EXHAUSTED, other 4xx → MODEL_BAD_REQUEST,
 *   a stream that ends without `[DONE]`/finish → MODEL_STREAM_BROKEN (retryable).
 *   `Retry-After` on 429/5xx is surfaced as `retryAfterMs`.
 * - This adapter does not retry itself; providers/retry.ts wraps it (see
 *   WINDOWS_RUNNER_MODEL_MAX_RETRIES) and only retries before any chunk was yielded.
 *
 * The API key is read from the environment at construction time and is never
 * logged or included in error messages.
 */
import { parseRetryAfter } from "./retry.js";
import { ProviderError, type LLMChunk, type LLMMessage, type LLMProvider, type LLMRequest, type LLMToolCall, type LLMToolSpec } from "./types.js";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Sent as-is with every request (e.g. OpenRouter's HTTP-Referer / X-Title). */
  extraHeaders?: Record<string, string>;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Ask the server for a final usage chunk. Default true (OpenAI, OpenRouter, vLLM honour it; others ignore). */
  includeUsage?: boolean;
  /** Optional system prompt prepended when the transcript has none. */
  systemPrompt?: string;
  temperature?: number;
}

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name = "openai-compatible";
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly includeUsage: boolean;
  private readonly systemPrompt?: string;
  private readonly temperature?: number;

  constructor(options: OpenAICompatibleOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.apiKey = options.apiKey && options.apiKey.length > 0 ? options.apiKey : undefined;
    this.extraHeaders = options.extraHeaders ?? {};
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.includeUsage = options.includeUsage ?? true;
    this.systemPrompt = options.systemPrompt;
    this.temperature = options.temperature;
    if (!this.model) throw new ProviderError("MODEL_BAD_REQUEST", "openai-compatible: a model name is required");
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
      ...this.extraHeaders,
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal });
    } catch (err: any) {
      if (signal.aborted) throw signal.reason ?? err;
      throw new ProviderError("MODEL_UNAVAILABLE", `openai-compatible: request to ${this.baseUrl} failed: ${err?.message ?? err}`, { retryable: true, cause: err });
    }

    if (!res.ok) {
      throw await this.httpError(res);
    }
    if (!res.body) {
      throw new ProviderError("MODEL_STREAM_BROKEN", "openai-compatible: response had no body", { retryable: true, status: res.status });
    }

    const toolCalls = new Map<number, { id: string; name: string; args: string }>();
    let usage: LLMChunk | undefined;
    let finished = false;
    let sawDone = false;

    for await (const data of guardStream(readSseData(res.body, signal), signal)) {
      if (data === "[DONE]") {
        sawDone = true;
        break;
      }
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        throw new ProviderError("MODEL_STREAM_BROKEN", "openai-compatible: malformed JSON in stream", { retryable: true });
      }
      if (json?.error) {
        throw this.errorFromPayload(json.error, res.status);
      }
      const choice = json?.choices?.[0];
      const delta = choice?.delta;
      if (delta) {
        if (typeof delta.content === "string" && delta.content.length > 0) {
          yield { type: "text_delta", text: delta.content };
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const index = typeof tc.index === "number" ? tc.index : toolCalls.size;
            let acc = toolCalls.get(index);
            if (!acc) {
              acc = { id: "", name: "", args: "" };
              toolCalls.set(index, acc);
            }
            if (typeof tc.id === "string" && tc.id) acc.id = tc.id;
            if (typeof tc.function?.name === "string" && tc.function.name) acc.name += tc.function.name;
            if (typeof tc.function?.arguments === "string") acc.args += tc.function.arguments;
          }
        }
      }
      if (choice?.finish_reason) finished = true;
      if (json?.usage && typeof json.usage === "object") {
        usage = {
          type: "usage",
          usage: {
            inputTokens: numberOrUndefined(json.usage.prompt_tokens),
            outputTokens: numberOrUndefined(json.usage.completion_tokens),
            totalTokens: numberOrUndefined(json.usage.total_tokens),
          },
        };
      }
    }

    if (signal.aborted) throw signal.reason ?? new Error("aborted");
    if (!sawDone && !finished) {
      // Some servers (Ollama) omit [DONE] but always send finish_reason; a stream
      // with neither ended prematurely.
      throw new ProviderError("MODEL_STREAM_BROKEN", "openai-compatible: stream ended before completion", { retryable: true });
    }

    for (const [index, acc] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      const call: LLMToolCall = { id: acc.id || `call_${index}`, name: acc.name, input: undefined };
      if (acc.args.trim() === "") {
        call.input = {};
      } else {
        try {
          call.input = JSON.parse(acc.args);
        } catch (err: any) {
          call.inputError = `arguments are not valid JSON (${err?.message ?? "parse error"})`;
          call.rawInput = acc.args;
        }
      }
      yield { type: "tool_call", call };
    }
    if (usage) yield usage;
  }

  private buildBody(request: LLMRequest): Record<string, unknown> {
    const messages: any[] = [];
    if (this.systemPrompt && !request.messages.some((m) => m.role === "system")) {
      messages.push({ role: "system", content: this.systemPrompt });
    }
    for (const m of request.messages) messages.push(toWireMessage(m));
    const body: Record<string, unknown> = { model: this.model, messages, stream: true };
    if (this.includeUsage) body.stream_options = { include_usage: true };
    if (this.temperature !== undefined) body.temperature = this.temperature;
    if (request.tools.length > 0) {
      body.tools = request.tools.map(toWireTool);
      body.tool_choice = "auto";
    }
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
    const message: string = typeof error === "string" ? error : error?.message ?? JSON.stringify(error).slice(0, 300);
    const code: string | undefined = typeof error === "object" ? error?.code ?? error?.type : undefined;
    if (code === "context_length_exceeded" || /context length|maximum context|too many tokens|context_length/i.test(message)) {
      return new ProviderError("MODEL_CONTEXT_EXHAUSTED", `openai-compatible: ${message}`, { status });
    }
    return this.errorFromStatus(status, message, retryAfterMs);
  }

  private errorFromStatus(status: number, detail: string, retryAfterMs?: number): ProviderError {
    const msg = `openai-compatible: HTTP ${status} from ${this.baseUrl}: ${redact(detail, this.apiKey)}`;
    if (status === 401 || status === 403) return new ProviderError("MODEL_AUTH", msg, { status });
    if (status === 429) return new ProviderError("MODEL_RATE_LIMITED", msg, { status, retryable: true, retryAfterMs });
    if (status === 404) return new ProviderError("MODEL_BAD_REQUEST", `${msg} (unknown model or wrong base URL?)`, { status });
    if (status >= 500) return new ProviderError("MODEL_UNAVAILABLE", msg, { status, retryable: true, retryAfterMs });
    if (status === 400 && /context length|maximum context|too many tokens/i.test(detail)) {
      return new ProviderError("MODEL_CONTEXT_EXHAUSTED", msg, { status });
    }
    if (status >= 400) return new ProviderError("MODEL_BAD_REQUEST", msg, { status });
    return new ProviderError("MODEL_FAILED", msg, { status });
  }
}

function toWireMessage(m: LLMMessage): Record<string, unknown> {
  switch (m.role) {
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    case "assistant": {
      const out: Record<string, unknown> = { role: "assistant", content: m.content === "" ? null : m.content };
      if (m.toolCalls && m.toolCalls.length > 0) {
        out.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.rawInput ?? JSON.stringify(c.input ?? {}) },
        }));
      }
      return out;
    }
    default:
      return { role: m.role, content: m.content };
  }
}

function toWireTool(t: LLMToolSpec): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters ?? { type: "object", properties: {}, additionalProperties: true },
    },
  };
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Keep the key out of any surfaced text even if an upstream echoes it. */
function redact(text: string, secret: string | undefined): string {
  return secret && secret.length >= 8 ? text.split(secret).join("[redacted]") : text;
}

/** Transport errors while reading the body are a broken stream, not an unreachable server. */
async function* guardStream(source: AsyncGenerator<string>, signal: AbortSignal): AsyncGenerator<string> {
  try {
    for await (const item of source) yield item;
  } catch (err: any) {
    if (signal.aborted) throw signal.reason ?? err;
    if (err instanceof ProviderError) throw err;
    throw new ProviderError("MODEL_STREAM_BROKEN", `openai-compatible: stream failed: ${err?.message ?? err}`, { retryable: true, cause: err });
  }
}

/**
 * Minimal SSE reader: yields the joined `data:` payload of each event.
 * Ignores comments and other fields; tolerates CRLF and multi-line data.
 */
export async function* readSseData(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error("aborted");
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, "");
        const data = rawEvent
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data.length > 0) yield data;
      }
    }
    const tail = buffer
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (tail.length > 0) yield tail;
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }
}
