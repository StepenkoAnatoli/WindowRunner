/**
 * B2 accessibility coverage (plan B2.5.2) for the B2 routes: top-level
 * navigation, Providers, Usage, Settings, and the /dashboard token form.
 *
 * Plan rule: "Do not introduce an accessibility dependency unless the
 * repository already uses one." The repo uses none — these checks are the
 * platform's own semantics: labels, roles, focus-visible outlines, keyboard
 * activation, dialog copy, and reflow at narrow widths (app.css promises "the
 * page never scrolls horizontally").
 *
 * Scope discipline (B2.4 lesson): this file covers what the existing suites do
 * not pin at browser level — accessibility semantics. Provider behavior stays
 * in providers-workspace.spec.ts / dashboard.spec.ts. Everything here is
 * read-only against the shared providers fixture server: forms are opened and
 * cancelled, the delete confirmation is dismissed; no profile is created,
 * edited, tested, or deleted.
 */
import { test, expect, type Page, type Dialog } from "@playwright/test";
import { PROVIDERS_PORT, DASH_PORT, E2E_TOKEN } from "./fixture.js";

const tid = (id: string) => `[data-testid="${id}"]`;

test.use({ baseURL: `http://127.0.0.1:${PROVIDERS_PORT}` });

async function signIn(page: Page): Promise<void> {
  // Same sessionStorage key the main UI writes (see providers-workspace.spec.ts).
  await page.addInitScript(([token, key]) => window.sessionStorage.setItem(key, token), [
    E2E_TOKEN,
    "windows-runner.token",
  ]);
  await page.goto("/");
  await expect(page.locator(tid("workspace-shell"))).toBeVisible();
}

async function noHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
    win: document.body.scrollWidth - window.innerWidth,
  }));
  expect(overflow.doc, "documentElement must not scroll horizontally").toBeLessThanOrEqual(0);
  expect(overflow.body, "body must not scroll horizontally").toBeLessThanOrEqual(0);
  expect(overflow.win, "viewport must not scroll horizontally").toBeLessThanOrEqual(0);
}

test("top navigation exposes named destinations and a visible keyboard focus ring", async ({ page }) => {
  await signIn(page);

  // The four top-level destinations (plan §2) are real controls with names.
  for (const id of ["nav-workspace", "nav-providers", "nav-usage", "nav-settings"]) {
    const name = (await page.locator(tid(id)).textContent())?.trim() ?? "";
    expect(name, `${id} must have an accessible name`).not.toBe("");
  }

  // First keyboard stop shows the stylesheet's focus-visible ring
  // (`outline: 2px solid var(--primary)` on :focus-visible — app.css).
  await page.locator("body").click({ position: { x: 2, y: 2 } });
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const s = getComputedStyle(el);
    return { tag: el.tagName, outline: s.outlineStyle, width: s.outlineWidth };
  });
  expect(focused, "Tab must move focus to a control").not.toBeNull();
  expect(focused!.tag).toMatch(/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/);
  expect(focused!.outline, "keyboard focus must show an outline (focus-visible)").not.toBe("none");
});

