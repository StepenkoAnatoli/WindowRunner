/**
 * Desktop B4 journey — provider model discovery in the real Electron shell
 * (plan B4.5). Owns its own app lifecycle, per-run data dir, project folder,
 * and its own fake upstream (in this process, so the upstream hit count is
 * directly assertable), separate from providers.spec.ts so neither run can
 * leak state into the other.
 *
 * Proves, in the installed shell:
 * - discovery runs on the existing in-memory API token (no re-entry, no
 *   second token transport);
 * - the freshly typed key travels ONLY in the authenticated
 *   POST /api/providers/discover-models body and the upstream probe's
 *   Authorization header — never in a URL, browser storage, the workspace
 *   catalog file, or visible post-save UI (the mask only);
 * - model selection fills the model field; manual fallback still works;
 * - a discovery timeout is visible and recoverable (the 5 s server deadline
 *   surfaces as an error and the form keeps working);
 * - discovery never activates a profile and cancelling never saves one;
 * - /dashboard behavior remains compatible (its own token form on a hard
 *   load, exactly as in providers.spec.ts).
 */
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, type Server } from "node:http";
import { launchDesktopApp } from "./launch.js";

const tid = (id: string) => `[data-testid="${id}"]`;
const PROJECT_DIR = path.join(os.tmpdir(), "wr-desktop-e2e-discovery-project");
const RAW_KEY = "sk-desktop-discovery-0123456789abcdef";
const RAW_KEY_MASK = "****cdef";
// CI retries re-run a failed test against the SAME app + backend, so saved
// profile ids must be unique per attempt, and module-level counters must be
// reset when a test starts.
const RUN = Date.now().toString(36);
const ID1 = `dsk-disc-${RUN}`;
const IDSLOW = `dsk-slow-${RUN}`;

let app: ElectronApplication | undefined;
let page: Page;
let backendOrigin: string;
let dataDir: string;
let upstream: Server;
let upstreamBase: string;
const upstreamHits: Array<{ path: string; authorization?: string }> = [];
const discoveryPosts: Array<{ url: string; body: any }> = [];
let activationPosts = 0;

test.describe.configure({ mode: "serial" });

async function startUpstream(): Promise<void> {
  upstream = createServer((req, res) => {
    upstreamHits.push({ path: req.url ?? "", authorization: typeof req.headers.authorization === "string" ? req.headers.authorization : undefined });
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/v1/models") {
      // Out of order with a duplicate: normalization must dedupe + sort.
      return json(200, { data: [{ id: "zeta" }, { id: "alpha" }, { id: "alpha" }, { id: "mid" }] });
    }
    if (req.url === "/v1/slow/models") return; // never responds: server hits its 5 s deadline
    json(404, {});
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const { port } = upstream.address() as { port: number };
  upstreamBase = `http://127.0.0.1:${port}`;
}

test.beforeAll(async () => {
  await startUpstream();
  await fsp.mkdir(PROJECT_DIR, { recursive: true });
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "wr-desktop-e2e-discovery-data-"));
  app = await launchDesktopApp({ dataDir, allowedRoots: [PROJECT_DIR] });
  page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForSelector(tid("project-sidebar"), { timeout: 60_000 });
  backendOrigin = new URL(page.url()).origin;
  page.on("request", (req) => {
    if (req.url().endsWith("/api/providers/discover-models")) {
      discoveryPosts.push({ url: req.url(), body: req.postDataJSON() });
    }
    if (/\/api\/providers\/[^/]+\/activate$/.test(req.url()) && req.method() === "POST") activationPosts += 1;
  });
});

