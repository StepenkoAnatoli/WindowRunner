/**
 * B4.4 — browser E2E for one-shot provider model discovery.
 *
 * Runs against the same real-bootstrap server as providers-workspace.spec
 * (e2e/providers-server.ts). The fake upstream lives IN THIS PROCESS, so the
 * spec can assert the exact upstream hit count directly — the browser only
 * ever talks to the Windows Runner server, which probes the upstream once.
 *
 * Journey (brief B4.4): type kind/base URL/key → Fetch models → exactly one
 * discovery request → sorted/deduped options → choose one → model field
 * updates → save → key masked → raw key absent from URL, web storage,
 * catalog, DOM, discovery responses, and rendered errors (including a
 * hostile upstream that echoes the Authorization header back) → failure and
 * empty runs → stale results clear when the form changes → discovery never
 * activates → cancel never saves.
 */
import { test, expect, type Page } from "@playwright/test";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { PROVIDERS_PORT, E2E_TOKEN } from "./fixture.js";

const tid = (id: string) => `[data-testid="${id}"]`;
const RAW_KEY = "sk-discovery-e2e-0123456789abcdef";
const RAW_KEY_MASK = "****cdef";
const TOKEN_KEY = "windows-runner.token";
// CI retries re-run a failed test against the SAME fixture server, so every
// saved profile id must be unique per attempt.
const RUN = Date.now().toString(36);
const ID1 = `disc-${RUN}-1`;
const ID2 = `disc-${RUN}-2`;
const ID3 = `disc-${RUN}-3`;
const IDERR = `disc-${RUN}-err`;
const CATALOG_KEY = "windows-runner.workspace-catalog.v1";

test.use({ baseURL: `http://127.0.0.1:${PROVIDERS_PORT}` });
test.describe.configure({ mode: "serial" });

// -- The fake provider upstream (in this process, on an ephemeral port). ----
let upstream: Server;
let upstreamBase: string; // e.g. http://127.0.0.1:<port>
const upstreamHits: Array<{ path: string; authorization?: string }> = [];

async function startUpstream(): Promise<void> {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
    upstreamHits.push({ path: req.url ?? "", authorization });
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/v1/models") {
      // Out of order, with a duplicate: normalization must sort + dedupe.
      return json(200, { data: [{ id: "zeta" }, { id: "alpha" }, { id: "alpha" }, { id: "mid" }] });
    }
    if (req.url === "/v1/empty/models") return json(200, { data: [] });
    if (req.url === "/v1/error/models") {
      // Upstream bodies must never reach the browser: this body even carries
      // the raw key, and the server must still not forward it.
      return json(500, { error: { message: `upstream explosion involving ${authorization} and other secrets` } });
    }
    if (req.url === "/v1/echo/models") {
      // Hostile upstream: echoes the Authorization header back in a 401 body.
      return json(401, { error: { message: `invalid credential ${authorization}` } });
    }
    if (req.url === "/v1/redirect/models") {
      res.writeHead(302, { location: `${upstreamBase}/v1/models` });
      return res.end();
    }
    json(404, { error: { message: "not found" } });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const { port } = upstream.address() as { port: number };
  upstreamBase = `http://127.0.0.1:${port}`;
}

test.beforeAll(startUpstream);
test.afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

// -- Helpers ----------------------------------------------------------------
async function signIn(page: Page): Promise<void> {
  await page.addInitScript(([token, key]) => window.sessionStorage.setItem(key, token), [E2E_TOKEN, TOKEN_KEY]);
  await page.goto("/providers");
  await expect(page.locator(tid("providers-page"))).toBeVisible();
}

const card = (page: Page, id: string) => page.locator(`${tid("providers-list")} [data-testid="dash-card"][data-id="${id}"]`);

async function openAddForm(page: Page, id: string, baseUrl: string): Promise<void> {
  await page.click(tid("providers-add"));
  await expect(page.locator(tid("provider-form"))).toBeVisible();
  await page.locator(tid("provider-kind")).selectOption("openai-compatible");
  await page.locator(tid("provider-id")).fill(id);
  await page.locator(tid("provider-label")).fill(`Disc ${id}`);
  await page.locator(tid("provider-base-url")).fill(baseUrl);
  await page.locator(tid("provider-api-key")).fill(RAW_KEY);
}

