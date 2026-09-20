/**
 * Anthropic adapter against an Anthropic-shaped fake: wire mapping (system,
 * tool_result merging, tools → input_schema), streamed text, tool_use JSON
 * accumulation, usage, error codes, broken streams, cancellation, and the
 * registry/config path (ANTHROPIC_API_KEY fallback, default base URL).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { ProviderError, type LLMChunk, type LLMProvider, type LLMRequest } from "../src/providers/types.js";
import { createProvider } from "../src/providers/index.js";
import { loadServerConfig } from "../src/config.js";
import { startServer } from "../src/boot.js";
import { startFakeAnthropic, type FakeAnthropicScript, type FakeAnthropicServer } from "./fakes/fake-anthropic-server.js";

const KEY = "sk-ant-secret-0123456789abcdef";
const servers: FakeAnthropicServer[] = [];
after(async () => {
  for (const s of servers) await s.close();
});
async function fake(script: FakeAnthropicScript[]) {
  const s = await startFakeAnthropic(script);
  servers.push(s);
  return s;
}
const provider = (url: string, extra: Partial<ConstructorParameters<typeof AnthropicProvider>[0]> = {}) =>
  new AnthropicProvider({ baseUrl: url, model: "fake-model", apiKey: KEY, systemPrompt: "be terse", ...extra });

async function collect(p: LLMProvider, req: LLMRequest = { messages: [{ role: "user", content: "hi" }], tools: [] }, signal = new AbortController().signal) {
  const out: LLMChunk[] = [];
  for await (const c of p.stream(req, { signal })) out.push(c);
  return out;
}
const textOf = (chunks: LLMChunk[]) => chunks.filter((c) => c.type === "text_delta").map((c: any) => c.text).join("");

describe("anthropic adapter", () => {
  it("streams text deltas and usage; sends x-api-key, anthropic-version, max_tokens and system", async () => {
    const s = await fake([{ kind: "text", text: "hello brave new world" }]);
    const chunks = await collect(provider(s.url));
    assert.equal(textOf(chunks), "hello brave new world");
    const usage = chunks.find((c) => c.type === "usage") as any;
    assert.deepEqual(usage.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18 });
    const r = s.requests[0];
    assert.equal(r.headers["x-api-key"], KEY);
    assert.equal(r.headers.authorization, undefined);
    assert.equal(r.headers["anthropic-version"], "2023-06-01");
    assert.equal(r.body.model, "fake-model");
    assert.equal(r.body.max_tokens, 4096);
    assert.equal(r.body.stream, true);
    assert.equal(r.body.system, "be terse");
    assert.deepEqual(r.body.messages, [{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });

  it("maps the transcript: system into `system`, assistant tool_use echoed, consecutive tool results merged into one user message, tools → input_schema", async () => {
    const s = await fake([{ kind: "text", text: "ok" }]);
    await collect(provider(s.url), {
      messages: [
        { role: "system", content: "extra rule" },
        { role: "user", content: "list and read" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "t1", name: "list_dir", input: { path: "." } },
            { id: "t2", name: "read_file", input: undefined, inputError: "bad", rawInput: "{oops" },
          ],
        },
        { role: "tool", toolCallId: "t1", toolName: "list_dir", content: "a.txt" },
        { role: "tool", toolCallId: "t2", toolName: "read_file", content: "TOOL_FAILED: bad" },
      ],
      tools: [{ name: "list_dir", description: "list", parameters: { type: "object", properties: { path: { type: "string" } } } }, { name: "read_file", description: "read" }],
    });
    const b = s.requests[0].body;
    assert.equal(b.system, "be terse\n\nextra rule");
    assert.equal(b.messages.length, 3);
    assert.deepEqual(b.messages[1], {
      role: "assistant",
      content: [
        { type: "tool_use", id: "t1", name: "list_dir", input: { path: "." } },
        { type: "tool_use", id: "t2", name: "read_file", input: { _raw: "{oops" } },
      ],
    });
    assert.deepEqual(b.messages[2], {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "a.txt" },
        { type: "tool_result", tool_use_id: "t2", content: "TOOL_FAILED: bad" },
      ],
    });
    assert.deepEqual(b.tools[0], { name: "list_dir", description: "list", input_schema: { type: "object", properties: { path: { type: "string" } } } });
    assert.equal(b.tools[1].input_schema.type, "object");
  });

  it("accumulates split input_json_delta fragments into one tool call per block, preserving text before it", async () => {
    const s = await fake([{ kind: "tool_use", text: "Let me look. ", calls: [{ id: "toolu_A", name: "read_file", json: '{"path":"src/index.ts","startLine":1}' }, { name: "list_dir", json: "" }], splitJson: 5 }]);
    const chunks = await collect(provider(s.url));
    assert.equal(textOf(chunks), "Let me look. ");
    const calls = chunks.filter((c) => c.type === "tool_call").map((c: any) => c.call);
    assert.deepEqual(calls, [
      { id: "toolu_A", name: "read_file", input: { path: "src/index.ts", startLine: 1 } },
      { id: "toolu_2", name: "list_dir", input: {} },
    ]);
  });

  it("reports unparsable tool input as inputError instead of throwing", async () => {
    const s = await fake([{ kind: "tool_use", calls: [{ name: "write_file", json: '{"path": "a.txt", "content": ' }] }]);
    const call = (await collect(provider(s.url))).find((c) => c.type === "tool_call") as any;
    assert.equal(call.call.name, "write_file");
    assert.equal(call.call.input, undefined);
    assert.match(call.call.inputError, /not valid JSON/);
    assert.equal(call.call.rawInput, '{"path": "a.txt", "content": ');
  });

  for (const [status, type, code, retryable] of [
    [401, "authentication_error", "MODEL_AUTH", false],
    [403, "permission_error", "MODEL_AUTH", false],
    [429, "rate_limit_error", "MODEL_RATE_LIMITED", true],
    [404, "not_found_error", "MODEL_BAD_REQUEST", false],
    [500, "api_error", "MODEL_UNAVAILABLE", true],
    [529, "overloaded_error", "MODEL_UNAVAILABLE", true],
    [400, "invalid_request_error", "MODEL_BAD_REQUEST", false],
  ] as const) {
    it(`maps HTTP ${status}/${type} to ${code} (retryable=${retryable}) without leaking the key`, async () => {
      const s = await fake([{ kind: "http_error", status, headers: { "retry-after": "2" }, body: { type: "error", error: { type, message: `nope; key was ${KEY}` } } }]);
      await assert.rejects(collect(provider(s.url)), (err: any) => {
        assert.ok(err instanceof ProviderError, String(err));
        assert.equal(err.code, code);
        assert.equal(err.retryable, retryable);
        assert.equal(err.status, status);
        if (retryable) assert.equal(err.retryAfterMs, 2000);
        assert.doesNotMatch(err.message, new RegExp(KEY));
        assert.match(err.message, /\[redacted\]/);
        return true;
      });
    });
  }

  it("maps a prompt-too-long 400 to MODEL_CONTEXT_EXHAUSTED", async () => {
    const s = await fake([{ kind: "http_error", status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens > 200000 maximum" } } }]);
    await assert.rejects(collect(provider(s.url)), (err: any) => err instanceof ProviderError && err.code === "MODEL_CONTEXT_EXHAUSTED" && !err.retryable);
  });

  it("an in-stream error event surfaces with its code after the partial text", async () => {
    const s = await fake([{ kind: "error_event", error: { type: "overloaded_error", message: "Overloaded" } }]);
    const seen: LLMChunk[] = [];
    await assert.rejects(
      (async () => {
        for await (const c of provider(s.url).stream({ messages: [], tools: [] }, { signal: new AbortController().signal })) seen.push(c);
      })(),
      (err: any) => err instanceof ProviderError && err.code === "MODEL_UNAVAILABLE" && err.retryable
    );
    assert.equal(textOf(seen), "partial ");
  });

  it("a stream that ends without message_stop is MODEL_STREAM_BROKEN (retryable)", async () => {
    for (const script of [[{ kind: "text", text: "no stop", noStop: true }], [{ kind: "cut", afterChunks: 2, text: "one two three four" }]] as FakeAnthropicScript[][]) {
      const s = await fake(script);
      await assert.rejects(collect(provider(s.url)), (err: any) => err instanceof ProviderError && err.code === "MODEL_STREAM_BROKEN" && err.retryable);
    }
  });

  it("malformed JSON in the stream is MODEL_STREAM_BROKEN", async () => {
    const s = await fake([{ kind: "garbage" }]);
    await assert.rejects(collect(provider(s.url)), (err: any) => err instanceof ProviderError && err.code === "MODEL_STREAM_BROKEN");
  });

  it("an unreachable server is MODEL_UNAVAILABLE (retryable)", async () => {
    await assert.rejects(collect(provider("http://127.0.0.1:1/v1")), (err: any) => err instanceof ProviderError && err.code === "MODEL_UNAVAILABLE" && err.retryable);
  });

  it("cancellation mid-stream throws the abort reason, not a provider error", async () => {
    const s = await fake([{ kind: "text", text: "a b c d e f g h i j k l m n o p" }]);
    const ac = new AbortController();
    const reason = new Error("stopped by user");
    await assert.rejects(
      (async () => {
        for await (const c of provider(s.url).stream({ messages: [], tools: [] }, { signal: ac.signal })) {
          if (c.type === "text_delta") ac.abort(reason);
        }
      })(),
      (err: any) => err === reason
    );
  });

  it("registry: provider=anthropic uses the Anthropic default base URL, ANTHROPIC_API_KEY fallback, and the retry wrapper", async () => {
    const config = loadServerConfig(
      { WINDOWS_RUNNER_PROVIDER: "anthropic", WINDOWS_RUNNER_MODEL: "claude-fake", ANTHROPIC_API_KEY: KEY, WINDOWS_RUNNER_AUTH_TOKEN: "boot-token-0123456789abcdef", WINDOWS_RUNNER_ALLOWED_ROOTS: os.tmpdir() },
      { homedir: os.tmpdir() }
    );
    assert.equal(config.model.baseUrl, "https://api.anthropic.com/v1");
    assert.equal(config.model.apiKey, KEY);
    const p = createProvider(config.provider, config.model) as any;
    assert.deepEqual(p.describe(), { baseUrl: "https://api.anthropic.com/v1", model: "claude-fake", hasApiKey: true });

    const s = await fake([{ kind: "http_error", status: 529, body: { type: "error", error: { type: "overloaded_error", message: "busy" } } }, { kind: "text", text: "after retry" }]);
    const lines: string[] = [];
    const retrying = createProvider("anthropic", { ...config.model, baseUrl: s.url }, (l) => lines.push(l));
    assert.equal(textOf(await collect(retrying)), "after retry");
    assert.equal(s.requests.length, 2);
    assert.match(lines[0], /MODEL_UNAVAILABLE \(529\); retry 1\/2/);
  });

  it("boot path: a two-step tool turn reports usage summed across both model calls", async () => {
    const s = await fake([{ kind: "tool_use", calls: [{ name: "list_dir", json: '{"path":"."}' }] }, { kind: "text", text: "done" }]);
    const config = loadServerConfig(
      { WINDOWS_RUNNER_PROVIDER: "anthropic", WINDOWS_RUNNER_MODEL: "m", WINDOWS_RUNNER_MODEL_BASE_URL: s.url, ANTHROPIC_API_KEY: KEY, WINDOWS_RUNNER_AUTH_TOKEN: "boot-token-0123456789abcdef", WINDOWS_RUNNER_ALLOWED_ROOTS: os.tmpdir() },
      { homedir: os.tmpdir() }
    );
    const h = await startServer(config);
    try {
      const auth = { authorization: "Bearer boot-token-0123456789abcdef", "content-type": "application/json" };
      const created = await fetch(`${h.url}/api/sessions/an/turns`, { method: "POST", headers: auth, body: JSON.stringify({ cwd: os.tmpdir(), message: "list" }) });
      assert.equal(created.status, 202);
      const { turnId } = await created.json();
      const events = await (await fetch(`${h.url}/api/sessions/an/turns/${turnId}/events`, { headers: auth })).text();
      const completed = JSON.parse(events.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).find((l) => l.includes('"turn_completed"'))!);
      // Each fake call reports input 11 / output 7; two calls → 22 / 14 / 36.
      assert.deepEqual(completed.usage, { inputTokens: 22, outputTokens: 14, totalTokens: 36 });
      assert.equal(s.requests.length, 2);
      assert.equal(s.requests[1].body.messages.at(-1).content[0].type, "tool_result");
    } finally {
      await h.close();
    }
  });

  it("config: OPENAI_API_KEY is not used as the anthropic fallback and WINDOWS_RUNNER_MODEL is required", () => {
    const c = loadServerConfig({ WINDOWS_RUNNER_PROVIDER: "anthropic", WINDOWS_RUNNER_MODEL: "m", OPENAI_API_KEY: "sk-openai-0123456789", WINDOWS_RUNNER_AUTH_TOKEN: "boot-token-0123456789abcdef" }, { homedir: os.tmpdir() });
    assert.equal(c.model.apiKey, undefined);
    assert.throws(() => loadServerConfig({ WINDOWS_RUNNER_PROVIDER: "anthropic", WINDOWS_RUNNER_AUTH_TOKEN: "boot-token-0123456789abcdef" }, { homedir: os.tmpdir() }), /WINDOWS_RUNNER_MODEL is required when WINDOWS_RUNNER_PROVIDER=anthropic/);
  });
});
