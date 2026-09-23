import type { ApprovalRequest, SkillDiagnostic, SkillMeta, StreamEvent, TurnState } from "@windows-runner/shared";
import { createInitialTurnState, reduceTurnState } from "@windows-runner/shared";
import type { HealthSummary, ProviderProfileView, TurnUsageView } from "./api.js";
import { validateProviderForm } from "./provider-types.js";
import {
  initialWorkspaceUiState,
  type InspectorSelection,
  type InspectorTab,
  type ProjectCatalogEntry,
  type SessionCatalogEntry,
  type WorkspaceCatalog,
  type WorkspaceUiState,
} from "./workspace-catalog.js";
import type { SettingsSection, UiRoute } from "./ui-route.js";

/**
 * UI state: a pure reducer over UI actions, separate from the shared turn
 * reducer (which folds StreamEvents into TurnState). Framework-free so it is
 * testable under Node; the renderer in main.ts is the only DOM code.
 */

export type ConnectionState = "idle" | "streaming" | "reconnecting" | "closed";

export interface ToolEntry {
  callId: string;
  toolName: string;
  input?: unknown;
  status: "called" | "running" | "done";
  result?: { ok: boolean; code?: string; message?: string; details?: Record<string, unknown>; output?: string };
}

export interface TurnView {
  turnId: string;
  message: string;
  state: TurnState;
  tools: ToolEntry[];
  connection: ConnectionState;
  reconnectAttempt: number;
  /** Set when the stream gave up or the server rejected it. */
  streamError?: string;
}

export interface TrustPrompt {
  realRoot: string;
  configHash: string;
  source: string;
  staleConfigHash?: string;
  toolName: string;
}

// ---------------------------------------------------------------------------
// B2 provider/usage UI state. The server stays the source of truth for
// provider profiles: this slice holds the masked list plus *editable form
// text* only. A raw API key exists in exactly one place — the in-memory
// `apiKey` form field while the user types — and is never persisted anywhere.

export interface ProviderNotice {
  tone: "success" | "error" | "info";
  text: string;
}

export interface ProviderFormState {
  mode: "create" | "edit";
  /** Create: the new profile's slug (server-required). Edit: the profile being edited. */
  profileId?: string;
  label: string;
  kind: string;
  baseUrl: string;
  model: string;
  /** Transient: the raw key only while typed. Never rendered back, never persisted. */
  apiKey: string;
  /** Distinguishes create-without-key / edit-keep-key / explicit replacement. */
  apiKeyMode: "empty" | "unchanged" | "replace";
  /**
   * Transient one-shot model-discovery state for the open form. Results are
   * cleared (back to idle) whenever kind, baseUrl, or apiKey materially
   * changes; the raw key never lands here — only the server's model ids do.
   */
  modelDiscovery:
    | { status: "idle" }
    | { status: "loading" }
    | { status: "ready"; models: string[] }
    | { status: "error"; message: string };
  validationErrors: Record<string, string>;
  submitting: boolean;
}

export interface ProviderUiState {
  status: "idle" | "loading" | "ready" | "error";
  /** Always taken from the server response, never guessed locally. */
  activeProfileId: string | null;
  profiles: ProviderProfileView[];
  form?: ProviderFormState;
  testingProfileId?: string;
  deletingProfileId?: string;
  activatingProfileId?: string;
  notice?: ProviderNotice;
  error?: { code: string; message: string };
}

export interface UsageUiState {
  status: "idle" | "loading" | "ready" | "error";
  records: TurnUsageView[];
  retained?: number;
  bounded?: boolean;
  error?: { code: string; message: string };
}

export const initialProviderUiState: ProviderUiState = { status: "idle", activeProfileId: null, profiles: [] };
export const initialUsageUiState: UsageUiState = { status: "idle", records: [] };

