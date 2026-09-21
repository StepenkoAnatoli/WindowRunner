import { ApiClient, ApiRequestError, clearToken, loadToken, saveToken } from "./api.js";
import { activeTurn, initialAppState, reduceApp, type AppAction, type AppState, type TurnView } from "./app-state.js";
import { renderAppShell } from "./app-shell.js";
import { describeError } from "./describe-error.js";
import { getDesktopCapabilities, isDesktopAvailable } from "./desktop-bridge.js";
import { button, el } from "./dom.js";
import { renderInspector } from "./inspector.js";
import { renderProjectSidebar } from "./project-sidebar.js";
import { renderConversationWorkspace } from "./workspace.js";
import {
  createInMemoryCatalogStore,
  createLocalStorageCatalogStore,
  emptyWorkspaceCatalog,
  newCatalogId,
  type SessionCatalogEntry,
  type WorkspaceCatalogStore,
} from "./workspace-catalog.js";

/**
 * Windows Runner web UI — coordinator for the B1 three-column workspace.
 *
 * main.ts is the only module that owns side effects: connect/sign out,
 * workspace-catalog load/save, the desktop folder picker, session
 * create/reattach/delete, the turn stream lifecycle, cancel, approve/deny,
 * grant/revoke trust, and render scheduling. All rendering is delegated to
 * the pure view modules (`app-shell`, `project-sidebar`, `workspace`,
 * `inspector`, `tool-timeline`); all turn/tool/approval state stays in the
 * `app-state` reducer.
 *
 * B1 boundary: the sidebar is a persisted catalog of locally remembered
 * `{ project root, sessionId }` pairs, not a server-backed history browser.
 * There is exactly one visible/active stream (`streamAbort`); switching
 * projects/sessions while a turn is active is blocked, never silent.
 */

let state: AppState = initialAppState;
let client: ApiClient | undefined;
let streamAbort: AbortController | undefined;
let catalogStore: WorkspaceCatalogStore = createInMemoryCatalogStore();

const root = document.getElementById("app")!;

// Renders are coalesced to one per animation frame: with real providers a
// turn produces many text_delta events per second and each render rebuilds
// the DOM. (jsdom/Playwright still see every state change on the next frame.)
let renderScheduled = false;
function dispatch(action: AppAction): void {
  state = reduceApp(state, action);
  if (renderScheduled) return;
  renderScheduled = true;
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb: () => void) => setTimeout(cb, 16);
  raf(() => {
    renderScheduled = false;
    render();
  });
}

// ---------------------------------------------------------------------------
// Effects

async function connect(token: string): Promise<void> {
  const candidate = new ApiClient({ token });
  dispatch({ type: "auth_checking" });
  try {
    const health = await candidate.health();
    client = candidate;
    saveToken(token);
    dispatch({ type: "auth_ok", securityMode: health.security?.mode ?? "unknown", persistenceMode: health.persistence?.mode ?? "unknown" });
  } catch (err) {
    client = undefined;
    clearToken();
    dispatch({ type: "auth_invalid", message: describeError(err) });
  }
}

function signOut(): void {
  streamAbort?.abort();
  client = undefined;
  clearToken();
  dispatch({ type: "auth_cleared" });
}

async function persistCatalog(): Promise<void> {
  try {
    await catalogStore.save(state.workspace.catalog);
  } catch (err) {
    // Non-blocking: a catalog write failure must never roll back a
    // successfully created/attached server session.
    dispatch({ type: "error", code: "CATALOG_SAVE_FAILED", message: `could not save recent projects: ${describeError(err)}` });
  }
}

function basenameOf(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || root;
}

/** Open (remember + select) a project. Never calls the server. */
async function openProject(root: string): Promise<void> {
  const trimmed = root.trim();
  if (!trimmed) return;
  if (activeTurn(state)) {
    dispatch({ type: "error", code: "SESSION_SWITCH_BLOCKED", message: "Finish or stop the active turn before switching sessions." });
    return;
  }
  const existing = state.workspace.catalog.projects.find((p) => p.root === trimmed);
  if (existing) {
    dispatch({ type: "project_selected", projectId: existing.id, lastOpenedAt: Date.now() });
  } else {
    dispatch({
      type: "project_upserted",
      project: { id: newCatalogId("p"), root: trimmed, label: basenameOf(trimmed), lastOpenedAt: Date.now() },
    });
  }
  await persistCatalog();
}

async function chooseProjectFolder(): Promise<void> {
  const caps = getDesktopCapabilities();
  if (!caps) return;
  try {
    const folder = await caps.chooseProjectFolder();
    if (folder) await openProject(folder);
  } catch (err) {
    reportError(err);
  }
}

