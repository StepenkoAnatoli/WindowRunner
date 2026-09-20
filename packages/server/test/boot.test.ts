/**
 * Server boot path (src/boot.ts, src/index.ts, src/providers/mock.ts).
 *
 * In-process tests drive `startServer()` on an ephemeral port with explicit
 * config objects, so nothing here depends on the environment or touches
 * ~/.windows-runner. The last block spawns the real executable entry through
 * tsx and checks the ready line and a clean SIGTERM exit — the same contract
 * scripts/smoke-start.mjs verifies against the compiled dist/ after a build.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, createRuntime, BindRefusedError, formatUrl, type StartedServer } from "../src/boot.js";
import { ConfigError, type ServerConfig } from "../src/config.js";
import { MockProvider } from "../src/providers/mock.js";
import { AVAILABLE_PROVIDERS, createProvider, UnknownProviderError } from "../src/providers/index.js";
import { FakeProvider, Steps } from "./fakes/fake-provider.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, "..");

const tmpDirs: string[] = [];
const started: StartedServer[] = [];

async function mkTmp(prefix = "wr-boot-"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

type ConfigOverrides = Omit<Partial<ServerConfig>, "persistence" | "auth"> & {
  persistence?: Partial<ServerConfig["persistence"]>;
  auth?: Partial<ServerConfig["auth"]>;
};

/** Every in-process server runs in the default token mode with this fixed token. */
export const TEST_TOKEN = "boot-test-token-0123456789abcdef";

function baseConfig(overrides: ConfigOverrides = {}): ServerConfig {
  const persistence = { mode: "memory" as const, dataDir: path.join(os.tmpdir(), "unused"), durableBeforeNotify: false, fsync: false };
  const auth = { mode: "token" as const, token: TEST_TOKEN, allowedHosts: [] as string[], allowedOrigins: [] as string[] };
  return {
    host: "127.0.0.1",
    port: 0,
    allowRemote: false,
    provider: "mock",
    allowedRoots: [os.tmpdir()],
    shutdownGraceMs: 2_000,
    ...overrides,
    persistence: { ...persistence, ...(overrides.persistence ?? {}) },
    auth: { ...auth, ...(overrides.auth ?? {}) },
  };
}

/** fetch with the test bearer token attached. */
function authed(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("authorization")) headers.set("authorization", `Bearer ${TEST_TOKEN}`);
  return fetch(url, { ...init, headers });
}

async function start(config: ServerConfig, overrides: Parameters<typeof startServer>[1] = {}): Promise<StartedServer> {
  const handle = await startServer(config, overrides);
  started.push(handle);
  return handle;
}

