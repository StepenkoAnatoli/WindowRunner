/**
 * Route-host contract coverage (B2.1).
 *
 * `main.ts` is the side-effect coordinator: this suite boots it as a module
 * against the DOM stub and drives the real wiring end to end — the boot route,
 * top-nav `navigateTo`, `popstate` back/forward, per-route data loading and
 * caching, the dirty-provider-form confirmation gate, B1 catalog/token
 * preservation across route changes, and route-URL secret hygiene.
 *
 * Pure parsing lives in `ui-route.test.ts` and reducer invariants in
 * `app-state.test.ts`; nothing here duplicates those. This pins the glue
 * between them: location → route state → rendered page → API data loading.
 * The provider-API method/URL contract itself is pinned by `api.test.ts` and
 * `dashboard-api.test.ts`; here we assert which of those calls each route
 * makes, and that no others appear.
 *
 * The suite is one sequential journey (`main.ts` holds module state); each
 * `it` builds on the settled state of the previous one.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { FakeElement, installDomStub, type StubDocument } from "./dom-stub.js";

interface FetchRecord {
  url: string;
  method: string;
}

const fetchCalls: FetchRecord[] = [];
const historyUrls: string[] = [];
const confirmMessages: string[] = [];
let confirmResult = true;
let failProvidersFetch = false;

const HEALTH_BODY = {
  status: "ok",
  security: { mode: "token" },
  persistence: { mode: "memory" },
};

const PROVIDERS_BODY = {
  activeProfileId: "p1",
  profiles: [
    {
      id: "p1",
      label: "Alpha Provider",
      kind: "mock",
      model: "mock-1",
      maskedApiKey: "sk-live-••••1234",
      createdAt: 1,
      updatedAt: 2,
      active: true,
    },
  ],
};

const USAGE_BODY = {
  records: [
    {
      turnId: "t1",
      providerId: "p1",
      model: "mock-1",
      status: "completed",
      at: 1700000000000,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      estCostUsd: 0.0001,
    },
  ],
  retained: 200,
  bounded: true,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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

const CATALOG_SEED = {
  version: 1,
  projects: [{ id: "p-demo", root: "/home/user/demo-project", label: "Demo Project", lastOpenedAt: 1700000000000 }],
  sessions: [{ sessionId: "s-demo", projectId: "p-demo", lastOpenedAt: 1700000001000 }],
};

let doc: StubDocument;
let root: FakeElement;
let location: { pathname: string; search: string; hash: string };
let listeners: Map<string, Array<(event: Record<string, unknown>) => void>>;
let rafQueue: Array<() => void>;
let sessionStorageStub: ReturnType<typeof makeStorage>;
let localStorageStub: ReturnType<typeof makeStorage>;

function setLoc(url: string): void {
  const hashAt = url.indexOf("#");
  const searchAt = url.indexOf("?");
  const hash = hashAt >= 0 ? url.slice(hashAt) : "";
  const withoutHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const search = searchAt >= 0 ? withoutHash.slice(searchAt) : "";
  location.pathname = searchAt >= 0 ? withoutHash.slice(0, searchAt) : withoutHash;
  location.search = search;
  location.hash = hash;
}

function flushRaf(): void {
  const pending = rafQueue.splice(0, rafQueue.length);
  for (const cb of pending) cb();
}

/** Drain renders and microtask/macrotask chains (catalog load, connect, data loads). */
async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    flushRaf();
    await new Promise((resolve) => setImmediate(resolve));
    flushRaf();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Simulate browser back/forward: the browser sets the location, then fires popstate. */
async function popTo(url: string): Promise<void> {
  setLoc(url);
  for (const listener of listeners.get("popstate") ?? []) listener({ type: "popstate" });
  await settle();
}

function el(selector: string): FakeElement | null {
  return root.querySelector(selector);
}

function needEl(selector: string): FakeElement {
  const found = el(selector);
  assert.ok(found, `expected ${selector} in the rendered DOM`);
  return found;
}

function click(selector: string): void {
  needEl(selector).click();
}

async function clickAndWait(selector: string): Promise<void> {
  click(selector);
  await settle();
}

function callsTo(url: string): number {
  return fetchCalls.filter((c) => c.url === url).length;
}

function text(selector: string): string {
  return needEl(selector).textContent;
}

