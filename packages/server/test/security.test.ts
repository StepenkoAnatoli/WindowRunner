/**
 * Security boundary (src/security.ts, src/agent/project-trust.ts, wiring in
 * src/app.ts and src/boot.ts) — RELEASE_CHECKLIST.md P0-01 / P0-02 / P0-04.
 *
 * Runs the real app over HTTP on an ephemeral loopback port so the checks see
 * genuine Host/Origin/Authorization headers, not synthesized request objects.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createApp } from "../src/app.js";
import { createSecurityPolicy, generateAuthToken, hostWithoutPort } from "../src/security.js";
import { ProjectTrustRegistry, computeConfigHash } from "../src/agent/project-trust.js";
import { TurnManager } from "../src/agent/turn-manager.js";
import { InMemoryTurnLogStore } from "../src/agent/turn-log-store.js";
import { ApprovalRegistry } from "../src/agent/approval-registry.js";
import { SessionManager } from "../src/agent/session-manager.js";
import { MetricsRegistry } from "../src/agent/metrics.js";
import { startServer, type StartedServer } from "../src/boot.js";
import { loadServerConfig, type ServerConfig } from "../src/config.js";
import { FakeProvider, Steps } from "./fakes/fake-provider.js";
import type { ToolDefinition } from "../src/agent/tools/types.js";
import { removeTempPath } from "../../../scripts/temp-path.mjs";

const TOKEN = "unit-test-token-0123456789abcdef";

const servers: Server[] = [];
const started: StartedServer[] = [];
const tmpDirs: string[] = [];

after(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  for (const h of started) await h.close({ graceMs: 500 }).catch(() => {});
  for (const d of tmpDirs) await removeTempPath(d);
});

async function mkTmp(prefix = "wr-sec-"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

interface Harness {
  base: string;
  metrics: MetricsRegistry;
  trust: ProjectTrustRegistry;
  provider: FakeProvider;
  approvals: ApprovalRegistry;
  manager: TurnManager;
}

async function listen(opts: {
  mode?: "token" | "off";
  allowedOrigins?: string[];
  allowedHosts?: string[];
  tools?: Map<string, ToolDefinition>;
  provider?: FakeProvider;
  allowedRoots?: string[];
  trust?: ProjectTrustRegistry;
} = {}): Promise<Harness> {
  const manager = new TurnManager({ store: new InMemoryTurnLogStore() });
  const approvals = new ApprovalRegistry();
  const metrics = new MetricsRegistry();
  const trust = opts.trust ?? new ProjectTrustRegistry();
  const provider = opts.provider ?? new FakeProvider([Steps.text("hi")]);
  const sessionManager = new SessionManager({ isTurnTerminal: (id) => manager.getLog(id)?.state.isTerminal ?? true });
  const app = createApp({
    manager,
    provider,
    tools: opts.tools ?? new Map(),
    approvals,
    sessionManager,
    metrics,
    trust,
    allowedRoots: opts.allowedRoots,
    validationIntervalMs: 0,
    security: {
      mode: opts.mode ?? "token",
      token: TOKEN,
      bindHost: "127.0.0.1",
      allowedHosts: opts.allowedHosts,
      allowedOrigins: opts.allowedOrigins,
    },
  });
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as any;
  return { base: `http://127.0.0.1:${port}`, metrics, trust, provider, approvals, manager };
}

/** Raw request: undici's fetch refuses to send a custom Host header, so Host tests go through node:http. */
function rawRequest(base: string, route: string, headers: Record<string, string>, method = "GET"): Promise<{ status: number; body: any }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: url.hostname, port: url.port, path: route, method, headers, setHost: false }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let body: any = data;
        try { body = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

const bearer = (token = TOKEN) => ({ authorization: `Bearer ${token}` });
const json = (body: unknown, extra: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...extra },
  body: JSON.stringify(body),
});

async function readSseToEnd(url: string, headers: Record<string, string>): Promise<any[]> {
  const res = await fetch(url, { headers });
  assert.equal(res.status, 200);
  const text = await res.text();
  return text
    .split("\n\n")
    .map((b) => b.split("\n").find((l) => l.startsWith("data: ")))
    .filter((l): l is string => Boolean(l))
    .map((l) => JSON.parse(l.slice(6)));
}

// ---------------------------------------------------------------------------

