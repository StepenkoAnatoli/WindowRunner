import { strict as assert } from "node:assert";
import test from "node:test";
import {
  createInitialTurnState,
  reduceTurnState,
  type StreamEvent,
  type StreamEventWithoutSeq,
  type TurnState,
} from "../src/index.js";

function event(seq: number, partial: StreamEventWithoutSeq): StreamEvent {
  return {
    seq,
    at: seq * 1000,
    sessionId: partial.sessionId ?? "s1",
    turnId: partial.turnId ?? "t1",
    ...partial,
  } as StreamEvent;
}

test("lifecycle events carry stable turn identity and explicit terminal status", () => {
  const events: StreamEvent[] = [
    event(1, { type: "turn_started", limits: { maxSteps: 2, modelCallTimeoutMs: 100, toolTimeoutMs: 100, approvalTimeoutMs: 100 }, message: "hi" }),
    event(2, { type: "turn_failed", code: "MODEL_TIMEOUT", message: "model call timed out", retryable: true }),
  ];

  assert.equal(events[0].turnId, events[1].turnId);
  assert.equal(events[1].type, "turn_failed");
  assert.equal((events[1] as any).retryable, true);
});

test("reducer: idle -> running -> completed", () => {
  let state = createInitialTurnState();
  state = reduceTurnState(state, event(1, { type: "turn_started", limits: { maxSteps: 10, modelCallTimeoutMs: 1000, toolTimeoutMs: 1000, approvalTimeoutMs: 1000 }, message: "hello" }));
  assert.equal(state.status, "running");
  assert.equal(state.seq, 1);
  assert.equal(state.isTerminal, false);

  state = reduceTurnState(state, event(2, { type: "text_delta", delta: "hi" }));
  assert.equal(state.status, "running");
  assert.equal(state.textAccumulated, "hi");

  state = reduceTurnState(state, event(3, { type: "turn_completed", usage: { totalTokens: 10 } }));
  assert.equal(state.status, "completed");
  assert.equal(state.isTerminal, true);
  assert.equal(state.seq, 3);
});

test("reducer: running -> waiting_for_approval -> running", () => {
  let state = createInitialTurnState();
  state = reduceTurnState(state, event(1, { type: "turn_started", limits: { maxSteps: 10, modelCallTimeoutMs: 1000, toolTimeoutMs: 1000, approvalTimeoutMs: 1000 }, message: "run" }));
  state = reduceTurnState(
    state,
    event(2, {
      type: "turn_waiting_for_approval",
      request: { requestId: "a1", providerCallId: "c1", turnId: "t1", sessionId: "s1", toolName: "run_terminal", input: { command: "npm test" }, reason: "needs approval", expiresAt: 10000, createdAt: 2000 },
    })
  );
  assert.equal(state.status, "waiting_for_approval");
  assert.equal(state.pendingApprovals.size, 1);

  state = reduceTurnState(state, event(3, { type: "approval_resolved", requestId: "a1", decision: "approve", resolvedAt: 3000 }));
  assert.equal(state.status, "running");
  assert.equal(state.pendingApprovals.size, 0);
});

test("reducer: approval denied stays running", () => {
  let state = createInitialTurnState();
  state = reduceTurnState(state, event(1, { type: "turn_started", limits: { maxSteps: 10, modelCallTimeoutMs: 1000, toolTimeoutMs: 1000, approvalTimeoutMs: 1000 }, message: "run" }));
  state = reduceTurnState(
    state,
    event(2, {
      type: "turn_waiting_for_approval",
      request: { requestId: "a1", providerCallId: "c1", turnId: "t1", sessionId: "s1", toolName: "run_terminal", input: {}, reason: "needs approval", expiresAt: 10000, createdAt: 2000 },
    })
  );
  state = reduceTurnState(state, event(3, { type: "approval_resolved", requestId: "a1", decision: "deny", resolvedAt: 3000 }));
  state = reduceTurnState(
    state,
    event(4, {
      type: "tool_completed",
      callId: "c1",
      toolName: "run_terminal",
      result: { ok: false, code: "APPROVAL_DENIED", message: "denied", retryable: true },
    })
  );
  assert.equal(state.status, "running");
  assert.equal(state.isTerminal, false);
});