export interface AppState {
  auth: "unknown" | "checking" | "ok" | "invalid";
  authError?: string;
  server?: { securityMode: string; persistenceMode: string };
  session?: {
    sessionId: string;
    root: string;
    trust?: { configHash: string; source?: string } | null;
    /**
     * Skills the attached project ships (ADR 003), loaded by main.ts and kept
     * here so the reducer stays the only writer of app state. Index only: no
     * skill bodies, which the agent loads on demand via `read_skill`.
     */
    skills?: { skills: SkillMeta[]; diagnostics: SkillDiagnostic[] };
  };
  turns: TurnView[];
  activeTurnId?: string;
  /** Latest global, actionable error (API failures outside a turn). */
  error?: { code: string; message: string };
  /** Untrusted-project refusals seen in the active turn; the UI offers a grant button. */
  trustPrompt?: TrustPrompt;
  busy: boolean;
  /**
   * B1 workspace navigation + inspector-only state. The turn reducer above
   * stays authoritative for turns/tools/approvals; this slice only decides
   * which project/session is shown and which turn/tool/approval the
   * inspector focuses. No DOM behavior lives here.
   */
  workspace: WorkspaceUiState;
  /** B2 client-side route (which top-level page is visible). */
  route: UiRoute;
  /** B2 provider management state (masked server data + transient form). */
  providers: ProviderUiState;
  /** B2 recent-turn usage state for the usage page. */
  usage: UsageUiState;
  /** Full GET /api/health summary for the settings pages (read-only display). */
  health?: HealthSummary;
}

export const initialAppState: AppState = {
  auth: "unknown",
  turns: [],
  busy: false,
  workspace: initialWorkspaceUiState,
  route: { kind: "workspace" },
  providers: initialProviderUiState,
  usage: initialUsageUiState,
};

export type AppAction =
  | { type: "auth_checking" }
  | { type: "auth_ok"; securityMode: string; persistenceMode: string }
  | { type: "auth_invalid"; message: string }
  | { type: "auth_cleared" }
  | { type: "session_created"; sessionId: string; root: string }
  | { type: "session_cleared" }
  | { type: "trust_loaded"; grant: { configHash: string; source?: string } | null }
  | { type: "skills_loaded"; skills: SkillMeta[]; diagnostics: SkillDiagnostic[] }
  | { type: "turn_submitted"; turnId: string; message: string }
  | { type: "turn_event"; turnId: string; event: StreamEvent }
  | { type: "turn_connection"; turnId: string; connection: ConnectionState; attempt?: number }
  | { type: "turn_stream_error"; turnId: string; message: string }
  | { type: "error"; code: string; message: string }
  | { type: "error_cleared" }
  | { type: "trust_prompt_cleared" }
  | { type: "busy"; busy: boolean }
  // ---- B1 workspace navigation (coordinator-owned side effects live in main.ts) ----
  | { type: "workspace_catalog_loaded"; catalog: WorkspaceCatalog }
  | { type: "project_upserted"; project: ProjectCatalogEntry }
  | { type: "project_selected"; projectId: string; lastOpenedAt: number }
  | { type: "session_upserted"; session: SessionCatalogEntry }
  | { type: "session_selected"; sessionId: string; lastOpenedAt: number }
  | { type: "inspector_tab_selected"; tab: InspectorTab }
  | { type: "inspector_selection_changed"; selection: InspectorSelection }
  | { type: "sidebar_toggled" }
  | { type: "inspector_toggled" }
  // ---- B2 route host + provider/usage coordination ----
  | { type: "route_changed"; route: UiRoute }
  | { type: "health_loaded"; health: HealthSummary }
  /** Whole-slice replace; the slice's contents are computed by the provider controller. */
  | { type: "providers_state"; providers: ProviderUiState }
  /** Whole-slice replace; contents computed by the usage loader in main.ts. */
  | { type: "usage_state"; usage: UsageUiState }
  /** Settings → Storage "reset navigation metadata": clears the local catalog only. */
  | { type: "workspace_catalog_reset" };