function watchDiscovery(page: Page): { posts: Array<{ url: string; body: any }>; responses: string[]; activations: number } {
  const watched = { posts: [] as Array<{ url: string; body: any }>, responses: [] as string[], activations: 0 };
  page.on("request", (req) => {
    if (req.url().endsWith("/api/providers/discover-models")) {
      watched.posts.push({ url: req.url(), body: req.postDataJSON() });
    }
    if (/\/api\/providers\/[^/]+\/activate$/.test(req.url()) && req.method() === "POST") watched.activations += 1;
  });
  page.on("response", async (res) => {
    if (res.url().endsWith("/api/providers/discover-models")) {
      try {
        watched.responses.push(await res.text());
      } catch {
        /* body already consumed — nothing to assert on */
      }
    }
  });
  return watched;
}

async function expectNoRawKeyAnywhere(page: Page): Promise<void> {
  expect(page.url()).not.toContain(RAW_KEY);
  const storage = await page.evaluate(() => ({
    local: JSON.stringify(Object.entries(localStorage)),
    session: JSON.stringify(Object.entries(sessionStorage)),
  }));
  expect(storage.local).not.toContain(RAW_KEY);
  expect(storage.session).not.toContain(RAW_KEY);
  // The only sessionStorage entry is the existing bearer-token boundary.
  const sessionKeys = await page.evaluate(() => Object.keys(sessionStorage));
  expect(sessionKeys).toEqual([TOKEN_KEY]);
  const catalog = await page.evaluate((key) => window.localStorage.getItem(key), CATALOG_KEY);
  if (catalog !== null) {
    const parsed = JSON.parse(catalog) as { projects?: unknown[]; sessions?: unknown[] };
    expect(JSON.stringify(parsed)).not.toContain(RAW_KEY);
    expect(Object.keys(parsed).sort()).toEqual(["projects", "sessions"]);
  }
  expect(await page.locator("body").innerText()).not.toContain(RAW_KEY);
}

// -- The main journey --------------------------------------------------------
test("discover once, choose, save masked, and keep the raw key off every boundary", async ({ page }) => {
  test.setTimeout(120_000);
  upstreamHits.length = 0;
  await signIn(page);
  await expect(card(page, "default")).toBeVisible(); // env bootstrap profile is there and active
  const watched = watchDiscovery(page);

  // -- 1-3: open the form, type kind/base URL/key, click Fetch models.
  await openAddForm(page, ID1, `${upstreamBase}/v1`);
  await page.click(tid("provider-discover-models"));

  // -- 4/5: exactly one discovery request, one upstream hit, sorted options.
  await expect(page.locator(tid("provider-model-select"))).toBeVisible();
  expect(watched.posts).toHaveLength(1);
  expect(watched.posts[0].url).not.toContain(RAW_KEY); // the key is never in a URL
  expect(watched.posts[0].body.apiKey).toBe(RAW_KEY); // the sanctioned path: the request body
  expect(upstreamHits.filter((h) => h.path === "/v1/models")).toHaveLength(1);
  expect(upstreamHits[0].authorization).toBe(`Bearer ${RAW_KEY}`);
  const options = await page.locator(`${tid("provider-model-select")} option`).allTextContents();
  expect(options).toEqual(["Select a model…", "alpha", "mid", "zeta"]); // deduped + sorted
  expect(watched.responses.join("")).toBe(JSON.stringify({ models: ["alpha", "mid", "zeta"] }));

  // -- 6/7: choosing a model fills the field; the select returns to placeholder.
  await page.locator(tid("provider-model-select")).selectOption("mid");
  await expect(page.locator(tid("provider-model"))).toHaveValue("mid");
  await expect(page.locator(tid("provider-model-select"))).toHaveValue("");

  // -- 8/9: save; the card shows the mask only.
  await page.click(tid("provider-submit"));
  await expect(page.locator(tid("provider-form"))).toHaveCount(0);
  await expect(card(page, ID1).locator(tid("dash-card-key"))).toHaveText(`key: ${RAW_KEY_MASK}`);

  // -- 10: the raw key is absent from every boundary after save.
  await expectNoRawKeyAnywhere(page);
  expect(watched.responses.join("")).not.toContain(RAW_KEY);

  // -- 11/12: a hostile echo upstream fails into a secret-free error, and
  // manual entry still completes the journey.
  await openAddForm(page, ID2, `${upstreamBase}/v1/echo`);
  await page.click(tid("provider-discover-models"));
  await expect(page.locator(tid("provider-model-discovery-error"))).toBeVisible();
  const errorText = await page.locator(tid("provider-model-discovery-error")).innerText();
  expect(errorText).not.toContain(RAW_KEY);
  expect(watched.responses.join("")).not.toContain(RAW_KEY);
  await expectNoRawKeyAnywhere(page);
  await page.locator(tid("provider-model")).fill("typed-by-hand");
  await page.click(tid("provider-submit"));
  await expect(page.locator(tid("provider-form"))).toHaveCount(0);
  await expect(card(page, ID2).locator(tid("dash-card-model"))).toContainText("typed-by-hand");

  // -- 15/16: changing the base URL clears the (now stale) results.
  await openAddForm(page, ID3, `${upstreamBase}/v1`);
  await page.click(tid("provider-discover-models"));
  await expect(page.locator(tid("provider-model-select"))).toBeVisible();
  await page.locator(tid("provider-base-url")).fill(`${upstreamBase}/v1/empty`);
  await expect(page.locator(tid("provider-model-select"))).toHaveCount(0);
  await expect(page.locator(tid("provider-model-discovery"))).toContainText("or enter the model id manually");

  // -- 17: nothing above activated a profile.
  expect(watched.activations).toBe(0);
  await expect(page.locator(tid("providers-active"))).toContainText("mock (env)");
  await expect(page.locator(tid("providers-active"))).not.toContainText("Disc ");

  // -- 18: cancel discards the typed form (including the key) without saving.
  await page.once("dialog", (dialog) => void dialog.accept());
  await page.click(tid("provider-cancel"));
  await expect(page.locator(tid("provider-form"))).toHaveCount(0);
  await expect(card(page, ID3)).toHaveCount(0);
  await expectNoRawKeyAnywhere(page);
});