test("reducer: tool failures stay running, model failures terminal", () => {
  let state = createInitialTurnState();
  state = reduceTurnState(state, event(1, { type: "turn_started", limits: { maxSteps: 10, modelCallTimeoutMs: 1000, toolTimeoutMs: 1000, approvalTimeoutMs: 1000 }, message: "hi" }));

  // tool failed
  state = reduceTurnState(state, event(2, { type: "tool_started", callId: "c1", toolName: "read_file" }));
  state = reduceTurnState(
    state,
    event(3, { type: "tool_completed", callId: "c1", toolName: "read_file", result: { ok: false, code: "TOOL_FAILED", message: "failed", retryable: true } })
  );
  assert.equal(state.status, "running");
  assert.equal(state.isTerminal, false);

  // model failed
  state = reduceTurnState(state, event(4, { type: "turn_failed", code: "MODEL_FAILED", message: "model failed", retryable: false }));
  assert.equal(state.status, "failed");
  assert.equal(state.isTerminal, true);
});

test("reducer: idempotency — duplicate seq ignored", () => {
  let state = createInitialTurnState();
  state = reduceTurnState(state, event(1, { type: "turn_started", limits: { maxSteps: 10, modelCallTimeoutMs: 1000, toolTimeoutMs: 1000, approvalTimeoutMs: 1000 }, message: "hi" }));
  const state2 = reduceTurnState(state, event(1, { type: "turn_started", limits: { maxSteps: 10, modelCallTimeoutMs: 1000, toolTimeoutMs: 1000, approvalTimeoutMs: 1000 }, message: "hi" }));
  assert.equal(state2.seq, 1);
  assert.equal(state2, state); // same object returned for duplicate
});

test("reducer: terminal state ignores further events", () => {
  let state = createInitialTurnState();
  state = reduceTurnState(state, event(1, { type: "turn_started", limits: { maxSteps: 10, modelCallTimeoutMs: 1000, toolTimeoutMs: 1000, approvalTimeoutMs: 1000 }, message: "hi" }));
  state = reduceTurnState(state, event(2, { type: "turn_completed" }));
  assert.equal(state.isTerminal, true);

  const stateAfter = reduceTurnState(state, event(3, { type: "text_delta", delta: "should be ignored" }));
  assert.equal(stateAfter.seq, 2); // still 2, not 3
  assert.equal(stateAfter.textAccumulated, ""); // no text added after terminal
  assert.equal(stateAfter.status, "completed");
});

test("reducer: cancellation terminal", () => {
  let state = createInitialTurnState();
  state = reduceTurnState(state, event(1, { type: "turn_started", limits: { maxSteps: 10, modelCallTimeoutMs: 1000, toolTimeoutMs: 1000, approvalTimeoutMs: 1000 }, message: "hi" }));
  state = reduceTurnState(state, event(2, { type: "turn_cancelled", reason: "Stop pressed" }));
  assert.equal(state.status, "cancelled");
  assert.equal(state.isTerminal, true);
});

test("reducer: text accumulation for partial-stream handling", () => {
  let state = createInitialTurnState();
  state = reduceTurnState(state, event(1, { type: "turn_started", limits: { maxSteps: 10, modelCallTimeoutMs: 1000, toolTimeoutMs: 1000, approvalTimeoutMs: 1000 }, message: "hi" }));
  state = reduceTurnState(state, event(2, { type: "text_delta", delta: "hello " }));
  state = reduceTurnState(state, event(3, { type: "text_delta", delta: "world" }));
  assert.equal(state.textAccumulated, "hello world");

  // Duplicate seq should not duplicate text (P1-05)
  const dup = reduceTurnState(state, event(3, { type: "text_delta", delta: "world" }));
  assert.equal(dup.textAccumulated, "hello world");
});