test("provider form fields are labeled and validation errors are announced and associated", async ({ page }) => {
  await signIn(page);
  await page.click(tid("nav-providers"));
  await expect(page.locator(tid("providers-page"))).toBeVisible();
  await page.click(tid("providers-add"));
  await expect(page.locator(tid("provider-form"))).toBeVisible();

  // Every input sits in a real <label> whose text names the field.
  for (const [id, name] of [
    ["provider-label", "Label"],
    ["provider-model", "Model"],
    ["provider-api-key", "API key"],
  ] as const) {
    const labelOf = await page.locator(tid(id)).evaluate((el: HTMLInputElement) =>
      Array.from(el.labels ?? []).map((l) => l.textContent ?? "").join(" ")
    );
    expect(labelOf, `${id} must be labeled`).toContain(name);
  }

  // Accessible masked-key explanation in create mode (plan: "accessible
  // masked-key explanation"): where the key goes, and that it is never kept.
  const createHint = (await page.locator(tid("provider-form")).textContent()) ?? "";
  expect(createHint).toContain("Stored only server-side");
  expect(createHint).toContain("masked (****last4)");

  // Empty submit validates client-side: each required field gets a
  // role=alert error that is aria-describedby-linked from an aria-invalid
  // input (provider-form.ts contract).
  await page.click(tid("provider-submit"));
  for (const field of ["profileId", "label", "model"]) {
    const err = page.locator(`${tid("provider-field-error")}[data-field="${field}"]`);
    await expect(err).toBeVisible();
    await expect(err).toHaveAttribute("role", "alert");
    const errId = await err.getAttribute("id");
    expect(errId).toBeTruthy();
    const inputId =
      field === "profileId" ? "provider-id" : field === "label" ? "provider-label" : "provider-model";
    const input = page.locator(tid(inputId));
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(input).toHaveAttribute("aria-describedby", errId!);
  }

  // Escape cancels a clean form (the form's keydown handler — no dirty state).
  await page.locator(tid("provider-form")).press("Escape");
  await expect(page.locator(tid("provider-form"))).toHaveCount(0);
});

test("edit form explains the masked key and keeps kind and id immutable", async ({ page }) => {
  await signIn(page);
  await page.click(tid("nav-providers"));
  await expect(page.locator(tid("providers-list"))).toBeVisible();
  const card = page.locator(`${tid("dash-card")}`).first();
  await expect(card).toBeVisible();
  await card.locator(tid("dash-edit")).click();

  const form = page.locator(tid("provider-form"));
  await expect(form).toBeVisible();
  // Masked-key explanation in edit mode: blank keeps the existing key, and if
  // the server returned a mask it renders display-only (****last4).
  await expect(page.locator(tid("provider-key-hint"))).toContainText("Leave blank to keep the existing key");
  const masked = page.locator(tid("provider-key-masked"));
  if ((await masked.count()) > 0) {
    await expect(masked).toContainText(/\*\*\*\*/);
  }
  // Immutable identity is announced (not silently locked inputs).
  await expect(page.locator(tid("provider-kind-fixed"))).toContainText("immutable");
  // The API key field never carries a prefilled secret.
  await expect(page.locator(tid("provider-api-key"))).toHaveValue("");

  // Cancel with the button (edit state may count as dirty for Escape).
  await page.click(tid("provider-cancel"));
  await expect(page.locator(tid("provider-form"))).toHaveCount(0);
});

test("card actions have button names and the delete confirmation reads back what it will delete", async ({ page }) => {
  await signIn(page);
  await page.click(tid("nav-providers"));
  await expect(page.locator(tid("providers-list"))).toBeVisible();
  const card = page.locator(tid("dash-card")).first();
  await expect(card).toBeVisible();

  for (const id of ["dash-activate", "dash-test", "dash-edit", "dash-delete"]) {
    const btn = card.locator(tid(id));
    const name = (await btn.textContent())?.trim() ?? "";
    expect(name, `${id} must have an accessible name`).not.toBe("");
    expect(await btn.evaluate((el: HTMLElement) => el.tagName)).toBe("BUTTON");
  }

  // The confirmation is a native confirm() with the profile's label and id in
  // the message (and an ACTIVE warning when the target is active) — readable
  // copy is the accessible part of the plan's "modal/confirmation" item; the
  // dialog itself is focus-managed by the platform. Dismissed: no mutation.
  const dialogSeen = new Promise<string>((resolve) => {
    page.once("dialog", async (d: Dialog) => {
      resolve(d.message());
      await d.dismiss();
    });
  });
  await card.locator(tid("dash-delete")).click();
  const message = await dialogSeen;
  expect(message).toMatch(/^Delete profile “.+” \(.+\)/);
  await expect(page.locator(tid("providers-list"))).toBeVisible();
});

