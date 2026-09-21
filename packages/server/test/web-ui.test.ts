/**
 * Static web UI serving (src/app.ts `webDir`, src/boot.ts `resolveWebDir`) —
 * RELEASE_CHECKLIST.md P1-07.
 *
 * The UI is public (it is just a page), the API under /api is not: the same
 * bearer token protects every /api route whether or not a UI is mounted. These
 * tests use a throwaway webDir so they do not depend on packages/web being
 * built; `resolveWebDir` is checked separately against the real build output
 * when it exists.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startServer, resolveWebDir, resolveDesktopDir, type StartedServer } from "../src/boot.js";
import { loadServerConfig } from "../src/config.js";

const TOKEN = "web-ui-test-token-0123456789abcdef";
const started: StartedServer[] = [];
const tmps: string[] = [];

after(async () => {
  await Promise.all(started.map((s) => s.close().catch(() => {})));
  await Promise.all(tmps.map((t) => fs.rm(t, { recursive: true, force: true })));
});

async function fakeWebDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wr-webui-"));
  tmps.push(dir);
  await fs.writeFile(path.join(dir, "index.html"), "<!doctype html><title>t</title><script type=module src=/app.js></script>");
  await fs.writeFile(path.join(dir, "app.js"), "console.log('ui')");
  await fs.mkdir(path.join(dir, "api"));
  await fs.writeFile(path.join(dir, "api", "health"), "should never be served");
  return dir;
}

async function boot(webDir: string | null | undefined, desktopDir?: string | null): Promise<StartedServer> {
  const config = loadServerConfig({ HOST: "127.0.0.1", PORT: "0", WINDOWS_RUNNER_AUTH_TOKEN: TOKEN }, { homedir: os.tmpdir() });
  const h = await startServer(config, { webDir, desktopDir });
  started.push(h);
  return h;
}

async function fakeDesktopDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wr-desktopui-"));
  tmps.push(dir);
  await fs.writeFile(path.join(dir, "index.html"), "<!doctype html><title>desktop</title><script type=module src=./renderer.js></script>");
  await fs.writeFile(path.join(dir, "renderer.js"), "console.log('desktop')");
  return dir;
}

describe("web UI static serving (P1-07)", () => {
  it("serves index.html at / and assets without a token, with no-store + CSP headers", async () => {
    const h = await boot(await fakeWebDir());
    assert.equal(h.webDir !== undefined, true);
    const index = await fetch(`${h.url}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(index.headers.get("cache-control"), "no-store");
    assert.equal(index.headers.get("x-content-type-options"), "nosniff");
    const csp = index.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline/);
    assert.match(await index.text(), /app\.js/);

    const js = await fetch(`${h.url}/app.js`);
    assert.equal(js.status, 200);
    assert.equal(js.headers.get("cache-control"), "no-store");
  });

  it("does not weaken the API boundary: /api/* still requires the bearer token even when a same-named file exists in webDir", async () => {
    const h = await boot(await fakeWebDir());
    const unauth = await fetch(`${h.url}/api/health`);
    assert.equal(unauth.status, 401);
    assert.equal(unauth.headers.get("www-authenticate")?.startsWith("Bearer"), true);
    const body = await unauth.text();
    assert.doesNotMatch(body, /should never be served/);
    const ok = await fetch(`${h.url}/api/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).status, "ok");
  });

  it("does not serve files outside webDir", async () => {
    const h = await boot(await fakeWebDir());
    for (const p of ["/../package.json", "/..%2fpackage.json", "/%2e%2e/%2e%2e/etc/passwd"]) {
      const res = await fetch(`${h.url}${p}`);
      assert.notEqual(res.status, 200, `${p} must not be served`);
    }
  });

  it("without a UI build, / is a plain 404 and the API is unchanged", async () => {
    const h = await boot(null);
    assert.equal(h.webDir, undefined);
    assert.equal((await fetch(`${h.url}/`)).status, 404);
    assert.equal((await fetch(`${h.url}/healthz`)).status, 200);
    assert.equal((await fetch(`${h.url}/api/health`)).status, 401);
  });

  it("resolveWebDir finds packages/web/dist/app relative to the server (when built) and never something else", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const expected = path.resolve(here, "..", "..", "web", "dist", "app");
    const resolved = resolveWebDir();
    if (existsSync(path.join(expected, "index.html"))) {
      assert.equal(resolved, expected);
    } else {
      assert.equal(resolved, undefined);
    }
  });
});

describe("desktop renderer shell serving (PR A)", () => {
  it("serves the shell at /desktop and assets under /desktop/* with the UI security headers", async () => {
    const h = await boot(null, await fakeDesktopDir());
    const page = await fetch(`${h.url}/desktop`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    const csp = page.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /connect-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline/);
    assert.match(await page.text(), /renderer\.js/);

    const js = await fetch(`${h.url}/desktop/renderer.js`);
    assert.equal(js.status, 200);
    assert.equal(js.headers.get("cache-control"), "no-store");
  });

  it("loading the shell does not weaken the API boundary", async () => {
    const h = await boot(null, await fakeDesktopDir());
    assert.equal((await fetch(`${h.url}/api/health`)).status, 401);
    const ok = await fetch(`${h.url}/api/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(ok.status, 200);
  });

  it("without a built desktop shell, /desktop is a plain 404", async () => {
    const h = await boot(await fakeWebDir(), null);
    assert.equal((await fetch(`${h.url}/desktop`)).status, 404);
    assert.equal((await fetch(`${h.url}/`)).status, 200);
  });

  it("resolveDesktopDir finds packages/desktop/dist/renderer relative to the server (when built) and never something else", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const expected = path.resolve(here, "..", "..", "desktop", "dist", "renderer");
    const resolved = resolveDesktopDir();
    if (existsSync(path.join(expected, "index.html"))) {
      assert.equal(resolved, expected);
    } else {
      assert.equal(resolved, undefined);
    }
  });
});