after(async () => {
  for (const handle of started) {
    try {
      await handle.close({ graceMs: 500 });
    } catch {}
  }
  for (const dir of tmpDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function postTurn(base: string, sessionId: string, cwd: string, message: string) {
  const res = await authed(`${base}/api/sessions/${sessionId}/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd, message }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

/** Read an SSE stream to EOF (the server ends it after the terminal event). */
async function readSseToEnd(url: string, timeoutMs = 5_000): Promise<any[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await authed(url, { signal: controller.signal });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text
      .split("\n\n")
      .map((block) => block.split("\n").find((line) => line.startsWith("data: ")))
      .filter((line): line is string => Boolean(line))
      .map((line) => JSON.parse(line.slice("data: ".length)));
  } finally {
    clearTimeout(timer);
  }
}

async function portIsFree(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("MockProvider", () => {
  it("streams a labelled reply that echoes the last user message, then usage", async () => {
    const provider = new MockProvider();
    const chunks: any[] = [];
    for await (const chunk of provider.stream(
      { messages: [{ role: "user", content: "first" }, { role: "assistant", content: "x" }, { role: "user", content: "  hello   world " }], tools: [] },
      { signal: new AbortController().signal }
    )) {
      chunks.push(chunk);
    }
    const text = chunks.filter((c) => c.type === "text_delta").map((c) => c.text).join("");
    assert.ok(chunks.filter((c) => c.type === "text_delta").length > 1, "streams more than one delta");
    assert.match(text, /^\[mock\] /);
    assert.match(text, /You said: "hello world"/, "whitespace is collapsed, latest user message echoed");
    const usage = chunks[chunks.length - 1];
    assert.equal(usage.type, "usage");
    assert.ok(usage.usage.totalTokens > 0);
  });

  it("stops at the abort signal", async () => {
    const controller = new AbortController();
    const provider = new MockProvider();
    const stream = provider.stream({ messages: [{ role: "user", content: "hi" }], tools: [] }, { signal: controller.signal })[Symbol.asyncIterator]();
    await stream.next();
    controller.abort(new Error("stop"));
    await assert.rejects(stream.next(), /stop/);
  });

  it("is the only registered provider; others are rejected with the available list", () => {
    assert.deepEqual([...AVAILABLE_PROVIDERS], ["mock"]);
    assert.ok(createProvider("mock") instanceof MockProvider);
    assert.throws(() => createProvider("openai"), (err: unknown) => err instanceof UnknownProviderError && /available: mock/.test(err.message));
  });
});

describe("startServer — memory mode", () => {
  it("listens on an ephemeral port, serves /healthz and /api/health, and releases the port on close", async () => {
    const handle = await start(baseConfig());
    assert.ok(handle.port > 0);
    assert.equal(handle.url, `http://127.0.0.1:${handle.port}`);
    assert.equal(handle.boot.persistenceMode, "memory");

    const live = await authed(`${handle.url}/healthz`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: "ok" });

    const health = (await authed(`${handle.url}/api/health`).then((r) => r.json())) as any;
    assert.equal(health.status, "ok");
    assert.equal(health.persistence.mode, "memory");
    assert.equal(health.diagnostics.boot.persistenceMode, "memory");
    assert.equal(health.diagnostics.boot.turns.turnsLoaded, 0);

    const result = await handle.close();
    assert.deepEqual(result, { abortedTurns: 0, forced: false });
    assert.equal(handle.app._validationTimer(), undefined, "validation timer cleared");
    assert.equal(await portIsFree(handle.port), true, "port released");
    await assert.rejects(authed(`${handle.url}/healthz`), "server no longer accepts connections");
  });

  it("close() is idempotent", async () => {
    const handle = await start(baseConfig());
    const first = handle.close();
    const second = handle.close();
    assert.equal(first, second, "same in-flight promise");
    await first;
    await handle.close();
  });

  it("runs a whole turn through the mock provider and ends the SSE stream at turn_completed", async () => {
    const project = await mkTmp("wr-boot-project-");
    const handle = await start(baseConfig({ allowedRoots: [project] }));

    const { status, body } = await postTurn(handle.url, "s1", project, "ping");
    assert.equal(status, 202);
    const events = await readSseToEnd(`${handle.url}/api/sessions/s1/turns/${body.turnId}/events`);
    assert.deepEqual(events.map((e) => e.type), ["turn_started", "text_delta", "turn_completed"]);
    assert.match(events[1].delta, /^\[mock\] .*You said: "ping"/);
    assert.equal(events[0].root, project);
  });

  it("enforces allowedRoots from the config", async () => {
    const project = await mkTmp("wr-boot-project-");
    const elsewhere = await mkTmp("wr-boot-elsewhere-");
    const handle = await start(baseConfig({ allowedRoots: [project] }));

    const refused = await postTurn(handle.url, "s2", elsewhere, "nope");
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, "PATH_ESCAPES_ROOT");

    const missing = await postTurn(handle.url, "s3", path.join(project, "does-not-exist"), "nope");
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, "PATH_NOT_FOUND");
  });

  it("uses no tools in this checkout and exposes that in the runtime", async () => {
    const handle = await start(baseConfig());
    assert.equal(handle.tools.size, 0);
    assert.ok(handle.provider instanceof MockProvider);
  });
});

