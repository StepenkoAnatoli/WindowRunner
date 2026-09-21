/**
 * Desktop main-process flow, executed for real (PR A / A1).
 *
 * Spawns `dist/main.cjs` under Node with the Electron API stubbed
 * (test/fixtures/electron-stub.cjs). Everything else is the real thing: the
 * real bundled WindowRunner server, real ports, real /healthz, real process
 * tree, real shutdown. Verifies the A1 main-process contract:
 *
 *   - data directories are created in the per-user location;
 *   - the backend is spawned on an OS-assigned loopback port and passes /healthz;
 *   - the window is asked to load `http://127.0.0.1:<port>/desktop` (never file://);
 *   - the bootstrap handshake returns {baseUrl, token} and the token never
 *     appears in the URL;
 *   - quitting runs the shutdown path and stops the backend (healthz refuses).
 *
 * The un-stubbed version of this flow is test/electron-smoke.ts, which needs
 * the real Electron binary.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const packagesRoot = path.resolve(desktopRoot, "..");
const stubPath = path.join(here, "fixtures", "electron-stub.cjs");
const mainCjs = path.join(desktopRoot, "dist", "main.cjs");
const serverBundle = path.join(packagesRoot, "server", "dist", "index.cjs");

let child: ChildProcess | undefined;
let dataDir = "";
let traceFile = "";
const traceLines: Array<Record<string, unknown>> = [];

function reloadTrace(): void {
  if (!traceFile || !fs.existsSync(traceFile)) return;
  const lines = fs
    .readFileSync(traceFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  traceLines.length = 0;
  traceLines.push(...lines);
}

function traces(event: string): Array<Record<string, unknown>> {
  return traceLines.filter((l) => l.event === event);
}

before(async () => {
  for (const artifact of [mainCjs, serverBundle]) {
    assert.ok(fs.existsSync(artifact), `missing ${artifact} — run \`npm run build\` and \`npm run build:desktop\` first`);
  }
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "wr-mainflow-"));
  traceFile = path.join(dataDir, "trace.jsonl");
  child = spawn(process.execPath, ["--require", stubPath, mainCjs], {
    env: {
      ...process.env,
      WINDOWS_RUNNER_DESKTOP_DATA_DIR: dataDir,
      ELECTRON_STUB_TRACE: traceFile,
      ELECTRON_STUB_QUIT_FILE: path.join(dataDir, "quit-trigger"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Wait until the bootstrap handshake has been answered (the app is up and
  // the real backend is serving). Shutdown is triggered by the last test.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    reloadTrace();
    if (traceLines.some((l) => l.event === "bootstrap-reply")) break;
    if (traceLines.some((l) => l.event === "error-box")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(async () => {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  if (dataDir) await fsp.rm(dataDir, { recursive: true, force: true });
});

describe("desktop main process flow (electron stub)", () => {
  it("creates per-user data dirs, boots the real backend, and loads /desktop from its http origin", () => {
    const load = traces("load-url")[0] as { url?: string } | undefined;
    assert.ok(load?.url, `no load-url in trace: ${JSON.stringify(traceLines)}`);
    const url = new URL(String(load.url));
    assert.equal(url.protocol, "http:");
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.pathname, "/desktop");

    assert.equal(fs.existsSync(path.join(dataDir, "logs")), true, "logs dir must exist");
    assert.equal(fs.existsSync(path.join(dataDir, "logs", "server.log")), true, "server log must exist");
  });

  it("hands the preload bootstrap a token that never appears in the URL", async () => {
    const reply = traces("bootstrap-reply")[0] as { value?: { baseUrl: string; token: string } } | undefined;
    assert.ok(reply?.value, `no bootstrap-reply in trace: ${JSON.stringify(traceLines)}`);
    assert.equal(typeof reply.value.token, "string");
    assert.ok(reply.value.token.length >= 16);
    assert.ok(reply.value.baseUrl.startsWith("http://127.0.0.1:"));

    const load = traces("load-url")[0] as { url?: string };
    assert.ok(!String(load.url).includes(reply.value.token), "token must not be in the window URL");

    const health = await fetch(`${reply.value.baseUrl}/healthz`);
    assert.equal(health.status, 200);
    const authed = await fetch(`${reply.value.baseUrl}/api/health`, {
      headers: { authorization: `Bearer ${reply.value.token}` },
    });
    assert.equal(authed.status, 200);
    const unauth = await fetch(`${reply.value.baseUrl}/api/health`);
    assert.equal(unauth.status, 401);
    const nullOrigin = await fetch(`${reply.value.baseUrl}/api/health`, {
      headers: { authorization: `Bearer ${reply.value.token}`, origin: "null" },
    });
    assert.equal(nullOrigin.status, 403);

    // Also assert against the real served page content.
    const page = await fetch(`${reply.value.baseUrl}/desktop`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /renderer\.js/);
  });

  it("registers only the allowlisted IPC channels and isolates the renderer", () => {
    assert.deepEqual(
      traces("ipc-sync-registered").map((t) => t.channel),
      ["window-runner:get-bootstrap"]
    );
    assert.deepEqual(
      traces("ipc-invoke-registered")
        .map((t) => t.channel)
        .sort(),
      ["window-runner:choose-folder", "window-runner:get-app-info", "window-runner:open-external"]
    );
    const win = traces("window")[0] as Record<string, unknown> | undefined;
    assert.equal(win?.contextIsolation, true);
    assert.equal(win?.nodeIntegration, false);
    assert.equal(win?.sandbox, true);
    assert.equal(String(win?.preload).endsWith("preload.cjs"), true);
  });

  it("shuts down cleanly and stops the backend", async () => {
    // Ask the stub window to quit; the app's real before-quit handler runs.
    await fsp.writeFile(path.join(dataDir, "quit-trigger"), "1");
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && child && child.exitCode === null) {
      await new Promise((r) => setTimeout(r, 100));
    }
    reloadTrace();
    assert.equal(traces("error-box").length, 0, `startup/shutdown errors: ${JSON.stringify(traces("error-box"))}`);
    assert.equal(traces("quit").length, 1, "app must have quit through the stub window's app.quit()");
    if (process.platform !== "win32") {
      assert.equal(child?.exitCode, 0, "desktop main must exit 0 after clean shutdown");
    }

    const reply = traces("bootstrap-reply")[0] as { value: { baseUrl: string } };
    let refused = false;
    try {
      await fetch(`${reply.value.baseUrl}/healthz`);
    } catch {
      refused = true;
    }
    assert.equal(refused, true, "backend must be stopped when the desktop app quits");
  });
});