test("settings tabs announce their state and work from the keyboard", async ({ page }) => {
  await signIn(page);
  await page.click(tid("nav-settings"));
  await expect(page.locator(tid("settings-page"))).toBeVisible();

  // Tab semantics (plan B2.5.2): a labeled sections nav of named tabs where
  // aria-current="page" marks the selected one (settings-shell.ts contract).
  await expect(page.locator(tid("settings-nav"))).toHaveAttribute("aria-label", "Settings sections");
  await expect(page.locator(tid("settings-nav-security"))).toHaveAttribute("aria-current", "page");
  await expect(page.locator(tid("settings-nav-storage"))).not.toHaveAttribute("aria-current", "page");

  // Keyboard activation: Enter on a tab switches sections and moves
  // aria-current with it.
  await page.locator(tid("settings-nav-storage")).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(tid("storage-page"))).toBeVisible();
  await expect(page.locator(tid("settings-nav-storage"))).toHaveAttribute("aria-current", "page");
  await expect(page.locator(tid("settings-nav-security"))).not.toHaveAttribute("aria-current", "page");

  await page.locator(tid("settings-nav-about")).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(tid("about-page"))).toBeVisible();
  await expect(page.locator(tid("settings-nav-about"))).toHaveAttribute("aria-current", "page");
});

test("B2 routes reflow without horizontal scrolling at narrow and wide viewports", async ({ page }) => {
  await signIn(page);

  // app.css: "the page never scrolls horizontally" — pin it at a phone width
  // and at the route-page measure for the providers, usage, and settings
  // routes (plan: "no horizontal overflow; responsive providers page").
  // In-app navigation only: hard reloads of app routes are a documented
  // limitation (the server serves HTML for `/` and `/dashboard` only — plan
  // appendix 5), so route changes go through the shell's nav controls.
  // Nav clicks happen at a wide viewport — below 800px the B1 rails become
  // fixed overlays over the header (app.css) — then the window narrows and the
  // route must reflow without horizontal scrolling (the real resize scenario).
  for (const viewport of [
    { width: 360, height: 740 },
    { width: 720, height: 900 },
  ]) {
    for (const [nav, pageId] of [
      ["nav-providers", "providers-page"],
      ["nav-usage", "usage-page"],
      ["nav-settings", "settings-page"],
    ] as const) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.click(tid(nav));
      await expect(page.locator(tid(pageId))).toBeVisible();
      await page.setViewportSize(viewport);
      await noHorizontalOverflow(page);
    }
  }

  // The providers page keeps its controls usable at the narrow width: the add
  // button is in view and clickable-sized.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.click(tid("nav-providers"));
  await expect(page.locator(tid("providers-page"))).toBeVisible();
  await page.setViewportSize({ width: 360, height: 740 });
  const add = page.locator(tid("providers-add"));
  await expect(add).toBeVisible();
  const box = await add.boundingBox();
  expect(box!.width).toBeGreaterThan(24);
  expect(box!.height).toBeGreaterThan(24);
});

test("/dashboard token form is labeled and shares the focus contract", async ({ page }) => {
  // No token anywhere: the dashboard must show the shared token form
  // (dash-token-form), styled by dashboard.css only. Absolute URL: the file's
  // baseURL points at the providers fixture server.
  await page.goto(`http://127.0.0.1:${DASH_PORT}/dashboard`);
  await expect(page.locator(tid("dash-token-form"))).toBeVisible();

  const input = page.locator(tid("dash-token-input"));
  const name = await input.evaluate((el: HTMLInputElement) => {
    const label = Array.from(el.labels ?? []).map((l) => l.textContent ?? "").join(" ");
    return label || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";
  });
  expect(name.trim(), "token input must have an accessible name").not.toBe("");

  // Focus contract applies to the compatibility entry's own stylesheet.
  await input.focus();
  const outline = await input.evaluate((el: HTMLElement) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe("none");
  await noHorizontalOverflow(page);
});
