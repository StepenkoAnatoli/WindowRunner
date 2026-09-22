/**
 * B5.6 — in-place upgrade and uninstall-data-survival journey.
 *
 * Runs ONLY when the Desktop installer CI job drives it, against the
 * INSTALLED app, with the per-user data directory pinned to the real install
 * location (`%APPDATA%\WindowRunner` on Windows) — not a throwaway temp dir,
 * because the point of the journey is what survives an upgrade and an
 * uninstall.
 *
 *   phase "old" (WR_UPGRADE_PHASE=old): create the marker project + a session
 *     with a completed mock turn; record the session id and project root in
 *     the marker dir; quit cleanly.
 *
 *   [the CI job now runs the NEXT-version installer over the install]
 *
 *   phase "new" (WR_UPGRADE_PHASE=new): assert the installed app reports the
 *     new version, the marker project is still in the workspace catalog, the
 *     phase-A session still lists and still renders its completed turn, and a
 *     fresh turn completes; quit cleanly.
 *
 * The job's uninstall step (after this spec) asserts user data survives
 * uninstall — `deleteAppDataOnUninstall: false`.
 *
 * Skipping is the default: every other run context (dev layout, the standard
 * installer-job e2e pass with temp data dirs) has no "previous version" to
 * upgrade from.
 */
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { launchDesktopApp } from "./launch.js";

const tid = (id: string) => `[data-testid="${id}"]`;

const phase = process.env.WR_UPGRADE_PHASE ?? "";
const expectedVersion = process.env.WR_EXPECTED_APP_VERSION ?? "";
const dataDir = process.env.WR_UPGRADE_DATA_DIR ?? "";
const markerDir = process.env.WR_UPGRADE_MARKER_DIR ?? "";

const active = phase === "old" || phase === "new";
test.skip(
  !active || expectedVersion === "" || dataDir === "" || markerDir === "",
  "upgrade journey runs only when the installer CI job sets WR_UPGRADE_PHASE/WR_EXPECTED_APP_VERSION/WR_UPGRADE_DATA_DIR/WR_UPGRADE_MARKER_DIR"
);

test.describe.configure({ mode: "serial" });

async function bootstrapApp(): Promise<{ app: ElectronApplication; page: Page; origin: string }> {
  await fsp.mkdir(markerDir, { recursive: true });
  await fsp.mkdir(dataDir, { recursive: true });
  const app = await launchDesktopApp({ dataDir, allowedRoots: [markerDir] });
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForSelector(tid("project-sidebar"), { timeout: 60_000 });
  return { app, page, origin: new URL(page.url()).origin };
}

async function quitCleanly(app: ElectronApplication, origin: string): Promise<void> {
  const proc = app.process();
  const exited = new Promise<{ code: number | null }>((resolve) => proc.once("exit", (code) => resolve({ code })));
  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => {});
  const { code } = await exited;
  expect(code, "upgraded app must quit cleanly (exit 0)").toBe(0);
  await expect
    .poll(
      async () => {
        try {
          await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1000) });
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 15_000, message: "backend still answering after quit" }
    )
    .toBe(false);
}

async function readAppVersion(page: Page): Promise<string> {
  const version = await page.evaluate(() => {
    const bridge = (window as unknown as { windowRunnerDesktop?: { getAppInfo(): Promise<{ version: string }> } })
      .windowRunnerDesktop;
    return bridge?.getAppInfo().then((info) => info.version) ?? Promise.resolve("no-bridge");
  });
  return version;
}

test.describe(`upgrade journey (phase: ${phase})`, () => {
  let app: ElectronApplication | undefined;
  let page: Page;
  let origin: string;

  test.afterAll(async () => {
    // Never clean the data dir here: phase "new" and the uninstall assertion
    // after it must still find it. The CI job owns cleanup.
    await app?.close().catch(() => {});
  });

  test("boots the installed app and reports the expected version", async () => {
    ({ app, page, origin } = await bootstrapApp());
    const version = await readAppVersion(page);
    expect(version, `installed app must report version ${expectedVersion}`).toBe(expectedVersion);
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  if (phase === "old") {
    test("creates the marker project, a session, and a completed turn", async () => {
      await app!.evaluate(({ dialog }, dir) => {
        dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog;
      }, markerDir);
      await page.click(tid("choose-project"));
      await expect(page.locator(tid("project-item")).first()).toBeVisible();

      await page.click(tid("new-session"));
      const sessionId = ((await page.locator(tid("session-id")).textContent()) ?? "").trim();
      expect(sessionId).toBeTruthy();

      await page.fill(tid("message-input"), "upgrade journey phase a");
      await page.click(tid("send"));
      const turn = page.locator(tid("turn")).last();
      await expect(turn).toHaveAttribute("data-status", "completed", { timeout: 30_000 });
      await expect(turn).toContainText("[mock]");

      // Persist the phase-A facts where phase B (a fresh process) reads them.
      await fsp.writeFile(path.join(markerDir, "upgrade-session-id.txt"), sessionId, "utf8");

      // The catalog must reference the marker root (also the post-uninstall
      // survival target for the CI job's final assertion).
      const catalogFile = path.join(dataDir, "workspace-catalog.json");
      const catalog = JSON.parse(await fsp.readFile(catalogFile, "utf8")) as { projects: Array<{ root: string }> };
      expect(
        catalog.projects.some((p) => p.root === markerDir),
        `catalog must list the marker project (${catalogFile})`
      ).toBe(true);

      await quitCleanly(app!, origin);
    });
  } else {
    test("the upgraded app still has the project, the session, and its turn — and completes a fresh turn", async () => {
      const sessionId = (await fsp.readFile(path.join(markerDir, "upgrade-session-id.txt"), "utf8")).trim();
      expect(sessionId).toBeTruthy();

      // The workspace catalog survived the in-place upgrade.
      const catalogFile = path.join(dataDir, "workspace-catalog.json");
      const catalog = JSON.parse(await fsp.readFile(catalogFile, "utf8")) as { projects: Array<{ id: string; root: string }> };
      const marker = catalog.projects.find((p) => p.root === markerDir);
      expect(marker, `catalog must still list the marker project after the upgrade`).toBeTruthy();

      // …and the sidebar renders it.
      await expect(page.locator(tid("project-item"), { hasText: markerDir })).toBeVisible();

      // The phase-A session survived and still renders its completed turn.
      await page.click(`[data-testid="project-select-${marker!.id}"]`);
      await expect(page.locator(`[data-testid="session-select-${sessionId}"]`)).toBeVisible({ timeout: 20_000 });
      await page.click(`[data-testid="session-select-${sessionId}"]`);
      await expect(page.locator(tid("turn")).first()).toHaveAttribute("data-status", "completed", { timeout: 20_000 });
      await expect(page.locator(tid("turns"))).toContainText("upgrade journey phase a");

      // A fresh turn completes on the upgraded app.
      await page.fill(tid("message-input"), "upgrade journey phase b");
      await page.click(tid("send"));
      const fresh = page.locator(tid("turn")).last();
      await expect(fresh).toHaveAttribute("data-status", "completed", { timeout: 30_000 });
      await expect(fresh).toContainText("[mock]");

      await quitCleanly(app!, origin);
    });
  }
});
