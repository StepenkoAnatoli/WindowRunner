/**
 * Browser E2E for the B2 workspace provider integration, against a dedicated
 * real-bootstrap server (e2e/providers-server.ts — see why it needs its own
 * port there).
 *
 * Covers the plan's scenarios: navigate Workspace → Providers, load profiles,
 * add the mock provider fixture, verify key masking (and that the raw key
 * never appears in the URL, localStorage, the workspace catalog, or the
 * rendered cards), edit without replacing the key (PATCH body carries no
 * apiKey), test (latency/status dot), activate (banner), delete a non-active
 * profile with confirmation, usage records, the three settings sections,
 * return-to-workspace preservation, and the /dashboard compatibility entry.
 */
import { test, expect, type Page } from "@playwright/test";
import { PROVIDERS_PORT, E2E_PROJECT, E2E_TOKEN } from "./fixture.js";

const tid = (id: string) => `[data-testid="${id}"]`;
const RAW_KEY = "sk-e2e-raw-0123456789abcdef";
const RAW_KEY_MASK = "****cdef";

test.use({ baseURL: `http://127.0.0.1:${PROVIDERS_PORT}` });

test.describe.configure({ mode: "serial" });

async function signIn(page: Page): Promise<void> {
  // Same sessionStorage key the main UI writes: the app picks the token up on
  // load and connects automatically (the workspace is the boot route).
  await page.addInitScript(([token, key]) => window.sessionStorage.setItem(key, token), [E2E_TOKEN, "windows-runner.token"]);
  await page.goto("/");
  await expect(page.locator(tid("workspace-shell"))).toBeVisible();
}

async function openProviders(page: Page): Promise<void> {
  await page.click(tid("nav-providers"));
  await expect(page.locator(tid("providers-page"))).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/providers");
}

async function openProjectAndSession(page: Page): Promise<string> {
  await page.fill(tid("project-path-input"), E2E_PROJECT);
  await page.click(tid("open-project"));
  await expect(page.locator(tid("project-item")).first()).toBeVisible();
  await page.click(tid("new-session"));
  await expect(page.locator(tid("session-id"))).toBeVisible({ timeout: 10_000 });
  return (await page.locator(tid("session-id")).textContent())!;
}

