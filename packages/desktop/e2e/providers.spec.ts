/**
 * Desktop B2 journey (plan B2.5.1) — provider and settings flows in the real
 * Electron shell, isolated from desktop.spec.ts: this file owns its own app
 * lifecycle (boot -> journey -> close), its own per-run data dir, and its own
 * project folder, so the core A2 journey in desktop.spec.ts (boot -> mock turn
 * -> clean shutdown) stays its own story and the two runs cannot leak state
 * into each other.
 *
 * The runner executes spec files serially (playwright.config.ts: one worker,
 * `fullyParallel: false`), so two app lifecycles — one per file — are safe.
 *
 * Journey (the merge gate's provider half):
 *   open a project + session -> /providers list -> create a keyed profile
 *   (key masked, raw key nowhere) -> create/test/activate an offline mock ->
 *   settings sections render read-only -> back to Workspace: session and
 *   catalog survive (navigation metadata only) -> /dashboard loads with the
 *   shared token flow. The offline mock provider needs no keys and no network.
 *
 * Invariants repeated in their user-visible form: the in-memory desktop token
 * never reaches the URL, web storage, the catalog JSON, or visible page text;
 * a raw provider key never appears beyond the form field that typed it.
 */
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { launchDesktopApp } from "./launch.js";

const tid = (id: string) => `[data-testid="${id}"]`;
const PROJECT_DIR = path.join(os.tmpdir(), "wr-desktop-e2e-providers-project");
const RAW_KEY = "sk-desktop-e2e-0123456789abcdef";

let app: ElectronApplication | undefined;
let page: Page;
let backendOrigin: string;
let dataDir: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await fsp.mkdir(PROJECT_DIR, { recursive: true });
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "wr-desktop-e2e-providers-data-"));
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

test("opens a project and session for the provider journey", async () => {
  // The sidebar's "Choose folder…" opens a native dialog; answer it from the
  // main process instead of driving OS UI (same object the IPC handler calls).
  await app!.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog;
  }, PROJECT_DIR);
  await page.click(tid("choose-project"));
  await expect(page.locator(tid("project-item")).first()).toBeVisible();
  await page.click(tid("new-session"));
  await expect(page.locator(tid("session-id"))).toBeVisible({ timeout: 10_000 });
});

test("providers journey: list, masked key, create, test, activate", async () => {
  test.setTimeout(120_000);
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
});

test("settings journey: security, storage, and about render in the shell", async () => {
  await page.click(tid("nav-settings"));
  await expect(page.locator(tid("settings-page"))).toBeVisible();

  await expect(page.locator(tid("settings-nav-security"))).toHaveAttribute("aria-current", "page");
  await expect(page.locator(tid("security-mode"))).toContainText("token");

  await page.click(tid("settings-nav-storage"));
  await expect(page.locator(tid("storage-persistence"))).toContainText("file");

  await page.click(tid("settings-nav-about"));
  await expect(page.locator(tid("about-version"))).toContainText(/\d+\.\d+\.\d+|development/);
});

test("workspace return and dashboard entry keep their boundaries", async () => {
  // Back to Workspace: the B1 catalog and the attached session survive.
  await page.click(tid("nav-workspace"));
  await expect(page.locator(tid("workspace-shell"))).toBeVisible();
  await expect(page.locator(tid("session-id"))).toBeVisible();
  await expect(page.locator(tid("project-item")).first()).toBeVisible();

  // No token and no provider key in: the URL, the workspace catalog file, or
  // the visible page text. (The masked key was asserted on the Providers page;
  // the workspace page deliberately shows no provider data.)
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
  const catalogFile = await app!.evaluate(({ app: electronApp }) => {
    const sep = process.platform === "win32" ? "\\" : "/";
    return `${electronApp.getPath("userData")}${sep}workspace-catalog.json`;
  });
  const catalogRaw = await fsp.readFile(catalogFile, "utf8");
  expect(catalogRaw).not.toContain(token);
  expect(catalogRaw).not.toContain(RAW_KEY);

  // /dashboard loads in the desktop window and offers the shared token flow
  // (fragment/sessionStorage — plan §2 "shared token behavior"): the in-memory
  // desktop token belongs to the /desktop shell document (renderer.ts sets the
  // bootstrap global there only), so the compatibility entry's own token form
  // is the correct surface on a hard load.
  await page.goto(`${backendOrigin}/dashboard`);
  await expect(page.locator(tid("dash-token-form"))).toBeVisible();
});