describe("startServer — refusals", () => {
  it("refuses a non-loopback bind unless allowRemote is set", async () => {
    await assert.rejects(
      startServer(baseConfig({ host: "0.0.0.0" })),
      (err: unknown) => err instanceof BindRefusedError && err instanceof ConfigError && /WINDOWS_RUNNER_ALLOW_REMOTE=1/.test(err.message)
    );
    const handle = await start(baseConfig({ host: "0.0.0.0", allowRemote: true }));
    assert.equal(handle.host, "0.0.0.0");
    assert.equal(handle.url, `http://0.0.0.0:${handle.port}`);
  });

  it("refuses a non-loopback bind with auth off even when allowRemote is set", async () => {
    await assert.rejects(
      startServer(baseConfig({ host: "0.0.0.0", allowRemote: true, auth: { mode: "off", token: undefined } })),
      (err: unknown) => err instanceof BindRefusedError && /WINDOWS_RUNNER_AUTH=off/.test(err.message)
    );
  });

  it("rejects an unknown provider as a ConfigError naming WINDOWS_RUNNER_PROVIDER", async () => {
    await assert.rejects(
      startServer(baseConfig({ provider: "anthropic" })),
      (err: unknown) => err instanceof ConfigError && err.variable === "WINDOWS_RUNNER_PROVIDER" && /available: mock/.test(err.message)
    );
  });

  it("reports a busy port as a ConfigError naming PORT", async () => {
    const first = await start(baseConfig());
    await assert.rejects(
      startServer(baseConfig({ port: first.port })),
      (err: unknown) => err instanceof ConfigError && err.variable === "PORT" && /already in use/.test(err.message)
    );
  });

  it("reports an unusable data dir as a ConfigError naming WINDOWS_RUNNER_DATA_DIR", async () => {
    const dir = await mkTmp();
    const notADir = path.join(dir, "file");
    await fs.writeFile(notADir, "x");
    await assert.rejects(
      startServer(baseConfig({ persistence: { mode: "file", dataDir: path.join(notADir, "data"), durableBeforeNotify: true } })),
      (err: unknown) => err instanceof ConfigError && err.variable === "WINDOWS_RUNNER_DATA_DIR"
    );
  });

  it("formats IPv6 hosts with brackets", () => {
    assert.equal(formatUrl("::1", 80), "http://[::1]:80");
    assert.equal(formatUrl("127.0.0.1", 7634), "http://127.0.0.1:7634");
  });
});

