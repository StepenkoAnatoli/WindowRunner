import { ApiClient, ApiRequestError, clearToken, getApiClientBootstrap, loadToken, publishApiClientBootstrap, saveToken } from "./api.js";
import type { HealthSummary } from "./api.js";
import { activeTurn, initialAppState, reduceApp, type AppAction, type AppState, type TurnView } from "./app-state.js";
import { renderAppShell } from "./app-shell.js";
import { describeError } from "./describe-error.js";
import { getDesktopCapabilities, isDesktopAvailable } from "./desktop-bridge.js";
import { button, el } from "./dom.js";
import { installArrowFocus } from "./keyboard-nav.js";
import { renderInspector } from "./inspector.js";
import { renderProjectSidebar } from "./project-sidebar.js";
import { renderConversationWorkspace } from "./workspace.js";
import { createProviderController, type ProviderController } from "./provider-controller.js";
import type { ProviderFormField } from "./providers/provider-form.js";
import { renderProviderPage } from "./providers/provider-page.js";
import { renderUsagePage } from "./usage/usage-page.js";
import { renderSettingsShell } from "./settings/settings-shell.js";
import { renderSecurityPage } from "./settings/security-page.js";
import { renderStoragePage } from "./settings/storage-page.js";
import { renderAboutPage } from "./settings/about-page.js";
import { parseUiRoute, routePath, type SettingsSection, type UiRoute } from "./ui-route.js";
import {
  createInMemoryCatalogStore,
  createLocalStorageCatalogStore,
  emptyWorkspaceCatalog,
  newCatalogId,
  type SessionCatalogEntry,
  type WorkspaceCatalogStore,
} from "./workspace-catalog.js";

/**
 * Windows Runner web UI — coordinator for the B1 three-column workspace plus
 * the B2 route host (Workspace | Providers | Usage | Settings).
 *
 * main.ts is the only module that owns side effects: connect/sign out,
 * workspace-catalog load/save, the desktop folder picker, session
 * create/reattach/delete, the turn stream lifecycle, cancel, approve/deny,
 * grant/revoke trust, client-side route changes, provider mutations (through
 * the shared provider controller), usage loading, and render scheduling. All
 * rendering is delegated to the pure view modules; all turn/tool/approval
 * state stays in the `app-state` reducer.
 *
 * B1 boundary: the sidebar is a persisted catalog of locally remembered
 * `{ project root, sessionId }` pairs, not a server-backed history browser.
 * There is exactly one visible/active stream (`streamAbort`); switching
 * projects/sessions while a turn is active is blocked, never silent.
 *
 * B2/B3 boundary: routes are client-side (`history.pushState` + `popstate`,
 * parsed by ui-route.ts — no router dependency). The server serves this same
 * shell for the allowlisted deep routes so a refresh stays on the page.
 * Provider form state is transient UI memory: it is never persisted, never
 * enters the workspace catalog, and the raw key exists only inside the open
 * form while the user types. Route changes never clear the catalog, the
 * current session, or the token; sign-out drops provider/usage state but
 * keeps the catalog.
 */

let state: AppState = initialAppState;
let client: ApiClient | undefined;
let streamAbort: AbortController | undefined;
let catalogStore: WorkspaceCatalogStore = createInMemoryCatalogStore();

const USAGE_LIMIT = 50;
const DIRTY_FORM_CONFIRM = "You have unsaved changes in the provider form. Leave this page? The form stays in memory until you close it or sign out.";

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
// B2 provider coordination: the same controller the /dashboard compatibility
// page uses, wired to the app-state reducer.

function providerAuthError(): void {
  signOut();
  dispatch({ type: "auth_invalid", message: "the server rejected the token; sign in again" });
}

const providersController: ProviderController = createProviderController({
  getClient: () => client,
  get: () => state.providers,
  set: (providers) => dispatch({ type: "providers_state", providers }),
  onAuthError: () => providerAuthError(),
});

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
    // The boot route may need data (a reload lands on /providers once the
    // bundle can parse it); fetch for whatever page is visible.
    void loadRouteData(state.route);
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