async function selectProject(projectId: string): Promise<void> {
  if (projectId === state.workspace.selectedProjectId) return;
  if (activeTurn(state)) {
    dispatch({ type: "error", code: "SESSION_SWITCH_BLOCKED", message: "Finish or stop the active turn before switching sessions." });
    return;
  }
  dispatch({ type: "project_selected", projectId, lastOpenedAt: Date.now() });
  await persistCatalog();
}

/** Create a fresh session id for a project and attach it. */
async function newSession(projectId: string): Promise<void> {
  if (activeTurn(state)) {
    dispatch({ type: "error", code: "SESSION_SWITCH_BLOCKED", message: "Finish or stop the active turn before switching sessions." });
    return;
  }
  const project = state.workspace.catalog.projects.find((p) => p.id === projectId);
  if (!project) return;
  const entry: SessionCatalogEntry = { sessionId: newCatalogId("s"), projectId, lastOpenedAt: Date.now() };
  dispatch({ type: "session_upserted", session: entry });
  await persistCatalog();
  await selectSession(entry);
}

/**
 * Attach a catalogued session: select it locally, then create-or-reattach
 * server-side. `SESSION_ALREADY_EXISTS` is the reattach path (the session
 * is still alive); anything else surfaces as an error and the optimistic
 * selection stays so the user can retry.
 */
async function selectSession(entry: SessionCatalogEntry): Promise<void> {
  if (activeTurn(state)) {
    dispatch({ type: "error", code: "SESSION_SWITCH_BLOCKED", message: "Finish or stop the active turn before switching sessions." });
    return;
  }
  const project = state.workspace.catalog.projects.find((p) => p.id === entry.projectId);
  if (!project || !client) return;
  dispatch({ type: "session_selected", sessionId: entry.sessionId, lastOpenedAt: Date.now() });
  await persistCatalog();
  dispatch({ type: "busy", busy: true });
  try {
    const created = await client.createSession(entry.sessionId, project.root);
    dispatch({ type: "session_created", sessionId: created.sessionId, root: created.root });
    await refreshTrust();
    await persistCatalog();
  } catch (err) {
    if (err instanceof ApiRequestError && err.code === "SESSION_ALREADY_EXISTS") {
      // Reattach to an existing session (e.g. after a page reload, or a
      // session remembered in the catalog from an earlier visit).
      try {
        const trust = await client.getTrust(entry.sessionId);
        dispatch({ type: "session_created", sessionId: entry.sessionId, root: trust.canonicalRoot });
        dispatch({ type: "trust_loaded", grant: trust.grant });
        await persistCatalog();
      } catch (inner) {
        reportError(inner);
      }
    } else {
      reportError(err);
    }
  } finally {
    dispatch({ type: "busy", busy: false });
  }
}

async function deleteSession(sessionId: string): Promise<void> {
  if (!client) return;
  streamAbort?.abort();
  try {
    await client.deleteSession(sessionId);
  } catch (err) {
    reportError(err);
  }
  // The catalog entry is kept as a recent: reselecting it recreates the
  // (empty) server session under the same id.
  dispatch({ type: "session_cleared" });
}

async function refreshTrust(): Promise<void> {
  if (!client || !state.session) return;
  try {
    const trust = await client.getTrust(state.session.sessionId);
    dispatch({ type: "trust_loaded", grant: trust.grant });
  } catch (err) {
    reportError(err);
  }
}

async function submitTurn(message: string): Promise<void> {
  if (!client || !state.session) return;
  dispatch({ type: "busy", busy: true });
  try {
    const { turnId } = await client.startTurn(state.session.sessionId, message);
    dispatch({ type: "turn_submitted", turnId, message });
    void followTurn(state.session.sessionId, turnId, 0);
  } catch (err) {
    reportError(err);
  } finally {
    dispatch({ type: "busy", busy: false });
  }
}

async function followTurn(sessionId: string, turnId: string, afterSeq: number): Promise<void> {
  if (!client) return;
  streamAbort?.abort();
  const abort = new AbortController();
  streamAbort = abort;
  dispatch({ type: "turn_connection", turnId, connection: "streaming" });
  try {
    const result = await client.streamTurn(
      sessionId,
      turnId,
      {
        onEvent: (event) => dispatch({ type: "turn_event", turnId, event }),
        onReconnect: (attempt) => dispatch({ type: "turn_connection", turnId, connection: "reconnecting", attempt }),
      },
      { afterSeq, signal: abort.signal }
    );
    if (result.reason === "gave_up") dispatch({ type: "turn_stream_error", turnId, message: `lost the event stream after ${result.seq} event(s); reload to resume` });
    else if (result.terminal || result.reason === "aborted") dispatch({ type: "turn_connection", turnId, connection: "closed" });
  } catch (err) {
    if (err instanceof ApiRequestError && err.isAuth) {
      signOut();
      dispatch({ type: "auth_invalid", message: "the server rejected the token while streaming; sign in again" });
      return;
    }
    dispatch({ type: "turn_stream_error", turnId, message: describeError(err) });
  }
}