describe("startServer — file mode", () => {
  it("creates the data dir, persists turns durably, and recovers them on the next boot", async () => {
    const dataDir = path.join(await mkTmp(), "nested", "data");
    const project = await mkTmp("wr-boot-project-");
    const config = baseConfig({ allowedRoots: [project], persistence: { mode: "file", dataDir, durableBeforeNotify: true } });

    const first = await start(config);
    assert.equal(first.boot.dataDir, dataDir);
    const { body } = await postTurn(first.url, "sess", project, "persist me");
    const events = await readSseToEnd(`${first.url}/api/sessions/sess/turns/${body.turnId}/events`);
    assert.equal(events[events.length - 1].type, "turn_completed");

    const turnFile = path.join(dataDir, "sessions", "sess", "turns", `${body.turnId}.jsonl`);
    const lines = (await fs.readFile(turnFile, "utf8")).split("\n").filter(Boolean);
    assert.equal(lines.length, events.length);
    await first.close();

    const second = await start(config);
    assert.equal(second.boot.turns.turnsLoaded, 1);
    assert.equal(second.boot.turns.turnsWithRestart, 0, "terminal turn gets no RESTART");
    assert.equal(second.boot.sessions?.sessionsLoaded, 1);
    const replay = await readSseToEnd(`${second.url}/api/sessions/sess/turns/${body.turnId}/events`);
    assert.deepEqual(replay.map((e) => e.seq), events.map((e) => e.seq));

    const health = (await authed(`${second.url}/api/health`).then((r) => r.json())) as any;
    assert.equal(health.persistence.mode, "file");
    assert.equal(health.persistence.dataDir, dataDir);
    assert.equal(health.diagnostics.boot.turns.turnsLoaded, 1);
    assert.equal(health.diagnostics.boot.sessions.sessionsLoaded, 1);
  });

  it("marks a non-terminal persisted turn RESTART and skips sessions outside the current allowed roots", async () => {
    const dataDir = await mkTmp();
    const project = await mkTmp("wr-boot-project-");
    const outside = await mkTmp("wr-boot-outside-");
    const now = Date.now();

    const seedSession = async (sessionId: string, root: string, turnId: string, activeTurnId: string | null) => {
      const dir = path.join(dataDir, "sessions", sessionId);
      await fs.mkdir(path.join(dir, "turns"), { recursive: true });
      await fs.writeFile(
        path.join(dir, "meta.json"),
        JSON.stringify({ version: 1, sessionId, canonicalRoot: root, realRoot: root, createdAt: now, lastActivityAt: now, activeTurnId })
      );
      const startedEvent = {
        seq: 1,
        at: now,
        sessionId,
        turnId,
        type: "turn_started",
        limits: { maxSteps: 10, modelCallTimeoutMs: 1000, toolTimeoutMs: 1000, approvalTimeoutMs: 1000 },
        message: "interrupted",
        root,
        realRoot: root,
      };
      await fs.writeFile(path.join(dir, "turns", `${turnId}.jsonl`), JSON.stringify(startedEvent) + "\n");
    };
    await seedSession("inside", project, "t_inside", "t_inside");
    await seedSession("outside", outside, "t_outside", null);

    const logged: string[] = [];
    const handle = await start(
      baseConfig({ allowedRoots: [project], persistence: { mode: "file", dataDir, durableBeforeNotify: true } }),
      { log: (line) => logged.push(line) }
    );

    assert.equal(handle.boot.turns.turnsLoaded, 2, "turn logs load regardless of session validity");
    assert.equal(handle.boot.turns.turnsWithRestart, 2);
    assert.equal(handle.boot.sessions?.sessionsLoaded, 1);
    assert.equal(handle.boot.sessions?.sessionsSkipped, 1);
    assert.equal(handle.boot.sessions?.sessionsWithClearedActiveTurn, 1);
    assert.deepEqual(handle.boot.sessions?.skippedSessions.map((s) => s.sessionId), ["outside"]);
    assert.ok(logged.some((line) => /skipping session/.test(line)), "boot warnings are logged");

    const replay = await readSseToEnd(`${handle.url}/api/sessions/inside/turns/t_inside/events`);
    assert.deepEqual(replay.map((e) => e.type), ["turn_started", "turn_failed"]);
    assert.equal(replay[1].code, "RESTART");
    assert.equal(replay[1].seq, 2);

    // Restart is idempotent: a third boot appends no second RESTART.
    await handle.close();
    const again = await start(baseConfig({ allowedRoots: [project], persistence: { mode: "file", dataDir, durableBeforeNotify: true } }));
    assert.equal(again.boot.turns.turnsWithRestart, 0);
    const lines = (await fs.readFile(path.join(dataDir, "sessions", "inside", "turns", "t_inside.jsonl"), "utf8")).split("\n").filter(Boolean);
    assert.equal(lines.length, 2);

    // The skipped session's root is outside the allowed roots, so it cannot be resumed.
    const refused = await postTurn(again.url, "outside", outside, "resume?");
    assert.equal(refused.status, 403);
  });
});

describe("close() with in-flight work", () => {
  it("aborts a running turn, records turn_cancelled, and returns within the grace period", async () => {
    const project = await mkTmp("wr-boot-project-");
    const provider = new FakeProvider([Steps.hang()]);
    const handle = await start(baseConfig({ allowedRoots: [project] }), { provider });

    const { status, body } = await postTurn(handle.url, "s-hang", project, "hang");
    assert.equal(status, 202);
    await waitFor(() => provider.requests.length === 1);
    assert.equal(handle.manager.getActiveTurnCount(), 1);

    const startedAt = Date.now();
    const result = await handle.close({ graceMs: 3_000, reason: "test shutdown" });
    assert.equal(result.abortedTurns, 1);
    assert.equal(result.forced, false, "the turn settled, nothing had to be forced");
    assert.ok(Date.now() - startedAt < 3_000);

    const log = handle.manager.getLog(body.turnId)!;
    assert.equal(log.state.status, "cancelled");
    assert.equal(log.state.isTerminal, true);
    assert.equal(handle.manager.getActiveTurnCount(), 0);
    assert.equal(handle.approvals.getPendingCount ? handle.approvals.getPendingCount() : 0, 0);
  });

  it("forces lingering connections closed when the grace period expires", async () => {
    const project = await mkTmp("wr-boot-project-");
    const provider = new FakeProvider([Steps.hang()]);
    const handle = await start(baseConfig({ allowedRoots: [project] }), { provider });
    const { body } = await postTurn(handle.url, "s-sse", project, "hang");
    await waitFor(() => provider.requests.length === 1);

    // Hold an SSE stream open; it only ends when the turn becomes terminal.
    const controller = new AbortController();
    const sse = await authed(`${handle.url}/api/sessions/s-sse/turns/${body.turnId}/events`, { signal: controller.signal });
    const reader = sse.body!.getReader();
    await reader.read(); // turn_started replay

    // Zero grace: the turn is aborted but close() does not wait for the socket.
    const result = await handle.close({ graceMs: 0 });
    assert.equal(result.abortedTurns, 1);
    assert.equal(result.forced, true);
    await assert.rejects(authed(`${handle.url}/healthz`));
    controller.abort();
  });

  it("createRuntime alone composes an app without binding a port", async () => {
    const runtime = await createRuntime(baseConfig());
    try {
      assert.equal(typeof runtime.app.abortActiveTurns, "function");
      assert.equal(runtime.app.abortActiveTurns(), 0);
      assert.equal(runtime.manager.getActiveTurnCount(), 0);
    } finally {
      runtime.app.close();
    }
  });
});