export function reduceApp(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "auth_checking":
      return { ...state, auth: "checking", authError: undefined };
    case "auth_ok":
      return { ...state, auth: "ok", authError: undefined, server: { securityMode: action.securityMode, persistenceMode: action.persistenceMode } };
    case "auth_invalid":
      // The catalog is local navigation metadata, not server state: signing
      // out forgets the token/session but keeps the remembered projects.
      // Provider and usage slices ARE server state — they are dropped (and
      // with them any transient provider form, invariants 8/9).
      return {
        ...initialAppState,
        route: state.route,
        auth: "invalid",
        authError: action.message,
        workspace: { ...initialWorkspaceUiState, catalog: state.workspace.catalog },
      };
    case "auth_cleared":
      return {
        ...initialAppState,
        route: state.route,
        workspace: { ...initialWorkspaceUiState, catalog: state.workspace.catalog },
      };
    case "session_created": {
      // Unchanged turn semantics (clear turns/prompt) plus workspace selection:
      // the attached session becomes the selected one, aligned to its project.
      const entry = state.workspace.catalog.sessions.find((s) => s.sessionId === action.sessionId);
      return {
        ...state,
        session: { sessionId: action.sessionId, root: action.root, trust: undefined },
        turns: [],
        activeTurnId: undefined,
        error: undefined,
        trustPrompt: undefined,
        workspace: {
          ...state.workspace,
          selectedSessionId: action.sessionId,
          selectedProjectId: entry ? entry.projectId : state.workspace.selectedProjectId,
          inspectorSelection: { kind: "none" },
        },
      };
    }
    case "session_cleared":
      return {
        ...state,
        session: undefined,
        turns: [],
        activeTurnId: undefined,
        trustPrompt: undefined,
        workspace: { ...state.workspace, selectedSessionId: undefined, inspectorSelection: { kind: "none" } },
      };
    case "trust_loaded":
      return state.session ? { ...state, session: { ...state.session, trust: action.grant }, trustPrompt: action.grant ? undefined : state.trustPrompt } : state;
    case "skills_loaded":
      // Ignored when no session is attached: a late response from a session
      // that has since been replaced must not attach to the new one.
      return state.session
        ? { ...state, session: { ...state.session, skills: { skills: action.skills, diagnostics: action.diagnostics } } }
        : state;
    case "turn_submitted": {
      const view: TurnView = { turnId: action.turnId, message: action.message, state: createInitialTurnState(), tools: [], connection: "idle", reconnectAttempt: 0 };
      return { ...state, turns: [...state.turns, view], activeTurnId: action.turnId, error: undefined };
    }
    case "turn_event": {
      const idx = state.turns.findIndex((t) => t.turnId === action.turnId);
      if (idx === -1) return state;
      const view = state.turns[idx];
      const nextState = reduceTurnState(view.state, action.event);
      if (nextState === view.state) return state; // duplicate / post-terminal: nothing changed
      const tools = applyToolEvent(view.tools, action.event);
      const next: TurnView = { ...view, state: nextState, tools };
      let trustPrompt = state.trustPrompt;
      const ev: any = action.event;
      if (ev.type === "tool_completed" && ev.result?.ok === false && ev.result.code === "PROJECT_NOT_TRUSTED" && ev.result.details?.configHash) {
        trustPrompt = {
          realRoot: String(ev.result.details.realRoot ?? ""),
          configHash: String(ev.result.details.configHash),
          source: String(ev.result.details.source ?? "project configuration"),
          staleConfigHash: ev.result.details.staleConfigHash ? String(ev.result.details.staleConfigHash) : undefined,
          toolName: ev.toolName,
        };
      }
      const turns = state.turns.slice();
      turns[idx] = next;
      const activeTurnId = nextState.isTerminal && state.activeTurnId === action.turnId ? undefined : state.activeTurnId;
      const workspace = nextInspectorSelection(state.workspace, view, next, action.turnId);
      return { ...state, turns, activeTurnId, trustPrompt, workspace };
    }
    case "turn_connection": {
      return updateTurn(state, action.turnId, (v) => ({ ...v, connection: action.connection, reconnectAttempt: action.attempt ?? 0, streamError: action.connection === "streaming" ? undefined : v.streamError }));
    }
    case "turn_stream_error":
      return updateTurn(state, action.turnId, (v) => ({ ...v, streamError: action.message, connection: "closed" }));
    case "error":
      return { ...state, error: { code: action.code, message: action.message } };
    case "error_cleared":
      return { ...state, error: undefined };
    case "trust_prompt_cleared":
      return { ...state, trustPrompt: undefined };
    case "busy":
      return { ...state, busy: action.busy };
    case "workspace_catalog_loaded": {
      // Keep the in-memory selection only where the loaded catalog still has
      // the referenced project/session; a stale selection is dropped, never
      // kept dangling. This intentionally does not synthesize any transcript.
      const catalog = action.catalog;
      const selectedProjectId = catalog.projects.some((p) => p.id === state.workspace.selectedProjectId)
        ? state.workspace.selectedProjectId
        : undefined;
      const selectedSession = catalog.sessions.find((s) => s.sessionId === state.workspace.selectedSessionId);
      const selectedSessionId = selectedSession && selectedSession.projectId === selectedProjectId
        ? selectedSession.sessionId
        : undefined;
      return { ...state, workspace: { ...state.workspace, catalog, selectedProjectId, selectedSessionId } };
    }
    case "project_upserted": {
      const catalog = upsertProjectEntry(state.workspace.catalog, action.project);
      // Opening a project selects it. Re-opening the already-selected project
      // only touches recency — it must not wipe the visible turns.
      if (state.workspace.selectedProjectId === action.project.id) {
        return { ...state, workspace: { ...state.workspace, catalog } };
      }
      return {
        ...state,
        session: undefined,
        turns: [],
        activeTurnId: undefined,
        trustPrompt: undefined,
        workspace: {
          ...state.workspace,
          catalog,
          selectedProjectId: action.project.id,
          selectedSessionId: undefined,
          inspectorSelection: { kind: "none" },
        },
      };
    }
    case "project_selected": {
      const project = state.workspace.catalog.projects.find((p) => p.id === action.projectId);
      if (!project) return state;
      const catalog = touchProjectEntry(state.workspace.catalog, action.projectId, action.lastOpenedAt);
      if (state.workspace.selectedProjectId === action.projectId) {
        return { ...state, workspace: { ...state.workspace, catalog } };
      }
      // Selecting a project clears the server-session display until one of
      // its sessions is attached (the coordinator blocks this while a turn
      // is active, so no visible stream is ever abandoned here).
      return {
        ...state,
        session: undefined,
        turns: [],
        activeTurnId: undefined,
        trustPrompt: undefined,
        workspace: {
          ...state.workspace,
          catalog,
          selectedProjectId: action.projectId,
          selectedSessionId: undefined,
          inspectorSelection: { kind: "none" },
        },
      };
    }
    case "session_upserted":
      return { ...state, workspace: { ...state.workspace, catalog: upsertSessionEntry(state.workspace.catalog, action.session) } };
    case "session_selected": {
      // Selection only: this must not mutate turns itself. The coordinator
      // decides whether switching is allowed and then attaches, at which
      // point `session_created` clears the old turns. A selected session
      // always belongs to the selected project — selecting across projects
      // moves the project selection along.
      const entry = state.workspace.catalog.sessions.find((s) => s.sessionId === action.sessionId);
      if (!entry) return state;
      if (!state.workspace.catalog.projects.some((p) => p.id === entry.projectId)) return state;
      return {
        ...state,
        workspace: {
          ...state.workspace,
          catalog: touchSessionEntry(state.workspace.catalog, action.sessionId, action.lastOpenedAt),
          selectedProjectId: entry.projectId,
          selectedSessionId: action.sessionId,
        },
      };
    }
    case "inspector_tab_selected":
      return { ...state, workspace: { ...state.workspace, inspectorTab: action.tab } };
    case "inspector_selection_changed":
      return { ...state, workspace: { ...state.workspace, inspectorSelection: action.selection } };
    case "sidebar_toggled":
      return { ...state, workspace: { ...state.workspace, sidebarOpen: !state.workspace.sidebarOpen } };
    case "inspector_toggled":
      return { ...state, workspace: { ...state.workspace, inspectorOpen: !state.workspace.inspectorOpen } };
    case "route_changed":
      // Only the route moves. Invariant 7: the workspace catalog, the current
      // session, turns, and the token are untouched — and the provider form
      // (if open) is preserved in memory so nothing typed is lost.
      return { ...state, route: action.route };
    case "health_loaded":
      return { ...state, health: action.health };
    case "providers_state":
      return { ...state, providers: action.providers };
    case "usage_state":
      return { ...state, usage: action.usage };
    case "workspace_catalog_reset":
      // Clears ONLY the local navigation catalog (and the selections that
      // referenced it). Server sessions, provider profiles, and provider
      // secrets are untouched — the coordinator saves the empty catalog
      // through the same store the app already uses.
      return {
        ...state,
        workspace: {
          ...state.workspace,
          catalog: { version: 1, projects: [], sessions: [] },
          selectedProjectId: undefined,
          selectedSessionId: undefined,
          inspectorSelection: { kind: "none" },
        },
      };
    default:
      return state;
  }
}

