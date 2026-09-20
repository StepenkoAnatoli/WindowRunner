import { test, expect, type Page } from "@playwright/test";
import { E2E_PROJECT, E2E_TOKEN, MCP_CONFIG_HASH } from "./server.js";

/**
 * Browser E2E for the web UI against the real server + scripted provider
 * (see e2e/server.ts). Every test starts from a fresh tab; the token lives in
 * sessionStorage so nothing leaks between tests.
 */

const tid = (id: string) => `[data-testid="${id}"]`;

async function signIn(page: Page, token = E2E_TOKEN) {
  await page.goto("/");
  await page.fill(tid("token-input"), token);
  await page.click(tid("token-submit"));
}

async function createSession(page: Page, id = `s-${Date.now().toString(36)}`, cwd = E2E_PROJECT) {
  await page.fill(tid("session-id-input"), id);
  await page.fill(tid("cwd-input"), cwd);
  await page.click(tid("create-session"));
  await expect(page.locator(tid("session-id"))).toHaveText(id);
  return id;
}

async function send(page: Page, message: string) {
  const before = await page.locator(tid("turn")).count();
  await page.fill(tid("message-input"), message);
  await page.click(tid("send"));
  await expect(page.locator(tid("turn"))).toHaveCount(before + 1);
  return page.locator(tid("turn")).nth(before);
}

test.describe("authentication", () => {
  test("rejects a wrong token, accepts the right one, and keeps it out of the URL", async ({ page }) => {
    await signIn(page, "definitely-wrong-token-000000");
    await expect(page.locator(tid("auth-error"))).toContainText("401");
    await page.fill(tid("token-input"), E2E_TOKEN);
    await page.click(tid("token-submit"));
    await expect(page.locator(tid("server-info"))).toContainText("auth token");
    await expect(page.locator(tid("session-form"))).toBeVisible();
    expect(page.url()).not.toContain(E2E_TOKEN);
    expect(await page.evaluate(() => sessionStorage.getItem("windows-runner.token"))).toBe(E2E_TOKEN);
  });

  test("picks the token up from the URL fragment (what the banner prints) and strips it", async ({ page }) => {
    await page.goto(`/#token=${E2E_TOKEN}`);
    await expect(page.locator(tid("session-form"))).toBeVisible();
    expect(page.url()).not.toContain("token=");
  });

  test("every API request carries the bearer header; sign out forgets it", async ({ page }) => {
    const authHeaders: (string | undefined)[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/")) authHeaders.push(req.headers()["authorization"]);
    });
    await signIn(page);
    await createSession(page);
    const turn = await send(page, "hello");
    await expect(turn).toHaveAttribute("data-status", "completed");
    expect(authHeaders.length).toBeGreaterThanOrEqual(4);
    for (const h of authHeaders) expect(h).toBe(`Bearer ${E2E_TOKEN}`);
    await page.click(tid("sign-out"));
    await expect(page.locator(tid("token-form"))).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem("windows-runner.token"))).toBeNull();
  });
});

test.describe("sessions", () => {
  test("refuses a folder outside the allowed roots with an actionable error", async ({ page }) => {
    await signIn(page);
    await page.fill(tid("session-id-input"), "outside");
    await page.fill(tid("cwd-input"), "/");
    await page.click(tid("create-session"));
    const banner = page.locator(tid("error-banner"));
    await expect(banner).toContainText("PATH_ESCAPES_ROOT");
    await page.click(tid("dismiss-error"));
    await expect(banner).toHaveCount(0);
  });

  test("creates, shows root and trust status, and deletes", async ({ page }) => {
    await signIn(page);
    await createSession(page, "life");
    await expect(page.locator(tid("session-root"))).toHaveText(E2E_PROJECT);
    await expect(page.locator(tid("trust-status"))).toContainText("not trusted");
    await page.click(tid("delete-session"));
    await expect(page.locator(tid("session-form"))).toBeVisible();
  });
});

