import { button, el } from "./dom.js";
import { sessionsForProject, sortedProjects, type WorkspaceCatalog } from "./workspace-catalog.js";

/**
 * Project + session navigation sidebar (B1).
 *
 * A sidebar "session" is a locally remembered `{ project root, sessionId }`
 * pair. Selecting one reattaches through the normal `createSession()` call;
 * the server answers `SESSION_ALREADY_EXISTS` when the session is still
 * alive. The sidebar never claims to reconstruct previous turn transcripts:
 * attaching shows a fresh (empty) conversation for that session id.
 *
 * Pure render: receives state + callbacks, never constructs ApiClient, calls
 * fetch, or mutates global state.
 */
export interface ProjectSidebarProps {
  catalog: WorkspaceCatalog;
  selectedProjectId?: string;
  selectedSessionId?: string;
  /** Attached session root (server-confirmed), shown for the selected session. */
  attachedRoot?: string;
  hasActiveTurn: boolean;
  desktopAvailable: boolean;
  busy: boolean;
  onChooseProjectFolder(): void;
  onOpenProject(root: string): void;
  onSelectProject(projectId: string): void;
  onNewSession(projectId: string): void;
  onSelectSession(sessionId: string): void;
  onDeleteSession(sessionId: string): void;
}

export function renderProjectSidebar(props: ProjectSidebarProps): HTMLElement {
  const projects = sortedProjects(props.catalog);
  const selectedProject = projects.find((p) => p.id === props.selectedProjectId);
  const sessions = selectedProject ? sessionsForProject(props.catalog, selectedProject.id) : [];
  const blocked = props.hasActiveTurn;

  const openRow = props.desktopAvailable
    ? button("choose-project", "Choose folder…", props.onChooseProjectFolder, "secondary", blocked || props.busy)
    : el(
        "form",
        { class: "open-project", "data-testid": "open-project-form" },
        el("input", {
          "data-testid": "project-path-input",
          placeholder: "/home/me/project",
          autocomplete: "off",
          ...(blocked ? { disabled: "true" } : {}),
        }),
        button("open-project", "Open project", undefined, "secondary", blocked || props.busy)
      );
  if (!props.desktopAvailable) {
    const form = openRow as HTMLElement;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = form.querySelector<HTMLInputElement>('[data-testid="project-path-input"]')!;
      const root = input.value.trim();
      if (root) {
        input.value = "";
        props.onOpenProject(root);
      }
    });
  }

  const projectItems = projects.map((p) => {
    const select = el(
      "button",
      {
        type: "button",
        class: `project-name${p.id === props.selectedProjectId ? " selected" : ""}`,
        "data-testid": `project-select-${p.id}`,
        ...(blocked ? { disabled: "true" } : {}),
      },
      p.label
    );
    if (!blocked) select.addEventListener("click", () => props.onSelectProject(p.id));
    return el(
      "li",
      { "data-testid": "project-item", "data-project-id": p.id, ...(p.id === props.selectedProjectId ? { "data-selected": "true" } : {}) },
      select,
      el("div", { class: "muted project-root" }, p.root)
    );
  });

  const sessionItems = sessions.map((s) => {
    const select = el(
      "button",
      {
        type: "button",
        class: `session-name${s.sessionId === props.selectedSessionId ? " selected" : ""}`,
        "data-testid": `session-select-${s.sessionId}`,
        ...(blocked ? { disabled: "true" } : {}),
      },
      s.sessionId
    );
    if (!blocked) select.addEventListener("click", () => props.onSelectSession(s.sessionId));
    return el(
      "li",
      {
        "data-testid": "session-item",
        "data-session-id": s.sessionId,
        ...(s.sessionId === props.selectedSessionId ? { "data-selected": "true" } : {}),
      },
      select
    );
  });

  return el(
    "aside",
    { class: "project-sidebar", "data-testid": "project-sidebar" },
    el("h2", {}, "Projects"),
    openRow,
    blocked
      ? el("p", { class: "hint warn", "data-testid": "session-switch-blocked" }, "Finish or stop the active turn before switching sessions.")
      : null,
    projects.length === 0
      ? el("p", { class: "hint", "data-testid": "no-projects" }, "Open a project folder to begin. Recent projects are remembered on this device only.")
      : el("ul", { class: "project-list", "data-testid": "project-list" }, ...projectItems),
    selectedProject
      ? el(
          "div",
          { class: "session-group" },
          el("h2", {}, "Sessions"),
          el("p", { class: "muted", "data-testid": "sidebar-project-root" }, selectedProject.root),
          button("new-session", "New session", () => props.onNewSession(selectedProject.id), "primary", blocked || props.busy),
          sessions.length === 0
            ? el("p", { class: "hint", "data-testid": "no-sessions" }, "No remembered sessions for this project yet.")
            : el("ul", { class: "session-list", "data-testid": "session-list" }, ...sessionItems),
          props.selectedSessionId
            ? el(
                "div",
                { class: "selected-session", "data-testid": "selected-session" },
                el("div", {}, el("span", { class: "muted" }, "session "), el("code", { "data-testid": "session-id" }, props.selectedSessionId)),
                props.attachedRoot ? el("div", {}, el("span", { class: "muted" }, "root "), el("code", { "data-testid": "session-root" }, props.attachedRoot)) : null,
                button("delete-session", "Delete session", () => props.onDeleteSession(props.selectedSessionId!), "secondary", blocked)
              )
            : null
        )
      : null
  );
}
