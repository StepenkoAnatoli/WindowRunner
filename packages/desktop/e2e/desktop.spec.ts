/**
 * Desktop end-to-end — the PR A / A2 merge-gate user journey.
 *
 * Drives the REAL Electron shell (the unpacked dev build by default; an
 * installed app when WR_ELECTRON_EXECUTABLE is set — the A2 windows-installer
 * job points it at the per-user install) through the story the merge gate
 * names:
 *
 *   launch -> /desktop loads from the backend origin and auto-authenticates
 *   -> open a project (create a session pinned to the project folder)
 *   -> run a mock turn to completion ([mock] reply streamed over SSE)
 *   -> quit cleanly (exit 0, backend process tree stopped with the app).
 *
 * The offline mock provider is pinned at launch: no keys, no network.
 * Invariants that test/page-smoke.ts and test/electron-smoke.ts cover in more
 * depth (token never in URL/storage, Origin policy) are asserted here in their
 * user-visible form.
 */
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { launchDesktopApp } from "./launch.js";

const tid = (id: string) => `[data-testid="${id}"]`;
const PROJECT_DIR = path.join(os.tmpdir(), "wr-desktop-e2e-project");

let app: ElectronApplication | undefined;
let page: Page;
let backendOrigin: string;
let dataDir: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await fsp.mkdir(PROJECT_DIR, { recursive: true });
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "wr-desktop-e2e-data-"));
  app = await launchDesktopApp({ dataDir, allowedRoots: [PROJECT_DIR] });
  page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForSelector(tid("project-sidebar"), { timeout: 60_000 });
  backendOrigin = new URL(page.url()).origin;
});

test.afterAll(async () => {
  await app?.close().catch(() => {});
  app = undefined;
  if (dataDir) await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(PROJECT_DIR, { recursive: true, force: true }).catch(() => {});
});

test("loads /desktop from the backend origin and auto-authenticates", async () => {
  expect(backendOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(page.url()).toBe(`${backendOrigin}/desktop`);
  // Auto-authenticated: the UI rendered the server info and project sidebar.
  await expect(page.locator(tid("server-info"))).toContainText("auth token");
  await expect(page.locator(tid("project-sidebar"))).toBeVisible();

  // The token is in memory only — never in the URL and never in web storage.
  const bootstrap = await page.evaluate(() => {
    const bridge = (
      window as unknown as {
        windowRunnerDesktop?: { getBootstrap(): { baseUrl: string; token: string } };
      }
    ).windowRunnerDesktop;
    return bridge?.getBootstrap() ?? null;
  });
  expect(bootstrap?.token).toBeTruthy();
  expect(page.url()).not.toContain(bootstrap!.token);
  const storage = await page.evaluate(() => ({
    local: JSON.stringify(Object.entries(localStorage)),
    session: JSON.stringify(Object.entries(sessionStorage)),
  }));
  expect(storage.local).not.toContain(bootstrap!.token);
  expect(storage.session).not.toContain(bootstrap!.token);
});

test("opens a project and completes a mock turn", async () => {
  // The sidebar's "Choose folder…" opens a native dialog; answer it from the
  // main process instead of driving OS UI. Same `dialog` object the IPC
  // handler calls (the module is external to the bundle).
  await app!.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog;
  }, PROJECT_DIR);
  await page.click(tid("choose-project"));
  await expect(page.locator(tid("project-item")).first()).toBeVisible();
  await page.click(tid("new-session"));
  const id = await page.locator(tid("session-id")).textContent();
  expect(id).toBeTruthy();

  await page.fill(tid("message-input"), "desktop e2e turn");
  await page.click(tid("send"));
  const turn = page.locator(tid("turn")).last();
  await expect(turn).toHaveAttribute("data-status", "completed", { timeout: 30_000 });
  await expect(turn).toContainText("[mock]");
  await expect(turn).toContainText("desktop e2e turn");

  // The workspace catalog persisted under the per-user data dir — navigation
  // metadata only, never the token.
  const catalogFile = await app!.evaluate(({ app: electronApp }) => {
    const sep = process.platform === "win32" ? "\\" : "/";
    return `${electronApp.getPath("userData")}${sep}workspace-catalog.json`;
  });
  const catalogRaw = await fsp.readFile(catalogFile, "utf8");
  // Compare the parsed root value, not the raw JSON: JSON escapes Windows
  // backslashes, so a raw substring match can never see `C:\Users\…`.
  const catalog = JSON.parse(catalogRaw) as { projects: Array<{ root: string }> };
  expect(catalog.projects.map((p) => p.root)).toContain(PROJECT_DIR);
  const token = await page.evaluate(() => {
    const bridge = (window as unknown as { windowRunnerDesktop?: { getBootstrap(): { token: string } } }).windowRunnerDesktop;
    return bridge?.getBootstrap().token ?? "";
  });
  expect(token).toBeTruthy();
  // The negative check stays on the raw bytes: the token is hex, so JSON
  // escaping cannot hide it — if it were ever written, this fails.
  expect(catalogRaw).not.toContain(token);
  await fsp.rm(catalogFile, { force: true });
});

