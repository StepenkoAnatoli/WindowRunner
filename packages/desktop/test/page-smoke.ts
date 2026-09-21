/**
 * Real-browser smoke of the desktop renderer shell (PR A / A1).
 *
 * Loads the REAL `http://127.0.0.1:<port>/desktop` page in real headless
 * Chromium (the binary ships inside the `@sparticuz/chromium` npm tarball, so
 * this runs in network-restricted environments where the Electron binary
 * cannot be downloaded). Verifies:
 *
 *   - the shell is served from the backend's http origin (never file://);
 *   - `renderer.js` runs and mounts the existing web application;
 *   - the in-memory bootstrap global (published by the desktop renderer from
 *     the preload handshake) authenticates the API — the same-origin page
 *     calls /api with the bearer token and succeeds, while missing-token
 *     requests are rejected;
 *   - the token never appears in the URL or web storage;
 *   - Origin: null is still refused.
 *
 * The BrowserWindow + contextBridge halves of the story are covered by
 * test/electron-smoke.ts (real Electron) and test/main-flow.test.ts (main
 * process flow).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { startServer, stopServer, waitForHealth, type DesktopServer } from "../src/server-process.js";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const packagesRoot = path.resolve(desktopRoot, "..");

const serverBundle = path.join(packagesRoot, "server", "dist", "index.cjs");
const webIndex = path.join(packagesRoot, "web", "dist", "app", "index.html");
const desktopShell = path.join(desktopRoot, "dist", "renderer", "index.html");

let browser: Browser | undefined;
let page: Page | undefined;
let server: DesktopServer | undefined;
let dataDir = "";

before(async () => {
  for (const artifact of [serverBundle, webIndex, desktopShell]) {
    assert.ok(
      fs.existsSync(artifact),
      `missing ${artifact} — run \`npm run build\` then \`npm run build:desktop\` before smoke:page`
    );
  }
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "wr-page-smoke-"));
  server = await startServer({ dataDir });
  await waitForHealth(server.url, 20_000);

  const sparticuz = require("@sparticuz/chromium");
  // Package root from its exported entry (…/build/cjs/index.cjs); the package
  // "exports" map does not expose ./package.json.
  const packDir = path.join(path.resolve(path.dirname(require.resolve("@sparticuz/chromium")), "..", ".."), "bin");
  // @sparticuz/chromium only extracts its bundled shared libraries on AWS
  // Lambda. Inflate the packs here so the binary finds libnspr4/libnss3/etc.
  // in restricted environments (browser tests never need a display).
  for (const pack of ["al2023.tar.br", "swiftshader.tar.br", "fonts.tar.br"]) {
    const archive = path.join(packDir, pack);
    if (!fs.existsSync(archive)) continue;
    const tarPath = path.join(os.tmpdir(), `wr-${pack}.tar`);
    await fsp.writeFile(tarPath, zlib.brotliDecompressSync(await fsp.readFile(archive)));
    spawnSync("tar", ["-xf", tarPath, "-C", os.tmpdir()], { stdio: "ignore" });
    await fsp.rm(tarPath, { force: true });
  }
  // The al2023 pack's contents extract to `<tmp>/lib/*` (its tar paths are
  // `lib/…`), which is where the loader must look.
  const libDir = path.join(os.tmpdir(), "lib");

  const executablePath: string = await sparticuz.executablePath();
  browser = await chromium.launch({
    executablePath,
    args: sparticuz.args,
    headless: true,
    env: {
      ...process.env,
      LD_LIBRARY_PATH: [libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
    },
  });
  page = await browser.newPage();

  // The desktop renderer publishes this global from the preload handshake
  // (packages/desktop/src/renderer.ts). Here we play the preload's part with
  // the real token from the real spawned server.
  await page.addInitScript((bootstrap) => {
    (globalThis as Record<string, unknown>).__WINDOWS_RUNNER_BOOTSTRAP__ = bootstrap;
  }, { baseUrl: server!.url, token: server!.token });

  await page.goto(`${server!.url}/desktop`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="project-sidebar"]', { timeout: 60_000 });
});

after(async () => {
  await browser?.close().catch(() => {});
  if (server) await stopServer(server);
  if (dataDir) await fsp.rm(dataDir, { recursive: true, force: true });
});

describe("desktop page smoke (real headless Chromium)", () => {
  it("loads /desktop from the backend's http origin and mounts the existing web UI", () => {
    const url = new URL(page!.url());
    assert.equal(url.protocol, "http:");
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.pathname, "/desktop");
  });

  it("keeps the bootstrap token out of the URL and web storage", async () => {
    const token = server!.token;
    assert.ok(!page!.url().includes(token), "token must not appear in the URL");
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
    assert.ok(!storage.local.includes(token), "token must not be in localStorage");
    assert.ok(!storage.session.includes(token), "token must not be in sessionStorage");
    assert.ok(!storage.hash.includes(token), "token must not be in the fragment");
  });

  it("makes authenticated same-origin API calls; rejects missing tokens and Origin: null", async () => {
    const token = server!.token;
    const result = await page!.evaluate(async (t) => {
      const withAuth = await fetch("/api/health", { headers: { authorization: `Bearer ${t}` } });
      const without = await fetch("/api/health");
      return { withAuth: withAuth.status, without: without.status };
    }, token);
    assert.equal(result.withAuth, 200);
    assert.equal(result.without, 401);

    const nullOrigin = await fetch(`${server!.url}/api/health`, {
      headers: { authorization: `Bearer ${token}`, origin: "null" },
    });
    assert.equal(nullOrigin.status, 403);
  });
});
