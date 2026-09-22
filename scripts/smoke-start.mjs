#!/usr/bin/env node
/**
 * windows-runner — startup smoke test for the built server.
 *
 * `npm test` exercises the boot path in-process from TypeScript sources. This
 * script exercises what a user actually runs: the compiled entry point,
 * `node packages/server/dist/index.cjs`, as a child process, from a clean
 * environment, in file-persistence mode against a temporary data directory.
 *
 * It asserts, in order:
 *   1. the process prints the ready line and serves /healthz and /api/health;
 *   2. a full turn runs end to end through the offline mock provider — POST
 *      turn, SSE stream to turn_completed, JSONL written to the data dir;
 *   3. a session outside the allowed roots is refused (403 PATH_ESCAPES_ROOT);
 *   4. SIGTERM produces a clean exit (code 0) within the grace period;
 *   5. a second boot on the same data dir recovers the persisted session/turn;
 *   6. a non-loopback bind without WINDOWS_RUNNER_ALLOW_REMOTE is refused (exit 1);
 *   7. the bearer token is enforced: /api without it is 401, with a wrong one
 *      401, and the token file the first boot created is what the second boot
 *      reused.
 *
 * Nothing here touches ~/.windows-runner or needs an API key or the network.
 * `npm run smoke:start` runs this; CI runs it after the build.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { removeTempPathSync } from "./temp-path.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(repoRoot, "packages", "server", "dist", "index.cjs");
const READY_RE = /^windows-runner listening on (http:\/\/\S+)$/m;
/** Fixed token for the smoke run: the API is authenticated by default. */
const TOKEN = "smoke-start-token-0123456789abcdef";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const READY_TIMEOUT_MS = 20_000;
const EXIT_TIMEOUT_MS = 10_000;
const IS_WINDOWS = process.platform === "win32";

class SmokeFailure extends Error {}

function assert(condition, message) {
  if (!condition) throw new SmokeFailure(message);
}

function step(message) {
  console.log(`  ✓ ${message}`);
}

/** Environment for the child: inherit PATH etc., but no inherited server settings. */
function childEnv(overrides) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "HOST" || key === "PORT" || key.startsWith("WINDOWS_RUNNER_")) continue;
    env[key] = value;
  }
  return { ...env, ...overrides };
}

function ensureBuilt() {
  const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "ensure-built.mjs")], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  return result.status === 0 && existsSync(ENTRY);
}

/** Spawn the built server and resolve with its URL once it prints the ready line. */
function startServer(env) {
  const child = spawn(process.execPath, [ENTRY], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  const output = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (output.stdout += chunk));
  child.stderr.on("data", (chunk) => (output.stderr += chunk));

  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new SmokeFailure(`server did not print the ready line within ${READY_TIMEOUT_MS}ms`));
    }, READY_TIMEOUT_MS);
    const check = () => {
      const match = READY_RE.exec(output.stdout);
      if (match) {
        clearTimeout(timer);
        child.stdout.off("data", check);
        resolve(match[1]);
      }
    };
    child.stdout.on("data", check);
    exited.then(({ code, signal }) => {
      clearTimeout(timer);
      reject(new SmokeFailure(`server exited before it was ready (code ${code}, signal ${signal})`));
    });
  });

  // A caller that only waits for exit (the refusal check) never awaits `ready`;
  // mark the rejection handled so it cannot surface as an unhandled rejection.
  ready.catch(() => {});

  return { child, output, exited, ready };
}

/** Wait for a spawned server to exit; resolve with {code, signal} or reject on timeout. */
function waitForExit(exited, timeoutMs) {
  return Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new SmokeFailure(`server did not exit within ${timeoutMs}ms`)), timeoutMs)),
  ]);
}

