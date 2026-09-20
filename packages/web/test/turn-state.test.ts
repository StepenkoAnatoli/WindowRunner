import { strict as assert } from "node:assert";
import test from "node:test";
import { applyEvent, initialTurnState } from "../src/turn-state.js";

test("UI reducer exposes a pending approval and then completed state", () => {
  const started = applyEvent(initialTurnState, {
    seq: 1,
    at: 1,
    sessionId: "s1",
    turnId: "t1",
    type: "turn_started",
    limits: { maxSteps: 2, modelCallTimeoutMs: 100, toolTimeoutMs: 100, approvalTimeoutMs: 100 },
    message: "hi",
  });
  const waiting = applyEvent(started, {
    seq: 2,
    at: 2,
    sessionId: "s1",
    turnId: "t1",
    type: "turn_waiting_for_approval",
    request: { requestId: "a1", providerCallId: "c1", turnId: "t1", sessionId: "s1", toolName: "run_terminal", input: { command: "npm test" }, reason: "needs approval", expiresAt: 1000, createdAt: 2 },
  });
  assert.equal(waiting.status, "waiting_for_approval");
  assert.equal(waiting.pendingApprovals.get("a1")?.requestId, "a1");
  const completed = applyEvent(waiting, { seq: 3, at: 3, sessionId: "s1", turnId: "t1", type: "turn_completed" });
  assert.equal(completed.status, "completed");
  assert.equal(completed.pendingApprovals.size, 0);
});

test("reducer ignores duplicate seq (idempotent replay)", () => {
  const started = applyEvent(initialTurnState, {
    seq: 1,
    at: 1,
    sessionId: "s1",
    turnId: "t1",
    type: "turn_started",
    limits: { maxSteps: 2, modelCallTimeoutMs: 100, toolTimeoutMs: 100, approvalTimeoutMs: 100 },
    message: "hi",
  });
  const dup = applyEvent(started, {
    seq: 1,
    at: 1,
    sessionId: "s1",
    turnId: "t1",
    type: "turn_started",
    limits: { maxSteps: 2, modelCallTimeoutMs: 100, toolTimeoutMs: 100, approvalTimeoutMs: 100 },
    message: "hi",
  });
  assert.equal(dup.seq, 1);
  assert.equal(dup, started);
});

test("Last-Event-ID replay: apply only seq > lastSeen", () => {
  let state = initialTurnState;
  const events = [
    { seq: 1, at: 1, sessionId: "s1", turnId: "t1", type: "turn_started", limits: { maxSteps: 10, modelCallTimeoutMs: 1000, toolTimeoutMs: 1000, approvalTimeoutMs: 1000 }, message: "hi" },
    { seq: 2, at: 2, sessionId: "s1", turnId: "t1", type: "text_delta", delta: "a" },
    { seq: 3, at: 3, sessionId: "s1", turnId: "t1", type: "text_delta", delta: "b" },
    { seq: 4, at: 4, sessionId: "s1", turnId: "t1", type: "turn_completed" },
  ] as any[];

  for (const e of events) {
    state = applyEvent(state, e);
  }
  assert.equal(state.seq, 4);
  assert.equal(state.textAccumulated, "ab");

  // Simulate reconnect with afterSeq=2 — should replay 3,4 only
  let reconnectedState = initialTurnState;
  // First, apply 1,2 as if seen before disconnect
  reconnectedState = applyEvent(reconnectedState, events[0]);
  reconnectedState = applyEvent(reconnectedState, events[1]);
  assert.equal(reconnectedState.seq, 2);

  // Replay 3,4
  reconnectedState = applyEvent(reconnectedState, events[2]);
  reconnectedState = applyEvent(reconnectedState, events[3]);
  assert.equal(reconnectedState.seq, 4);
  assert.equal(reconnectedState.textAccumulated, "ab");
  assert.equal(reconnectedState.status, "completed");
});