test.describe("turns", () => {
  test("shows a running turn with Stop, then the streamed text, completed with usage", async ({ page }) => {
    await signIn(page);
    await createSession(page);
    const turn = await send(page, "slow: one two three four five");
    await expect(turn).toHaveAttribute("data-status", "running");
    await expect(page.locator(tid("cancel"))).toBeVisible();
    await expect(turn.locator(tid("turn-text"))).toHaveText("one two three four five");
    await expect(turn).toHaveAttribute("data-status", "completed");
    await expect(turn.locator(tid("turn-status"))).toContainText("completed · 10 tokens");
    await expect(page.locator(tid("cancel"))).toHaveCount(0);
  });

  test("Stop cancels a hanging turn", async ({ page }) => {
    await signIn(page);
    await createSession(page);
    const turn = await send(page, "hang");
    await expect(turn).toHaveAttribute("data-status", "running");
    await page.click(tid("cancel"));
    await expect(turn).toHaveAttribute("data-status", "cancelled");
    await expect(turn.locator(tid("turn-status"))).toContainText("cancelled");
    await expect(page.locator(tid("send"))).toBeEnabled();
  });

  test("shows a provider failure as a failed turn and allows the next turn", async ({ page }) => {
    await signIn(page);
    await createSession(page);
    const failed = await send(page, "fail");
    await expect(failed).toHaveAttribute("data-status", "failed");
    await expect(failed.locator(tid("turn-status"))).toContainText("MODEL_FAILED");
    const next = await send(page, "again");
    await expect(next).toHaveAttribute("data-status", "completed");
    await expect(page.locator(tid("turn"))).toHaveCount(2);
  });

  test("reconnects with Last-Event-ID after the stream is cut and does not duplicate text", async ({ page }) => {
    await signIn(page);
    await createSession(page);
    const eventRequests: Array<{ lastEventId?: string; auth?: string }> = [];
    page.on("request", (req) => {
      if (/\/events(\?|$)/.test(req.url())) {
        const h = req.headers();
        eventRequests.push({ lastEventId: h["last-event-id"], auth: h["authorization"] });
      }
    });
    // Arm the fixture proxy: the next /events response is severed right after turn_started (seq 1).
    await page.request.post("/__e2e/cut-next-events");
    const turn = await send(page, "slow: alpha beta gamma delta epsilon zeta");
    await expect(turn.locator(tid("turn-text"))).toHaveText("alpha beta gamma delta epsilon zeta", { timeout: 15_000 });
    await expect(turn).toHaveAttribute("data-status", "completed");
    expect(eventRequests.length).toBeGreaterThanOrEqual(2);
    expect(eventRequests[0].lastEventId).toBeUndefined();
    expect(eventRequests[1].lastEventId).toBe("1");
    for (const r of eventRequests) expect(r.auth).toBe(`Bearer ${E2E_TOKEN}`);
  });
});

test.describe("approvals", () => {
  test("shows the approval card, approve runs the tool", async ({ page }) => {
    await signIn(page);
    await createSession(page);
    const turn = await send(page, "approve: ls -la");
    const card = turn.locator(tid("approval"));
    await expect(card).toBeVisible();
    await expect(card).toContainText("run_terminal");
    await expect(card).toContainText('run "ls -la"');
    await expect(turn).toHaveAttribute("data-status", "waiting_for_approval");
    await page.click(tid("approve"));
    await expect(card).toHaveCount(0);
    await expect(turn.locator(tid("tool")).first()).toHaveAttribute("data-status", "done");
    await expect(turn.locator(tid("turn-text"))).toContainText("pretended to run: ls -la");
    await expect(turn).toHaveAttribute("data-status", "completed");
  });

  test("deny reports APPROVAL_DENIED and the turn still completes", async ({ page }) => {
    await signIn(page);
    await createSession(page);
    const turn = await send(page, "approve: rm -rf /");
    await page.click(tid("deny"));
    await expect(turn.locator(tid("tool")).first()).toContainText("APPROVAL_DENIED");
    await expect(turn.locator(tid("turn-text"))).toContainText("APPROVAL_DENIED");
    await expect(turn).toHaveAttribute("data-status", "completed");
  });
});

test.describe("project trust", () => {
  test("untrusted project is refused, granting trust from the prompt lets the next turn run, revoke works", async ({ page }) => {
    await signIn(page);
    await createSession(page, `trust-${Date.now().toString(36)}`);
    const first = await send(page, "trust: what time is it");
    await expect(first.locator(tid("tool")).first()).toContainText("PROJECT_NOT_TRUSTED");
    await expect(first).toHaveAttribute("data-status", "completed");
    const prompt = page.locator(tid("trust-prompt"));
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText(".mcp.json");
    await expect(prompt).toContainText(MCP_CONFIG_HASH);
    await page.click(tid("grant-trust"));
    await expect(prompt).toHaveCount(0);
    await expect(page.locator(tid("trust-status"))).toContainText("trusted");
    const second = await send(page, "trust: what time is it");
    await expect(second.locator(tid("turn-text"))).toContainText("mcp answered: what time is it");
    await expect(second).toHaveAttribute("data-status", "completed");
    await page.click(tid("revoke-trust"));
    await expect(page.locator(tid("trust-status"))).toContainText("not trusted");
    const third = await send(page, "trust: again");
    await expect(third.locator(tid("tool")).first()).toContainText("PROJECT_NOT_TRUSTED");
  });
});
