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
  await page.waitForSelector(tid("session-form"), { timeout: 60_000 });
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
  // Auto-authenticated: the UI rendered the server info and session form.
  await expect(page.locator(tid("server-info"))).toContainText("auth token");
  await expect(page.locator(tid("session-form"))).toBeVisible();

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
  const id = `e2e-${Date.now().toString(36)}`;
  await page.fill(tid("session-id-input"), id);
  await page.fill(tid("cwd-input"), PROJECT_DIR);
  await page.click(tid("create-session"));
  await expect(page.locator(tid("session-id"))).toHaveText(id);

  await page.fill(tid("message-input"), "desktop e2e turn");
  await page.click(tid("send"));
  const turn = page.locator(tid("turn")).last();
  await expect(turn).toHaveAttribute("data-status", "completed", { timeout: 30_000 });
  await expect(turn).toContainText("[mock]");
  await expect(turn).toContainText("desktop e2e turn");
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
