/**
 * Provider dashboard E2E (the real server, real profile bootstrap, no
 * scripted provider): the token shared with the main UI opens the page,
 * then the full plan flow —
 *
 *   add a mock profile → Test (status dot turns ok) → Use this (banner +
 *   card update) → quick chat (the reply streams in, prefixed "[mock]") →
 *   the recent-turns table shows the row (provider label + status).
 *
 * The dashboard runs on its own fixture server (DASH_PORT, see
 * dashboard-server.ts) because this flow hot-swaps the active provider,
 * which the scripted-provider server cannot do.
 */
import { test, expect } from "@playwright/test";
import { DASH_PORT, DASH_STOP_PORT, E2E_PROJECT, E2E_TOKEN } from "./fixture.js";

test.describe("provider dashboard", () => {
  test.use({ baseURL: `http://127.0.0.1:${DASH_PORT}` });

  test.beforeEach(async ({ page }) => {
    // Same sessionStorage key the main UI writes (src/api.ts TOKEN_KEY): the
    // dashboard picks the token up on load and connects automatically.
    await page.addInitScript(([token, key]) => window.sessionStorage.setItem(key, token), [E2E_TOKEN, "windows-runner.token"]);
  });

  test("add → test → activate → quick chat → usage row", async ({ page }) => {
    const card = (id: string) => page.locator(`[data-testid="dash-card"][data-id="${id}"]`);
    await page.goto("/dashboard");

    // Auto-connect with the shared token: the banner appears, and the
    // first-boot "default" profile card is listed (env bootstrap).
    await expect(page.locator('[data-testid="dash-banner"]')).toBeVisible();
    await expect(card("default")).toBeVisible();
    await expect(page.locator('[data-testid="dash-token-input"]')).toHaveCount(0);

    // Add the mock profile under test (the preset pre-fills model + label).
    await page.locator('[data-testid="dash-add"]').click();
    await page.locator('[data-testid="dash-preset"]').selectOption("mock");
    await page.locator('[data-testid="dash-id"]').fill("dash-mock");
    await page.locator('[data-testid="dash-label"]').fill("Dash Mock");
    await expect(page.locator('[data-testid="dash-model"]')).toHaveValue("mock");
    await page.locator('[data-testid="dash-save"]').click();

    await expect(card("dash-mock")).toBeVisible();
    await expect(card("dash-mock").locator('[data-testid="dash-card-label"]')).toHaveText("Dash Mock");
    // The created card shows the masked key placeholder, never a raw key.
    await expect(page.locator('[data-testid="dash-form"]')).toHaveCount(0);

    // Test: the status dot on the card turns ok (lastTest persisted).
    await card("dash-mock").locator('[data-testid="dash-test"]').click();
    await expect(card("dash-mock").locator('[data-testid="dash-card-status"]')).toHaveAttribute("data-ok", "true", { timeout: 15_000 });

    // Activate: the banner names the new profile and the card is flagged.
    await card("dash-mock").locator('[data-testid="dash-activate"]').click();
    await expect(card("dash-mock")).toHaveAttribute("data-active", "true");
    await expect(page.locator('[data-testid="dash-banner"]')).toContainText("Dash Mock");
    await expect(card("default")).toHaveAttribute("data-active", "false");

    // Quick chat: one turn to the newly active profile, streamed.
    await page.locator('[data-testid="dash-cwd"]').fill(E2E_PROJECT);
    await page.locator('[data-testid="dash-message"]').fill("hello dashboard");
    await page.locator('[data-testid="dash-send"]').click();

    const reply = page.locator('[data-testid="dash-reply"]');
    await expect(reply).toBeVisible();
    await expect(reply).toContainText("[mock]", { timeout: 20_000 });
    await expect(reply).toContainText("hello dashboard", { timeout: 20_000 });

    // The recent-turns table picks the finished turn up: provider label and
    // a completed status, newest first (it is the only row).
    const row = page.locator('[data-testid="dash-usage-row"]');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Dash Mock");
    await expect(row).toContainText("completed");
    await expect(row).toHaveAttribute("data-provider", "dash-mock");
  });
});

test.describe("provider dashboard quick chat", () => {
  // A dedicated fixture server (e2e/dashboard-stop-server.ts) whose mock
  // streams with a per-chunk delay, so the turn is still running when Stop is
  // clicked. It must be a server of its own: an injected slow provider is
  // replaced by a plain fast mock the moment any profile is activated, and the
  // DASH_PORT fixture above activates one.
  test.use({ baseURL: `http://127.0.0.1:${DASH_STOP_PORT}` });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(([token, key]) => window.sessionStorage.setItem(key, token), [E2E_TOKEN, "windows-runner.token"]);
  });

  test("Stop cancels an in-flight quick chat turn and records it as cancelled", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.locator('[data-testid="dash-banner"]')).toBeVisible();

    await page.locator('[data-testid="dash-cwd"]').fill(E2E_PROJECT);
    await page.locator('[data-testid="dash-message"]').fill("please stop");
    await page.locator('[data-testid="dash-send"]').click();

    // Stop appears once there is a turn id to cancel, and Send is disabled
    // while the turn runs.
    const stop = page.locator('[data-testid="dash-chat-stop"]');
    await expect(stop).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="dash-send"]')).toBeDisabled();

    await stop.click();

    // The cancellation is confirmed by the server's own turn_cancelled event,
    // not by the client giving up: the stream stays open to receive it.
    await expect(page.locator('[data-testid="dash-chat-status"]')).toContainText("cancelled", { timeout: 20_000 });
    await expect(page.locator('[data-testid="dash-chat-stop"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="dash-send"]')).toBeEnabled();

    // The cancelled turn still lands in the usage table (newest first).
    const row = page.locator('[data-testid="dash-usage-row"]').first();
    await expect(row).toHaveAttribute("data-status", "cancelled", { timeout: 15_000 });
  });
});