async function cancelActive(): Promise<void> {
  const turn = activeTurn(state);
  if (!client || !state.session || !turn) return;
  try {
    await client.cancelTurn(state.session.sessionId, turn.turnId, "stopped from the web UI");
  } catch (err) {
    reportError(err);
  }
}

async function decide(requestId: string, decision: "approve" | "deny"): Promise<void> {
  if (!client || !state.session) return;
  try {
    await client.approve(state.session.sessionId, requestId, decision);
  } catch (err) {
    reportError(err);
  }
}

async function grantTrust(): Promise<void> {
  if (!client || !state.session || !state.trustPrompt) return;
  try {
    await client.grantTrust(state.session.sessionId, state.trustPrompt.configHash, state.trustPrompt.source);
    dispatch({ type: "trust_prompt_cleared" });
    await refreshTrust();
  } catch (err) {
    reportError(err);
  }
}

async function revokeTrust(): Promise<void> {
  if (!client || !state.session) return;
  try {
    await client.revokeTrust(state.session.sessionId);
    await refreshTrust();
  } catch (err) {
    reportError(err);
  }
}

function reportError(err: unknown): void {
  if (err instanceof ApiRequestError && err.isAuth) {
    signOut();
    dispatch({ type: "auth_invalid", message: "the server rejected the token; sign in again" });
    return;
  }
  const code = err instanceof ApiRequestError ? err.code : "CLIENT_ERROR";
  dispatch({ type: "error", code, message: describeError(err) });
}

// ---------------------------------------------------------------------------
// Rendering: header + three-column shell. Rebuilds the DOM from state.
// Input values are preserved across renders by keeping the inputs' current
// values when the same element is rebuilt.

function inspectorTurn(): TurnView | undefined {
  const sel = state.workspace.inspectorSelection;
  if (sel.kind !== "none") {
    const found = state.turns.find((t) => t.turnId === sel.turnId);
    if (found) return found;
  }
  return activeTurn(state) ?? state.turns[state.turns.length - 1];
}