test("workspace → providers: add, mask, edit without key, test, activate, delete, usage, back", async ({ page }) => {
  test.setTimeout(90_000);

  // -- 14 (part 1): the URL never carries the key we are about to type.
  await signIn(page);

  // -- 12 (setup): attach a session now; returning from Providers must keep it.
  const sessionId = await openProjectAndSession(page);

  // -- 1: navigate Workspace → Providers from the top-level nav.
  await openProviders(page);

  // -- 2: the profile list loads (first-boot "default" from the env bootstrap).
  const card = (id: string) => page.locator(`${tid("providers-list")} [data-testid="dash-card"][data-id="${id}"]`);
  await expect(page.locator(tid("providers-loading"))).toHaveCount(0);
  await expect(card("default")).toBeVisible();
  await expect(page.locator(tid("providers-active"))).toContainText("Currently using");

  // -- 3: add the mock provider fixture through the shared form.
  await page.click(tid("providers-add"));
  await expect(page.locator(tid("provider-form"))).toBeVisible();
  await page.locator(tid("provider-kind")).selectOption("mock");
  await page.locator(tid("provider-id")).fill("ws-mock");
  await page.locator(tid("provider-label")).fill("WS Mock");
  await page.locator(tid("provider-model")).fill("mock");
  await page.click(tid("provider-submit"));
  await expect(page.locator(tid("provider-form"))).toHaveCount(0);
  await expect(card("ws-mock")).toBeVisible();

  // -- 3b/4: a keyed openai-compatible profile; the key must come back masked.
  await page.click(tid("providers-add"));
  await page.locator(tid("provider-kind")).selectOption("openai-compatible");
  await page.locator(tid("provider-id")).fill("ws-key");
  await page.locator(tid("provider-label")).fill("WS Keyed");
  await page.locator(tid("provider-base-url")).fill("http://127.0.0.1:9/v1");
  await page.locator(tid("provider-model")).fill("keyed-model");
  await page.locator(tid("provider-api-key")).fill(RAW_KEY);
  const keyInputType = await page.locator(tid("provider-api-key")).getAttribute("type");
  expect(keyInputType).toBe("password");
  await page.click(tid("provider-submit"));
  await expect(page.locator(tid("provider-form"))).toHaveCount(0);
  await expect(card("ws-key")).toBeVisible();

  // -- 4/14: masked in the card; the raw key appears nowhere (URL, storage,
  // catalog, page text).
  await expect(card("ws-key").locator(tid("dash-card-key"))).toHaveText(`key: ${RAW_KEY_MASK}`);
  expect(page.url()).not.toContain(RAW_KEY);
  const storage = await page.evaluate(() => ({
    local: JSON.stringify(Object.entries(localStorage)),
    session: JSON.stringify(Object.entries(sessionStorage)),
  }));
  expect(storage.local).not.toContain(RAW_KEY);
  expect(storage.session).not.toContain(RAW_KEY);
  expect(await page.locator("body").innerText()).not.toContain(RAW_KEY);

  // -- 5/6: edit label + model, leave the key blank; the PATCH must not carry
  // an apiKey at all (blank = keep).
  const patches: Array<Record<string, unknown>> = [];
  page.on("request", (req) => {
    if (req.method() === "PATCH" && req.url().includes("/api/providers/")) {
      try {
        patches.push(req.postDataJSON() as Record<string, unknown>);
      } catch {
        /* not JSON — would fail the assertion below anyway */
      }
    }
  });
  await card("ws-key").locator(tid("dash-edit")).click();
  await expect(page.locator(tid("provider-form"))).toBeVisible();
  await expect(page.locator(tid("provider-key-hint"))).toContainText("Leave blank to keep the existing key");
  await expect(page.locator(tid("provider-api-key"))).toHaveValue("");
  await page.locator(tid("provider-label")).fill("WS Keyed v2");
  await page.locator(tid("provider-model")).fill("keyed-model-2");
  await page.click(tid("provider-submit"));
  await expect(page.locator(tid("provider-form"))).toHaveCount(0);
  await expect(card("ws-key").locator(tid("dash-card-label"))).toHaveText("WS Keyed v2");
  await expect(card("ws-key").locator(tid("dash-card-model"))).toContainText("keyed-model-2");
  expect(patches.length).toBeGreaterThanOrEqual(1);
  for (const patch of patches) {
    expect(Object.prototype.hasOwnProperty.call(patch, "apiKey")).toBe(false);
    expect(JSON.stringify(patch)).not.toContain(RAW_KEY);
    expect(JSON.stringify(patch)).not.toContain(RAW_KEY_MASK);
  }
  // The mask survived the edit: the key was NOT replaced.
  await expect(card("ws-key").locator(tid("dash-card-key"))).toHaveText(`key: ${RAW_KEY_MASK}`);

  // -- 7: test the mock provider — status dot flips to ok, notice shows latency.
  await card("ws-mock").locator(tid("dash-test")).click();
  await expect(card("ws-mock").locator(tid("dash-card-status"))).toHaveAttribute("data-ok", "true", { timeout: 15_000 });
  await expect(page.locator(tid("providers-notice"))).toContainText(/test passed: WS Mock answered in \d+ms/);
  // Testing did not activate it: the banner still shows no active profile.
  await expect(page.locator(tid("providers-active"))).not.toContainText("WS Mock");

  // -- 8: activate the mock — banner and card update from the server.
  await card("ws-mock").locator(tid("dash-activate")).click();
  await expect(card("ws-mock")).toHaveAttribute("data-active", "true");
  await expect(page.locator(tid("providers-active"))).toContainText("WS Mock");
  await expect(page.locator(tid("providers-active"))).toContainText("mock · mock");

  // -- 9: delete the NON-active keyed profile with confirmation.
  let confirmed = 0;
  page.on("dialog", (dialog) => {
    confirmed += 1;
    void dialog.accept();
  });
  await card("ws-key").locator(tid("dash-delete")).click();
  await expect(card("ws-key")).toHaveCount(0, { timeout: 15_000 });
  expect(confirmed).toBeGreaterThanOrEqual(1); // delete required the dialog
  // The active profile is untouched.
  await expect(card("ws-mock")).toHaveAttribute("data-active", "true");

  // -- 10: run a workspace turn, then the Usage page shows it.
  await page.click(tid("nav-workspace"));
  await expect(page.locator(tid("workspace-shell"))).toBeVisible();
  await page.fill(tid("message-input"), "hello providers e2e");
  await page.click(tid("send"));
  const turn = page.locator(tid("turn")).last();
  await expect(turn).toHaveAttribute("data-status", "completed", { timeout: 30_000 });

  await page.click(tid("nav-usage"));
  await expect(page.locator(tid("usage-page"))).toBeVisible();
  const row = page.locator('[data-testid="dash-usage-row"]').first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toContainText("WS Mock");
  await expect(row).toContainText("completed");
  await expect(row).toHaveAttribute("data-provider", "ws-mock");

  // -- 12: back to Workspace — session, catalog, and transcript survive.
  await page.click(tid("nav-workspace"));
  await expect(page.locator(tid("workspace-shell"))).toBeVisible();
  await expect(page.locator(tid("session-id"))).toHaveText(sessionId);
  await expect(page.locator(tid("turn")).last()).toContainText("hello providers e2e");
  await expect(page.locator(tid("project-item")).first()).toContainText(E2E_PROJECT.split("/").pop()!);

  // -- 14 (final): the raw key still appears nowhere.
  expect(page.url()).not.toContain(RAW_KEY);
  const finalStorage = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
  expect(finalStorage).not.toContain(RAW_KEY);
  expect(await page.locator("body").innerText()).not.toContain(RAW_KEY);
});

