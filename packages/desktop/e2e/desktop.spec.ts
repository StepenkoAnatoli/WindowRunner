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
