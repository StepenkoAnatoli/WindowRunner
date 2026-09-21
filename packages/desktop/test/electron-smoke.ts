/**
 * Linux-runnable Electron smoke (PR A / A1 required check).
 *
 * Launches the real, unpacked Electron app (dist/main.cjs) headlessly and
 * verifies the A1 gate end to end:
 *
 *   1. the window loads `/desktop` from the backend's own http origin
 *      (never file://);
 *   2. the preload bridge answers with an in-memory bootstrap whose token is
 *      not present in the URL or web storage;
 *   3. authenticated same-origin API calls succeed and missing-token requests
 *      are rejected; Origin: null is still refused;
 *   4. the existing web UI mounts (session form visible);
 *   5. quitting the app stops the backend (clean shutdown).
 *
 * Runs without a display via `--ozone-platform=headless` (or under xvfb-run).
 * Requires `npm run build` + `npm run build:desktop` first — it fails loudly
 * if the artifacts are missing rather than skipping.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const packagesRoot = path.resolve(desktopRoot, "..");

const mainCjs = path.join(desktopRoot, "dist", "main.cjs");
const serverBundle = path.join(packagesRoot, "server", "dist", "index.cjs");
const webIndex = path.join(packagesRoot, "web", "dist", "app", "index.html");

let app: ElectronApplication | undefined;
let page: Page | undefined;
let dataDir = "";

before(async () => {
  for (const artifact of [mainCjs, serverBundle, webIndex]) {
    assert.ok(
      fs.existsSync(artifact),
      `missing ${artifact} — run \`npm run build\` then \`npm run build:desktop\` before smoke:electron`
    );
  }
  // The Electron binary is downloaded by electron's install script from
  // GitHub release assets. Network-restricted environments block that host;
  // fail loudly with the reason instead of a confusing launch error.
  const electronPath: string = require("electron");
  assert.ok(
    typeof electronPath === "string" && fs.existsSync(electronPath),
    "the Electron binary is not installed (electron/dist/electron missing). " +
      "Run `node node_modules/electron/install.js` where GitHub release downloads are allowed, " +
      "then re-run smoke:electron. (In-sandbox substitutes: `smoke:page` + `npm run test:desktop`.)"
  );
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "wr-electron-smoke-"));

  const args = [mainCjs];
  // Ozone is the Linux windowing layer. Windows/macOS runners have no DISPLAY
  // variable but DO have a desktop — the flags are meaningless (and risky)
  // there, so gate on the platform as well. CI's Linux leg runs this suite
  // under `xvfb-run` (a real virtual display) instead: ozone headless hung the
  // Electron launch handshake on ubuntu-latest (2026-09-21), while the same
  // build passed on windows-latest.
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    // Headless Chromium ozone: no X server required (may not work on all
    // Electron builds — prefer xvfb-run where available).
    args.unshift("--ozone-platform=headless", "--disable-gpu");
  }
  args.unshift("--no-sandbox");

  // electron.launch() has no timeout of its own: if the handshake hangs (seen
  // with ozone headless), an unbounded await would wedge the whole suite.
  // Fail loudly and specifically instead.
  app = await Promise.race([
    electron.launch({
      executablePath: electronPath,
      args,
      env: {
        ...process.env,
        ELECTRON_DISABLE_SANDBOX: "1",
        WINDOWS_RUNNER_DESKTOP_DATA_DIR: dataDir,
      },
    }),
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `electron.launch() did not connect within 60s (args: ${args.join(" ")}). ` +
              "On headless Linux prefer `xvfb-run -a npm run smoke:electron`."
          )
        );
      }, 60_000);
      timer.unref();
    }),
  ]);
  page = await app.firstWindow({ timeout: 60_000 });
  // Wait for the shell to mount the web application (bootstrap auto-connect).
  await page.waitForSelector('[data-testid="session-form"]', { timeout: 60_000 });
});

after(async () => {
  await app?.close().catch(() => {});
  app = undefined;
  page = undefined;
  if (dataDir) await fsp.rm(dataDir, { recursive: true, force: true });
});

describe("desktop shell smoke (unpacked Electron)", () => {
  it("loads /desktop same-origin from the backend (not file://)", () => {
    const url = new URL(page!.url());
    assert.equal(url.protocol, "http:");
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.pathname, "/desktop");
  });

  it("exposes the preload bootstrap with an in-memory token (never in the URL or storage)", async () => {
    type Bridge = { getBootstrap(): { baseUrl: string; token: string } };
    const bootstrap = await page!.evaluate(() => {
      const g = globalThis as unknown as { windowRunnerDesktop: Bridge };
      return g.windowRunnerDesktop.getBootstrap();
    });
    assert.equal(typeof bootstrap.baseUrl, "string");
    assert.equal(typeof bootstrap.token, "string");
    assert.ok(bootstrap.token.length >= 16);
    assert.ok(bootstrap.baseUrl.startsWith("http://127.0.0.1:"));

    const url = page!.url();
    assert.ok(!url.includes(bootstrap.token), "token must not appear in the URL");
    const storage = await page!.evaluate(() => {
      const g = globalThis as unknown as {
        localStorage: Record<string, string>;
        sessionStorage: Record<string, string>;
        location: { hash: string };
      };
      return {
        local: JSON.stringify(g.localStorage),
        session: JSON.stringify(g.sessionStorage),
        hash: g.location.hash,
      };
    });
    assert.ok(!storage.local.includes(bootstrap.token), "token must not be in localStorage");
    assert.ok(!storage.session.includes(bootstrap.token), "token must not be in sessionStorage");
    assert.ok(!storage.hash.includes(bootstrap.token), "token must not be in the fragment");
  });

  it("makes authenticated same-origin API calls; rejects missing token and Origin: null", async () => {
    type Bridge = { getBootstrap(): { token: string } };
    const result = await page!.evaluate(async () => {
      const g = globalThis as unknown as { windowRunnerDesktop: Bridge };
      const token = g.windowRunnerDesktop.getBootstrap().token;
      const withAuth = await fetch("/api/health", { headers: { authorization: `Bearer ${token}` } });
      const without = await fetch("/api/health");
      return { withAuth: withAuth.status, without: without.status, token };
    });
    assert.equal(result.withAuth, 200);
    assert.equal(result.without, 401);

    // Node-side check: the server's Origin policy is unchanged (null refused).
    const originRes = await fetch(`${new URL(page!.url()).origin}/api/health`, {
      headers: {
        authorization: `Bearer ${result.token}`,
        origin: "null",
      },
    });
    assert.equal(originRes.status, 403);
  });

  it("stops the backend when the app quits (clean shutdown)", async () => {
    const origin = new URL(page!.url()).origin;
    const exited = new Promise<void>((resolve) => app!.on("close", () => resolve()));
    await app!.evaluate(({ app: electronApp }) => electronApp.quit());
    await exited;

    let refused = false;
    for (let i = 0; i < 40 && !refused; i++) {
      try {
        await fetch(`${origin}/healthz`);
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        refused = true;
      }
    }
    assert.equal(refused, true, "backend must stop when the desktop app quits");
  });
});
