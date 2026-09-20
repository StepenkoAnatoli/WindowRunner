export type SessionId = string;
export type TurnId = string;
export type ApprovalId = string;
export type ToolCallId = string;

export type TurnStatus = "running" | "waiting_for_approval" | "completed" | "cancelled" | "failed";
export type ApprovalDecision = "approve" | "deny";
export type TurnFailureCode = "MODEL_TIMEOUT" | "MODEL_FAILED" | "APPROVAL_TIMEOUT" | "TURN_LIMIT" | "RESTART";
export type ToolErrorCode =
  | "TOOL_FAILED"
  | "TOOL_TIMED_OUT"
  | "APPROVAL_DENIED"
  | "UNKNOWN_TOOL"
  | "CANCELLED"
  | "PATH_ESCAPES_ROOT"
  | "PROJECT_NOT_TRUSTED"
  | "PATH_NOT_FOUND"
  | "NOT_A_FILE"
  | "NOT_A_DIRECTORY"
  | "IS_DIRECTORY"
  | "PERMISSION_DENIED"
  | "FILE_EXISTS"
  | "IO_ERROR";

export interface TurnLimits {
  maxSteps: number;
  modelCallTimeoutMs: number;
  toolTimeoutMs: number;
  approvalTimeoutMs: number;
}

export const DEFAULT_TURN_LIMITS: TurnLimits = {
  maxSteps: 120,
  modelCallTimeoutMs: 120_000,
  toolTimeoutMs: 120_000,
  approvalTimeoutMs: 300_000,
};

export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type ToolResult =
  | { ok: true; output: string }
  | { ok: false; code: ToolErrorCode; message: string; retryable: boolean };

export interface ApprovalRequest {
  requestId: ApprovalId;
  providerCallId: string; // correlation metadata, original toolCall.id, never registry key
  turnId: TurnId;
  sessionId: SessionId;
  toolName: string;
  input: unknown;
  reason: string;
  expiresAt: number; // computed by registry, single source
  createdAt: number;
}

export type ApprovalResolution =
  | { kind: "approved"; input?: unknown }
  | { kind: "denied"; reason?: string }
  | { kind: "expired" }
  | { kind: "cancelled" };

// ---- Event envelope ----

export interface StreamEventBase {
  seq: number; // per-turn monotonic from 1, owned by TurnManager
  at: number; // timestamp ms
  sessionId: SessionId;
  turnId: TurnId;
}

export type StreamEvent = StreamEventBase & (
  | { type: "turn_started"; limits: TurnLimits; message: string }
  | { type: "text_delta"; delta: string; accumulated?: string }
  | { type: "tool_call"; callId: ToolCallId; toolName: string; input: unknown }
  | { type: "turn_waiting_for_approval"; request: ApprovalRequest }
  | { type: "approval_resolved"; requestId: ApprovalId; decision: ApprovalDecision | string; resolvedAt: number; resolution?: ApprovalResolution }
  | { type: "tool_started"; callId: ToolCallId; toolName: string }
  | { type: "tool_completed"; callId: ToolCallId; toolName: string; result: ToolResult }
  | { type: "turn_completed"; usage?: TurnUsage }
  | { type: "turn_cancelled"; reason: string }
  | { type: "turn_failed"; code: TurnFailureCode; message: string; retryable: boolean }
);

// Events without seq/at/sessionId/turnId — what TurnRunner emits, manager stamps
// Use distributive Omit to preserve variant fields (Omit on Base & (A|B) loses variant fields)
type DistributiveOmit<T, K extends PropertyKey> = T extends any ? Omit<T, K> : never;
export type StreamEventWithoutSeq = DistributiveOmit<StreamEvent, "seq" | "at" | "sessionId" | "turnId"> & {
  sessionId?: SessionId;
  turnId?: TurnId;
  at?: number;
};

// ---- TurnState ----

export interface TurnState {
  sessionId: SessionId;
  turnId: TurnId;
  status: TurnStatus | "idle";
  seq: number; // last applied seq, 0 = no events
  limits: TurnLimits;
  startedAt?: number;
  updatedAt: number;
  stepsCompleted: number;
  pendingApprovals: Map<ApprovalId, ApprovalRequest>;
  activeTools: Map<ToolCallId, { toolName: string; startedAt: number }>;
  error?: { code: TurnFailureCode; message: string; retryable: boolean };
  usage?: TurnUsage;
  isTerminal: boolean;
  textAccumulated: string;
}

