/**
 * B3 deep-route refresh (plan B3.2).
 *
 * A direct load and a reload of each allowlisted route must serve the main
 * app shell, authenticate with the existing sessionStorage token (never a
 * token in the URL), and land on the matching page. Returning to Workspace
 * keeps the navigation catalog. Transcripts are not restored — B1 never
 * persisted them.
 *
 * Read-only against the providers fixture: no profile is created or deleted.
 */
import { test, expect, type Page } from "@playwright/test";
import { E2E_PROJECT, E2E_TOKEN, PROVIDERS_PORT } from "./fixture.js";

const tid = (id: string) => `[data-testid="${id}"]`;
const CATALOG_KEY = "windows-runner.workspace-catalog.v1";
const TOKEN_KEY = "windows-runner.token";
const CATALOG = {
  version: 1,
  projects: [{ id: "p-deep", root: E2E_PROJECT, label: "deep-project", lastOpenedAt: 1 }],
  sessions: [{ sessionId: "s-deep", projectId: "p-deep", lastOpenedAt: 2 }],
};

const ROUTES = [
  { path: "/providers", pageId: "providers-page" },
  { path: "/usage", pageId: "usage-page" },
  { path: "/settings/security", pageId: "security-page" },
  { path: "/settings/storage", pageId: "storage-page" },
  { path: "/settings/about", pageId: "about-page" },
] as const;

test.use({ baseURL: `http://127.0.0.1:${PROVIDERS_PORT}` });

async function seed(page: Page): Promise<void> {
  await page.addInitScript(
    ([token, tokenKey, catalogKey, catalog]) => {
      window.sessionStorage.setItem(tokenKey, token);
      window.localStorage.setItem(catalogKey, catalog);
    },
    [E2E_TOKEN, TOKEN_KEY, CATALOG_KEY, JSON.stringify(CATALOG)] as const
  );
}

async function tokenNotInUrl(page: Page): Promise<void> {
  const url = page.url();
  expect(url).not.toContain(E2E_TOKEN);
  expect(url).not.toContain("token=");
}

test.describe("deep-route refresh", () => {
  for (const route of ROUTES) {
    test(`${route.path} survives a direct load and a reload`, async ({ page }) => {
      await seed(page);
      const response = await page.goto(route.path);
      expect(response?.status(), `${route.path} must be served, not 404`).toBe(200);
      expect(new URL(page.url()).pathname).toBe(route.path);
      await tokenNotInUrl(page);
      await expect(page.locator(tid(route.pageId))).toBeVisible();
      expect(await page.locator("body").innerText()).not.toContain(E2E_TOKEN);

      await page.reload();
      expect(new URL(page.url()).pathname).toBe(route.path);
      await tokenNotInUrl(page);
      await expect(page.locator(tid(route.pageId))).toBeVisible();

      const stored = await page.evaluate(
        ([tokenKey, catalogKey, token]) => ({
          session: window.sessionStorage.getItem(tokenKey),
          catalog: window.localStorage.getItem(catalogKey) ?? "",
          tokenInCatalog: (window.localStorage.getItem(catalogKey) ?? "").includes(token),
        }),
        [TOKEN_KEY, CATALOG_KEY, E2E_TOKEN] as const
      );
      expect(stored.session).toBe(E2E_TOKEN);
      expect(stored.tokenInCatalog).toBe(false);
      expect(stored.catalog).toContain("p-deep");
      expect(stored.catalog).toContain("s-deep");

      await page.click(tid("nav-workspace"));
      await expect(page.locator(tid("workspace-shell"))).toBeVisible();
      expect(new URL(page.url()).pathname).toBe("/");
      await tokenNotInUrl(page);
      const project = page.locator(`${tid("project-item")}[data-project-id="p-deep"]`);
      await expect(project).toBeVisible();
      await page.click(tid("project-select-p-deep"));
      await expect(page.locator(`${tid("session-item")}[data-session-id="s-deep"]`)).toBeVisible();
    });
  }

  test("unknown paths stay 404 and are not the app shell", async ({ page }) => {
    const missing = await page.goto("/no-such-b3-route");
    expect(missing?.status()).toBe(404);
    await expect(page.locator(tid("top-nav"))).toHaveCount(0);
  });
});