test.afterAll(async () => {
  await app?.close().catch(() => {});
  app = undefined;
  if (dataDir) await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(PROJECT_DIR, { recursive: true, force: true }).catch(() => {});
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

const card = (id: string) => page.locator(`${tid("providers-list")} [data-testid="dash-card"][data-id="${id}"]`);

test("discovery on the in-memory token: fetch, choose, save masked, boundaries hold", async () => {
  test.setTimeout(180_000);
  upstreamHits.length = 0;
  discoveryPosts.length = 0;
  activationPosts = 0;

  // A session exists so the workspace catalog file is real when we assert it.
  await app!.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog;
  }, PROJECT_DIR);
  await page.click(tid("choose-project"));
  await expect(page.locator(tid("project-item")).first()).toBeVisible();
  await page.click(tid("new-session"));
  await expect(page.locator(tid("session-id"))).toBeVisible({ timeout: 10_000 });

  // Providers open on the in-memory bootstrap token: the list loads with no
  // token form anywhere.
  await page.click(tid("nav-providers"));
  await expect(page.locator(tid("providers-page"))).toBeVisible();
  await expect(card("default")).toBeVisible();
  await expect(page.locator(tid("dash-token-form"))).toHaveCount(0);

  // Type kind/base URL/key, fetch once, get sorted deduped options.
  await page.click(tid("providers-add"));
  await page.locator(tid("provider-kind")).selectOption("openai-compatible");
  await page.locator(tid("provider-id")).fill(ID1);
  await page.locator(tid("provider-label")).fill(`Dsk ${ID1}`);
  await page.locator(tid("provider-base-url")).fill(`${upstreamBase}/v1`);
  await page.locator(tid("provider-api-key")).fill(RAW_KEY);
  await page.click(tid("provider-discover-models"));
  await expect(page.locator(tid("provider-model-select"))).toBeVisible({ timeout: 15_000 });
  const options = await page.locator(`${tid("provider-model-select")} option`).allTextContents();
  expect(options).toEqual(["Select a model…", "alpha", "mid", "zeta"]);

  // Exactly one discovery request; the key rode in the body (sanctioned) and
  // in the upstream Authorization header, never in a URL.
  expect(discoveryPosts).toHaveLength(1);
  expect(discoveryPosts[0].url).not.toContain(RAW_KEY);
  expect(discoveryPosts[0].body.apiKey).toBe(RAW_KEY);
  expect(upstreamHits.filter((h) => h.path === "/v1/models")).toHaveLength(1);
  expect(upstreamHits.find((h) => h.path === "/v1/models")?.authorization).toBe(`Bearer ${RAW_KEY}`);

  // Choose a model: the field updates; saving shows the mask only.
  await page.locator(tid("provider-model-select")).selectOption("alpha");
  await expect(page.locator(tid("provider-model"))).toHaveValue("alpha");
  await page.click(tid("provider-submit"));
  await expect(page.locator(tid("provider-form"))).toHaveCount(0);
  await expect(card(ID1).locator(tid("dash-card-key"))).toHaveText(`key: ${RAW_KEY_MASK}`);

  // Boundaries: URL, web storage, visible text, workspace catalog file.
  expect(page.url()).not.toContain(RAW_KEY);
  const storage = await page.evaluate(() => ({
    local: JSON.stringify(Object.entries(localStorage)),
    session: JSON.stringify(Object.entries(sessionStorage)),
  }));
  expect(storage.local).not.toContain(RAW_KEY);
  expect(storage.session).not.toContain(RAW_KEY);
  expect(await page.locator("body").innerText()).not.toContain(RAW_KEY);
  const catalogFile = await app!.evaluate(({ app: electronApp }) => {
    const sep = process.platform === "win32" ? "\\" : "/";
    return `${electronApp.getPath("userData")}${sep}workspace-catalog.json`;
  });
  const catalogRaw = await fsp.readFile(catalogFile, "utf8");
  expect(catalogRaw).not.toContain(RAW_KEY);

  // Discovery never activated anything.
  expect(activationPosts).toBe(0);
  await expect(page.locator(tid("providers-active"))).toContainText("mock (env)");
  await expect(page.locator(tid("providers-active"))).not.toContainText("Dsk ");
});

test("timeout is visible and recoverable; manual fallback still saves; /dashboard compatible", async () => {
  test.setTimeout(180_000);
  upstreamHits.length = 0;
  discoveryPosts.length = 0;
  activationPosts = 0;

  // A hanging upstream hits the server's 5 s deadline; the error surfaces in
  // the discovery region and the form stays usable.
  await page.click(tid("providers-add"));
  await page.locator(tid("provider-kind")).selectOption("openai-compatible");
  await page.locator(tid("provider-id")).fill(IDSLOW);
  await page.locator(tid("provider-label")).fill(`Dsk ${IDSLOW}`);
  await page.locator(tid("provider-base-url")).fill(`${upstreamBase}/v1/slow`);
  await page.locator(tid("provider-api-key")).fill(RAW_KEY);
  await page.click(tid("provider-discover-models"));
  await expect(page.locator(tid("provider-model-discovery-error"))).toBeVisible({ timeout: 20_000 });
  expect(await page.locator(tid("provider-model-discovery-error")).innerText()).not.toContain(RAW_KEY);

  // Recoverable: point the SAME form at the healthy upstream — discovery
  // works again without reopening anything.
  await page.locator(tid("provider-base-url")).fill(`${upstreamBase}/v1`);
  await page.click(tid("provider-discover-models"));
  await expect(page.locator(tid("provider-model-select"))).toBeVisible({ timeout: 15_000 });

  // Manual fallback: ignore the select, type the model by hand, save.
  await page.locator(tid("provider-model")).fill("hand-typed-model");
  await page.click(tid("provider-submit"));
  await expect(page.locator(tid("provider-form"))).toHaveCount(0);
  await expect(card(IDSLOW).locator(tid("dash-card-model"))).toContainText("hand-typed-model");

  // Cancelling never saves: open, type, cancel through the confirm dialog.
  await page.once("dialog", (dialog) => void dialog.accept());
  await page.click(tid("providers-add"));
  await page.locator(tid("provider-id")).fill("dsk-cancelled");
  await page.locator(tid("provider-label")).fill("Never Saved");
  await page.once("dialog", (dialog) => void dialog.accept());
  await page.click(tid("provider-cancel"));
  await expect(page.locator(tid("provider-form"))).toHaveCount(0);
  await expect(card("dsk-cancelled")).toHaveCount(0);

  // No activation anywhere in this spec either.
  expect(activationPosts).toBe(0);

  // /dashboard compatibility is unchanged: a hard load keeps its own token
  // form (the in-memory desktop token belongs to the /desktop document).
  await page.goto(`${backendOrigin}/dashboard`);
  await expect(page.locator(tid("dash-token-form"))).toBeVisible();
});