/**
 * Settings → Storage's reset: forgets the LOCAL navigation catalog only.
 * Server sessions, provider profiles, and provider keys are untouched — this
 * goes through the same catalog store (localStorage / desktop preload IPC),
 * so the desktop path is the fixed bridge method, never arbitrary deletion.
 */
async function resetNavigationMetadata(): Promise<void> {
  if (!window.confirm("Forget all remembered projects and sessions on this device? Server sessions and provider profiles are not touched.")) return;
  dispatch({ type: "workspace_catalog_reset" });
  await persistCatalog();
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
// B2 routing: parse/apply locations, load per-route data with caching.

function routesEqual(a: UiRoute, b: UiRoute): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "settings" && b.kind === "settings") return a.section === b.section;
  return true;
}

/**
 * Programmatic navigation (the plan's `navigateTo`): push the path, update
 * state, load the route's data. A dirty provider form asks for confirmation
 * first — the form itself stays in memory either way, so confirming loses
 * nothing; declining simply keeps the user on the page.
 */
function navigateTo(route: UiRoute): void {
  if (routesEqual(route, state.route)) {
    // Same route: normalize the URL (e.g. "/" vs "/#token-stripped") but
    // never reload data the user is already looking at.
    history.replaceState({}, "", routePath(route));
    return;
  }
  if (providersController.isDirty() && !window.confirm(DIRTY_FORM_CONFIRM)) return;
  history.pushState({}, "", routePath(route));
  dispatch({ type: "route_changed", route });
  void loadRouteData(route);
}

/** Back/forward shares the exact same path as programmatic navigation. */
function onPopState(): void {
  const next = parseUiRoute(window.location.pathname, window.location.hash);
  if (routesEqual(next, state.route)) return;
  if (providersController.isDirty() && !window.confirm(DIRTY_FORM_CONFIRM)) {
    // Undo the pop: restore the history entry the user stayed on.
    history.pushState({}, "", routePath(state.route));
    return;
  }
  dispatch({ type: "route_changed", route: next });
  void loadRouteData(next);
}

/**
 * Per-route data loading with duplicate-request guards: provider/usage data
 * is cached while ready (explicit Refresh buttons force a reload; mutations
 * reload through the controller), settings fetch health only once.
 */
async function loadRouteData(route: UiRoute): Promise<void> {
  if (state.auth !== "ok") return;
  switch (route.kind) {
    case "workspace":
      break; // B1 state loads at boot and on selection
    case "providers":
      if (state.providers.status === "idle" || state.providers.status === "error") await providersController.load();
      break;
    case "usage":
      if (state.usage.status === "idle" || state.usage.status === "error") await loadUsage();
      break;
    case "settings":
      if (!state.health) await refreshHealth();
      break;
  }
}

async function loadUsage(force = false): Promise<void> {
  if (!client) return;
  if (!force && (state.usage.status === "loading" || state.usage.status === "ready")) return;
  dispatch({ type: "usage_state", usage: { ...state.usage, status: "loading", error: undefined } });
  try {
    const result = await client.usage(USAGE_LIMIT);
    dispatch({ type: "usage_state", usage: { status: "ready", records: result.records, retained: result.retained, bounded: result.bounded } });
  } catch (err) {
    if (err instanceof ApiRequestError && err.isAuth) {
      providerAuthError();
      return;
    }
    dispatch({
      type: "usage_state",
      usage: { ...state.usage, status: "error", error: { code: err instanceof ApiRequestError ? err.code : "CLIENT_ERROR", message: describeError(err) } },
    });
  }
}

async function refreshHealth(): Promise<void> {
  if (!client) return;
  try {
    const health: HealthSummary = await client.health();
    dispatch({ type: "health_loaded", health });
  } catch (err) {
    if (err instanceof ApiRequestError && err.isAuth) {
      providerAuthError();
      return;
    }
    reportError(err);
  }
}