describe("security policy — unit", () => {
  it("generateAuthToken yields distinct 43-char base64url tokens", () => {
    const a = generateAuthToken();
    const b = generateAuthToken();
    assert.notEqual(a, b);
    assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  });

  it("hostWithoutPort handles IPv4, names, bracketed and bare IPv6", () => {
    assert.equal(hostWithoutPort("127.0.0.1:7634"), "127.0.0.1");
    assert.equal(hostWithoutPort("LocalHost"), "localhost");
    assert.equal(hostWithoutPort("[::1]:7634"), "::1");
    assert.equal(hostWithoutPort("::1"), "::1");
    assert.equal(hostWithoutPort("example.com:80"), "example.com");
  });

  it("token mode without a token is a programming error", () => {
    assert.throws(() => createSecurityPolicy({ mode: "token" }), /requires a token/);
  });

  it("host allowlist: loopback names, the bind host and configured hosts; nothing else", () => {
    const p = createSecurityPolicy({ mode: "off", bindHost: "192.168.1.5", allowedHosts: ["Runner.Local"] });
    for (const ok of ["localhost", "localhost:1", "127.0.0.1:7634", "127.9.9.9", "[::1]:7634", "192.168.1.5:7634", "runner.local"]) {
      assert.equal(p.isHostAllowed(ok), true, ok);
    }
    for (const bad of [undefined, "", "evil.example", "localhost.evil.example", "127.0.0.1.evil", "0.0.0.0"]) {
      assert.equal(p.isHostAllowed(bad), false, String(bad));
    }
    // A wildcard bind is not a Host value anyone should send.
    const any = createSecurityPolicy({ mode: "off", bindHost: "0.0.0.0" });
    assert.equal(any.isHostAllowed("0.0.0.0"), false);
  });

  it("origin allowlist: empty means loopback origins only; explicit list is exact; null never", () => {
    const loop = createSecurityPolicy({ mode: "off" });
    assert.equal(loop.isOriginAllowed(undefined), true, "absent Origin is not a browser cross-site request");
    assert.equal(loop.isOriginAllowed("http://localhost:5173"), true);
    assert.equal(loop.isOriginAllowed("http://127.0.0.1"), true);
    assert.equal(loop.isOriginAllowed("http://[::1]:3000"), true);
    assert.equal(loop.isOriginAllowed("null"), false);
    assert.equal(loop.isOriginAllowed(""), false);
    assert.equal(loop.isOriginAllowed("http://evil.example"), false);
    assert.equal(loop.isOriginAllowed("file://"), false);

    const strict = createSecurityPolicy({ mode: "off", allowedOrigins: ["https://app.example"] });
    assert.equal(strict.isOriginAllowed("https://app.example"), true);
    assert.equal(strict.isOriginAllowed("HTTPS://APP.EXAMPLE"), true);
    assert.equal(strict.isOriginAllowed("http://localhost:5173"), false, "explicit list replaces the loopback default");
    assert.equal(strict.isOriginAllowed("https://app.example.evil"), false);
  });

  it("bearer check is exact and scheme-insensitive; auth off accepts anything", () => {
    const p = createSecurityPolicy({ mode: "token", token: TOKEN });
    assert.equal(p.isAuthorized(`Bearer ${TOKEN}`), true);
    assert.equal(p.isAuthorized(`bearer ${TOKEN}`), true);
    assert.equal(p.isAuthorized(`Bearer ${TOKEN}x`), false);
    assert.equal(p.isAuthorized(`Bearer ${TOKEN.slice(0, -1)}`), false);
    assert.equal(p.isAuthorized(`Basic ${TOKEN}`), false);
    assert.equal(p.isAuthorized(TOKEN), false);
    assert.equal(p.isAuthorized(undefined), false);
    assert.equal(createSecurityPolicy({ mode: "off" }).isAuthorized(undefined), true);
  });

  it("describe() never includes the token", () => {
    const p = createSecurityPolicy({ mode: "token", token: TOKEN, allowedHosts: ["a"], allowedOrigins: ["http://a"] });
    assert.equal(JSON.stringify(p.describe()).includes(TOKEN), false);
    assert.deepEqual(p.describe(), { mode: "token", allowedHosts: ["a"], allowedOrigins: ["http://a"] });
  });
});

// ---------------------------------------------------------------------------

