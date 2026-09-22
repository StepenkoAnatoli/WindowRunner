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
import { isClientAppRoute } from "../src/app.js";
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

async function boot(webDir: string | null | undefined, desktopDir?: string | null, dashboardDir?: string | null): Promise<StartedServer> {
  const config = loadServerConfig({ HOST: "127.0.0.1", PORT: "0", WINDOWS_RUNNER_AUTH_TOKEN: TOKEN }, { homedir: os.tmpdir() });
  const h = await startServer(config, { webDir, desktopDir, dashboardDir });
  started.push(h);
  return h;
}

async function fakeDashboardDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wr-dashui-"));
  tmps.push(dir);
  await fs.writeFile(path.join(dir, "dashboard.html"), "<!doctype html><title>dash</title>");
  return dir;
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
    assert.equal((await fetch(`${h.url}/providers`)).status, 404);
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

describe("deep client routes (B3)", () => {
  it("folds only the allowlisted paths", () => {
    for (const p of ["/providers", "/Providers/", "/usage", "/settings/security", "/settings/storage/", "/SETTINGS/ABOUT"]) {
      assert.equal(isClientAppRoute(p), true, p);
    }
    for (const p of ["/", "/dashboard", "/desktop", "/api/providers", "/healthz", "/settings", "/settings/nope", "/providers/app.js", "/no-such"]) {
      assert.equal(isClientAppRoute(p), false, p);
    }
  });

  it("serves the main app shell for allowlisted routes and refuses everything else", async () => {
    const h = await boot(await fakeWebDir(), null, await fakeDashboardDir());
    const shell = await (await fetch(`${h.url}/`)).text();
    assert.match(shell, /<title>t<\/title>/);

    for (const route of ["/providers", "/Providers/", "/usage", "/settings/security", "/settings/storage/", "/settings/about"]) {
      const res = await fetch(`${h.url}${route}`);
      assert.equal(res.status, 200, route);
      assert.match(res.headers.get("content-type") ?? "", /text\/html/);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.match(res.headers.get("content-security-policy") ?? "", /script-src 'self'/);
      assert.equal(await res.text(), shell, `${route} must be the same static shell, not an interpolated page`);
    }

    const queried = await fetch(`${h.url}/providers?token=${encodeURIComponent(TOKEN)}`);
    const queriedBody = await queried.text();
    assert.equal(queried.status, 200);
    assert.equal(queriedBody, shell);
    assert.equal(queriedBody.includes(TOKEN), false, "a query string must not be reflected into the HTML");

    const head = await fetch(`${h.url}/usage`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.match(head.headers.get("content-type") ?? "", /text\/html/);

    const dash = await fetch(`${h.url}/dashboard`);
    const dashBody = await dash.text();
    assert.equal(dash.status, 200);
    assert.match(dashBody, /<title>dash<\/title>/);
    assert.equal(dashBody.includes("<title>t</title>"), false, "/dashboard must not be swallowed by the app shell");

    const api = await fetch(`${h.url}/api/providers`);
    const apiBody = await api.text();
    assert.equal(api.status, 401);
    assert.equal(apiBody.includes("<title>t</title>"), false);

    const healthz = await fetch(`${h.url}/healthz`);
    assert.equal(healthz.status, 200);
    assert.equal((await healthz.json()).status, "ok");

    for (const missing of ["/no-such-page", "/settings", "/settings/nope", "/providers/app.js", "/missing.js", "/desktop"]) {
      const res = await fetch(`${h.url}${missing}`);
      assert.equal(res.status, 404, missing);
      const body = await res.text();
      assert.equal(body.includes("<title>t</title>"), false, `${missing} must not receive the app shell`);
    }

    const post = await fetch(`${h.url}/providers`, { method: "POST" });
    const postBody = await post.text();
    assert.equal(post.status, 404);
    assert.equal(postBody.includes("<title>t</title>"), false, "POST must not be answered with the shell");
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