async function readSse(url, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: AUTH });
    assert(res.status === 200, `SSE ${url} returned ${res.status}`);
    assert((res.headers.get("content-type") ?? "").startsWith("text/event-stream"), "SSE content-type missing");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    // The server ends the stream after the terminal event, so read to EOF.
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function sseEvents(text) {
  return text
    .split("\n\n")
    .map((block) => block.split("\n").find((line) => line.startsWith("data: ")))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

async function probeHealth(base, expectations) {
  const live = await fetch(`${base}/healthz`);
  assert(live.status === 200, `/healthz returned ${live.status}`);
  const liveBody = await live.json();
  assert(liveBody.status === "ok", `/healthz body ${JSON.stringify(liveBody)}`);

  const health = await fetch(`${base}/api/health`, { headers: AUTH });
  assert(health.status === 200, `/api/health returned ${health.status}`);
  const body = await health.json();
  assert(body.status === "ok" || body.status === "degraded", `/api/health status ${body.status}`);
  assert(body.persistence?.mode === "file", `/api/health persistence.mode ${body.persistence?.mode}`);
  assert(body.persistence?.dataDir === expectations.dataDir, `/api/health dataDir ${body.persistence?.dataDir}`);
  const boot = body.diagnostics?.boot;
  assert(boot && typeof boot === "object", "/api/health has no boot diagnostics");
  assert(boot.turns?.turnsLoaded === expectations.turnsLoaded, `boot.turns.turnsLoaded=${boot.turns?.turnsLoaded}, expected ${expectations.turnsLoaded}`);
  assert(boot.sessions?.sessionsLoaded === expectations.sessionsLoaded, `boot.sessions.sessionsLoaded=${boot.sessions?.sessionsLoaded}, expected ${expectations.sessionsLoaded}`);
  return body;
}

async function stopGracefully(handle, label) {
  if (IS_WINDOWS) {
    // Windows has no SIGTERM; child.kill() is TerminateProcess, which is not
    // graceful, so only assert that the process goes away.
    handle.child.kill();
    await waitForExit(handle.exited, EXIT_TIMEOUT_MS);
    step(`${label}: terminated (Windows: graceful-exit code not asserted)`);
    return;
  }
  handle.child.kill("SIGTERM");
  const { code, signal } = await waitForExit(handle.exited, EXIT_TIMEOUT_MS);
  assert(code === 0 && signal === null, `expected clean exit on SIGTERM, got code ${code} signal ${signal}`);
  assert(/windows-runner: stopped/.test(handle.output.stdout), "shutdown did not log 'stopped'");
  step(`${label}: SIGTERM -> exit 0`);
}

async function main() {
  console.log("windows-runner startup smoke test");
  console.log(`  entry: ${path.relative(repoRoot, ENTRY)}`);

  if (!ensureBuilt()) {
    console.error("\nBuild is not available; cannot smoke-test the server.");
    return 1;
  }

  const tmp = mkdtempSync(path.join(os.tmpdir(), "wr-smoke-"));
  const dataDir = path.join(tmp, "data");
  const projectDir = path.join(tmp, "project");
  mkdirSync(projectDir, { recursive: true });

  const env = childEnv({
    HOST: "127.0.0.1",
    PORT: "0",
    WINDOWS_RUNNER_PERSISTENCE_MODE: "file",
    WINDOWS_RUNNER_DATA_DIR: dataDir,
    WINDOWS_RUNNER_ALLOWED_ROOTS: projectDir,
    WINDOWS_RUNNER_SHUTDOWN_GRACE_MS: "5000",
    WINDOWS_RUNNER_AUTH_TOKEN: TOKEN,
  });

  let handle = null;
  try {
    // ---- 1. boot + health ---------------------------------------------------
    handle = startServer(env);
    const base = await handle.ready;
    step(`ready line: ${base}`);
    await probeHealth(base, { dataDir, turnsLoaded: 0, sessionsLoaded: 0 });
    step("/healthz and /api/health respond (file mode, fresh data dir)");

    // ---- 2. a full turn through the mock provider --------------------------
    const started = await fetch(`${base}/api/sessions/smoke/turns`, {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ cwd: projectDir, message: "smoke test" }),
    });
    if (started.status !== 202) throw new SmokeFailure(`POST /turns returned ${started.status}: ${await started.text()}`);
    const { turnId } = await started.json();
    assert(typeof turnId === "string" && turnId.length > 0, "no turnId returned");

    const events = sseEvents(await readSse(`${base}/api/sessions/smoke/turns/${turnId}/events`));
    const types = events.map((e) => e.type);
    assert(types[0] === "turn_started", `first event ${types[0]}`);
    assert(types.includes("text_delta"), `no text_delta in ${types.join(",")}`);
    assert(types[types.length - 1] === "turn_completed", `last event ${types[types.length - 1]}`);
    const text = events.filter((e) => e.type === "text_delta").map((e) => e.delta).join("");
    assert(text.startsWith("[mock]"), `mock reply not labelled: ${text.slice(0, 60)}`);
    assert(text.includes("smoke test"), "mock reply does not echo the message");
    assert(events.every((e, i) => e.seq === i + 1), `seq not contiguous: ${events.map((e) => e.seq).join(",")}`);
    step(`turn ${turnId}: ${types.join(" -> ")}`);

    const turnFile = path.join(dataDir, "sessions", "smoke", "turns", `${turnId}.jsonl`);
    assert(existsSync(turnFile), `turn log not persisted at ${turnFile}`);
    const lines = readFileSync(turnFile, "utf8").split("\n").filter((l) => l.trim() !== "");
    assert(lines.length === events.length, `JSONL has ${lines.length} lines, SSE delivered ${events.length} events`);
    assert(JSON.parse(lines[lines.length - 1]).type === "turn_completed", "last persisted event is not turn_completed");
    assert(existsSync(path.join(dataDir, "sessions", "smoke", "meta.json")), "session meta.json not persisted");
    step("turn log and session meta persisted under the data dir");

    // ---- 3. allowed roots are enforced -------------------------------------
    const outside = await fetch(`${base}/api/sessions/outside/turns`, {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ cwd: os.tmpdir(), message: "should be refused" }),
    });
    assert(outside.status === 403, `session outside allowed roots returned ${outside.status}`);
    const refusal = await outside.json();
    assert(refusal.code === "PATH_ESCAPES_ROOT", `refusal code ${refusal.code}`);
    step("session outside WINDOWS_RUNNER_ALLOWED_ROOTS refused (403 PATH_ESCAPES_ROOT)");

    // ---- 3b. the API is authenticated -------------------------------------
    const noToken = await fetch(`${base}/api/sessions/smoke/turns/${turnId}/events`);
    assert(noToken.status === 401, `SSE without a token returned ${noToken.status}, expected 401`);
    assert((await noToken.json()).code === "AUTH_REQUIRED", "401 body does not carry AUTH_REQUIRED");
    const wrongToken = await fetch(`${base}/api/health`, { headers: { authorization: "Bearer not-the-token-000000000000" } });
    assert(wrongToken.status === 401, `wrong token returned ${wrongToken.status}, expected 401`);
    const badHostOrigin = await fetch(`${base}/api/health`, { headers: { ...AUTH, origin: "http://evil.example" } });
    assert(badHostOrigin.status === 403, `foreign Origin returned ${badHostOrigin.status}, expected 403`);
    const liveNoToken = await fetch(`${base}/healthz`);
    assert(liveNoToken.status === 200, "/healthz must stay reachable without a token");
    step("bearer token enforced on /api (401 without/with wrong token, 403 foreign Origin, /healthz public)");

    // ---- 4. graceful shutdown ----------------------------------------------
    await stopGracefully(handle, "first boot");
    handle = null;

    // ---- 5. restart recovery on the same data dir --------------------------
    handle = startServer(env);
    const base2 = await handle.ready;
    await probeHealth(base2, { dataDir, turnsLoaded: 1, sessionsLoaded: 1 });
    const replay = sseEvents(await readSse(`${base2}/api/sessions/smoke/turns/${turnId}/events`));
    assert(replay.length === events.length, `replay after restart has ${replay.length} events, expected ${events.length}`);
    assert(replay[replay.length - 1].type === "turn_completed", "replayed turn is not terminal");
    step("second boot recovered the session and replays the persisted turn");
    await stopGracefully(handle, "second boot");
    handle = null;

    // ---- 6. non-loopback bind is refused without explicit opt-in ------------
    const refused = startServer(childEnv({ HOST: "0.0.0.0", PORT: "0" }));
    const { code } = await waitForExit(refused.exited, EXIT_TIMEOUT_MS);
    assert(code === 1, `HOST=0.0.0.0 without WINDOWS_RUNNER_ALLOW_REMOTE exited ${code}, expected 1`);
    assert(/WINDOWS_RUNNER_ALLOW_REMOTE/.test(refused.output.stderr), "refusal message does not name the opt-in variable");
    step("HOST=0.0.0.0 without WINDOWS_RUNNER_ALLOW_REMOTE refused (exit 1)");

    // ---- 7. generated token persisted in file mode ----------------------------
    const generatedEnv = childEnv({
      HOST: "127.0.0.1",
      PORT: "0",
      WINDOWS_RUNNER_PERSISTENCE_MODE: "file",
      WINDOWS_RUNNER_DATA_DIR: path.join(tmp, "data-generated"),
      WINDOWS_RUNNER_ALLOWED_ROOTS: projectDir,
    });
    handle = startServer(generatedEnv);
    const base3 = await handle.ready;
    const tokenFile = path.join(tmp, "data-generated", "auth-token");
    assert(existsSync(tokenFile), `no token file at ${tokenFile}`);
    const generated = readFileSync(tokenFile, "utf8").trim();
    assert(generated.length >= 32, "generated token too short");
    assert(!handle.output.stdout.includes(generated), "file-mode boot must not print the token");
    assert((await fetch(`${base3}/api/health`)).status === 401, "generated-token server answered /api/health without a token");
    assert((await fetch(`${base3}/api/health`, { headers: { authorization: `Bearer ${generated}` } })).status === 200, "generated token from the file was not accepted");
    await stopGracefully(handle, "generated-token boot");
    handle = null;
    step("file mode generated a token at <dataDir>/auth-token and enforces it");

    console.log("\nStartup smoke test passed.");
    return 0;
  } catch (err) {
    console.error(`\nStartup smoke test FAILED: ${err instanceof Error ? err.message : String(err)}`);
    if (!(err instanceof SmokeFailure) && err instanceof Error && err.stack) console.error(err.stack);
    if (handle) {
      console.error("\n--- server stdout ---\n" + handle.output.stdout);
      console.error("--- server stderr ---\n" + handle.output.stderr);
    }
    return 1;
  } finally {
    if (handle && handle.child.exitCode === null) {
      handle.child.kill(IS_WINDOWS ? undefined : "SIGKILL");
      await handle.exited.catch(() => {});
    }
    removeTempPathSync(tmp);
  }
}

process.exitCode = await main();