test("the provider route works in the desktop window with the in-memory token", async () => {
  test.setTimeout(120_000);
  const RAW_KEY = "sk-desktop-e2e-0123456789abcdef";
  const card = (id: string) => page.locator(`${tid("providers-list")} [data-testid="dash-card"][data-id="${id}"]`);

  // The provider API must stay authenticated over the in-memory bootstrap:
  // navigating to /providers reuses the same client, no second token transport.
  await page.click(tid("nav-providers"));
  await expect(page.locator(tid("providers-page"))).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/providers");

  // The provider list loads through the same bearer token (env-bootstrap
  // "default" profile).
  await expect(card("default")).toBeVisible();

  // Create a keyed profile: the key comes back masked and appears nowhere.
  await page.click(tid("providers-add"));
  await page.locator(tid("provider-kind")).selectOption("openai-compatible");
  await page.locator(tid("provider-id")).fill("desktop-key");
  await page.locator(tid("provider-label")).fill("Desktop Keyed");
  await page.locator(tid("provider-base-url")).fill("http://127.0.0.1:9/v1");
  await page.locator(tid("provider-model")).fill("keyed-model");
  await page.locator(tid("provider-api-key")).fill(RAW_KEY);
  await page.click(tid("provider-submit"));
  await expect(page.locator(tid("provider-form"))).toHaveCount(0);
  await expect(card("desktop-key").locator(tid("dash-card-key"))).toHaveText("key: ****cdef");

  // Create + test + activate the offline mock provider.
  await page.click(tid("providers-add"));
  await page.locator(tid("provider-kind")).selectOption("mock");
  await page.locator(tid("provider-id")).fill("desktop-mock");
  await page.locator(tid("provider-label")).fill("Desktop Mock");
  await page.locator(tid("provider-model")).fill("mock");
  await page.click(tid("provider-submit"));
  await expect(card("desktop-mock")).toBeVisible();
  await card("desktop-mock").locator(tid("dash-test")).click();
  await expect(card("desktop-mock").locator(tid("dash-card-status"))).toHaveAttribute("data-ok", "true", { timeout: 15_000 });
  await card("desktop-mock").locator(tid("dash-activate")).click();
  await expect(page.locator(tid("providers-active"))).toContainText("Desktop Mock");

  // Back to Workspace: the B1 catalog and the attached session survive.
  await page.click(tid("nav-workspace"));
  await expect(page.locator(tid("workspace-shell"))).toBeVisible();
  await expect(page.locator(tid("session-id"))).toBeVisible();
  await expect(page.locator(tid("turn")).last()).toContainText("desktop e2e turn");
  await page.click(tid("choose-project"));
  await expect(page.locator(tid("project-item")).first()).toBeVisible();

  // No token and no provider key in: the URL, the workspace catalog file, or
  // the visible page text.
  const token = (await page.evaluate(() => {
    const bridge = (window as unknown as { windowRunnerDesktop?: { getBootstrap(): { token: string } } }).windowRunnerDesktop;
    return bridge?.getBootstrap().token ?? "";
  })) as string;
  expect(token).toBeTruthy();
  expect(page.url()).not.toContain(token);
  expect(page.url()).not.toContain(RAW_KEY);
  const bodyText = await page.locator("body").innerText();
  expect(bodyText).not.toContain(token);
  expect(bodyText).not.toContain(RAW_KEY);
  expect(bodyText).toContain("****cdef"); // masked form is what the user sees
  const catalogFile = await app!.evaluate(({ app: electronApp }) => {
    const sep = process.platform === "win32" ? "\\" : "/";
    return `${electronApp.getPath("userData")}${sep}workspace-catalog.json`;
  });
  const catalogRaw = await fsp.readFile(catalogFile, "utf8");
  expect(catalogRaw).not.toContain(token);
  expect(catalogRaw).not.toContain(RAW_KEY);
});

test("quits cleanly: exit 0 and the backend stops with it", async () => {
  const running = app!;
  const proc = running.process();
  const exited = new Promise<{ code: number | null }>((resolve) =>
    proc.once("exit", (code) => resolve({ code }))
  );
  // The real quit path: before-quit -> stop the backend tree -> app.quit().
  await running
    .evaluate(({ app: electronApp }) => {
      electronApp.quit();
    })
    .catch(() => {});
  const { code } = await exited;
  expect(code).toBe(0);

  // The backend was a child of the app; its port must refuse connections now.
  await expect
    .poll(
      async () => {
        try {
          await fetch(`${backendOrigin}/healthz`, { signal: AbortSignal.timeout(1000) });
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 15_000, message: "backend still answering after quit" }
    )
    .toBe(false);
  app = undefined;
});
