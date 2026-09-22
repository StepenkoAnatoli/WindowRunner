/**
 * Desktop B3 deep routes (plan B3.5).
 *
 * Own app lifecycle, like providers.spec.ts. Direct navigation and reload of
 * the allowlisted routes must stay authenticated via the in-memory bootstrap
 * (the `/desktop` renderer does not run on those documents). The catalog stays
 * project/session metadata. Shutdown is the real quit path.
 *
 * Electron is required. This sandbox often cannot download the binary; CI is
 * the evidence when a local launch is impossible.
 */
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { launchDesktopApp } from "./launch.js";

const tid = (id: string) => `[data-testid="${id}"]`;
const PROJECT_DIR = path.join(os.tmpdir(), "wr-desktop-e2e-deeproutes-project");

let app: ElectronApplication | undefined;
let page: Page;
let backendOrigin: string;
let dataDir: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await fsp.mkdir(PROJECT_DIR, { recursive: true });
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "wr-desktop-e2e-deeproutes-data-"));
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

async function tokenFromBridge(): Promise<string> {
  return page.evaluate(() => {
    const bridge = (window as unknown as { windowRunnerDesktop?: { getBootstrap(): { token: string } } }).windowRunnerDesktop;
    return bridge?.getBootstrap().token ?? "";
  });
}

test("opens a project so the catalog exists before a deep-route refresh", async () => {
  await app!.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog;
  }, PROJECT_DIR);
  await page.click(tid("choose-project"));
  await expect(page.locator(tid("project-item")).first()).toBeVisible();
  await page.click(tid("new-session"));
  await expect(page.locator(tid("session-id"))).toBeVisible({ timeout: 10_000 });
});

test("direct deep routes and reload stay authenticated without putting the token in the URL", async () => {
  test.setTimeout(120_000);
  const token = await tokenFromBridge();
  expect(token).toBeTruthy();

  for (const route of [
    { path: "/providers", pageId: "providers-page" },
    { path: "/usage", pageId: "usage-page" },
    { path: "/settings/security", pageId: "security-page" },
  ] as const) {
    await page.goto(`${backendOrigin}${route.path}`);
    await expect(page.locator(tid(route.pageId))).toBeVisible({ timeout: 20_000 });
    expect(new URL(page.url()).pathname).toBe(route.path);
    expect(page.url()).not.toContain(token);
    await page.reload();
    await expect(page.locator(tid(route.pageId))).toBeVisible({ timeout: 20_000 });
    expect(page.url()).not.toContain(token);
    const storage = await page.evaluate(() => ({
      local: JSON.stringify(Object.entries(localStorage)),
      session: JSON.stringify(Object.entries(sessionStorage)),
    }));
    expect(storage.local).not.toContain(token);
    expect(storage.session).not.toContain(token);
    expect(await page.locator("body").innerText()).not.toContain(token);
  }

  // Cards and the form are the same components the browser shell uses.
  await page.goto(`${backendOrigin}/providers`);
  await expect(page.locator(tid("dash-card")).first()).toBeVisible();
  await page.click(tid("providers-add"));
  await expect(page.locator(tid("provider-form"))).toBeVisible();
  // Escape is listened for on the form and bubbles from a focused field.
  // Pressing it on the form element itself does not move focus inside, so
  // Electron never delivers the key to the handler. A dirty form confirms;
  // accepting discards it.
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(tid("provider-label")).press("Escape");
  await expect(page.locator(tid("provider-form"))).toHaveCount(0);

  await page.click(tid("nav-workspace"));
  await expect(page.locator(tid("workspace-shell"))).toBeVisible();
  await expect(page.locator(tid("project-item")).first()).toBeVisible();

  const catalogFile = await app!.evaluate(({ app: electronApp }) => {
    const sep = process.platform === "win32" ? "\\" : "/";
    return `${electronApp.getPath("userData")}${sep}workspace-catalog.json`;
  });
  const catalogRaw = await fsp.readFile(catalogFile, "utf8");
  expect(catalogRaw).not.toContain(token);
  const catalog = JSON.parse(catalogRaw) as {
    version: number;
    projects: Array<Record<string, unknown>>;
    sessions: Array<Record<string, unknown>>;
  };
  expect(catalog.version).toBe(1);
  expect(catalog.projects.length).toBeGreaterThan(0);
  for (const project of catalog.projects) {
    expect(Object.keys(project).sort()).toEqual(["id", "label", "lastOpenedAt", "root"]);
  }
  for (const session of catalog.sessions) {
    expect(Object.keys(session).sort()).toEqual(["lastOpenedAt", "projectId", "sessionId"]);
  }
});

test("quits cleanly: exit 0 and the backend stops with it", async () => {
  const running = app!;
  const proc = running.process();
  const exited = new Promise<{ code: number | null }>((resolve) => proc.once("exit", (code) => resolve({ code })));
  await running.evaluate(({ app: electronApp }) => {
    electronApp.quit();
  }).catch(() => {});
  const { code } = await exited;
  expect(code).toBe(0);
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