describe("main route host (B2.1 wiring)", () => {
  before(async () => {
    // ---- DOM -------------------------------------------------------------
    doc = installDomStub();
    root = doc.createElement("div");
    root.setAttribute("id", "app");
    doc.body.append(root);

    // ---- location/history ------------------------------------------------
    location = { pathname: "/", search: "", hash: "#token=boot-token-987" };
    listeners = new Map();
    const historyStub = {
      pushState(_s: unknown, _t: unknown, url: string): void {
        historyUrls.push(String(url));
        setLoc(String(url));
      },
      replaceState(_s: unknown, _t: unknown, url: string): void {
        historyUrls.push(String(url));
        setLoc(String(url));
      },
    };
    sessionStorageStub = makeStorage();
    localStorageStub = makeStorage();
    localStorageStub.setItem("windows-runner.workspace-catalog.v1", JSON.stringify(CATALOG_SEED));

    const windowStub = {
      location,
      history: historyStub,
      sessionStorage: sessionStorageStub,
      confirm(message: string): boolean {
        confirmMessages.push(String(message));
        return confirmResult;
      },
      addEventListener(type: string, cb: (event: Record<string, unknown>) => void): void {
        const list = listeners.get(type) ?? [];
        list.push(cb);
        listeners.set(type, list);
      },
      dispatchEvent(event: { type: string }): boolean {
        for (const cb of listeners.get(event.type) ?? []) cb(event as unknown as Record<string, unknown>);
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
      fetchCalls.push({ url: path, method });
      if (path === "/api/health") return Promise.resolve(jsonResponse(HEALTH_BODY));
      if (path === "/api/providers") {
        if (method === "GET") {
          if (failProvidersFetch) return Promise.resolve(jsonResponse({ code: "PROVIDER_UPSTREAM", error: "upstream exploded" }, 500));
          return Promise.resolve(jsonResponse(PROVIDERS_BODY));
        }
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (path === "/api/usage?limit=50") return Promise.resolve(jsonResponse(USAGE_BODY));
      return Promise.reject(new Error(`unexpected fetch in main-routes test: ${method} ${path}`));
    };

    // Boot the real application module. The banner-style `#token=` fragment is
    // present at boot — exactly what `npm start` prints in memory mode.
    await import("../src/main.js");
    await settle();
  });

  it("boots on the workspace: the #token fragment is consumed and stripped, never treated as a route", () => {
    // Auth fragment hygiene: token moved to sessionStorage, URL cleaned.
    assert.equal(sessionStorageStub.getItem("windows-runner.token"), "boot-token-987");
    assert.equal(location.hash, "", "the token fragment must be stripped from the address bar");
    assert.equal(location.pathname, "/");
    for (const url of historyUrls) {
      assert.ok(!/token=/i.test(url), `a token leaked into a history URL: ${url}`);
    }

    // Only the credential check hit the network — a fragment is not a route
    // and must not trigger provider/usage loading.
    assert.equal(callsTo("/api/health"), 1);
    assert.equal(callsTo("/api/providers"), 0);
    assert.equal(callsTo("/api/usage?limit=50"), 0);

    // The boot route is the B1 workspace shell.
    assert.ok(el('[data-testid="top-nav"]'), "authenticated header navigation");
    assert.ok(el('[data-testid="project-sidebar"]'), "B1 workspace shell renders");
    assert.equal(el('[data-testid="providers-page"]'), null);
  });

  it("unknown paths fall back to the workspace; nav and popstate share one route path", async () => {
    await popTo("/mystery/place");
    assert.ok(el('[data-testid="project-sidebar"]'), "unknown path falls back to the workspace");

    await clickAndWait('[data-testid="nav-providers"]');
    assert.ok(el('[data-testid="providers-page"]'), "providers page renders after nav");
    assert.equal(historyUrls[historyUrls.length - 1], "/providers");
    assert.equal(callsTo("/api/providers"), 1, "first providers visit loads provider data");

    await popTo("/");
    assert.ok(el('[data-testid="project-sidebar"]'), "back to the workspace via popstate");

    await popTo("/providers");
    assert.ok(el('[data-testid="providers-page"]'), "forward to providers via popstate");
    assert.equal(callsTo("/api/providers"), 1, "ready provider data is cached — no duplicate fetch");
  });

  it("route data loading follows the route table: usage loads once, settings reuses health, refresh forces reloads, errors are actionable", async () => {
    await clickAndWait('[data-testid="nav-usage"]');
    assert.ok(el('[data-testid="usage-page"]'), "usage page renders");
    assert.equal(callsTo("/api/usage?limit=50"), 1, "usage route calls ApiClient.usage(50) exactly once");
    assert.ok(el('[data-testid="dash-usage-row"]'), "usage records render");

    await popTo("/providers");
    await popTo("/usage");
    assert.equal(callsTo("/api/usage?limit=50"), 1, "ready usage data is cached across route changes");

    // Explicit Refresh forces a reload (and the route-specific error path).
    failProvidersFetch = true;
    await clickAndWait('[data-testid="nav-providers"]');
    await clickAndWait('[data-testid="providers-refresh"]');
    assert.equal(callsTo("/api/providers"), 2);
    assert.ok(el('[data-testid="providers-error"]'), "provider load failure renders the route error state");
    assert.match(text('[data-testid="providers-error"]'), /upstream exploded/i);
    assert.ok(el('[data-testid="providers-retry"]'), "the error is actionable");

    failProvidersFetch = false;
    await clickAndWait('[data-testid="providers-retry"]');
    assert.equal(el('[data-testid="providers-error"]'), null, "retry clears the error");
    assert.equal(callsTo("/api/providers"), 3);

    // Settings loads the health snapshot exactly once (connect's call is the
    // credential check; `health_loaded` caching is what settings reuses).
    await clickAndWait('[data-testid="nav-settings"]');
    assert.ok(el('[data-testid="settings-page"]'), "settings shell renders");
    assert.ok(el('[data-testid="settings-nav-security"]'));
    assert.equal(callsTo("/api/health"), 2, "connect credential check + one settings health load");

    await clickAndWait('[data-testid="settings-nav-about"]');
    assert.equal(historyUrls[historyUrls.length - 1], "/settings/about");
    assert.ok(el('[data-testid="settings-page"]'), "settings section routes render");
    await clickAndWait('[data-testid="settings-nav-security"]');
    assert.equal(callsTo("/api/health"), 2, "the health snapshot is cached across sections and routes");
  });

  it("B1 catalog and the session token survive route changes in memory", async () => {
    await clickAndWait('[data-testid="nav-workspace"]');
    const items = root.querySelectorAll('[data-testid="project-item"]');
    assert.equal(items.length, 1, "the seeded catalog project is loaded");
    assert.match(items[0].textContent, /Demo Project/);

    await clickAndWait('[data-testid="nav-providers"]');
    await clickAndWait('[data-testid="nav-usage"]');
    await clickAndWait('[data-testid="nav-settings"]');
    await clickAndWait('[data-testid="nav-workspace"]');

    const again = root.querySelectorAll('[data-testid="project-item"]');
    assert.equal(again.length, 1, "route changes never clear the B1 catalog");
    assert.match(again[0].textContent, /Demo Project/);
    assert.equal(sessionStorageStub.getItem("windows-runner.token"), "boot-token-987", "the token survives navigation");
  });

  it("a dirty provider form gates navigation with confirmation and survives in memory", async () => {
    await clickAndWait('[data-testid="nav-providers"]');
    await clickAndWait('[data-testid="providers-add"]');
    assert.ok(el('[data-testid="provider-form"]'), "the add form opens");

    const label = needEl('[data-testid="provider-label"]');
    label.value = "Draft Label";
    label.fire("input");

    const confirmCountBefore = confirmMessages.length;
    confirmResult = false;
    await clickAndWait('[data-testid="nav-workspace"]');
    assert.equal(confirmMessages.length, confirmCountBefore + 1, "leaving a dirty form asks for confirmation");
    assert.ok(el('[data-testid="providers-page"]'), "declining stays on the page");

    confirmResult = true;
    await clickAndWait('[data-testid="nav-workspace"]');
    assert.ok(el('[data-testid="project-sidebar"]'), "confirming navigates away");

    // The form state lives in memory: returning shows the draft again.
    await popTo("/providers");
    const restored = needEl('[data-testid="provider-label"]');
    assert.equal(restored.value, "Draft Label", "the dirty form survives route changes");
  });

  it("storage reset clears only the navigation catalog — no provider or session deletion", async () => {
    confirmResult = true;
    const providersBefore = callsTo("/api/providers");
    const usageBefore = callsTo("/api/usage?limit=50");
    const healthBefore = callsTo("/api/health");

    // The dirty form from the previous journey step gates this nav too — the
    // confirm stub answers for both it and the reset.
    await clickAndWait('[data-testid="nav-settings"]');
    await clickAndWait('[data-testid="settings-nav-storage"]');
    assert.ok(el('[data-testid="storage-page"]'), "storage settings render");
    await clickAndWait('[data-testid="reset-workspace-catalog"]');
    assert.ok(
      confirmMessages.some((m) => /Forget all remembered projects/.test(m)),
      "reset asks for confirmation before forgetting anything"
    );

    await clickAndWait('[data-testid="nav-workspace"]');
    assert.equal(root.querySelectorAll('[data-testid="project-item"]').length, 0, "the sidebar starts empty");
    assert.ok(el('[data-testid="no-projects"]'));

    const stored = JSON.parse(localStorageStub.getItem("windows-runner.workspace-catalog.v1") ?? "{}") as {
      projects?: unknown[];
      sessions?: unknown[];
    };
    assert.equal((stored.projects ?? []).length, 0, "the persisted catalog is cleared");
    assert.equal((stored.sessions ?? []).length, 0);

    assert.equal(callsTo("/api/providers"), providersBefore, "no provider deletion request");
    assert.equal(callsTo("/api/usage?limit=50"), usageBefore, "no session/usage mutation");
    assert.equal(callsTo("/api/health"), healthBefore, "no other server effects");
    assert.equal(sessionStorageStub.getItem("windows-runner.token"), "boot-token-987", "the token is untouched");
  });

  it("route history never carries tokens or provider secrets", () => {
    assert.ok(historyUrls.length > 0);
    for (const url of historyUrls) {
      assert.ok(!/(token=|api[-_]?key|bearer |sk-live)/i.test(url), `secret material leaked into a history URL: ${url}`);
    }
    for (const call of fetchCalls) {
      assert.ok(!/(token=|api[-_]?key=)/i.test(call.url), `secret material leaked into a request URL: ${call.url}`);
    }
    // The provider API surface this route host uses is exactly the pinned one
    // (health is called twice: the connect credential check and the settings
    // page's one-shot health load).
    const apiPaths = [...new Set(fetchCalls.map((c) => `${c.method} ${c.url}`))].sort();
    assert.deepEqual(apiPaths, ["GET /api/health", "GET /api/providers", "GET /api/usage?limit=50"]);
  });
});
