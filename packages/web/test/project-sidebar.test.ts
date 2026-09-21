import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installDomStub, uninstallDomStub, type FakeElement } from "./dom-stub.js";
import { renderProjectSidebar, type ProjectSidebarProps } from "../src/project-sidebar.js";
import { validateWorkspaceCatalog } from "../src/workspace-catalog.js";

describe("project sidebar", () => {
  beforeEach(() => {
    installDomStub();
  });
  afterEach(() => {
    uninstallDomStub();
  });

  function q(root: HTMLElement, sel: string): HTMLElement {
    const found = root.querySelector(sel);
    assert.ok(found, `missing ${sel}`);
    return found as HTMLElement;
  }

  function qa(root: HTMLElement, sel: string): HTMLElement[] {
    return Array.from(root.querySelectorAll(sel)) as HTMLElement[];
  }

  function catalog() {
    return validateWorkspaceCatalog({
      version: 1,
      projects: [
        { id: "p-old", root: "/old", label: "old", lastOpenedAt: 1 },
        { id: "p-new", root: "/new", label: "new", lastOpenedAt: 2 },
      ],
      sessions: [
        { sessionId: "s-a1", projectId: "p-new", lastOpenedAt: 3 },
        { sessionId: "s-a2", projectId: "p-new", lastOpenedAt: 4 },
        { sessionId: "s-b1", projectId: "p-old", lastOpenedAt: 5 },
      ],
    });
  }

  function props(overrides: Partial<ProjectSidebarProps> = {}): ProjectSidebarProps & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      catalog: catalog(),
      hasActiveTurn: false,
      desktopAvailable: false,
      busy: false,
      onChooseProjectFolder: () => void calls.push("choose"),
      onOpenProject: (root: string) => void calls.push(`open:${root}`),
      onSelectProject: (id: string) => void calls.push(`project:${id}`),
      onNewSession: (id: string) => void calls.push(`new:${id}`),
      onSelectSession: (id: string) => void calls.push(`session:${id}`),
      onDeleteSession: (id: string) => void calls.push(`delete:${id}`),
      ...overrides,
    };
  }

  it("desktop picker callback creates/selects a project; browser path fallback works", () => {
    const desktop = props({ desktopAvailable: true });
    const sidebar = renderProjectSidebar(desktop);
    assert.equal(sidebar.querySelector('[data-testid="project-path-input"]'), null);
    q(sidebar, '[data-testid="choose-project"]').click();
    assert.deepEqual(desktop.calls, ["choose"]);

    const browser = props({ desktopAvailable: false });
    const browserSidebar = renderProjectSidebar(browser);
    assert.equal(browserSidebar.querySelector('[data-testid="choose-project"]'), null);
    const input = browserSidebar.querySelector('[data-testid="project-path-input"]') as unknown as FakeElement;
    input.value = "  /tmp/proj  ";
    (q(browserSidebar, '[data-testid="open-project-form"]') as unknown as { submit(): void }).submit();
    assert.deepEqual(browser.calls, ["open:/tmp/proj"]);
  });

  it("lists projects most-recent-first and selects on click", () => {
    const p = props({});
    const sidebar = renderProjectSidebar(p);
    assert.deepEqual(
      qa(sidebar, '[data-testid="project-item"]').map((li: HTMLElement) => li.getAttribute("data-project-id")),
      ["p-new", "p-old"]
    );
    q(sidebar, '[data-testid="project-select-p-old"]').click();
    assert.deepEqual(p.calls, ["project:p-old"]);
  });

  it("scopes session entries to the selected project and selects on click", () => {
    const p = props({ selectedProjectId: "p-new" });
    const sidebar = renderProjectSidebar(p);
    assert.deepEqual(
      qa(sidebar, '[data-testid="session-item"]').map((li: HTMLElement) => li.getAttribute("data-session-id")),
      ["s-a2", "s-a1"]
    );
    q(sidebar, '[data-testid="session-select-s-a1"]').click();
    assert.deepEqual(p.calls, ["session:s-a1"]);
    assert.equal(sidebar.querySelector('[data-testid="no-sessions"]'), null);

    const other = renderProjectSidebar(props({ selectedProjectId: "p-old" }));
    assert.deepEqual(
      qa(other, '[data-testid="session-item"]').map((li: HTMLElement) => li.getAttribute("data-session-id")),
      ["s-b1"]
    );
  });

  it("creates sessions for the selected project and shows the attached session", () => {
    const p = props({ selectedProjectId: "p-new", selectedSessionId: "s-a1", attachedRoot: "/new" });
    const sidebar = renderProjectSidebar(p);
    q(sidebar, '[data-testid="new-session"]').click();
    assert.deepEqual(p.calls, ["new:p-new"]);
    assert.equal(q(sidebar, '[data-testid="session-id"]').textContent, "s-a1");
    assert.equal(q(sidebar, '[data-testid="session-root"]').textContent, "/new");
    q(sidebar, '[data-testid="delete-session"]').click();
    assert.deepEqual(p.calls, ["new:p-new", "delete:s-a1"]);
  });

  it("disables session/project switching during an active turn with an explanation", () => {
    const p = props({ selectedProjectId: "p-new", selectedSessionId: "s-a1", hasActiveTurn: true, desktopAvailable: true });
    const sidebar = renderProjectSidebar(p);
    const blocked = q(sidebar, '[data-testid="session-switch-blocked"]');
    assert.match(blocked.textContent, /Finish or stop the active turn before switching sessions/);
    assert.equal(q(sidebar, '[data-testid="new-session"]').getAttribute("disabled"), "true");
    assert.equal(q(sidebar, '[data-testid="choose-project"]').getAttribute("disabled"), "true");
    assert.equal(q(sidebar, '[data-testid="project-select-p-old"]').getAttribute("disabled"), "true");
    assert.equal(q(sidebar, '[data-testid="session-select-s-a2"]').getAttribute("disabled"), "true");
    assert.equal(q(sidebar, '[data-testid="delete-session"]').getAttribute("disabled"), "true");
    // Blocked controls have no listeners: clicks are inert.
    q(sidebar, '[data-testid="project-select-p-old"]').click();
    q(sidebar, '[data-testid="session-select-s-a2"]').click();
    assert.deepEqual(p.calls, []);

    const browser = renderProjectSidebar(props({ hasActiveTurn: true }));
    assert.equal(browser.querySelector('[data-testid="project-path-input"]')!.getAttribute("disabled"), "true");
    assert.equal(browser.querySelector('[data-testid="open-project"]')!.getAttribute("disabled"), "true");
  });

  it("shows empty hints when nothing is remembered yet", () => {
    const sidebar = renderProjectSidebar(props({ catalog: validateWorkspaceCatalog({ version: 1, projects: [], sessions: [] }) }));
    assert.ok(sidebar.querySelector('[data-testid="no-projects"]'));
    assert.equal(sidebar.querySelector('[data-testid="project-list"]'), null);
  });
});