/**
 * Inspector auto-follow for streamed events. A newly pending approval always
 * takes over (`{ kind: "approval", … }` on the approvals tab); otherwise the
 * active turn is followed only while the user has not manually focused
 * another turn/tool/approval. A resolved approval falls back to its turn.
 * Post-terminal events never reach here (the caller early-returns when the
 * shared reducer reports no change), so late UI state cannot overwrite the
 * terminal turn handling.
 */
function nextInspectorSelection(workspace: WorkspaceUiState, before: TurnView, after: TurnView, turnId: string): WorkspaceUiState {
  const beforePending = before.state.pendingApprovals;
  const afterPending = after.state.pendingApprovals;
  let fresh: string | undefined;
  for (const requestId of afterPending.keys()) {
    if (!beforePending.has(requestId)) {
      fresh = requestId;
      break;
    }
  }
  if (fresh !== undefined) {
    return {
      ...workspace,
      inspectorTab: "approvals",
      inspectorSelection: { kind: "approval", turnId, requestId: fresh },
    };
  }
  const selection = workspace.inspectorSelection;
  if (selection.kind === "approval" && selection.turnId === turnId && !afterPending.has(selection.requestId)) {
    return { ...workspace, inspectorSelection: { kind: "turn", turnId } };
  }
  if (selection.kind === "none") {
    return { ...workspace, inspectorSelection: { kind: "turn", turnId } };
  }
  return workspace;
}

