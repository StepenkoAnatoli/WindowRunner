/**
 * B3 responsive contract (plan B3.4).
 *
 * The six release widths must not scroll the page sideways. At 800 and below
 * the sidebar and inspector are overlays (and can be collapsed), provider
 * cards are one column, and the add-provider form stays usable. Notices are
 * not sticky overlays. The desktop shell loads this same app.css.
 */
import { test, expect, type Page } from "@playwright/test";
import { E2E_TOKEN, PROVIDERS_PORT } from "./fixture.js";

const tid = (id: string) => `[data-testid="${id}"]`;

const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1100, height: 800 },
  { width: 900, height: 800 },
  { width: 800, height: 800 },
  { width: 640, height: 800 },
] as const;

test.use({ baseURL: `http://127.0.0.1:${PROVIDERS_PORT}` });

async function signIn(page: Page): Promise<void> {
  await page.addInitScript(([token, key]) => window.sessionStorage.setItem(key, token), [
    E2E_TOKEN,
    "windows-runner.token",
  ] as const);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(page.locator(tid("workspace-shell"))).toBeVisible();
}

async function noHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  expect(overflow.doc, "documentElement must not scroll horizontally").toBeLessThanOrEqual(1);
  expect(overflow.body, "body must not scroll horizontally").toBeLessThanOrEqual(1);
}

test("release widths do not scroll sideways on workspace, providers, usage, or settings", async ({ page }) => {
  await signIn(page);
  const pages = [
    { nav: null, id: "workspace-shell" },
    { nav: "nav-providers", id: "providers-page" },
    { nav: "nav-usage", id: "usage-page" },
    { nav: "nav-settings", id: "settings-page" },
  ] as const;

  for (const size of WIDTHS) {
    for (const dest of pages) {
      await page.setViewportSize({ width: 1280, height: 800 });
      if (dest.nav) await page.click(tid(dest.nav));
      else await page.click(tid("nav-workspace"));
      await expect(page.locator(tid(dest.id))).toBeVisible();
      await page.setViewportSize(size);
      await noHorizontalOverflow(page);
    }
  }
});

test("narrow widths collapse the rails, stack provider cards, and keep the form usable", async ({ page }) => {
  await signIn(page);

  for (const size of [
    { width: 800, height: 800 },
    { width: 640, height: 800 },
  ] as const) {
    // Collapse at a wide viewport. A full re-render detaches the toggle, and
    // a retried click would toggle twice — so do not "restore" with a second
    // click. Reload between widths instead (sessionStorage keeps the token).
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator(tid("project-sidebar"))).toBeVisible();
    await page.setViewportSize(size);
    const sidebarInfo = await page.locator(tid("project-sidebar")).evaluate((el) => ({
      position: getComputedStyle(el).position,
      display: getComputedStyle(el).display,
      shell: el.parentElement?.className ?? "",
    }));
    expect(sidebarInfo.position, `sidebar overlays at ${size.width}: ${JSON.stringify(sidebarInfo)}`).toBe("fixed");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.click(tid("toggle-sidebar"));
    await expect(page.locator(tid("project-sidebar"))).toBeHidden();
    await page.click(tid("toggle-inspector"));
    await expect(page.locator(tid("context-inspector"))).toBeHidden();
    await page.setViewportSize(size);
    await noHorizontalOverflow(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.reload();
    await expect(page.locator(tid("workspace-shell"))).toBeVisible();
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click(tid("nav-providers"));
  await expect(page.locator(tid("providers-page"))).toBeVisible();
  await page.setViewportSize({ width: 640, height: 800 });
  const list = page.locator(tid("providers-list"));
  const card = list.locator(tid("dash-card")).first();
  await expect(card).toBeVisible();
  const listBox = await list.boundingBox();
  const cardBox = await card.boundingBox();
  expect(listBox).toBeTruthy();
  expect(cardBox).toBeTruthy();
  expect(cardBox!.width).toBeGreaterThan(listBox!.width * 0.85);

  const add = page.locator(tid("providers-add"));
  await expect(add).toBeVisible();
  const addBox = await add.boundingBox();
  expect(addBox!.width).toBeGreaterThan(24);
  expect(addBox!.height).toBeGreaterThan(24);
  await page.click(tid("providers-add"));
  await expect(page.locator(tid("provider-form"))).toBeVisible();
  await expect(page.locator(tid("provider-label"))).toBeVisible();
  await expect(page.locator(tid("provider-submit"))).toBeVisible();
  await noHorizontalOverflow(page);
  await page.locator(tid("provider-form")).press("Escape");
  await expect(page.locator(tid("provider-form"))).toHaveCount(0);
});

test("banners are not sticky overlays", async ({ page }) => {
  await signIn(page);
  const sticky = await page.evaluate(() => {
    const hits: string[] = [];
    for (const sheet of document.styleSheets) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of rules) {
        if (rule instanceof CSSStyleRule && rule.selectorText.includes(".banner") && rule.style.position === "sticky") {
          hits.push(rule.selectorText);
        }
      }
    }
    return hits;
  });
  expect(sticky).toEqual([]);
  expect(await page.locator('[aria-modal="true"]').count()).toBe(0);
});