describe("security boundary — HTTP", () => {
  it("every /api route requires a bearer token; /healthz does not", async () => {
    const { base, metrics } = await listen();
    const routes: Array<[string, string]> = [
      ["POST", "/api/sessions/s1"],
      ["DELETE", "/api/sessions/s1"],
      ["POST", "/api/sessions/s1/turns"],
      ["GET", "/api/sessions/s1/turns/t1/events"],
      ["POST", "/api/sessions/s1/turns/t1/cancel"],
      ["POST", "/api/sessions/s1/approve"],
      ["GET", "/api/sessions/s1/trust"],
      ["POST", "/api/sessions/s1/trust"],
      ["DELETE", "/api/sessions/s1/trust"],
      ["GET", "/api/health"],
      ["GET", "/api/metrics"],
      ["GET", "/api/diagnostics/persistence"],
    ];
    for (const [method, route] of routes) {
      const res = await fetch(base + route, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" });
      assert.equal(res.status, 401, `${method} ${route}`);
      assert.match(res.headers.get("www-authenticate") ?? "", /^Bearer realm="windows-runner"/);
      assert.deepEqual(await res.json(), { error: "Authorization: Bearer <token> required", code: "AUTH_REQUIRED" });
    }
    const live = await fetch(`${base}/healthz`);
    assert.equal(live.status, 200);

    const wrong = await fetch(`${base}/api/health`, { headers: bearer("definitely-not-the-token-0000000") });
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).code, "AUTH_INVALID");
    assert.match(wrong.headers.get("www-authenticate") ?? "", /error="invalid_token"/);

    const ok = await fetch(`${base}/api/health`, { headers: bearer() });
    assert.equal(ok.status, 200);
    const health = await ok.json();
    assert.deepEqual(health.security, { mode: "token", allowedHosts: [], allowedOrigins: "loopback" });
    assert.equal(JSON.stringify(health).includes(TOKEN), false, "health never leaks the token");

    const snap = metrics.snapshot();
    assert.equal(snap.counters.securityRejections, routes.length + 1);
    assert.equal(snap.counters.securityRejectionsByKind.auth, routes.length + 1);
    assert.ok(snap.recent.incidents.every((i) => !JSON.stringify(i).includes("definitely-not")), "incidents carry no credential");
  });

  it("unauthenticated requests cannot start a turn, approve, or read a stream — state stays untouched", async () => {
    const project = await mkTmp();
    const { base, provider, manager } = await listen({ allowedRoots: [project] });
    const res = await fetch(`${base}/api/sessions/s1/turns`, json({ cwd: project, message: "hi" }));
    assert.equal(res.status, 401);
    assert.equal(provider.requests.length, 0, "provider was never called");
    assert.equal(manager.getActiveTurnCount(), 0);
  });

  it("Host header outside the allowlist is 403 HOST_NOT_ALLOWED even with a valid token (DNS rebinding)", async () => {
    const { base, metrics } = await listen();
    const res = await rawRequest(base, "/api/health", { ...bearer(), host: "attacker.example" });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "HOST_NOT_ALLOWED");
    const okName = await rawRequest(base, "/api/health", { ...bearer(), host: "localhost:1" });
    assert.equal(okName.status, 200);
    const v6 = await rawRequest(base, "/api/health", { ...bearer(), host: "[::1]:7634" });
    assert.equal(v6.status, 200);
    // Also enforced on the public liveness route, and a missing Host is refused.
    const live = await rawRequest(base, "/healthz", { host: "attacker.example" });
    assert.equal(live.status, 403);
    // Node's own parser already answers 400 to a request without Host (HTTP/1.1
    // requires it); either way it is refused and never reaches a route.
    const noHost = await rawRequest(base, "/healthz", {});
    assert.ok(noHost.status === 400 || noHost.status === 403, `status ${noHost.status}`);
    assert.equal(metrics.snapshot().counters.securityRejectionsByKind.host, 2);
  });

  it("WINDOWS_RUNNER_ALLOWED_HOSTS admits an extra name", async () => {
    const { base } = await listen({ allowedHosts: ["runner.internal"] });
    const res = await rawRequest(base, "/api/health", { ...bearer(), host: "runner.internal:7634" });
    assert.equal(res.status, 200);
    const other = await rawRequest(base, "/api/health", { ...bearer(), host: "runner.internal.evil" });
    assert.equal(other.status, 403);
  });

  it("Origin: loopback origins pass by default with CORS headers; foreign and null origins are refused before auth", async () => {
    const { base, metrics } = await listen();
    const good = await fetch(`${base}/api/health`, { headers: { ...bearer(), origin: "http://localhost:5173" } });
    assert.equal(good.status, 200);
    assert.equal(good.headers.get("access-control-allow-origin"), "http://localhost:5173");
    assert.equal(good.headers.get("vary"), "Origin");

    const evil = await fetch(`${base}/api/health`, { headers: { ...bearer(), origin: "http://evil.example" } });
    assert.equal(evil.status, 403);
    assert.equal((await evil.json()).code, "ORIGIN_NOT_ALLOWED");
    assert.equal(evil.headers.get("access-control-allow-origin"), null);

    const nul = await fetch(`${base}/api/health`, { headers: { ...bearer(), origin: "null" } });
    assert.equal(nul.status, 403);
    assert.equal((await nul.json()).error, 'Origin "null" is refused');

    // Without a token the origin check still happens first, and the answer
    // reveals nothing about the token.
    const evilNoAuth = await fetch(`${base}/api/health`, { headers: { origin: "http://evil.example" } });
    assert.equal(evilNoAuth.status, 403);
    assert.equal(metrics.snapshot().counters.securityRejectionsByKind.origin, 3);
  });

  it("explicit allowedOrigins replaces the loopback default (no wildcard)", async () => {
    const { base } = await listen({ allowedOrigins: ["https://app.example"] });
    assert.equal((await fetch(`${base}/api/health`, { headers: { ...bearer(), origin: "https://app.example" } })).status, 200);
    assert.equal((await fetch(`${base}/api/health`, { headers: { ...bearer(), origin: "http://localhost:5173" } })).status, 403);
  });

  it("CORS preflight is answered for allowed origins without a token, and refused for others", async () => {
    const { base } = await listen();
    const pre = await fetch(`${base}/api/sessions/s1/turns`, {
      method: "OPTIONS",
      headers: { origin: "http://127.0.0.1:5173", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" },
    });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "http://127.0.0.1:5173");
    assert.match(pre.headers.get("access-control-allow-headers") ?? "", /Authorization/);
    assert.match(pre.headers.get("access-control-allow-headers") ?? "", /Last-Event-ID/);
    assert.match(pre.headers.get("access-control-allow-methods") ?? "", /POST/);

    const bad = await fetch(`${base}/api/sessions/s1/turns`, { method: "OPTIONS", headers: { origin: "http://evil.example", "access-control-request-method": "POST" } });
    assert.equal(bad.status, 403);
  });

  it("auth off: no token needed, but Host and Origin are still enforced", async () => {
    const { base } = await listen({ mode: "off" });
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.equal((await rawRequest(base, "/api/health", { host: "attacker.example" })).status, 403);
    assert.equal((await fetch(`${base}/api/health`, { headers: { origin: "http://evil.example" } })).status, 403);
  });

  it("the whole authenticated lifecycle works: session, turn, SSE with Last-Event-ID, cancel, delete", async () => {
    const project = await mkTmp();
    const { base } = await listen({ allowedRoots: [project], provider: new FakeProvider([Steps.text("one"), Steps.hang()]) });
    const created = await fetch(`${base}/api/sessions/life`, json({ cwd: project }, bearer()));
    assert.equal(created.status, 201);

    const turn = await fetch(`${base}/api/sessions/life/turns`, json({ message: "go" }, bearer()));
    assert.equal(turn.status, 202);
    const { turnId } = await turn.json();

    const events = await readSseToEnd(`${base}/api/sessions/life/turns/${turnId}/events`, bearer());
    assert.equal(events[events.length - 1].type, "turn_completed");
    const resumed = await readSseToEnd(`${base}/api/sessions/life/turns/${turnId}/events`, { ...bearer(), "last-event-id": String(events[0].seq) });
    assert.deepEqual(resumed.map((e) => e.seq), events.slice(1).map((e) => e.seq));

    // Same request without the token is refused, and an SSE client gets JSON, not a stream.
    const noAuth = await fetch(`${base}/api/sessions/life/turns/${turnId}/events`);
    assert.equal(noAuth.status, 401);
    assert.match(noAuth.headers.get("content-type") ?? "", /application\/json/);

    // Cancelling a turn that already finished is an honest 409, not fake success.
    const cancelFinished = await fetch(`${base}/api/sessions/life/turns/${turnId}/cancel`, json({}, bearer()));
    assert.equal(cancelFinished.status, 409);
    assert.equal((await cancelFinished.json()).code, "TURN_NOT_ACTIVE");

    // Cancelling an in-flight turn is 202.
    const hanging = await fetch(`${base}/api/sessions/life/turns`, json({ message: "hang" }, bearer()));
    assert.equal(hanging.status, 202);
    const { turnId: hangId } = await hanging.json();
    const cancel = await fetch(`${base}/api/sessions/life/turns/${hangId}/cancel`, json({}, bearer()));
    assert.equal(cancel.status, 202);

    const del = await fetch(`${base}/api/sessions/life`, { method: "DELETE", headers: bearer() });
    assert.equal(del.status, 204);
  });
});