function sortByRecency<T extends { lastOpenedAt: number }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

function upsertProjectEntry(catalog: WorkspaceCatalog, project: ProjectCatalogEntry): WorkspaceCatalog {
  const projects = sortByRecency([
    project,
    ...catalog.projects.filter((p) => p.id !== project.id && p.root !== project.root),
  ]);
  return { ...catalog, projects };
}

function touchProjectEntry(catalog: WorkspaceCatalog, projectId: string, lastOpenedAt: number): WorkspaceCatalog {
  return {
    ...catalog,
    projects: sortByRecency(catalog.projects.map((p) => (p.id === projectId ? { ...p, lastOpenedAt } : p))),
  };
}

function upsertSessionEntry(catalog: WorkspaceCatalog, session: SessionCatalogEntry): WorkspaceCatalog {
  const sessions = sortByRecency([
    session,
    ...catalog.sessions.filter((s) => s.sessionId !== session.sessionId),
  ]);
  return { ...catalog, sessions };
}

function touchSessionEntry(catalog: WorkspaceCatalog, sessionId: string, lastOpenedAt: number): WorkspaceCatalog {
  return {
    ...catalog,
    sessions: sortByRecency(catalog.sessions.map((s) => (s.sessionId === sessionId ? { ...s, lastOpenedAt } : s))),
  };
}

function updateTurn(state: AppState, turnId: string, fn: (v: TurnView) => TurnView): AppState {
  const idx = state.turns.findIndex((t) => t.turnId === turnId);
  if (idx === -1) return state;
  const turns = state.turns.slice();
  turns[idx] = fn(turns[idx]);
  return { ...state, turns };
}

