/**
 * OpenAI-compatible adapter (src/providers/openai-compatible.ts) against a
 * fake OpenAI-shaped SSE server — no network, no keys. Covers the failure
 * modes RELEASE_CHECKLIST P1-07 lists for the fake-provider suite: auth, rate
 * limit, context exhaustion, broken/dropped streams, malformed tool calls,
 * cancellation mid-stream — plus the wire-format round trip of tool calls.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { ProviderError, type LLMChunk, type LLMProvider, type LLMRequest } from "../src/providers/types.js";
import { runModelCall } from "../src/providers/model-call.js";
import { startFakeOpenAI, type FakeOpenAIServer } from "./fakes/fake-openai-server.js";
import { startServer, type StartedServer } from "../src/boot.js";
import { loadServerConfig } from "../src/config.js";
import { createProvider } from "../src/providers/index.js";

const servers: FakeOpenAIServer[] = [];
const started: StartedServer[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
  await Promise.all(started.map((s) => s.close().catch(() => {})));
});

async function fake(script: Parameters<typeof startFakeOpenAI>[0]) {
  const s = await startFakeOpenAI(script);
  servers.push(s);
  return s;
}

const KEY = "sk-test-secret-key-000000";
const provider = (baseUrl: string, extra: Partial<ConstructorParameters<typeof OpenAICompatibleProvider>[0]> = {}) =>
  new OpenAICompatibleProvider({ baseUrl, model: "fake-model", apiKey: KEY, ...extra });

async function collect(p: LLMProvider, req: LLMRequest = { messages: [{ role: "user", content: "hi" }], tools: [] }, signal = new AbortController().signal) {
  const out: LLMChunk[] = [];
  for await (const c of p.stream(req, { signal })) out.push(c);
  return out;
}

describe("openai-compatible adapter", () => {
  it("streams text deltas, then usage, and sends the bearer key + stream options", async () => {
    const s = await fake([{ kind: "text", text: "hello brave new world", usage: true }]);
    const chunks = await collect(provider(s.url));
    const text = chunks.filter((c) => c.type === "text_delta").map((c: any) => c.text).join("");
    assert.equal(text, "hello brave new world");
    const usage = chunks.find((c) => c.type === "usage") as any;
    assert.deepEqual(usage.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18 });
    assert.equal(s.requests[0].headers.authorization, `Bearer ${KEY}`);
    assert.equal(s.requests[0].body.stream, true);
    assert.deepEqual(s.requests[0].body.stream_options, { include_usage: true });
    assert.equal(s.requests[0].body.model, "fake-model");
  });

  it("works without an API key (local servers) and without [DONE] when finish_reason is present", async () => {
    const s = await fake([{ kind: "text", text: "ollama style", noDone: true }]);
    const chunks = await collect(provider(s.url, { apiKey: undefined }));
    assert.equal(chunks.filter((c) => c.type === "text_delta").map((c: any) => c.text).join(""), "ollama style");
    assert.equal(s.requests[0].headers.authorization, undefined);
  });

  it("assembles tool calls split across many chunks and parses the JSON arguments", async () => {
    const s = await fake([{ kind: "tool_calls", calls: [{ id: "call_A", name: "read_file", args: '{"path":"src/index.ts","startLine":1}' }], splitArgs: 7 }]);
    const chunks = await collect(provider(s.url), {
      messages: [{ role: "user", content: "read it" }],
      tools: [{ name: "read_file", description: "d", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
    });
    const call = chunks.find((c) => c.type === "tool_call") as any;
    assert.deepEqual(call.call, { id: "call_A", name: "read_file", input: { path: "src/index.ts", startLine: 1 } });
    const wireTool = s.requests[0].body.tools[0];
    assert.equal(wireTool.type, "function");
    assert.equal(wireTool.function.name, "read_file");
    assert.deepEqual(wireTool.function.parameters.required, ["path"]);
    assert.equal(s.requests[0].body.tool_choice, "auto");
  });

  it("reports unparsable tool arguments as inputError instead of throwing", async () => {
    const s = await fake([{ kind: "tool_calls", calls: [{ name: "write_file", args: '{"path": "a.txt", "content": ' }] }]);
    const chunks = await collect(provider(s.url));
    const call = chunks.find((c) => c.type === "tool_call") as any;
    assert.equal(call.call.name, "write_file");
    assert.equal(call.call.input, undefined);
    assert.match(call.call.inputError, /not valid JSON/);
    assert.equal(call.call.rawInput, '{"path": "a.txt", "content": ');
  });

  it("round-trips assistant tool calls and tool results in the wire transcript", async () => {
    const s = await fake([{ kind: "text", text: "done" }]);
    await collect(provider(s.url, { systemPrompt: "be terse" }), {
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "list_dir", input: { path: "." } }] },
        { role: "tool", content: "file  12  a.txt", toolCallId: "c1", toolName: "list_dir" },
      ],
      tools: [],
    });
    const m = s.requests[0].body.messages;
    assert.deepEqual(m[0], { role: "system", content: "be terse" });
    assert.deepEqual(m[2], { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "list_dir", arguments: '{"path":"."}' } }] });
    assert.deepEqual(m[3], { role: "tool", tool_call_id: "c1", content: "file  12  a.txt" });
    assert.equal("tools" in s.requests[0].body, false, "no tools key when the tool list is empty");
  });

  for (const [status, code, retryable] of [
    [401, "MODEL_AUTH", false],
    [403, "MODEL_AUTH", false],
    [429, "MODEL_RATE_LIMITED", true],
    [404, "MODEL_BAD_REQUEST", false],
    [500, "MODEL_UNAVAILABLE", true],
    [503, "MODEL_UNAVAILABLE", true],
  ] as const) {
    it(`maps HTTP ${status} to ${code} (retryable=${retryable}) without leaking the key`, async () => {
      const s = await fake([{ kind: "http_error", status, body: { error: { message: `upstream said no; key was ${KEY}` } } }]);
      await assert.rejects(collect(provider(s.url)), (err: any) => {
        assert.ok(err instanceof ProviderError, String(err));
        assert.equal(err.code, code);
        assert.equal(err.retryable, retryable);
        assert.equal(err.status, status);
        assert.doesNotMatch(err.message, new RegExp(KEY));
        assert.match(err.message, /\[redacted\]/);
        return true;
      });
    });
  }

  it("surfaces Retry-After on 429 as retryAfterMs", async () => {
    const s = await fake([{ kind: "http_error", status: 429, headers: { "retry-after": "7" }, body: { error: { message: "slow down" } } }]);
    await assert.rejects(collect(provider(s.url)), (err: any) => err instanceof ProviderError && err.code === "MODEL_RATE_LIMITED" && err.retryAfterMs === 7000);
  });

  it("createProvider wraps the adapter in retries: a 503 then a good stream yields the text once and logs the retry", async () => {
    const s = await fake([
      { kind: "http_error", status: 503, body: { error: { message: "overloaded" } } },
      { kind: "text", text: "hello" },
    ]);
    const lines: string[] = [];
    const p = createProvider("openai-compatible", { baseUrl: s.url, model: "m", apiKey: KEY, maxRetries: 2, maxSteps: 10, callTimeoutMs: 30_000 }, (l) => lines.push(l));
    const chunks = await collect(p);
    assert.equal(chunks.filter((c) => c.type === "text_delta").map((c: any) => c.text).join(""), "hello");
    assert.equal(s.requests.length, 2);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /MODEL_UNAVAILABLE \(503\); retry 1\/2 in \d+ms/);
    assert.doesNotMatch(lines[0], new RegExp(KEY));
  });

  it("maps a context-length 400 to MODEL_CONTEXT_EXHAUSTED", async () => {
    const s = await fake([{ kind: "http_error", status: 400, body: { error: { message: "This model's maximum context length is 8192 tokens.", code: "context_length_exceeded" } } }]);
    await assert.rejects(collect(provider(s.url)), (err: any) => err instanceof ProviderError && err.code === "MODEL_CONTEXT_EXHAUSTED" && !err.retryable);
  });

  it("maps an in-stream error event to a ProviderError after partial text", async () => {
    const s = await fake([{ kind: "error_event", error: { message: "rate limited mid-stream", code: "rate_limit_exceeded" } }]);
    const controller = new AbortController();
    await assert.rejects(runModelCall(provider(s.url), { messages: [{ role: "user", content: "x" }], tools: [] }, controller.signal, 5000), (err: any) => {
      assert.equal(err.partialText, "partial ");
      assert.ok(err.cause instanceof ProviderError || err instanceof ProviderError);
      return true;
    });
  });

  it("a stream cut before finish is MODEL_STREAM_BROKEN (retryable) and keeps the partial text", async () => {
    const s = await fake([{ kind: "cut", afterChunks: 2, text: "one two three four" }]);
    const controller = new AbortController();
    await assert.rejects(runModelCall(provider(s.url), { messages: [{ role: "user", content: "x" }], tools: [] }, controller.signal, 5000), (err: any) => {
      const pe = err instanceof ProviderError ? err : err.cause;
      assert.ok(pe instanceof ProviderError, String(err));
      assert.equal(pe.code, "MODEL_STREAM_BROKEN");
      assert.equal(pe.retryable, true);
      assert.equal(err.partialText, "one two ");
      return true;
    });
  });

  it("malformed JSON in the stream is MODEL_STREAM_BROKEN", async () => {
    const s = await fake([{ kind: "garbage" }]);
    await assert.rejects(collect(provider(s.url)), (err: any) => err instanceof ProviderError && err.code === "MODEL_STREAM_BROKEN");
  });

  it("aborting mid-stream tears down the HTTP connection and rejects with the abort reason", async () => {
    const s = await fake([{ kind: "hang" }]);
    const controller = new AbortController();
    const it = provider(s.url).stream({ messages: [{ role: "user", content: "x" }], tools: [] }, { signal: controller.signal })[Symbol.asyncIterator]();
    const first = await it.next();
    assert.equal((first.value as any).text, "thinking… ");
    const reason = new Error("Stop pressed");
    controller.abort(reason);
    await assert.rejects(it.next(), /Stop pressed/);
    await s.hangAborted; // the fake saw the socket close
  });

  it("connection refused is MODEL_UNAVAILABLE (retryable)", async () => {
    const p = provider("http://127.0.0.1:1/v1");
    await assert.rejects(collect(p), (err: any) => err instanceof ProviderError && err.code === "MODEL_UNAVAILABLE" && err.retryable);
  });
});

describe("openai-compatible provider through config + boot", () => {
  it("createProvider builds it from WINDOWS_RUNNER_MODEL_* and the banner never shows the key", async () => {
    const s = await fake([{ kind: "text", text: "from the real boot path", usage: true }]);
    const config = loadServerConfig(
      {
        HOST: "127.0.0.1",
        PORT: "0",
        WINDOWS_RUNNER_PROVIDER: "openai-compatible",
        WINDOWS_RUNNER_MODEL_BASE_URL: s.url,
        WINDOWS_RUNNER_MODEL: "fake-model",
        WINDOWS_RUNNER_MODEL_API_KEY: KEY,
        WINDOWS_RUNNER_AUTH_TOKEN: "boot-token-0123456789abcdef",
        WINDOWS_RUNNER_ALLOWED_ROOTS: os.tmpdir(),
        // Isolated data dir: the env provider is bootstrapped into the profile
        // store on first boot, and a shared store would leak this test's
        // (now-closed) fake endpoint into other tests' boots.
        WINDOWS_RUNNER_DATA_DIR: await fs.mkdtemp(path.join(os.tmpdir(), "wr-oa-")),
      },
      { homedir: os.tmpdir() }
    );
    assert.equal(config.model.model, "fake-model");
    const p = createProvider(config.provider, config.model) as OpenAICompatibleProvider;
    assert.deepEqual(p.describe(), { baseUrl: s.url, model: "fake-model", hasApiKey: true }, "describe() passes through the retry wrapper");

    const h = await startServer(config);
    started.push(h);
    const auth = { authorization: "Bearer boot-token-0123456789abcdef", "content-type": "application/json" };
    const created = await fetch(`${h.url}/api/sessions/oa/turns`, { method: "POST", headers: auth, body: JSON.stringify({ cwd: os.tmpdir(), message: "hi" }) });
    assert.equal(created.status, 202);
    const { turnId } = await created.json();
    const events = await (await fetch(`${h.url}/api/sessions/oa/turns/${turnId}/events`, { headers: auth })).text();
    const streamedText = [...events.matchAll(/"type":"text_delta","delta":"([^"]*)"/g)].map((m) => m[1]).join("");
    assert.match(streamedText, /from the real boot path/);
    assert.match(events, /turn_completed/);
    assert.doesNotMatch(events, new RegExp(KEY));
    // The real boot path advertises the built-in tools to the model. This is a
    // deliberate chokepoint: adding a tool means editing this list, so a new
    // tool cannot start being advertised to every provider unnoticed.
    const names = s.requests[0].body.tools.map((t: any) => t.function.name).sort();
    assert.deepEqual(names, ["edit_file", "list_dir", "read_file", "read_skill", "run_terminal", "write_file"]);
    assert.equal(s.requests[0].body.messages[0].role, "system");
  });

  it("config refuses openai-compatible without a model and rejects bad base URLs", () => {
    assert.throws(() => loadServerConfig({ WINDOWS_RUNNER_PROVIDER: "openai-compatible" }, { homedir: os.tmpdir() }), /WINDOWS_RUNNER_MODEL is required/);
    assert.throws(() => loadServerConfig({ WINDOWS_RUNNER_MODEL_BASE_URL: "ftp://x" }, { homedir: os.tmpdir() }), /http or https/);
    assert.throws(() => loadServerConfig({ WINDOWS_RUNNER_MODEL_BASE_URL: "not a url" }, { homedir: os.tmpdir() }), /absolute http\(s\) URL/);
    const c = loadServerConfig({ OPENAI_API_KEY: "sk-fallback" }, { homedir: os.tmpdir() });
    assert.equal(c.model.apiKey, "sk-fallback");
    assert.equal(c.provider, "mock");
  });
});