test("settings: security is read-only, storage explains and resets the local catalog only, about shows versions", async ({ page }) => {
  await signIn(page);
  await page.click(tid("nav-settings"));
  await expect(page.locator(tid("settings-page"))).toBeVisible();
  await expect(page.locator(tid("settings-nav-security"))).toHaveAttribute("aria-current", "page");

  // Security: read-only health information.
  await expect(page.locator(tid("security-mode"))).toContainText("token");
  expect(await page.locator(tid("security-page")).locator("button").count()).toBe(0);

  // Storage: server persistence + the catalog explanation + reset.
  await page.click(tid("settings-nav-storage"));
  await expect(page.locator(tid("storage-persistence"))).toContainText("file");
  await expect(page.locator(tid("reset-workspace-catalog"))).toBeVisible();

  // About: version + desktop/browser mode + links.
  await page.click(tid("settings-nav-about"));
  await expect(page.locator(tid("about-version"))).toContainText(/\d+\.\d+\.\d+|development/);
  await expect(page.locator(tid("about-mode"))).toContainText("Browser");
  await expect(page.locator(tid("about-link-repository"))).toBeVisible();

  // Storage reset clears ONLY the local catalog: seed a remembered project,
  // reset, and watch the sidebar empty while providers stay server-side.
  await page.click(tid("nav-workspace"));
  await page.fill(tid("project-path-input"), E2E_PROJECT);
  await page.click(tid("open-project"));
  await expect(page.locator(tid("project-item")).first()).toBeVisible();
  await page.click(tid("nav-settings"));
  await page.click(tid("settings-nav-storage"));
  page.on("dialog", (dialog) => void dialog.accept());
  await page.click(tid("reset-workspace-catalog"));
  await page.click(tid("nav-workspace"));
  await expect(page.locator(tid("no-projects"))).toBeVisible({ timeout: 10_000 });
  // Providers were not touched by the catalog reset.
  await page.click(tid("nav-providers"));
  await expect(page.locator(`${tid("providers-list")} [data-testid="dash-card"]`).first()).toBeVisible();
});

test("/dashboard stays a directly-loadable compatibility entry with the same provider behavior", async ({ page }) => {
  await page.addInitScript(([token, key]) => window.sessionStorage.setItem(key, token), [E2E_TOKEN, "windows-runner.token"]);
  await page.goto("/dashboard");
  expect(new URL(page.url()).pathname).toBe("/dashboard");
  await expect(page.locator(tid("providers-active"))).toBeVisible();
  await expect(page.locator(`${tid("providers-list")} [data-testid="dash-card"][data-id="ws-mock"]`)).toBeVisible();
  await expect(page.locator(`${tid("providers-list")} [data-testid="dash-card"][data-id="ws-mock"]`)).toHaveAttribute("data-active", "true");
  await expect(page.locator(tid("dash-main-link"))).toBeVisible();
  await expect(page.locator(tid("usage-page"))).toBeVisible();
  await expect(page.locator(tid("dash-chat"))).toBeVisible();

  // The shared form works here too.
  await page.click(tid("providers-add"));
  await expect(page.locator(tid("provider-form"))).toBeVisible();
  await page.click(tid("provider-cancel"));
  await expect(page.locator(tid("provider-form"))).toHaveCount(0);
});