function applyToolEvent(tools: ToolEntry[], event: StreamEvent): ToolEntry[] {
  const ev: any = event;
  switch (ev.type) {
    case "tool_call":
      return [...tools, { callId: ev.callId, toolName: ev.toolName, input: ev.input, status: "called" }];
    case "tool_started":
      return tools.map((t) => (t.callId === ev.callId ? { ...t, status: "running" } : t));
    case "tool_completed":
      return tools.map((t) => (t.callId === ev.callId ? { ...t, status: "done", result: ev.result } : t));
    default:
      return tools;
  }
}

export function pendingApprovals(view: TurnView | undefined): ApprovalRequest[] {
  return view ? [...view.state.pendingApprovals.values()] : [];
}

export function activeTurn(state: AppState): TurnView | undefined {
  return state.activeTurnId ? state.turns.find((t) => t.turnId === state.activeTurnId) : undefined;
}

/** Human-readable status line for a turn. */
export function describeTurn(view: TurnView): string {
  const s = view.state;
  if (view.streamError) return `stream error: ${view.streamError}`;
  switch (s.status) {
    case "idle":
      return view.connection === "reconnecting" ? `reconnecting (attempt ${view.reconnectAttempt})…` : "starting…";
    case "running": {
      const step = s.stepsCompleted > 0 ? `step ${s.stepsCompleted}/${s.limits.maxSteps} · ` : "";
      return view.connection === "reconnecting"
        ? `${step}running — reconnecting (attempt ${view.reconnectAttempt})…`
        : s.activeTools.size > 0
          ? `${step}running ${[...s.activeTools.values()].map((t) => t.toolName).join(", ")}…`
          : `${step}running…`;
    }
    case "waiting_for_approval":
      return `waiting for approval (${s.pendingApprovals.size})`;
    case "completed": {
      const steps = s.stepsCompleted > 1 ? ` · ${s.stepsCompleted} steps` : "";
      return s.usage?.totalTokens !== undefined ? `completed · ${s.usage.totalTokens} tokens${steps}` : `completed${steps}`;
    }
    case "cancelled":
      return "cancelled";
    case "failed":
      return `failed: ${s.error?.code ?? "unknown"} — ${s.error?.message ?? ""}${s.error?.retryable ? " (retryable)" : ""}`;
    default:
      return String(s.status);
  }
}

// ---------------------------------------------------------------------------
// Approval previews: show what a tool will do, not its JSON.

export type ApprovalPreview =
  | { kind: "diff"; path: string; lines: Array<{ type: "-" | "+" | " "; text: string }>; note?: string }
  | { kind: "command"; command: string; note?: string }
  | { kind: "json"; text: string };

const MAX_PREVIEW_LINES = 60;

export function previewApproval(toolName: string, input: unknown): ApprovalPreview {
  const obj = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
  if (obj) {
    if (toolName === "edit_file" && typeof obj.path === "string" && typeof obj.oldText === "string" && typeof obj.newText === "string") {
      const lines = [
        ...obj.oldText.split(/\r?\n/).map((text) => ({ type: "-" as const, text })),
        ...obj.newText.split(/\r?\n/).map((text) => ({ type: "+" as const, text })),
      ];
      return clip({ kind: "diff", path: obj.path, lines, note: obj.replaceAll === true ? "replaces every occurrence" : "replaces exactly one occurrence" });
    }
    if (toolName === "write_file" && typeof obj.path === "string" && typeof obj.content === "string") {
      const lines = obj.content.split(/\r?\n/).map((text) => ({ type: "+" as const, text }));
      return clip({ kind: "diff", path: obj.path, lines, note: `writes the whole file (${new TextEncoder().encode(obj.content).length} bytes)` });
    }
    if (toolName === "run_terminal" && typeof obj.command === "string") {
      return { kind: "command", command: obj.command, note: "runs in the project root via the system shell; no network or path restrictions apply inside the command" };
    }
  }
  return { kind: "json", text: safeStringify(input) };
}

function clip(p: Extract<ApprovalPreview, { kind: "diff" }>): ApprovalPreview {
  if (p.lines.length <= MAX_PREVIEW_LINES) return p;
  const hidden = p.lines.length - MAX_PREVIEW_LINES;
  return { ...p, lines: [...p.lines.slice(0, MAX_PREVIEW_LINES), { type: " ", text: `… ${hidden} more line(s)` }] };
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}
