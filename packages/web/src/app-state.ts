import type { ApprovalRequest, StreamEvent, TurnState } from "@windows-runner/shared";
import { createInitialTurnState, reduceTurnState } from "@windows-runner/shared";

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

export interface AppState {
  auth: "unknown" | "checking" | "ok" | "invalid";
  authError?: string;
  server?: { securityMode: string; persistenceMode: string };
  session?: { sessionId: string; root: string; trust?: { configHash: string; source?: string } | null };
  turns: TurnView[];
  activeTurnId?: string;
  /** Latest global, actionable error (API failures outside a turn). */
  error?: { code: string; message: string };
  /** Untrusted-project refusals seen in the active turn; the UI offers a grant button. */
  trustPrompt?: TrustPrompt;
  busy: boolean;
}

export const initialAppState: AppState = { auth: "unknown", turns: [], busy: false };

export type AppAction =
  | { type: "auth_checking" }
  | { type: "auth_ok"; securityMode: string; persistenceMode: string }
  | { type: "auth_invalid"; message: string }
  | { type: "auth_cleared" }
  | { type: "session_created"; sessionId: string; root: string }
  | { type: "session_cleared" }
  | { type: "trust_loaded"; grant: { configHash: string; source?: string } | null }
  | { type: "turn_submitted"; turnId: string; message: string }
  | { type: "turn_event"; turnId: string; event: StreamEvent }
  | { type: "turn_connection"; turnId: string; connection: ConnectionState; attempt?: number }
  | { type: "turn_stream_error"; turnId: string; message: string }
  | { type: "error"; code: string; message: string }
  | { type: "error_cleared" }
  | { type: "trust_prompt_cleared" }
  | { type: "busy"; busy: boolean };

export function reduceApp(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "auth_checking":
      return { ...state, auth: "checking", authError: undefined };
    case "auth_ok":
      return { ...state, auth: "ok", authError: undefined, server: { securityMode: action.securityMode, persistenceMode: action.persistenceMode } };
    case "auth_invalid":
      return { ...initialAppState, auth: "invalid", authError: action.message };
    case "auth_cleared":
      return { ...initialAppState };
    case "session_created":
      return { ...state, session: { sessionId: action.sessionId, root: action.root, trust: undefined }, turns: [], activeTurnId: undefined, error: undefined, trustPrompt: undefined };
    case "session_cleared":
      return { ...state, session: undefined, turns: [], activeTurnId: undefined, trustPrompt: undefined };
    case "trust_loaded":
      return state.session ? { ...state, session: { ...state.session, trust: action.grant }, trustPrompt: action.grant ? undefined : state.trustPrompt } : state;
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
      return { ...state, turns, activeTurnId, trustPrompt };
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
    default:
      return state;
  }
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
