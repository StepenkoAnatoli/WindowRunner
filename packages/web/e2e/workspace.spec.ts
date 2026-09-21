import { test, expect, type Page } from "@playwright/test";
import { E2E_PROJECT, E2E_TOKEN } from "./fixture.js";

/**
 * Browser E2E for the B1 three-column workspace (sidebar | chat | inspector)
 * against the real server + scripted provider (see e2e/server.ts).
 *
 * Covers the B1 contract: three stable regions, sidebar project/session
 * management over the persisted local catalog, inspector tabs driven by the
 * same turn state as the center, blocked switching during an active turn,
 * and the documented limits — no transcript recovery after reload/reattach,
 * and no completed-file diff claim in Changes.
 */

const tid = (id: string) => `[data-testid="${id}"]`;

async function signIn(page: Page) {
  await page.goto("/");
  await page.fill(tid("token-input"), E2E_TOKEN);
  await page.click(tid("token-submit"));
  await expect(page.locator(tid("workspace-shell"))).toBeVisible();
}

async function openProject(page: Page, cwd = E2E_PROJECT) {
  await page.fill(tid("project-path-input"), cwd);
  await page.click(tid("open-project"));
  await expect(page.locator(tid("project-item")).first()).toBeVisible();
}

async function newSession(page: Page, previous?: string | null) {
  await page.click(tid("new-session"));
  const id = page.locator(tid("session-id"));
  if (previous) await expect(id).not.toHaveText(previous, { timeout: 10_000 });
  else await expect(id).toBeVisible({ timeout: 10_000 });
  return (await id.textContent())!;
}

async function send(page: Page, message: string) {
  const before = await page.locator(tid("turn")).count();
  await page.fill(tid("message-input"), message);
  await page.click(tid("send"));
  await expect(page.locator(tid("turn"))).toHaveCount(before + 1);
  return page.locator(tid("turn")).nth(before);
}

test("sidebar, chat, and inspector render as distinct regions", async ({ page }) => {
  await signIn(page);
  await expect(page.locator(tid("workspace-shell"))).toBeVisible();
  await expect(page.locator(tid("project-sidebar"))).toBeVisible();
  await expect(page.locator(tid("conversation-workspace"))).toBeVisible();
  await expect(page.locator(tid("context-inspector"))).toBeVisible();
  for (const tab of ["approvals", "activity", "context", "changes"]) {
    await expect(page.locator(tid(`inspector-tab-${tab}`))).toBeVisible();
  }
  // No session yet: the center says so, the inspector context tab agrees.
  await expect(page.locator(tid("no-session"))).toBeVisible();
  await expect(page.locator(tid("inspector-empty"))).toContainText("No session attached");
});

test("projects and sessions persist in the local catalog across reloads (without transcripts)", async ({ page }) => {
  await signIn(page);
  await openProject(page);
  const id = await newSession(page);
  const turn = await send(page, "hello");
  await expect(turn).toHaveAttribute("data-status", "completed");

  await page.reload();
  // Auto-reconnected from sessionStorage; the catalog came back from
  // localStorage — but nothing is attached and no transcript is claimed.
  await expect(page.locator(tid("project-sidebar"))).toBeVisible();
  await expect(page.locator(tid("project-item")).first()).toContainText(E2E_PROJECT.split("/").pop()!);
  await expect(page.locator(tid("no-session"))).toBeVisible();
  await expect(page.locator(tid("turn"))).toHaveCount(0);

  // Reattach the remembered session: re-open the project (deduped by root),
  // then pick the remembered session. The server still has it
  // (SESSION_ALREADY_EXISTS path), but previous turns are not reconstructed.
  await openProject(page);
  await expect(page.locator(tid("session-item")).first()).toBeVisible();
  await page.locator(tid("session-item")).first().locator("button").click();
  await expect(page.locator(tid("session-id"))).toHaveText(id);
  await expect(page.locator(tid("turn"))).toHaveCount(0);
  await expect(page.locator(tid("turn-form"))).toBeVisible();
});