// ---------------------------------------------------------------------------

describe("input validation (P0-04)", () => {
  it("rejects malformed session and turn ids before touching any store", async () => {
    const { base } = await listen();
    const badSession = await fetch(`${base}/api/sessions/${encodeURIComponent("../etc")}`, json({ cwd: "/tmp" }, bearer()));
    assert.equal(badSession.status, 400);
    assert.equal((await badSession.json()).code, "SESSION_ID_INVALID");
    const badTurn = await fetch(`${base}/api/sessions/ok/turns/${encodeURIComponent("t 1")}/events`, { headers: bearer() });
    assert.equal(badTurn.status, 400);
    assert.equal((await badTurn.json()).code, "TURN_ID_INVALID");
    const longId = "a".repeat(129);
    assert.equal((await fetch(`${base}/api/sessions/${longId}/trust`, { headers: bearer() })).status, 400);
  });

  it("rejects non-object bodies, invalid JSON and oversized payloads", async () => {
    const { base } = await listen();
    const arr = await fetch(`${base}/api/sessions/s1/turns`, json([1, 2], bearer()));
    assert.equal(arr.status, 400);
    assert.equal((await arr.json()).code, "BODY_INVALID");

    const broken = await fetch(`${base}/api/sessions/s1/turns`, { method: "POST", headers: { ...bearer(), "content-type": "application/json" }, body: "{not json" });
    assert.equal(broken.status, 400);
    assert.equal((await broken.json()).code, "BODY_INVALID");

    const huge = await fetch(`${base}/api/sessions/s1/turns`, json({ message: "x".repeat(1_100_000) }, bearer()));
    assert.equal(huge.status, 413);
    assert.equal((await huge.json()).code, "BODY_TOO_LARGE");

    const longMessage = await fetch(`${base}/api/sessions/s1/turns`, json({ cwd: "/tmp", message: "x".repeat(200_001) }, bearer()));
    assert.equal(longMessage.status, 400);
    assert.equal((await longMessage.json()).code, "MESSAGE_TOO_LONG");
  });

  it("validates cwd type, null bytes and length", async () => {
    const { base } = await listen();
    for (const cwd of [42, "", "/tmp/a\u0000b", "/" + "x".repeat(5000)]) {
      const res = await fetch(`${base}/api/sessions/s1`, json({ cwd }, bearer()));
      assert.equal(res.status, 400, JSON.stringify(cwd).slice(0, 40));
      assert.equal((await res.json()).code, "CWD_REQUIRED");
    }
    const turnCwd = await fetch(`${base}/api/sessions/s1/turns`, json({ cwd: 42, message: "m" }, bearer()));
    assert.equal(turnCwd.status, 400);
    assert.equal((await turnCwd.json()).code, "CWD_INVALID");
  });

  it("rejects a non-numeric Last-Event-ID / afterSeq instead of silently replaying from 0", async () => {
    const project = await mkTmp();
    const { base } = await listen({ allowedRoots: [project] });
    const turn = await fetch(`${base}/api/sessions/c1/turns`, json({ cwd: project, message: "go" }, bearer()));
    const { turnId } = await turn.json();
    const bad = await fetch(`${base}/api/sessions/c1/turns/${turnId}/events`, { headers: { ...bearer(), "last-event-id": "abc" } });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, "CURSOR_INVALID");
    const neg = await fetch(`${base}/api/sessions/c1/turns/${turnId}/events?afterSeq=-1`, { headers: bearer() });
    assert.equal(neg.status, 400);
    const arrayQuery = await fetch(`${base}/api/sessions/c1/turns/${turnId}/events?afterSeq=1&afterSeq=2`, { headers: bearer() });
    assert.equal(arrayQuery.status, 400);
  });

  it("approve/cancel payloads are strictly typed and a turn cannot be cancelled through another session", async () => {
    const project = await mkTmp();
    const { base } = await listen({ allowedRoots: [project], provider: new FakeProvider([Steps.hang(), Steps.hang()]) });
    for (const body of [{ requestId: 1, decision: "approve" }, { requestId: "x", decision: "yes" }, { requestId: "x".repeat(300), decision: "approve" }]) {
      const res = await fetch(`${base}/api/sessions/s1/approve`, json(body, bearer()));
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, "APPROVAL_INVALID");
    }
    const turn = await fetch(`${base}/api/sessions/owner/turns`, json({ cwd: project, message: "go" }, bearer()));
    const { turnId } = await turn.json();
    const badReason = await fetch(`${base}/api/sessions/owner/turns/${turnId}/cancel`, json({ reason: 5 }, bearer()));
    assert.equal(badReason.status, 400);
    const wrongSession = await fetch(`${base}/api/sessions/other/turns/${turnId}/cancel`, json({}, bearer()));
    assert.equal(wrongSession.status, 404);
    assert.equal((await wrongSession.json()).code, "TURN_NOT_FOUND");
    const right = await fetch(`${base}/api/sessions/owner/turns/${turnId}/cancel`, json({ reason: "done" }, bearer()));
    assert.equal(right.status, 202);
  });
});

