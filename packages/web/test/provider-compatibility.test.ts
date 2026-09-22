/**
 * Dashboard compatibility adapter contract (B2.4).
 *
 * `/dashboard` is not its own app: it boots through `dashboard.ts` →
 * `providers/compatibility.ts` and composes the SAME provider page, provider
 * controller, and usage table the workspace uses, plus the dashboard-only
 * quick chat. This suite boots the real entry module against the DOM stub and
 * pins what the browser E2E cannot see from the outside:
 *
 * - adapter wiring and the preserved legacy selectors (`dash-*`);
 * - provider mutations running through the one shared controller;
 * - isolation from B1 workspace state (import graph + no catalog mutation);
 * - dashboard.html's own CSS/JS mount — never `app.css`;
 * - the shared fragment/sessionStorage token flow (auto-connect, sign-out).
 *
 * The end-to-end flows (add → test → activate → quick chat → usage row,
 * quick-chat Stop) stay in `e2e/dashboard.spec.ts` and
 * `e2e/providers-workspace.spec.ts`; nothing here duplicates those journeys.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installDomStub, type FakeElement, type StubDocument } from "./dom-stub.js";
import type { State } from "../src/dashboard-state.js";

interface FetchRecord {
  method: string;
  url: string;
  auth?: string;
  body?: unknown;
}

// The dashboard's own sessionStorage keys (pinned literally; asserted against
// the module's exports once it loads).
const CWD_KEY = "windows-runner.dash.cwd";
const SESSION_KEY = "windows-runner.dash.session";

const fetchCalls: FetchRecord[] = [];
const assignedUrls: string[] = [];

const TOKEN = "dash-shared-token-999";

const PROFILES = [
  {
    id: "p1",
    label: "Alpha",
    kind: "mock",
    model: "mock-1",
    apiKeyMasked: "****1234",
    createdAt: 1,
    updatedAt: 2,
    active: true,
  },
];

const USAGE = {
  records: [{ at: 1700000000000, turnId: "t1", providerId: "p1", model: "mock-1", status: "completed", inputTokens: 3, outputTokens: 4, estCostUsd: 0.0001 }],
  retained: 200,
  bounded: false,
};

const CATALOG_SEED = {
  version: 1,
  projects: [{ id: "p-demo", root: "/home/user/demo-project", label: "Demo Project", lastOpenedAt: 1700000000000 }],
  sessions: [{ sessionId: "s-demo", projectId: "p-demo", lastOpenedAt: 1700000001000 }],
};

let doc: StubDocument;
let root: FakeElement;
let dashState: State;
let dashRender: () => void;
let sessionStorageStub: ReturnType<typeof makeStorage>;
let localStorageStub: ReturnType<typeof makeStorage>;
let rafQueue: Array<() => void>;

function makeStorage(): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
} {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function flushRaf(): void {
  const pending = rafQueue.splice(0, rafQueue.length);
  for (const cb of pending) cb();
}

async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    flushRaf();
    await new Promise((resolve) => setImmediate(resolve));
    flushRaf();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function el(selector: string): FakeElement | null {
  return root.querySelector(selector);
}

function needEl(selector: string): FakeElement {
  const found = el(selector);
  assert.ok(found, `expected ${selector} in the rendered dashboard`);
  return found;
}

async function clickAndWait(selector: string): Promise<void> {
  needEl(selector).click();
  await settle();
}

function callsTo(url: string, method = "GET"): number {
  return fetchCalls.filter((c) => c.url === url && c.method === method).length;
}

describe("dashboard compatibility adapter (B2.4)", () => {
  before(async () => {
    doc = installDomStub();
    root = doc.createElement("div");
    root.setAttribute("id", "app");
    doc.body.append(root);

    sessionStorageStub = makeStorage();
    sessionStorageStub.setItem("windows-runner.token", TOKEN);
    sessionStorageStub.setItem(CWD_KEY, "/home/user/demo-project");
    sessionStorageStub.setItem(SESSION_KEY, "s-demo");
    localStorageStub = makeStorage();
    localStorageStub.setItem("windows-runner.workspace-catalog.v1", JSON.stringify(CATALOG_SEED));

    const location = {
      pathname: "/dashboard",
      search: "",
      hash: "",
      assign(url: string): void {
        assignedUrls.push(String(url));
      },
    };
    const historyStub = {
      pushState(_s: unknown, _t: unknown, _url: string): void {},
      replaceState(_s: unknown, _t: unknown, _url: string): void {},
    };
    const windowStub = {
      location,
      history: historyStub,
      sessionStorage: sessionStorageStub,
      confirm: () => true,
      addEventListener(): void {},
      dispatchEvent(): boolean {
        return true;
      },
    };

    const globals = globalThis as Record<string, unknown>;
    globals.window = windowStub;
    globals.history = historyStub;
    globals.localStorage = localStorageStub;
    rafQueue = [];
    globals.requestAnimationFrame = (cb: (t: number) => void): number => {
      rafQueue.push(() => cb(0));
      return rafQueue.length;
    };
    globals.fetch = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const path = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      fetchCalls.push({ method, url: path, auth: headers.authorization, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path === "/api/health") return Promise.resolve(jsonResponse({ status: "ok", security: { mode: "token" }, persistence: { mode: "memory" } }));
      if (path === "/api/providers" && method === "GET") return Promise.resolve(jsonResponse({ activeProfileId: "p1", profiles: PROFILES }));
      if (path === "/api/usage?limit=50") return Promise.resolve(jsonResponse(USAGE));
      if (path === "/api/providers/discover-models") return Promise.resolve(jsonResponse({ models: ["mock", "mock-2"] }));
      if (path.startsWith("/api/providers/")) return Promise.resolve(jsonResponse({ ok: true }));
      return Promise.reject(new Error(`unexpected fetch in provider-compatibility test: ${method} ${path}`));
    };

    // Boot the REAL entry module: dashboard.ts runs loadToken() and mounts the
    // compatibility page — exactly what /dashboard's bundle does. The state
    // module binds `document` at import time, so it is imported only now, with
    // the DOM stub in place (dashboard.js then shares this instance).
    const dash = await import("../src/dashboard-state.js");
    dashState = dash.state;
    dashRender = dash.render;
    assert.equal(dash.CWD_KEY, CWD_KEY, "sessionStorage key contract: cwd");
    assert.equal(dash.SESSION_KEY, SESSION_KEY, "sessionStorage key contract: session");
    await import("../src/dashboard.js");
    await settle();
  });

  it("boots independently: the shared token auto-connects and the token panel never appears", () => {
    assert.equal(el('[data-testid="dash-token-form"]'), null, "a valid shared token connects silently");
    assert.equal(dashState.auth, "ok");
    assert.equal(callsTo("/api/health"), 1, "connect is the shared credential check");
    assert.equal(callsTo("/api/providers"), 1, "the shared controller loads the provider list");
    assert.equal(callsTo("/api/usage?limit=50"), 1, "the shared usage table loads");
    for (const call of fetchCalls) {
      assert.equal(call.auth, `Bearer ${TOKEN}`, "every request carries the shared bearer token");
    }
  });

  it("composes the shared components with the preserved dashboard selectors (including quick chat)", () => {
    for (const selector of [
      '[data-testid="dash-main-link"]',
      '[data-testid="dash-sign-out"]',
      '[data-testid="providers-page"]',
      '[data-testid="providers-active"]',
      '[data-testid="providers-list"]',
      '[data-testid="dash-card"]',
      '[data-testid="usage-page"]',
      '[data-testid="dash-usage-row"]',
      '[data-testid="dash-chat"]',
    ]) {
      assert.ok(el(selector), `missing preserved selector ${selector}`);
    }
    assert.equal(needEl('[data-testid="dash-main-link"]').getAttribute("href"), "/", "the main-UI link is a real href");
    assert.match(root.textContent ?? "", /Sends one turn to/, "quick chat remains part of the dashboard contract");
    assert.match(root.textContent ?? "", /Alpha \(mock-1\)/, "quick chat names the active provider");
  });

  it("provider mutations run through the one shared controller", async () => {
    // openCreateForm / closeForm through the adapter's wiring.
    await clickAndWait('[data-testid="providers-add"]');
    assert.ok(el('[data-testid="provider-form"]'), "the shared form opens from the dashboard");
    await clickAndWait('[data-testid="provider-cancel"]');
    assert.equal(el('[data-testid="provider-form"]'), null);

    // An update through the shared form: PATCH + list reload + shared notice.
    await clickAndWait('[data-testid="dash-edit"]');
    const label = needEl('[data-testid="provider-label"]');
    label.value = "Alpha Renamed";
    label.fire("input");
    needEl('[data-testid="provider-form"]').submit();
    await settle();
    assert.equal(callsTo("/api/providers/p1", "PATCH"), 1, "the shared controller owns the mutation");
    assert.equal(callsTo("/api/providers"), 2, "the shared controller reloads the list after the mutation");
    const patch = fetchCalls.find((c) => c.method === "PATCH");
    assert.ok(!("apiKey" in ((patch?.body as Record<string, unknown>) ?? {})), "unchanged keys are omitted on the dashboard too");
    assert.ok(el('[data-testid="providers-notice"]'), "provider notices render inside the shared page");

    // The dashboard's usage Refresh uses the shared refresh() (both slices).
    const providersBefore = callsTo("/api/providers");
    const usageBefore = callsTo("/api/usage?limit=50");
    await clickAndWait('[data-testid="usage-refresh"]');
    assert.equal(callsTo("/api/providers"), providersBefore + 1);
    assert.equal(callsTo("/api/usage?limit=50"), usageBefore + 1);
  });

  it("is isolated from B1 workspace state: no workspace imports, no catalog mutation", () => {
    // Structural: none of the dashboard-side modules may depend on the B1
    // workspace (importing app-state.js for the shared provider/usage slice
    // SHAPES is by design and allowed).
    const dashboardModules = [
      "../src/dashboard.ts",
      "../src/dashboard-api.ts",
      "../src/dashboard-state.ts",
      "../src/dashboard-chat.ts",
      "../src/providers/compatibility.ts",
    ];
    const forbidden = /(workspace-catalog|project-sidebar|app-shell|inspector)\.js|"\.\/(main|workspace)\.js"/;
    for (const modulePath of dashboardModules) {
      const source = readFileSync(new URL(modulePath, import.meta.url), "utf8");
      assert.ok(!forbidden.test(source), `dashboard module ${modulePath} must not import B1 workspace state`);
    }

    // Behavioral: booting and mutating through the dashboard never touches
    // the workspace catalog the B1 app persists.
    assert.equal(
      localStorageStub.getItem("windows-runner.workspace-catalog.v1"),
      JSON.stringify(CATALOG_SEED),
      "the B1 catalog is byte-identical after dashboard use"
    );
    // The dashboard state has no workspace slice at all.
    assert.ok(!("workspace" in dashState));
    assert.ok(!("route" in dashState));
  });

  it("dashboard.html stays on its own CSS/JS mount — never app.css", () => {
    const html = readFileSync(new URL("../public/dashboard.html", import.meta.url), "utf8");
    assert.match(html, /href="\/dashboard\/dashboard\.css"/);
    assert.match(html, /src="\/dashboard\/dashboard\.js"/);
    assert.ok(!html.includes("app.css"), "the dashboard must not depend on app.css");
    assert.ok(!html.includes("app.js"));
    assert.match(html, /<div id="app">/, "the compatibility root is retained");
    // Contrast: the main app document is the one that uses app.css.
    const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    // Root-absolute: a refresh of /providers must not request /providers/app.js.
    assert.match(index, /href="\/app\.css"/);
    assert.match(index, /src="\/app\.js"/);
    assert.equal(index.includes("./app.css"), false);
    assert.equal(index.includes("./app.js"), false);
  });

  it("page-level notices render and dismiss outside the shared provider page", async () => {
    dashState.notice = "refresh failed: something broke";
    dashRender();
    await settle();
    const notice = needEl('[data-testid="dash-notice"]');
    assert.match(notice.textContent ?? "", /refresh failed: something broke/);
    await clickAndWait('[data-testid="dash-notice-dismiss"]');
    assert.equal(el('[data-testid="dash-notice"]'), null);
  });

  it("sign-out clears the shared token and returns to the token panel", async () => {
    await clickAndWait('[data-testid="dash-sign-out"]');
    assert.equal(sessionStorageStub.getItem("windows-runner.token"), null, "sign-out forgets the shared token");
    assert.ok(el('[data-testid="dash-token-form"]'), "the token panel is the only thing left");
    assert.equal(el('[data-testid="dash-token-input"]') !== null, true);
  });

  it("the back-to-workspace affordances navigate home (real href + in-app handler)", async () => {
    // Re-connect first so the page body (and its back link) renders again.
    const input = needEl('[data-testid="dash-token-input"]');
    input.value = TOKEN;
    needEl('[data-testid="dash-token-form"]').submit();
    await settle();
    // The header's dash-main-link is a plain real href (asserted above); the
    // shared page's back link carries the in-app handler, which navigates the
    // standalone dashboard to the main UI document.
    const link = needEl('[data-testid="providers-main-link"]');
    link.fire("click", { button: 0 });
    assert.deepEqual(assignedUrls, ["/"], "a plain left click navigates to the main UI document");
  });

  it("model discovery (B4.3) works on the dashboard through the shared controller", async () => {
    await clickAndWait('[data-testid="providers-add"]');
    assert.ok(el('[data-testid="provider-model-discovery"]'), "the discovery region renders inside the shared form");
    assert.ok(el('[data-testid="provider-model-manual"]'), "manual model entry renders on the dashboard too");
    await clickAndWait('[data-testid="provider-discover-models"]');
    assert.equal(callsTo("/api/providers/discover-models", "POST"), 1, "one-shot discovery through the shared client");
    const call = fetchCalls.find((c) => c.url === "/api/providers/discover-models");
    assert.equal((call?.body as Record<string, unknown>).kind, "openai-compatible", "discovery reads the CURRENT form values");
    assert.ok(el('[data-testid="provider-model-select"]'), "discovered models render as a select");
    await clickAndWait('[data-testid="provider-cancel"]');
    assert.equal(el('[data-testid="provider-form"]'), null, "cancelling closes the form without saving");
    assert.equal(callsTo("/api/providers", "POST"), 0, "discovery never creates a profile");
  });
});