export function createInitialTurnState(): TurnState {
  return {
    sessionId: "",
    turnId: "",
    status: "idle",
    seq: 0,
    limits: { ...DEFAULT_TURN_LIMITS },
    updatedAt: 0,
    stepsCompleted: 0,
    pendingApprovals: new Map(),
    activeTools: new Map(),
    isTerminal: false,
    textAccumulated: "",
  };
}

export const initialTurnState: TurnState = createInitialTurnState();

// ---- Reducer ----

export function reduceTurnState(state: TurnState, event: StreamEvent): TurnState {
  // idempotency: duplicate seq
  if (event.seq <= state.seq) {
    return state;
  }

  // Once terminal, ignore all further events (even with higher seq) — idempotent
  if (state.isTerminal) {
    return state;
  }

  // Gap detection: if seq jumps, we still apply but could log. For now allow any seq > current.
  // In strict mode we could throw, but for resilience we apply.
  const next: TurnState = {
    ...state,
    sessionId: event.sessionId,
    turnId: event.turnId,
    seq: event.seq,
    updatedAt: event.at,
    // clone maps to keep pure (shallow copy)
    pendingApprovals: new Map(state.pendingApprovals),
    activeTools: new Map(state.activeTools),
  };

  switch (event.type) {
    case "turn_started": {
      next.status = "running";
      next.limits = event.limits;
      next.startedAt = event.at;
      next.stepsCompleted = 0;
      next.textAccumulated = "";
      next.pendingApprovals = new Map();
      next.activeTools = new Map();
      next.error = undefined;
      next.usage = undefined;
      next.isTerminal = false;
      break;
    }

    case "text_delta": {
      next.status = "running";
      next.textAccumulated += event.delta;
      break;
    }

    case "tool_call": {
      next.status = "running";
      next.stepsCompleted += 1;
      break;
    }

    case "turn_waiting_for_approval": {
      next.status = "waiting_for_approval";
      next.pendingApprovals.set(event.request.requestId, event.request);
      break;
    }

    case "approval_resolved": {
      next.pendingApprovals.delete(event.requestId);
      // if no more pending, back to running, else stay waiting
      next.status = next.pendingApprovals.size === 0 ? "running" : "waiting_for_approval";
      break;
    }

    case "tool_started": {
      next.status = "running";
      next.activeTools.set(event.callId, { toolName: event.toolName, startedAt: event.at });
      break;
    }

    case "tool_completed": {
      next.status = "running";
      next.activeTools.delete(event.callId);
      // Tool failures (TOOL_FAILED, TOOL_TIMED_OUT, APPROVAL_DENIED, UNKNOWN_TOOL) stay running
      // — model will be called again with result appended. This is explicit in mapping.
      break;
    }

    case "turn_completed": {
      next.status = "completed";
      next.isTerminal = true;
      next.stepsCompleted += 1;
      next.usage = event.usage;
      next.pendingApprovals.clear();
      next.activeTools.clear();
      break;
    }

    case "turn_cancelled": {
      next.status = "cancelled";
      next.isTerminal = true;
      next.pendingApprovals.clear();
      next.activeTools.clear();
      break;
    }

    case "turn_failed": {
      next.status = "failed";
      next.isTerminal = true;
      next.error = { code: event.code, message: event.message, retryable: event.retryable };
      next.pendingApprovals.clear();
      next.activeTools.clear();
      break;
    }

    default: {
      // exhaustive check
      const _exhaustive: never = event;
      return state;
    }
  }

  return next;
}

// ---- TurnLogStore seam ----

export interface TurnLogStore {
  append(turnId: TurnId, event: StreamEvent): Promise<void>;
  read(turnId: TurnId, afterSeq: number): Promise<StreamEvent[]>;
  readAll(turnId: TurnId): Promise<StreamEvent[]>;
  list(): Promise<TurnId[]>;
}

// ---- Helpers ----

export function isTerminalStatus(status: TurnStatus | "idle"): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}