// ---------------------------------------------------------------------------
// Rendering: header + route host. Rebuilds the DOM from state.
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
  // Capture each field's live value AND its state-backed default. The live
  // value alone is not enough: a re-render can be caused by a state change
  // to a field the user never typed in (picking a discovered model moves the
  // model field from the select), and restoring the stale live value would
  // silently undo that change.
  const inputValues = new Map<string, { value: string; defaultValue: string }>();
  root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea").forEach((el) => {
    const id = el.getAttribute("data-testid");
    if (id) inputValues.set(id, { value: el.value, defaultValue: el.defaultValue });
  });

  const children: Array<HTMLElement | null> = [];
  // In document flow under the header — not a sticky bar over the composer,
  // and not a dialog (no focus trap, Escape is not swallowed here).
  const notice = state.error ? errorBanner() : null;
  if (state.auth !== "ok") {
    children.push(header(), notice, tokenPanel());
  } else if (state.route.kind === "workspace") {
    const turn = inspectorTurn();
    children.push(
      renderAppShell({
        header: header(),
        notice,
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
  } else {
    children.push(el("div", { class: "app-root" }, header(), notice, routeContent()));
  }

  root.replaceChildren(...children.filter((node): node is HTMLElement => node !== null));

  inputValues.forEach((captured, id) => {
    const el = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-testid="${id}"]`);
    // Restore the previously-typed live value only when the field's default
    // (its state-backed attribute) did not move — otherwise STATE changed
    // the field and the stale live value must lose. This keeps typed values
    // that state deliberately does not hold (the API-key field) across
    // re-renders, while a discovered-model pick still reaches the field.
    if (el && el.defaultValue === captured.defaultValue && el.value !== captured.value) el.value = captured.value;
  });
  if (focusId) root.querySelector<HTMLElement>(`[data-testid="${focusId}"]`)?.focus();
}

function routeContent(): HTMLElement {
  switch (state.route.kind) {
    case "providers":
      return el(
        "main",
        { class: "route-page" },
        renderProviderPage({
          state: state.providers,
          onAdd: () => providersController.openCreateForm(),
          onEdit: (profileId) => {
            const profile = state.providers.profiles.find((p) => p.id === profileId);
            if (profile) providersController.openEditForm(profile);
          },
          onTest: (profileId) => void providersController.test(profileId),
          onActivate: (profileId) => void providersController.activate(profileId),
          onDelete: (profileId) => void providersController.delete(profileId),
          onSubmit: () => void providersController.submitForm(),
          onCancelForm: () => providersController.closeForm(),
          onFieldChange: (field: ProviderFormField, value: string) => providersController.handleFieldChange(field, value),
          onDiscoverModels: () => void providersController.discoverModels(),
          onDismissNotice: () => providersController.dismissNotice(),
          onRefresh: () => void providersController.load(true),
          onBackToWorkspace: () => navigateTo({ kind: "workspace" }),
        })
      );
    case "usage":
      return el(
        "main",
        { class: "route-page" },
        renderUsagePage({
          state: state.usage,
          limit: USAGE_LIMIT,
          onRefresh: () => void loadUsage(true),
          resolveProviderLabel: (providerId) => state.providers.profiles.find((p) => p.id === providerId)?.label ?? providerId,
        })
      );
    case "settings":
      return el(
        "main",
        { class: "route-page" },
        renderSettingsShell({
          section: state.route.section,
          onSelect: (section: SettingsSection) => navigateTo({ kind: "settings", section }),
          content: settingsContent(),
        })
      );
    case "workspace":
      // Unreachable (render() composes the workspace shell directly); kept so
      // the switch stays exhaustive.
      return el("main", { class: "route-page" });
  }
}

function settingsContent(): HTMLElement {
  const section: SettingsSection = state.route.kind === "settings" ? state.route.section : "security";
  switch (section) {
    case "security":
      return renderSecurityPage({ health: state.health, server: state.server });
    case "storage":
      return renderStoragePage({
        health: state.health,
        server: state.server,
        desktopAvailable: isDesktopAvailable(),
        onResetNavigationMetadata: () => void resetNavigationMetadata(),
      });
    case "about":
      return renderAboutPage({ health: state.health, server: state.server, desktopAvailable: isDesktopAvailable() });
  }
}

function navItem(testId: string, label: string, route: UiRoute): HTMLElement {
  const active = routesEqual(state.route, route);
  const b = el("button", { type: "button", class: `nav-link${active ? " selected" : ""}`, "data-testid": testId }, label);
  if (active) b.setAttribute("aria-current", "page");
  b.addEventListener("click", () => navigateTo(route));
  return b;
}

function header(): HTMLElement {
  const server = state.server ? `auth ${state.server.securityMode} · persistence ${state.server.persistenceMode}` : "";
  const onWorkspace = state.route.kind === "workspace";
  const sidebarToggle = state.auth === "ok" && onWorkspace
    ? button("toggle-sidebar", state.workspace.sidebarOpen ? "Hide projects" : "Show projects", () => dispatch({ type: "sidebar_toggled" }), "secondary")
    : null;
  const inspectorToggle = state.auth === "ok" && onWorkspace
    ? button("toggle-inspector", state.workspace.inspectorOpen ? "Hide inspector" : "Show inspector", () => dispatch({ type: "inspector_toggled" }), "secondary")
    : null;
  if (sidebarToggle) sidebarToggle.setAttribute("aria-pressed", String(state.workspace.sidebarOpen));
  if (inspectorToggle) inspectorToggle.setAttribute("aria-pressed", String(state.workspace.inspectorOpen));
  const nav = state.auth === "ok"
    ? el(
        "nav",
        { class: "top-nav", "data-testid": "top-nav", "aria-label": "Main" },
        navItem("nav-workspace", "Workspace", { kind: "workspace" }),
        navItem("nav-providers", "Providers", { kind: "providers" }),
        navItem("nav-usage", "Usage", { kind: "usage" }),
        navItem("nav-settings", "Settings", { kind: "settings", section: state.route.kind === "settings" ? state.route.section : "security" })
      )
    : null;
  if (nav) installArrowFocus(nav, "button.nav-link");
  return el(
    "header",
    {},
    el("h1", {}, "Windows Runner"),
    el("span", { class: "muted", "data-testid": "server-info" }, server),
    nav,
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
  // role=alert, not a dialog: Tab moves on, Escape is not captured. Provider
  // form Escape and native confirm() are the dismissal paths; this banner is
  // dismissed with its button.
  return el("div", { class: "banner error", role: "alert", "data-testid": "error-banner" }, el("strong", {}, state.error!.code), " ", state.error!.message, " ", button("dismiss-error", "Dismiss", () => dispatch({ type: "error_cleared" }), "link"));
}

/**
 * A refresh of `/providers` (and the other allowlisted routes) loads this
 * document directly — the `/desktop` renderer, which normally publishes the
 * in-memory token, does not run. Ask the preload bridge once, before
 * `loadToken()`, so `saveToken` stays a no-op. A missing or malformed
 * bootstrap is ignored: the browser token form still works.
 */
function adoptDesktopBootstrap(): void {
  if (getApiClientBootstrap()) return;
  if (typeof window === "undefined") return;
  const bridge = (window as unknown as {
    windowRunnerDesktop?: { getBootstrap?: () => { baseUrl?: unknown; token?: unknown } };
  }).windowRunnerDesktop;
  if (!bridge || typeof bridge.getBootstrap !== "function") return;
  let raw: { baseUrl?: unknown; token?: unknown } | undefined;
  try {
    raw = bridge.getBootstrap();
  } catch {
    return;
  }
  if (!raw || typeof raw.baseUrl !== "string" || typeof raw.token !== "string" || raw.token.length === 0) return;
  publishApiClientBootstrap({ baseUrl: raw.baseUrl, token: raw.token });
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

adoptDesktopBootstrap();
const initialToken = loadToken();
catalogStore = resolveCatalogStore();
// Apply the boot route before the first render (unknown paths and
// `#token=…` fragments resolve to the workspace via parseUiRoute).
dispatch({ type: "route_changed", route: parseUiRoute(window.location.pathname, window.location.hash) });
render();
void catalogStore.load().then(
  (catalog) => dispatch({ type: "workspace_catalog_loaded", catalog }),
  () => dispatch({ type: "workspace_catalog_loaded", catalog: emptyWorkspaceCatalog() })
);
if (initialToken) void connect(initialToken);
window.addEventListener("popstate", onPopState);