function render(): void {
  const focused = document.activeElement as HTMLElement | null;
  const focusId = focused?.getAttribute("data-testid") ?? undefined;
  const inputValues = new Map<string, string>();
  root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea").forEach((el) => {
    const id = el.getAttribute("data-testid");
    if (id) inputValues.set(id, el.value);
  });

  const children: HTMLElement[] = [];
  if (state.auth !== "ok") {
    children.push(header(), tokenPanel());
  } else {
    const turn = inspectorTurn();
    children.push(
      renderAppShell({
        header: header(),
        sidebar: renderProjectSidebar({
          catalog: state.workspace.catalog,
          selectedProjectId: state.workspace.selectedProjectId,
          selectedSessionId: state.workspace.selectedSessionId,
          attachedRoot: state.session?.root,
          hasActiveTurn: Boolean(activeTurn(state)),
          desktopAvailable: isDesktopAvailable(),
          busy: state.busy,
          onChooseProjectFolder: () => void chooseProjectFolder(),
          onOpenProject: (root) => void openProject(root),
          onSelectProject: (projectId) => void selectProject(projectId),
          onNewSession: (projectId) => void newSession(projectId),
          onSelectSession: (sessionId) => {
            const entry = state.workspace.catalog.sessions.find((s) => s.sessionId === sessionId);
            if (entry) void selectSession(entry);
          },
          onDeleteSession: (sessionId) => void deleteSession(sessionId),
        }),
        workspace: renderConversationWorkspace({
          session: state.session,
          turns: state.turns,
          activeTurn: activeTurn(state),
          busy: state.busy,
          trustPrompt: state.trustPrompt,
          selectedTurnId: state.workspace.inspectorSelection.kind !== "none" ? state.workspace.inspectorSelection.turnId : undefined,
          onSubmit: (message) => void submitTurn(message),
          onCancel: () => void cancelActive(),
          onDecide: (requestId, decision) => void decide(requestId, decision),
          onGrantTrust: () => void grantTrust(),
          onDismissTrust: () => dispatch({ type: "trust_prompt_cleared" }),
          onSelectTurn: (turnId) => dispatch({ type: "inspector_selection_changed", selection: { kind: "turn", turnId } }),
          onSelectApproval: (turnId, requestId) => {
            dispatch({ type: "inspector_selection_changed", selection: { kind: "approval", turnId, requestId } });
            dispatch({ type: "inspector_tab_selected", tab: "approvals" });
          },
        }),
        inspector: renderInspector({
          tab: state.workspace.inspectorTab,
          selection: state.workspace.inspectorSelection,
          session: state.session,
          turn,
          turns: state.turns,
          onSelectTab: (tab) => dispatch({ type: "inspector_tab_selected", tab }),
          onSelectTool: (turnId, callId) => dispatch({ type: "inspector_selection_changed", selection: { kind: "tool", turnId, callId } }),
          onDecide: (requestId, decision) => void decide(requestId, decision),
          onRevokeTrust: () => void revokeTrust(),
        }),
        sidebarOpen: state.workspace.sidebarOpen,
        inspectorOpen: state.workspace.inspectorOpen,
      })
    );
  }
  if (state.error) children.push(errorBanner());

  root.replaceChildren(...children);

  inputValues.forEach((value, id) => {
    const el = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-testid="${id}"]`);
    if (el && el.value === el.defaultValue) el.value = value;
  });
  if (focusId) root.querySelector<HTMLElement>(`[data-testid="${focusId}"]`)?.focus();
}

function header(): HTMLElement {
  const server = state.server ? `auth ${state.server.securityMode} · persistence ${state.server.persistenceMode}` : "";
  const sidebarToggle = state.auth === "ok" ? button("toggle-sidebar", state.workspace.sidebarOpen ? "Hide projects" : "Show projects", () => dispatch({ type: "sidebar_toggled" }), "secondary") : null;
  const inspectorToggle = state.auth === "ok" ? button("toggle-inspector", state.workspace.inspectorOpen ? "Hide inspector" : "Show inspector", () => dispatch({ type: "inspector_toggled" }), "secondary") : null;
  if (sidebarToggle) sidebarToggle.setAttribute("aria-pressed", String(state.workspace.sidebarOpen));
  if (inspectorToggle) inspectorToggle.setAttribute("aria-pressed", String(state.workspace.inspectorOpen));
  return el(
    "header",
    {},
    el("h1", {}, "Windows Runner"),
    el("span", { class: "muted", "data-testid": "server-info" }, server),
    sidebarToggle,
    inspectorToggle,
    state.auth === "ok" ? button("sign-out", "Sign out", signOut, "secondary") : null
  );
}

function tokenPanel(): HTMLElement {
  const form = el(
    "form",
    { class: "panel", "data-testid": "token-form" },
    el("h2", {}, "API token"),
    el("p", { class: "hint" }, "The server prints the token in its banner (memory mode) or stores it at <data dir>/auth-token (file mode). It is kept in this tab only."),
    el("input", { type: "password", "data-testid": "token-input", placeholder: "Bearer token", autocomplete: "off", required: "true" }),
    button("token-submit", state.auth === "checking" ? "Checking…" : "Connect", undefined, "primary", state.auth === "checking"),
    state.auth === "invalid" ? el("p", { class: "error", role: "alert", "data-testid": "auth-error" }, state.authError ?? "invalid token") : null
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = form.querySelector<HTMLInputElement>('[data-testid="token-input"]')!;
    const token = input.value.trim();
    if (token) void connect(token);
  });
  return form;
}

function errorBanner(): HTMLElement {
  return el("div", { class: "banner error", role: "alert", "data-testid": "error-banner" }, el("strong", {}, state.error!.code), " ", state.error!.message, " ", button("dismiss-error", "Dismiss", () => dispatch({ type: "error_cleared" }), "link"));
}

// ---------------------------------------------------------------------------

function resolveCatalogStore(): WorkspaceCatalogStore {
  const caps = getDesktopCapabilities();
  if (caps) {
    return {
      load: async () => (await caps.loadWorkspaceCatalog()) ?? emptyWorkspaceCatalog(),
      save: async (catalog) => caps.saveWorkspaceCatalog(catalog),
    };
  }
  try {
    if (typeof localStorage !== "undefined") return createLocalStorageCatalogStore(localStorage);
  } catch {}
  return createInMemoryCatalogStore();
}

const initialToken = loadToken();
catalogStore = resolveCatalogStore();
render();
void catalogStore.load().then(
  (catalog) => dispatch({ type: "workspace_catalog_loaded", catalog }),
  () => dispatch({ type: "workspace_catalog_loaded", catalog: emptyWorkspaceCatalog() })
);
if (initialToken) void connect(initialToken);