test("empty, failing, redirecting, and anthropic discovery fall back to manual entry", async ({ page }) => {
  test.setTimeout(120_000);
  upstreamHits.length = 0;
  await signIn(page);
  const watched = watchDiscovery(page);

  // -- 13/14: empty result → the exact guidance copy.
  await openAddForm(page, `disc-${RUN}-empty`, `${upstreamBase}/v1/empty`);
  await page.click(tid("provider-discover-models"));
  await expect(page.locator(tid("provider-model-discovery-empty"))).toHaveText(
    "No models were returned. Enter the model id manually."
  );
  await page.once("dialog", (dialog) => void dialog.accept());
  await page.click(tid("provider-cancel"));
  await expect(page.locator(tid("provider-form"))).toHaveCount(0);

  // An upstream 500 (its body carries the raw key!) → actionable, secret-free.
  await openAddForm(page, IDERR, `${upstreamBase}/v1/error`);
  await page.click(tid("provider-discover-models"));
  await expect(page.locator(tid("provider-model-discovery-error"))).toContainText("HTTP 500");
  expect((await page.locator(tid("provider-model-discovery-error")).innerText())).not.toContain(RAW_KEY);
  expect(watched.responses.join("")).not.toContain(RAW_KEY);
  // The manual input never disabled: type a model and save successfully.
  await page.locator(tid("provider-model")).fill("handpicked");
  await page.click(tid("provider-submit"));
  await expect(page.locator(tid("provider-form"))).toHaveCount(0);
  await expect(card(page, IDERR)).toBeVisible();

  // A redirect is refused, not followed.
  await openAddForm(page, `disc-${RUN}-redir`, `${upstreamBase}/v1/redirect`);
  await page.click(tid("provider-discover-models"));
  await expect(page.locator(tid("provider-model-discovery-error"))).toContainText("redirect");
  await page.once("dialog", (dialog) => void dialog.accept());
  await page.click(tid("provider-cancel"));
  await expect(page.locator(tid("provider-form"))).toHaveCount(0);

  // Anthropic: the documented fallback up front, no button, manual entry open.
  await page.click(tid("providers-add"));
  await page.locator(tid("provider-kind")).selectOption("anthropic");
  await expect(page.locator(tid("provider-model-discovery-fallback"))).toHaveText(
    "model discovery unavailable for this provider"
  );
  await expect(page.locator(tid("provider-discover-models"))).toHaveCount(0);
  await expect(page.locator(tid("provider-model"))).toBeEditable();
  await page.once("dialog", (dialog) => void dialog.accept());
  await page.click(tid("provider-cancel"));

  // -- 17 (again): still no activation, and the active banner is untouched.
  expect(watched.activations).toBe(0);
  await expect(page.locator(tid("providers-active"))).toContainText("mock (env)");
  await expectNoRawKeyAnywhere(page);
});
