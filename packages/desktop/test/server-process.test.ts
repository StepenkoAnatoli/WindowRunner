/**
 * Backend lifecycle tests (PR A / A1, plan item 12).
 *
 * Integration tests spawn the real bundled server (packages/server/dist/index.cjs)
 * and pin: dynamic port, /healthz, bearer auth required, Origin: null still
 * refused, clean stop, clear failure when the bundle is missing, early-exit
 * rejection with token-redacted diagnostics, and process-tree cleanup on stop.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultServerBundle, startServer, stopServer, waitForHealth, type DesktopServer } from "../src/server-process.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const fixtures = path.join(here, "fixtures");

const servers: DesktopServer[] = [];
const tmps: string[] = [];

before(async () => {
  if (!fs.existsSync(defaultServerBundle())) {
    const result = spawnSync("npm", ["run", "build", "--workspace", "packages/server"], {
      cwd: repoRoot,
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    assert.equal(result.status, 0, `failed to build packages/server:\n${result.stdout}\n${result.stderr}`);
  }
});

after(async () => {
  await Promise.all(servers.map((s) => s.stop().catch(() => {})));
  await Promise.all(tmps.map((t) => fsp.rm(t, { recursive: true, force: true })));
});

async function tmpDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmps.push(dir);
  return dir;
}

async function startReal(): Promise<DesktopServer> {
  const s = await startServer({ dataDir: await tmpDir("wr-serverproc-") });
  servers.push(s);
  await waitForHealth(s.url, 20_000);
  return s;
}

describe("desktop server process", () => {
  it("starts the bundled server on dynamically selected ports", async () => {
    const a = await startReal();
    const b = await startReal();
    const portA = Number(new URL(a.url).port);
    const portB = Number(new URL(b.url).port);
    assert.ok(portA > 0 && portB > 0);
    assert.notEqual(portA, portB, "two instances must get two ports (PORT=0)");
    assert.equal(new URL(a.url).hostname, "127.0.0.1");
  });

  it("health endpoint becomes available and diagnostics require auth", async () => {
    const s = await startReal();
    const health = await fetch(`${s.url}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { status: string }).status, "ok");

    const unauth = await fetch(`${s.url}/api/health`);
    assert.equal(unauth.status, 401);
    const wrong = await fetch(`${s.url}/api/health`, { headers: { authorization: `Bearer ${"x".repeat(40)}` } });
    assert.equal(wrong.status, 401);
    const ok = await fetch(`${s.url}/api/health`, { headers: { authorization: `Bearer ${s.token}` } });
    assert.equal(ok.status, 200);
  });

  it("still refuses Origin: null even with a valid token", async () => {
    const s = await startReal();
    const res = await fetch(`${s.url}/api/health`, {
      headers: { authorization: `Bearer ${s.token}`, origin: "null" },
    });
    assert.equal(res.status, 403);
  });

  it("stops cleanly (graceful exit) and stop is idempotent", async () => {
    const s = await startReal();
    await s.stop();
    await s.stop();
    await stopServer(s);
    if (process.platform !== "win32") {
      assert.equal(s.process.exitCode, 0, "SIGTERM must drain and exit 0");
    }
    await assert.rejects(fetch(`${s.url}/healthz`));
  });

  it("startup fails clearly if the bundle is missing", async () => {
    const missing = path.join(await tmpDir("wr-missing-"), "nope", "index.cjs");
    await assert.rejects(
      startServer({ dataDir: await tmpDir("wr-serverproc-"), serverBundle: missing }),
      (err: Error) => {
        assert.match(err.message, /bundled server not found/);
        assert.ok(err.message.includes(missing));
        return true;
      }
    );
  });

  it("rejects startup when the process exits early, with the token redacted from diagnostics", async () => {
    const token = "super-secret-token-abcdef123456";
    const logFile = path.join(await tmpDir("wr-redact-"), "server.log");
    await assert.rejects(
      startServer({
        dataDir: await tmpDir("wr-serverproc-"),
        serverBundle: path.join(fixtures, "fail-fast.cjs"),
        token,
        logFile,
      }),
      (err: Error) => {
        assert.match(err.message, /exited before ready/);
        assert.match(err.message, /\[redacted\]/);
        assert.ok(!err.message.includes(token), "token must be redacted from error output");
        return true;
      }
    );
    const logged = await fsp.readFile(logFile, "utf8");
    assert.match(logged, /\[redacted\]/);
    assert.ok(!logged.includes(token), "token must be redacted from the log file");
  });

  it("child process cleanup runs on shutdown (process tree, not just the server)", async () => {
    const dataDir = await tmpDir("wr-tree-");
    const pidFile = path.join(dataDir, "grandchild.pid");
    const s = await startServer({
      dataDir,
      serverBundle: path.join(fixtures, "fake-server.cjs"),
      extraEnv: { FAKE_CHILD_PID_FILE: pidFile },
    });
    await waitForHealth(s.url, 10_000);
    const pid = Number(await fsp.readFile(pidFile, "utf8"));
    assert.ok(pid > 0);
    // The grandchild is alive before shutdown.
    assert.doesNotThrow(() => process.kill(pid, 0));

    await s.stop();

    // The fake server deliberately never kills its own `sleep` child: it only
    // dies if stopServer reached the whole process tree.
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, `grandchild ${pid} survived shutdown`);
  });
});