test("approval previews match between center and inspector; inspector can decide", async ({ page }) => {
  await signIn(page);
  await openProject(page);
  await newSession(page);
  const turn = await send(page, "edit: src/app.ts");
  const center = turn.locator(tid("approval"));
  await expect(center).toBeVisible();

  // The inspector auto-followed onto the approvals tab with the same card.
  const side = page.locator(tid("inspector-approval"));
  await expect(side).toBeVisible();
  await expect(side).toContainText("edit_file");
  const centerPreview = await turn.locator(tid("approval-preview")).textContent();
  const sidePreview = await page.locator(tid("inspector-approval-preview")).textContent();
  expect(sidePreview).toBe(centerPreview);

  // Changes tab shows the pending write/edit preview (and only pending ones).
  await page.click(tid("inspector-tab-changes"));
  await expect(page.locator(tid("inspector-change-preview"))).toBeVisible();

  // Decide from the inspector: the turn completes; the activity timeline
  // records the finished tool.
  await page.click(tid("inspector-tab-approvals"));
  await page.click(tid("inspector-approve"));
  await expect(turn).toHaveAttribute("data-status", "completed");
  await page.click(tid("inspector-tab-activity"));
  const item = page.locator(tid("tool-activity-item")).first();
  await expect(item).toContainText("edit_file");
  await expect(item.locator(tid("tool-activity-status"))).toHaveText("done");

  // After resolution there is no pending change — and B1 does not pretend
  // completed file history exists.
  await page.click(tid("inspector-tab-changes"));
  await expect(page.locator(tid("inspector-empty"))).toHaveText(
    "No pending file change preview. Completed file-change history is not available in this release."
  );
});

test("switching sessions during an active turn is visibly blocked, then works after Stop", async ({ page }) => {
  await signIn(page);
  await openProject(page);
  const first = await newSession(page);
  const second = await newSession(page, first);
  expect(second).not.toBe(first);

  const turn = await send(page, "hang");
  await expect(turn).toHaveAttribute("data-status", "running");
  await expect(page.locator(tid("session-switch-blocked"))).toContainText(
    "Finish or stop the active turn before switching sessions."
  );
  await expect(page.locator(tid("new-session"))).toBeDisabled();
  await expect(page.locator(tid("project-path-input"))).toBeDisabled();
  await expect(page.locator(tid("send"))).toBeDisabled();
  await expect(page.locator(tid("cancel"))).toBeVisible();

  await page.click(tid("cancel"));
  await expect(turn).toHaveAttribute("data-status", "cancelled");
  await expect(page.locator(tid("session-switch-blocked"))).toHaveCount(0);

  // Switch to the remembered first session: reattached fresh, no transcript.
  await page.locator(tid("session-item"), { hasText: first }).locator("button").click();
  await expect(page.locator(tid("session-id"))).toHaveText(first);
  await expect(page.locator(tid("turn"))).toHaveCount(0);
});

test("the inspector collapses at narrow widths without breaking Send/Stop", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await signIn(page);
  await openProject(page);
  await newSession(page);

  await page.click(tid("toggle-inspector"));
  await expect(page.locator(tid("context-inspector"))).toBeHidden();

  const turn = await send(page, "slow: alpha beta");
  await expect(page.locator(tid("cancel"))).toBeVisible();
  await expect(turn.locator(tid("turn-text"))).toHaveText("alpha beta");
  await expect(turn).toHaveAttribute("data-status", "completed");

  await page.click(tid("toggle-inspector"));
  await expect(page.locator(tid("context-inspector"))).toBeVisible();
  await page.click(tid("toggle-sidebar"));
  await expect(page.locator(tid("project-sidebar"))).toBeHidden();
  await page.click(tid("toggle-sidebar"));
  await expect(page.locator(tid("project-sidebar"))).toBeVisible();
});
