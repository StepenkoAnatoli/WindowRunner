/**
 * Provider dashboard backend routes (GET/POST/PATCH/DELETE /api/providers,
 * …/activate, …/test, GET /api/usage) plus the boot integration:
 * - 401 without / with a wrong bearer token on every provider route;
 * - 400 with a per-field error list on invalid profiles;
 * - 409 deleting the active profile (PROVIDER_ACTIVE);
 * - the raw apiKey never appears in any response (masked everywhere), while
 *   it IS stored in the 0600 profile file;
 * - activation is a real hot-swap: the turn started AFTER activate runs on
 *   the newly active profile (asserted via the usage record and the box);
 * - PATCH on the active profile hot-reloads (next turn hits the new baseUrl);
 * - the /test endpoint: ok + latency for a working profile, ProviderError
 *   code for an unreachable one, lastTest persisted on the profile;
 * - first boot registers the env provider as the "default" profile (0600
 *   file); a later boot honours the persisted active profile over the env.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "node:http";
import { createApp } from "../src/app.js";
import { TurnManager } from "../src/agent/turn-manager.js";
import { InMemoryTurnLogStore } from "../src/agent/turn-log-store.js";
import { ApprovalRegistry } from "../src/agent/approval-registry.js";
import { SessionManager } from "../src/agent/session-manager.js";
import { MockProvider } from "../src/providers/mock.js";
import { createProviderFromProfile } from "../src/providers/index.js";
import { ProviderStore, profilesFilePath, type ProviderProfile } from "../src/provider-profiles.js";
import { ActiveProviderBox, ProviderService } from "../src/provider-service.js";
import { UsageLog, type TurnUsageRecord } from "../src/usage-log.js";
import { startServer, type StartedServer } from "../src/boot.js";
import type { ServerConfig } from "../src/config.js";
import { startFakeOpenAI } from "./fakes/fake-openai-server.js";

const TOKEN = "test-token-0123456789abcdef";
const AUTH = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Concatenate the model's streamed text from a turn's SSE log. The fakes
 *  chunk replies into several text_delta events, so matching against the raw
 *  log would see JSON boundaries instead of the words. */
function streamText(events: string): string {
  return [...events.matchAll(/"type":"text_delta","delta":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).join("");
}

async function readSseUntil(url: string, pattern: RegExp, headers: Record<string, string>, timeoutMs = 8000): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const res = await fetch(url, { headers, signal: controller.signal });
  if (!res.body) throw new Error("no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (pattern.test(buffer)) break;
    }
  } finally {
    clearTimeout(timeout);
    try {
      await reader.cancel();
    } catch {}
  }
  return buffer;
}