describe("src/index.ts executable", () => {
  const require = createRequire(import.meta.url);
  const tsxCli = require.resolve("tsx/cli");
  const entry = path.join(serverRoot, "src", "index.ts");

  function cleanEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key === "HOST" || key === "PORT" || key.startsWith("WINDOWS_RUNNER_")) continue;
      env[key] = value;
    }
    return { ...env, ...overrides };
  }

  function run(overrides: Record<string, string>) {
    const child = spawn(process.execPath, [tsxCli, entry], { cwd: serverRoot, env: cleanEnv(overrides), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });
    const ready = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ready line within 20s\n${stdout}\n${stderr}`)), 20_000);
      const check = () => {
        const match = /^windows-runner listening on (http:\/\/\S+)$/m.exec(stdout);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      };
      child.stdout.on("data", check);
      exited.then(({ code }) => {
        clearTimeout(timer);
        reject(new Error(`exited early with ${code}\n${stdout}\n${stderr}`));
      });
    });
    ready.catch(() => {});
    return { child, exited, ready, output: () => ({ stdout, stderr }) };
  }

  it("prints the banner and ready line, serves /healthz, and exits 0 on SIGTERM", { skip: process.platform === "win32" ? "no SIGTERM on Windows" : false }, async () => {
    const home = await mkTmp("wr-boot-home-");
    const proc = run({ PORT: "0", WINDOWS_RUNNER_HOME: home, WINDOWS_RUNNER_SHUTDOWN_GRACE_MS: "2000" });
    try {
      const url = await proc.ready;
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
      const res = await fetch(`${url}/healthz`);
      assert.equal(res.status, 200);
      const { stdout } = proc.output();
      // Memory mode with no WINDOWS_RUNNER_AUTH_TOKEN: the generated token is
      // printed once, and it is the only thing that opens /api.
      const tokenMatch = /^ {2}token: +(\S+)$/m.exec(stdout);
      assert.ok(tokenMatch, `banner prints the generated token:\n${stdout}`);
      assert.equal((await fetch(`${url}/api/health`)).status, 401);
      assert.equal((await fetch(`${url}/api/health`, { headers: { authorization: `Bearer ${tokenMatch![1]}` } })).status, 200);
      assert.match(stdout, /auth: +bearer token/);
      assert.match(stdout, /provider: +mock \(offline/);
      assert.match(stdout, /persistence: +memory/);
      assert.match(stdout, new RegExp(`roots: +${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.match(stdout, /tools: +none registered/);
    } finally {
      proc.child.kill("SIGTERM");
    }
    const { code, signal } = await proc.exited;
    assert.equal(signal, null);
    assert.equal(code, 0);
    assert.match(proc.output().stdout, /received SIGTERM, shutting down/);
    assert.match(proc.output().stdout, /windows-runner: stopped/);
  });

  it("exits 1 with a message naming the variable on a configuration error", async () => {
    const proc = run({ PORT: "not-a-port" });
    const { code } = await proc.exited;
    assert.equal(code, 1);
    assert.match(proc.output().stderr, /configuration error \(PORT\): PORT must be an integer/);
  });
});
