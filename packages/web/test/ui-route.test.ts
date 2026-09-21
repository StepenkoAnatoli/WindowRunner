import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { navigate, parseUiRoute, routePath, type UiRoute } from "../src/ui-route.js";

describe("parseUiRoute", () => {
  it("maps the documented pathname routes", () => {
    assert.deepEqual(parseUiRoute("/"), { kind: "workspace" });
    assert.deepEqual(parseUiRoute(""), { kind: "workspace" });
    assert.deepEqual(parseUiRoute("/providers"), { kind: "providers" });
    assert.deepEqual(parseUiRoute("/providers/"), { kind: "providers" });
    assert.deepEqual(parseUiRoute("/usage"), { kind: "usage" });
    assert.deepEqual(parseUiRoute("/settings/security"), { kind: "settings", section: "security" });
    assert.deepEqual(parseUiRoute("/settings/storage/"), { kind: "settings", section: "storage" });
    assert.deepEqual(parseUiRoute("/settings/about"), { kind: "settings", section: "about" });
  });

  it("keeps /dashboard a compatibility entry: it renders providers without renaming the URL", () => {
    assert.deepEqual(parseUiRoute("/dashboard"), { kind: "providers" });
    assert.deepEqual(parseUiRoute("/dashboard/"), { kind: "providers" });
  });

  it("falls back to the workspace for unknown paths", () => {
    assert.deepEqual(parseUiRoute("/unknown"), { kind: "workspace" });
    assert.deepEqual(parseUiRoute("/settings/not-a-section"), { kind: "workspace" });
    assert.deepEqual(parseUiRoute("/providers/extra/deep"), { kind: "workspace" });
  });

  it("never treats a token fragment (or any non-route hash) as an application route", () => {
    assert.deepEqual(parseUiRoute("/", "#token=secret-token-123"), { kind: "workspace" });
    assert.deepEqual(parseUiRoute("/", "#token=abc&extra=1"), { kind: "workspace" });
    assert.deepEqual(parseUiRoute("/providers", "#token=secret-token-123"), { kind: "providers" });
    assert.deepEqual(parseUiRoute("/", "#some-other-fragment"), { kind: "workspace" });
  });

  it("accepts #/ application links on the root page (bookmarks that every static host serves)", () => {
    assert.deepEqual(parseUiRoute("/", "#/providers"), { kind: "providers" });
    assert.deepEqual(parseUiRoute("", "#/usage"), { kind: "usage" });
    assert.deepEqual(parseUiRoute("/", "#/settings/storage"), { kind: "settings", section: "storage" });
  });
});

describe("routePath", () => {
  it("generates the canonical path for every route", () => {
    assert.equal(routePath({ kind: "workspace" }), "/");
    assert.equal(routePath({ kind: "providers" }), "/providers");
    assert.equal(routePath({ kind: "usage" }), "/usage");
    assert.equal(routePath({ kind: "settings", section: "security" }), "/settings/security");
    assert.equal(routePath({ kind: "settings", section: "storage" }), "/settings/storage");
    assert.equal(routePath({ kind: "settings", section: "about" }), "/settings/about");
  });

  it("round-trips through parseUiRoute", () => {
    const routes: UiRoute[] = [
      { kind: "workspace" },
      { kind: "providers" },
      { kind: "usage" },
      { kind: "settings", section: "security" },
      { kind: "settings", section: "storage" },
      { kind: "settings", section: "about" },
    ];
    for (const route of routes) {
      if (route.kind === "workspace") continue; // "/" normalizes to workspace — still equal
      assert.deepEqual(parseUiRoute(routePath(route)), route);
    }
    assert.deepEqual(parseUiRoute(routePath({ kind: "workspace" })), { kind: "workspace" });
  });

  it("never carries secrets: routes are built from kind/section only", () => {
    const path = routePath({ kind: "settings", section: "about" });
    assert.ok(!/token|key|secret/i.test(path));
  });
});

describe("navigate", () => {
  it("pushes the route path and notifies through popstate (browser-like globals)", () => {
    const pushed: string[] = [];
    let popped = 0;
    const listeners = new Map<string, Array<() => void>>();
    (globalThis as Record<string, unknown>).history = { pushState: (_s: unknown, _t: unknown, path: string) => pushed.push(path) };
    (globalThis as Record<string, unknown>).window = {
      dispatchEvent: () => {
        popped += 1;
      },
      addEventListener: (_t: string, cb: () => void) => {
        const list = listeners.get(_t) ?? [];
        list.push(cb);
        listeners.set(_t, list);
      },
    };
    try {
      navigate({ kind: "providers" });
      assert.deepEqual(pushed, ["/providers"]);
      assert.equal(popped, 1, "popstate must fire so the single route-handling path runs");
      navigate({ kind: "settings", section: "about" });
      assert.deepEqual(pushed, ["/providers", "/settings/about"]);
    } finally {
      delete (globalThis as Record<string, unknown>).history;
      delete (globalThis as Record<string, unknown>).window;
    }
  });

  it("is a no-op outside a browser (no history global)", () => {
    // No globals installed: must not throw.
    navigate({ kind: "usage" });
  });
});