// ---------------------------------------------------------------------------

describe("project trust (P0-02)", () => {
  const mcpConfig = { command: "npx", args: ["-y", "some-mcp-server"], env: { FOO: "1" } };
  const configHash = computeConfigHash(mcpConfig);

  function mcpTool(): Map<string, ToolDefinition> {
    return new Map([
      [
        "mcp_call",
        {
          name: "mcp_call",
          description: "calls a project-configured MCP server",
          requiresApproval: () => false,
          trust: () => ({ configHash, source: ".mcp.json" }),
          execute: async () => "mcp ok",
        },
      ],
    ]);
  }

  it("computeConfigHash is stable across key order and sensitive to content", () => {
    assert.equal(computeConfigHash({ a: 1, b: [1, 2] }), computeConfigHash({ b: [1, 2], a: 1 }));
    assert.notEqual(computeConfigHash({ a: 1 }), computeConfigHash({ a: 2 }));
    assert.match(configHash, /^sha256:[0-9a-f]{64}$/);
  });

  it("registry: grants are keyed by real root and invalidated by a config change; malformed files are ignored", async () => {
    const dataDir = await mkTmp();
    const reg = new ProjectTrustRegistry({ dataDir, now: () => 1000 });
    assert.deepEqual(reg.check("/p", configHash), { trusted: false });
    await reg.grant({ realRoot: "/p", canonicalRoot: "/link-to-p", configHash, source: ".mcp.json" });
    assert.equal(reg.isTrusted("/p", configHash), true);
    assert.equal(reg.isTrusted("/p-other", configHash), false, "a different root shares nothing");
    const changed = reg.check("/p", computeConfigHash({ ...mcpConfig, args: ["evil"] }));
    assert.equal(changed.trusted, false);
    assert.equal(changed.staleGrant?.configHash, configHash);

    const file = JSON.parse(await fs.readFile(path.join(dataDir, "trust.json"), "utf8"));
    assert.equal(file.version, 1);
    assert.equal(file.grants[0].realRoot, "/p");
    if (process.platform !== "win32") {
      const mode = (await fs.stat(path.join(dataDir, "trust.json"))).mode & 0o777;
      assert.equal(mode, 0o600);
    }

    const reloaded = new ProjectTrustRegistry({ dataDir });
    assert.equal((await reloaded.boot()).loaded, 1);
    assert.equal(reloaded.isTrusted("/p", configHash), true);
    assert.equal(await reloaded.revoke("/p"), true);
    assert.equal(await reloaded.revoke("/p"), false);
    assert.equal((await new ProjectTrustRegistry({ dataDir }).boot()).loaded, 0);

    await fs.writeFile(path.join(dataDir, "trust.json"), "{garbage");
    const broken = new ProjectTrustRegistry({ dataDir });
    const boot = await broken.boot();
    assert.equal(boot.loaded, 0);
    assert.match(boot.warnings[0], /not valid JSON/);

    await fs.writeFile(path.join(dataDir, "trust.json"), JSON.stringify({ version: 1, grants: [{ realRoot: "relative", configHash, canonicalRoot: "x", grantedAt: 1 }, { realRoot: "/ok", configHash: "md5:abc", canonicalRoot: "x", grantedAt: 1 }] }));
    const partial = new ProjectTrustRegistry({ dataDir });
    assert.equal((await partial.boot()).loaded, 0);
  });

  it("the loop refuses a trust-declaring tool with PROJECT_NOT_TRUSTED until the project is trusted for that exact config", async () => {
    const project = await mkTmp();
    const provider = new FakeProvider([
      Steps.toolCall("c1", "mcp_call", {}), Steps.text("after refusal"),
      Steps.toolCall("c1", "mcp_call", {}), Steps.text("after grant"),
      Steps.toolCall("c1", "mcp_call", {}), Steps.text("after stale"),
    ]);
    const { base, trust } = await listen({ allowedRoots: [project], tools: mcpTool(), provider });

    // 1. Not trusted: tool_completed carries PROJECT_NOT_TRUSTED, tool never ran, turn still completes.
    let turn = await fetch(`${base}/api/sessions/tr/turns`, json({ cwd: project, message: "use mcp" }, bearer()));
    assert.equal(turn.status, 202);
    let events = await readSseToEnd(`${base}/api/sessions/tr/turns/${(await turn.json()).turnId}/events`, bearer());
    let completed = events.find((e) => e.type === "tool_completed");
    assert.equal(completed.result.ok, false);
    assert.equal(completed.result.code, "PROJECT_NOT_TRUSTED");
    assert.equal(completed.result.retryable, false);
    assert.match(completed.result.message, /POST \/api\/sessions\/tr\/trust/);
    assert.equal(events.some((e) => e.type === "tool_started"), false, "tool did not start");
    assert.equal(events.some((e) => e.type === "turn_waiting_for_approval"), false, "no approval is requested for an untrusted project");
    assert.equal(events[events.length - 1].type, "turn_completed");

    // 2. Inspect, then grant through the API (bound to the session's real root).
    const before = await fetch(`${base}/api/sessions/tr/trust`, { headers: bearer() }).then((r) => r.json());
    assert.equal(before.grant, null);
    assert.equal(before.realRoot, await fs.realpath(project));
    const badHash = await fetch(`${base}/api/sessions/tr/trust`, json({ configHash: "sha256:nothex" }, bearer()));
    assert.equal(badHash.status, 400);
    assert.equal((await badHash.json()).code, "CONFIG_HASH_INVALID");
    const granted = await fetch(`${base}/api/sessions/tr/trust`, json({ configHash, source: ".mcp.json" }, bearer()));
    assert.equal(granted.status, 201);
    assert.equal((await granted.json()).grant.realRoot, await fs.realpath(project));
    assert.equal(trust.isTrusted(await fs.realpath(project), configHash), true);

    turn = await fetch(`${base}/api/sessions/tr/turns`, json({ message: "use mcp" }, bearer()));
    events = await readSseToEnd(`${base}/api/sessions/tr/turns/${(await turn.json()).turnId}/events`, bearer());
    completed = events.find((e) => e.type === "tool_completed");
    assert.deepEqual(completed.result, { ok: true, output: "mcp ok" });

    // 3. Configuration changed: the old grant is stale and named in the refusal.
    await trust.grant({ realRoot: await fs.realpath(project), canonicalRoot: project, configHash: computeConfigHash({ other: true }) });
    turn = await fetch(`${base}/api/sessions/tr/turns`, json({ message: "use mcp" }, bearer()));
    events = await readSseToEnd(`${base}/api/sessions/tr/turns/${(await turn.json()).turnId}/events`, bearer());
    completed = events.find((e) => e.type === "tool_completed");
    assert.equal(completed.result.code, "PROJECT_NOT_TRUSTED");
    assert.match(completed.result.message, /different .mcp.json configuration/);

    // 4. Revoke.
    assert.equal((await fetch(`${base}/api/sessions/tr/trust`, { method: "DELETE", headers: bearer() })).status, 204);
    assert.equal((await fetch(`${base}/api/sessions/tr/trust`, { method: "DELETE", headers: bearer() })).status, 404);
    assert.equal((await fetch(`${base}/api/sessions/nope/trust`, { headers: bearer() })).status, 404);
  });

  it("an approval never substitutes for trust: trust is checked before the approval request is minted", async () => {
    const project = await mkTmp();
    const tools = mcpTool();
    const def = tools.get("mcp_call")!;
    def.requiresApproval = () => true;
    const provider = new FakeProvider([Steps.toolCall("c1", "mcp_call", {}), Steps.text("done")]);
    const { base, approvals } = await listen({ allowedRoots: [project], tools, provider });
    const turn = await fetch(`${base}/api/sessions/ap/turns`, json({ cwd: project, message: "go" }, bearer()));
    const events = await readSseToEnd(`${base}/api/sessions/ap/turns/${(await turn.json()).turnId}/events`, bearer());
    assert.equal(events.find((e) => e.type === "tool_completed").result.code, "PROJECT_NOT_TRUSTED");
    assert.equal(approvals.getPendingCount(), 0);
  });
});