describe("provider profile routes", () => {
  let base: string;
  let server: ReturnType<typeof createServer>;
  let dataDir: string;
  let store: ProviderStore;
  let box: ActiveProviderBox;
  let service: ProviderService;
  let usageLog: UsageLog;
  let app: any;

  const seeded: ProviderProfile = {
    id: "mock-a",
    label: "Mock A",
    kind: "mock",
    model: "mock",
    apiKey: "sk-secret-mock-a-1234",
    createdAt: 1,
    updatedAt: 1,
  };

  before(async () => {
    dataDir = await tmpDir("wr-prov-routes-");
    store = new ProviderStore({ dataDir });
    await store.load();
    store.data.profiles.push(seeded, {
      id: "mock-b",
      label: "Mock B",
      kind: "mock",
      model: "mock",
      createdAt: 1,
      updatedAt: 1,
    });
    store.data.activeProfileId = "mock-a";
    await store.persist();

    box = new ActiveProviderBox(new MockProvider(), "mock-a");
    service = new ProviderService({ store, active: box, build: (p) => createProviderFromProfile(p, { maxRetries: 0 }) });
    usageLog = new UsageLog({ dataDir });
    const manager = new TurnManager({ store: new InMemoryTurnLogStore() });
    const approvals = new ApprovalRegistry();
    const sessionManager = new SessionManager({
      isTurnTerminal: (turnId) => {
        const log = manager.getLog(turnId);
        return log ? log.state.isTerminal : true;
      },
    });
    app = createApp({
      manager,
      provider: box.get(),
      activeProvider: box,
      providerAdmin: service,
      usageLog,
      recordTurnUsage: (turnId, sessionId, result) => {
        const desc = service.describeActive();
        usageLog.append({
          at: Date.now(),
          providerId: desc?.id ?? "default",
          model: desc?.model ?? "unknown",
          turnId,
          sessionId,
          status: result.status,
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
        });
      },
      tools: new Map(),
      approvals,
      sessionManager,
      security: { mode: "token", token: TOKEN },
    });
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const req = async (method: string, path: string, body?: unknown, token: string | "none" = TOKEN) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token !== "none") headers.authorization = `Bearer ${token}`;
    const res = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    let json: any = undefined;
    const text = await res.text();
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {}
    return { status: res.status, json, text };
  };

  it("401 AUTH_REQUIRED without a token and AUTH_INVALID with a wrong one — on every provider route", async () => {
    const paths: Array<[string, string]> = [
      ["GET", "/api/providers"],
      ["POST", "/api/providers"],
      ["PATCH", "/api/providers/mock-a"],
      ["DELETE", "/api/providers/mock-a"],
      ["POST", "/api/providers/mock-a/activate"],
      ["POST", "/api/providers/mock-a/test"],
      ["GET", "/api/usage"],
    ];
    for (const [method, path] of paths) {
      const missing = await req(method, path, undefined, "none");
      assert.equal(missing.status, 401, `${method} ${path} without token`);
      assert.equal(missing.json.code, "AUTH_REQUIRED");
      const wrong = await req(method, path, undefined, "wrong-token-0123456789abcdef");
      assert.equal(wrong.status, 401, `${method} ${path} with wrong token`);
      assert.equal(wrong.json.code, "AUTH_INVALID");
    }
  });

  it("GET /api/providers lists profiles with the active flag and a masked key only", async () => {
    const { status, json, text } = await req("GET", "/api/providers");
    assert.equal(status, 200);
    assert.equal(json.activeProfileId, "mock-a");
    assert.equal(json.profiles.length, 2);
    const a = json.profiles.find((p: any) => p.id === "mock-a");
    assert.equal(a.active, true);
    assert.equal(json.profiles.find((p: any) => p.id === "mock-b").active, false);
    assert.equal(a.apiKeyMasked, "****1234");
    assert.ok(!("apiKey" in a), "apiKey must not be present in the response");
    assert.ok(!text.includes(seeded.apiKey!), "raw key must not appear anywhere in the response");
  });

  it("POST /api/providers creates (201) and stores the key in the 0600 file without echoing it", async () => {
    const { status, json, text } = await req("POST", "/api/providers", {
      id: "omniroute",
      label: "OmniRoute",
      kind: "openai-compatible",
      baseUrl: "https://omni.example/v1",
      model: "gpt-4o-mini",
      apiKey: "sk-omni-9999888877776666",
    });
    assert.equal(status, 201);
    assert.equal(json.id, "omniroute");
    assert.equal(json.apiKeyMasked, "****6666");
    assert.ok(!text.includes("sk-omni-9999888877776666"), "response must not contain the raw key");
    const file = await fs.readFile(profilesFilePath(dataDir), "utf8");
    assert.ok(file.includes("sk-omni-9999888877776666"), "key must be persisted at rest");
    // POSIX only: Windows ignores mode bits (ACLs instead).
    if (process.platform !== "win32") assert.equal((await fs.stat(profilesFilePath(dataDir))).mode & 0o777, 0o600);
  });

  it("POST /api/providers rejects invalid profiles with 400 and a per-field error list", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ id: "Bad Id", label: "x", kind: "mock", model: "mock" }, "id must be"],
      [{ id: "ok", label: "", kind: "mock", model: "mock" }, "label required"],
      [{ id: "ok", label: "x", kind: "mock", model: "" }, "model required"],
      [{ id: "ok", label: "x", kind: "gemini", model: "mock" }, "kind must be"],
      [{ id: "ok", label: "x", kind: "openai-compatible", model: "mock" }, "baseUrl required"],
      [{ id: "ok", label: "x", kind: "openai-compatible", baseUrl: "ftp://nope", model: "mock" }, "baseUrl must start with"],
      [{ id: "ok", label: "x", kind: "mock", model: "mock", apiKey: "x".repeat(513) }, "apiKey too long"],
    ];
    for (const [body, expected] of cases) {
      const { status, json } = await req("POST", "/api/providers", body);
      assert.equal(status, 400, JSON.stringify(body));
      assert.equal(json.code, "PROFILE_INVALID");
      assert.ok(Array.isArray(json.errors) && json.errors.length > 0, "errors list expected");
      assert.ok(json.errors.some((e: string) => e.startsWith(expected)), `expected an error starting with "${expected}" in ${JSON.stringify(json.errors)}`);
    }
    // Nothing was created by the invalid attempts.
    const list = await req("GET", "/api/providers");
    assert.ok(!list.json.profiles.some((p: any) => p.id === "ok"));
  });

  it("POST /api/providers refuses a duplicate id with 409 PROFILE_EXISTS", async () => {
    const { status, json } = await req("POST", "/api/providers", { id: "mock-a", label: "dup", kind: "mock", model: "mock" });
    assert.equal(status, 409);
    assert.equal(json.code, "PROFILE_EXISTS");
  });

  it("PATCH updates label/model/baseUrl; apiKey omitted keeps, null clears; unknown fields and kind changes are 400; unknown id is 404", async () => {
    // update model + label; keep the key
    let r = await req("PATCH", "/api/providers/omniroute", { label: "OmniRoute (prod)", model: "gpt-4o" });
    assert.equal(r.status, 200);
    assert.equal(r.json.label, "OmniRoute (prod)");
    assert.equal(r.json.model, "gpt-4o");
    assert.equal(r.json.apiKeyMasked, "****6666", "omitted apiKey keeps the existing key");

    r = await req("PATCH", "/api/providers/omniroute", { baseUrl: "https://omni2.example/v1", apiKey: null });
    assert.equal(r.status, 200);
    assert.equal(r.json.baseUrl, "https://omni2.example/v1");
    assert.equal(r.json.apiKeyMasked, undefined, "apiKey null clears the key");

    r = await req("PATCH", "/api/providers/omniroute", { kind: "anthropic" });
    assert.equal(r.status, 400);
    assert.match(r.json.errors[0], /immutable/);
    r = await req("PATCH", "/api/providers/omniroute", { baseUrl: "not-a-url" });
    assert.equal(r.status, 400);
    assert.match(r.json.errors[0], /baseUrl must start with/);
    r = await req("PATCH", "/api/providers/omniroute", { lastTest: { at: 1, ok: true } });
    assert.equal(r.status, 400);
    assert.match(r.json.errors[0], /only these fields can be updated/);

    r = await req("PATCH", "/api/providers/nope", { label: "x" });
    assert.equal(r.status, 404);
    assert.equal(r.json.code, "PROFILE_NOT_FOUND");
  });

  it("DELETE: unknown id 404; the active profile 409 PROVIDER_ACTIVE; an inactive one 204", async () => {
    let r = await req("DELETE", "/api/providers/nope");
    assert.equal(r.status, 404);
    r = await req("DELETE", "/api/providers/mock-a");
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "PROVIDER_ACTIVE");
    r = await req("DELETE", "/api/providers/omniroute");
    assert.equal(r.status, 204);
    const list = await req("GET", "/api/providers");
    assert.ok(!list.json.profiles.some((p: any) => p.id === "omniroute"));
  });

  it("activate: unknown id 404; 200 moves the active profile and persists it", async () => {
    let r = await req("POST", "/api/providers/nope/activate");
    assert.equal(r.status, 404);
    assert.equal(r.json.code, "PROFILE_NOT_FOUND");

    r = await req("POST", "/api/providers/mock-b/activate");
    assert.equal(r.status, 200);
    assert.equal(r.json.activeProfileId, "mock-b");
    assert.equal(r.json.profile.id, "mock-b");
    assert.ok(!r.text.includes("sk-secret"));

    const list = await req("GET", "/api/providers");
    assert.equal(list.json.activeProfileId, "mock-b");
    const file = JSON.parse(await fs.readFile(profilesFilePath(dataDir), "utf8"));
    assert.equal(file.activeProfileId, "mock-b", "the choice is persisted, not just in memory");
  });

  it("hot-swap: the turn started after activate runs on the newly active profile", async () => {
    // Deterministic starting point (an earlier test left mock-b active).
    await req("POST", "/api/providers/mock-a/activate");
    assert.equal(box.profileId, "mock-a");

    const createdA = await fetch(`${base}/api/sessions/hs/turns`, { method: "POST", headers: AUTH, body: JSON.stringify({ cwd: os.tmpdir(), message: "turn on a" }) });
    assert.equal(createdA.status, 202);
    const turnA = (await createdA.json()) as { turnId: string };
    const eventsA = await readSseUntil(`${base}/api/sessions/hs/turns/${turnA.turnId}/events`, /turn_completed|turn_failed|turn_cancelled/, AUTH);
    assert.match(eventsA, /turn_completed/);

    await req("POST", "/api/providers/mock-b/activate");
    assert.equal(box.profileId, "mock-b");

    const createdB = await fetch(`${base}/api/sessions/hs/turns`, { method: "POST", headers: AUTH, body: JSON.stringify({ cwd: os.tmpdir(), message: "turn on b" }) });
    const turnB = (await createdB.json()) as { turnId: string };
    const eventsB = await readSseUntil(`${base}/api/sessions/hs/turns/${turnB.turnId}/events`, /turn_completed|turn_failed|turn_cancelled/, AUTH);
    assert.match(eventsB, /turn_completed/);
    assert.equal(box.profileId, "mock-b");

    const { json } = await req("GET", "/api/usage?limit=50");
    const byTurn = new Map<string, TurnUsageRecord>(json.records.map((r: TurnUsageRecord) => [r.turnId, r] as const));
    const recA = byTurn.get(turnA.turnId);
    const recB = byTurn.get(turnB.turnId);
    assert.ok(recA, "turn A has a usage record");
    assert.ok(recB, "turn B has a usage record");
    assert.equal(recA.providerId, "mock-a");
    assert.equal(recB.providerId, "mock-b", "the post-activation turn ran on the new profile");
    assert.equal(recB.status, "completed");
  });

  it("GET /api/usage says how much history it retains and whether it is complete", async () => {
    const { status, json } = await req("GET", "/api/usage?limit=5");
    assert.equal(status, 200);
    assert.ok(Array.isArray(json.records));
    // `retained` counts the whole in-memory ring, so a paged response can
    // report "showing 5 of N"; `bounded` tells the client that older records
    // existed and are gone (ring trimmed, tail window, or a rotation).
    assert.equal(typeof json.retained, "number", "retained is reported");
    assert.ok(json.retained >= json.records.length, "retained covers every returned record");
    assert.equal(typeof json.bounded, "boolean", "bounded is reported");
    assert.equal(json.bounded, false, "a handful of turns has not been trimmed or rotated");
  });

  it("PATCH on the ACTIVE profile hot-reloads: the next turn hits the new baseUrl", async () => {
    const [fakeA, fakeB] = await Promise.all([
      startFakeOpenAI([{ kind: "text", text: "from A" }, { kind: "text", text: "from A again" }]),
      startFakeOpenAI([{ kind: "text", text: "from B" }]),
    ]);
    try {
      await req("POST", "/api/providers", { id: "oa-swap", label: "OA swap", kind: "openai-compatible", baseUrl: fakeA.url, model: "m" });
      await req("POST", "/api/providers/oa-swap/activate");

      const run = async (message: string) => {
        const created = await fetch(`${base}/api/sessions/hot/turns`, { method: "POST", headers: AUTH, body: JSON.stringify({ cwd: os.tmpdir(), message }) });
        const { turnId } = (await created.json()) as { turnId: string };
        const events = await readSseUntil(`${base}/api/sessions/hot/turns/${turnId}/events`, /turn_completed|turn_failed|turn_cancelled/, AUTH);
        return streamText(events);
      };

      assert.match(await run("one"), /from A/);
      assert.equal(fakeA.requests.length, 1);

      // Edit the ACTIVE profile: no restart, the next turn must hit B.
      const patch = await req("PATCH", "/api/providers/oa-swap", { baseUrl: fakeB.url });
      assert.equal(patch.status, 200);
      assert.match(await run("two"), /from B/);
      assert.equal(fakeB.requests.length, 1);
      assert.equal(fakeA.requests.length, 1, "the old endpoint is not called after the edit");
    } finally {
      await fakeA.close();
      await fakeB.close();
    }
  });

  it("test endpoint: mock profile ok with latency and reply; unreachable endpoint fails with the ProviderError code; lastTest is persisted", async () => {
    let r = await req("POST", "/api/providers/mock-a/test");
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(typeof r.json.latencyMs, "number");
    assert.match(r.json.reply, /^\[mock\]/);
    assert.ok(!r.text.includes("sk-secret"), "the reply body must not leak other profiles' keys");

    await req("POST", "/api/providers", { id: "dead", label: "Dead", kind: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", model: "m" });
    r = await req("POST", "/api/providers/dead/test");
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.code, "MODEL_UNAVAILABLE");
    assert.equal(typeof r.json.latencyMs, "number");

    r = await req("POST", "/api/providers/nope/test");
    assert.equal(r.status, 404);

    const list = await req("GET", "/api/providers");
    const a = list.json.profiles.find((p: any) => p.id === "mock-a");
    assert.equal(a.lastTest.ok, true);
    const dead = list.json.profiles.find((p: any) => p.id === "dead");
    assert.equal(dead.lastTest.ok, false);
    assert.equal(dead.lastTest.code, "MODEL_UNAVAILABLE");
  });

  it("GET /api/usage: newest first, limit respected, bad limit 400", async () => {
    const { status, json } = await req("GET", "/api/usage?limit=2");
    assert.equal(status, 200);
    assert.ok(json.records.length >= 1);
    assert.ok(json.records.length <= 2);
    for (let i = 1; i < json.records.length; i++) assert.ok(json.records[i - 1].at >= json.records[i].at, "newest first");
    assert.equal((await req("GET", "/api/usage?limit=0")).status, 400);
    assert.equal((await req("GET", "/api/usage?limit=x")).status, 400);
    assert.equal((await req("GET", "/api/usage?limit=501")).status, 400);
  });
});

