import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installDomStub, uninstallDomStub, type StubDocument } from "./dom-stub.js";
import { el } from "../src/dom.js";
import { renderAppShell } from "../src/app-shell.js";

describe("app shell", () => {
  let doc: StubDocument;
  beforeEach(() => {
    doc = installDomStub();
  });
  afterEach(() => {
    uninstallDomStub();
  });

  function q(root: HTMLElement, sel: string): HTMLElement {
    const found = root.querySelector(sel);
    assert.ok(found, `missing ${sel}`);
    return found as HTMLElement;
  }

  function regions() {
    void doc;
    return {
      header: el("header", {}, "h"),
      sidebar: el("aside", { "data-testid": "project-sidebar" }, "s"),
      workspace: el("main", { "data-testid": "conversation-workspace" }, "w"),
      inspector: el("aside", { "data-testid": "context-inspector" }, "i"),
    };
  }

  it("renders header plus the three stable regions in sidebar/workspace/inspector order", () => {
    const r = regions();
    const root = renderAppShell({ ...r, sidebarOpen: true, inspectorOpen: true });
    const shell = q(root, '[data-testid="workspace-shell"]');
    assert.deepEqual(
      Array.from(shell.children).map((c) => (c as HTMLElement).getAttribute("data-testid")),
      ["project-sidebar", "conversation-workspace", "context-inspector"]
    );
    assert.ok(root.querySelector("header"), "header must be rendered");
  });

  it("marks collapsed panels with classes without unmounting them", () => {
    const r = regions();
    const root = renderAppShell({ ...r, sidebarOpen: false, inspectorOpen: false });
    const shell = q(root, '[data-testid="workspace-shell"]');
    const cls = shell.getAttribute("class")!;
    assert.match(cls, /sidebar-collapsed/);
    assert.match(cls, /inspector-collapsed/);
    // Still mounted (CSS hides them): input focus and scroll survive toggles.
    assert.ok(shell.querySelector('[data-testid="project-sidebar"]'));
    assert.ok(shell.querySelector('[data-testid="context-inspector"]'));

    const open = renderAppShell({ ...regions(), sidebarOpen: true, inspectorOpen: true });
    const openShell = q(open, '[data-testid="workspace-shell"]');
    assert.match(openShell.getAttribute("class")!, /sidebar-open/);
    assert.match(openShell.getAttribute("class")!, /inspector-open/);
  });
});