// ---------------------------------------------------------------------------

describe("boot integration", () => {
  function cfg(overrides: Partial<Record<string, string>>): ServerConfig {
    const env: NodeJS.ProcessEnv = { HOST: "127.0.0.1", PORT: "0", ...overrides };
    return loadServerConfig(env, { homedir: os.tmpdir() });
  }
  async function start(config: ServerConfig): Promise<StartedServer> {
    const h = await startServer(config);
    started.push(h);
    return h;
  }

  it("memory mode generates a per-process token, exposes it on the runtime only, and enforces it", async () => {
    const h = await start(cfg({}));
    assert.ok(h.authToken && h.authToken.length >= 32);
    assert.equal(h.boot.auth.tokenSource, "generated");
    assert.equal(h.boot.auth.tokenFile, undefined);
    assert.equal((await fetch(`${h.url}/api/health`)).status, 401);
    const ok = await fetch(`${h.url}/api/health`, { headers: bearer(h.authToken!) });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(JSON.stringify(body).includes(h.authToken!), false);
    assert.equal(body.diagnostics.boot.auth.tokenSource, "generated");
  });

  it("file mode persists the token at <dataDir>/auth-token (0600) and reuses it across boots; trust.json is loaded", async () => {
    const dataDir = path.join(await mkTmp(), "data");
    const project = await mkTmp();
    const env = { WINDOWS_RUNNER_PERSISTENCE_MODE: "file", WINDOWS_RUNNER_DATA_DIR: dataDir, WINDOWS_RUNNER_ALLOWED_ROOTS: project };
    const first = await start(cfg(env));
    assert.equal(first.boot.auth.tokenSource, "generated");
    assert.equal(first.boot.auth.tokenFile, path.join(dataDir, "auth-token"));
    const onDisk = (await fs.readFile(path.join(dataDir, "auth-token"), "utf8")).trim();
    assert.equal(onDisk, first.authToken);
    if (process.platform !== "win32") assert.equal((await fs.stat(path.join(dataDir, "auth-token"))).mode & 0o777, 0o600);

    // Trust a project, then restart: token and grant both survive.
    const created = await fetch(`${first.url}/api/sessions/p/turns`, json({ cwd: project, message: "x" }, bearer(first.authToken!)));
    assert.equal(created.status, 202);
    const hash = computeConfigHash({ any: "thing" });
    assert.equal((await fetch(`${first.url}/api/sessions/p/trust`, json({ configHash: hash }, bearer(first.authToken!)))).status, 201);
    await first.close();

    const second = await start(cfg(env));
    assert.equal(second.boot.auth.tokenSource, "file");
    assert.equal(second.authToken, first.authToken);
    assert.equal(second.boot.trust?.loaded, 1);
    assert.equal(second.trust.isTrusted(await fs.realpath(project), hash), true);
    assert.equal((await fetch(`${second.url}/api/health`, { headers: bearer(first.authToken!) })).status, 200);
    await second.close();

    // A corrupt token file is a boot error naming the variable, not a silent fallback.
    await fs.writeFile(path.join(dataDir, "auth-token"), "short\n");
    await assert.rejects(startServer(cfg(env)), /auth-token does not contain a usable token/);
  });

  it("WINDOWS_RUNNER_AUTH_TOKEN wins over the file and is never printed by describeConfig", async () => {
    const dataDir = path.join(await mkTmp(), "data");
    const token = "env-supplied-token-abcdefghijklmnop";
    const h = await start(cfg({ WINDOWS_RUNNER_PERSISTENCE_MODE: "file", WINDOWS_RUNNER_DATA_DIR: dataDir, WINDOWS_RUNNER_AUTH_TOKEN: token }));
    assert.equal(h.boot.auth.tokenSource, "env");
    assert.equal(h.authToken, token);
    await assert.rejects(fs.stat(path.join(dataDir, "auth-token")), "no token file is created when the env supplies one");
    assert.equal((await fetch(`${h.url}/api/health`, { headers: bearer(token) })).status, 200);
  });

  it("WINDOWS_RUNNER_AUTH=off works on loopback and is refused at config time off loopback", async () => {
    const h = await start(cfg({ WINDOWS_RUNNER_AUTH: "off" }));
    assert.equal(h.authToken, undefined);
    assert.equal((await fetch(`${h.url}/api/health`)).status, 200);
    assert.throws(() => cfg({ WINDOWS_RUNNER_AUTH: "off", HOST: "0.0.0.0", WINDOWS_RUNNER_ALLOW_REMOTE: "1" }), /WINDOWS_RUNNER_AUTH=off is only permitted on a loopback HOST/);
  });

  it("auth off is refused for every non-loopback host representation, allowed for every loopback one", () => {
    const refused = ["0.0.0.0", "::", "[::]", "0:0:0:0:0:0:0:0", "::ffff:0.0.0.0", "::ffff:192.168.1.5", "192.168.1.5", "fe80::1", "2001:db8::1", "example.com"];
    for (const HOST of refused) {
      assert.throws(() => cfg({ HOST, WINDOWS_RUNNER_AUTH: "off", WINDOWS_RUNNER_ALLOW_REMOTE: "1" }), /only permitted on a loopback HOST/, HOST);
    }
    const allowed = ["127.0.0.1", "127.1.2.3", "LOCALHOST", "::1", "[::1]", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"];
    for (const HOST of allowed) {
      assert.equal(cfg({ HOST, WINDOWS_RUNNER_AUTH: "off" }).auth.mode, "off", HOST);
    }
  });

  it("the generated memory-mode token is never served by any endpoint", async () => {
    const h = await start(cfg({}));
    const token = h.authToken!;
    for (const route of ["/healthz", "/api/health", "/api/metrics", "/api/diagnostics/persistence"]) {
      const res = await fetch(`${h.url}${route}`, { headers: bearer(token) });
      const text = await res.text();
      assert.equal(text.includes(token), false, route);
    }
  });

  it("config parsing: token length, host/origin list shapes", () => {
    assert.throws(() => cfg({ WINDOWS_RUNNER_AUTH_TOKEN: "tooshort" }), /at least 16 characters/);
    assert.throws(() => cfg({ WINDOWS_RUNNER_AUTH_TOKEN: "has a space in it yes" }), /whitespace/);
    assert.throws(() => cfg({ WINDOWS_RUNNER_AUTH: "maybe" }), /must be "token" or "off"/);
    assert.throws(() => cfg({ WINDOWS_RUNNER_AUTH: "off", WINDOWS_RUNNER_AUTH_TOKEN: "abcdefghijklmnopqrstuvwxyz" }), /disables authentication/);
    assert.throws(() => cfg({ WINDOWS_RUNNER_ALLOWED_ORIGINS: "*" }), /explicit origins/);
    assert.throws(() => cfg({ WINDOWS_RUNNER_ALLOWED_ORIGINS: "null" }), /explicit origins/);
    assert.throws(() => cfg({ WINDOWS_RUNNER_ALLOWED_ORIGINS: "http://a/path" }), /bare http\(s\) origins/);
    assert.throws(() => cfg({ WINDOWS_RUNNER_ALLOWED_ORIGINS: "ftp://a" }), /bare http\(s\) origins/);
    assert.throws(() => cfg({ WINDOWS_RUNNER_ALLOWED_HOSTS: "*" }), /no wildcard/);
    assert.throws(() => cfg({ WINDOWS_RUNNER_ALLOWED_HOSTS: "http://a" }), /no wildcard, scheme or path/);
    const c = cfg({ WINDOWS_RUNNER_ALLOWED_ORIGINS: " HTTP://App.Example:8443 , http://localhost:5173,http://localhost:5173", WINDOWS_RUNNER_ALLOWED_HOSTS: "Runner.Local, runner.local" });
    assert.deepEqual(c.auth.allowedOrigins, ["http://app.example:8443", "http://localhost:5173"]);
    assert.deepEqual(c.auth.allowedHosts, ["runner.local"]);
    assert.equal(c.auth.mode, "token");
  });
});