describe("provider boot integration", () => {
  let servers: StartedServer[] = [];
  const auth = { authorization: "Bearer boot-token-0123456789abcdef", "content-type": "application/json" };
  after(async () => {
    for (const s of servers) await s.close();
    servers = [];
  });

  function configFor(dataDir: string): ServerConfig {
    return {
      host: "127.0.0.1",
      port: 0,
      allowRemote: false,
      auth: { mode: "token", token: "boot-token-0123456789abcdef", allowedHosts: [], allowedOrigins: [] },
      provider: "mock", // the environment says mock…
      model: { baseUrl: "https://api.openai.com/v1", maxRetries: 0, maxSteps: 10, callTimeoutMs: 30_000 },
      tools: { enabled: false, terminalTimeoutMs: 60_000, terminalOutputLimit: 65_536 },
      persistence: { mode: "file", dataDir, durableBeforeNotify: false, fsync: false },
      allowedRoots: [os.tmpdir()],
      shutdownGraceMs: 2000,
    };
  }

  it("first boot registers the env provider as the default profile (0600); a later boot honours the persisted active profile over the env", async () => {
    const dataDir = await tmpDir("wr-prov-boot-");
    const file = profilesFilePath(dataDir);

    // First boot: file does not exist yet.
    let h = await startServer(configFor(dataDir));
    servers.push(h);
    const stored: any = JSON.parse(await fs.readFile(file, "utf8"));
    // POSIX only: Windows ignores mode bits (ACLs instead).
    if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(stored.profiles.map((p: any) => p.id), ["default"]);
    assert.equal(stored.profiles[0].kind, "mock");
    assert.equal(stored.activeProfileId, "default");
    assert.equal(h.activeProvider.profileId, "default");
    await h.close();

    // Simulate a dashboard choice: an openai-compatible profile is created and
    // activated (the env still says mock).
    const fake = await startFakeOpenAI([{ kind: "text", text: "the persisted choice wins" }]);
    try {
      stored.profiles.push({ id: "oa", label: "OA", kind: "openai-compatible", baseUrl: fake.url, model: "m", createdAt: 1, updatedAt: 1 });
      stored.activeProfileId = "oa";
      await fs.writeFile(file, JSON.stringify(stored, null, 2), { mode: 0o600 });

      // Second boot: the persisted choice must win over WINDOWS_RUNNER_PROVIDER=mock.
      h = await startServer(configFor(dataDir));
      servers.push(h);
      assert.equal(h.activeProvider.profileId, "oa");
      const desc = h.providers.describeActive();
      assert.deepEqual(desc, { id: "oa", label: "OA", model: "m", kind: "openai-compatible" });

      const created = await fetch(`${h.url}/api/sessions/pb/turns`, { method: "POST", headers: auth, body: JSON.stringify({ cwd: os.tmpdir(), message: "hi" }) });
      assert.equal(created.status, 202);
      const { turnId } = (await created.json()) as { turnId: string };
      const events = await readSseUntil(`${h.url}/api/sessions/pb/turns/${turnId}/events`, /turn_completed|turn_failed|turn_cancelled/, auth);
      assert.match(events, /turn_completed/);
      assert.equal(streamText(events), "the persisted choice wins");
      assert.equal(fake.requests.length, 1, "the turn hit the openai-compatible profile, not the env mock");

      // And it is in the usage log with the profile id.
      const usage = await (await fetch(`${h.url}/api/usage`, { headers: auth })).json();
      assert.equal(usage.records[0].providerId, "oa");
      assert.equal(usage.records[0].status, "completed");
    } finally {
      await fake.close();
    }
  });

  it("a stored active profile that no longer exists falls back to default without breaking boot", async () => {
    const dataDir = await tmpDir("wr-prov-boot-fallback-");
    const file = profilesFilePath(dataDir);
    const h1 = await startServer(configFor(dataDir));
    servers.push(h1);
    await h1.close();
    const stored: any = JSON.parse(await fs.readFile(file, "utf8"));
    stored.activeProfileId = "deleted-forever";
    await fs.writeFile(file, JSON.stringify(stored, null, 2), { mode: 0o600 });

    const h2 = await startServer(configFor(dataDir));
    servers.push(h2);
    assert.equal(h2.activeProvider.profileId, "default");
    const again: any = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(again.activeProfileId, "default", "the fallback is persisted, not just in memory");
  });
});
