import { strict as assert } from "node:assert";
import test from "node:test";
import { TurnManager } from "../../src/agent/turn-manager.js";
import { InMemoryTurnLogStore } from "../../src/agent/turn-log-store.js";

test("manager owns seq, monotonic per turn", () => {
  const manager = new TurnManager({ store: new InMemoryTurnLogStore() });
  const s1 = "s1", t1 = "t1";

  const e1 = manager.append(s1, t1, { type: "turn_started", limits: { maxSteps: 10, modelCallTimeoutMs: 1000, toolTimeoutMs: 1000, approvalTimeoutMs: 1000 }, message: "hi" });
  const e2 = manager.append(s1, t1, { type: "text_delta", delta: "hello" });
  const e3 = manager.append(s1, t1, { type: "turn_completed" });

  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);
  assert.equal(e3.seq, 3);

  const snap = manager.snapshot(s1, t1);
  assert.equal(snap.seq, 3);
  assert.equal(snap.events.length, 3);
  assert.equal(snap.status, "completed");
});

test("atomic subscribe: replay then live, no gap", () => {
  const manager = new TurnManager({ store: new InMemoryTurnLogStore() });
  const s1 = "s1", t1 = "t1";

  manager.append(s1, t1, { type: "turn_started", limits: { maxSteps: 10, modelCallTimeoutMs: 1000, toolTimeoutMs: 1000, approvalTimeoutMs: 1000 }, message: "hi" });
  manager.append(s1, t1, { type: "text_delta", delta: "a" });
  manager.append(s1, t1, { type: "text_delta", delta: "b" });

  const received: number[] = [];
  const { replay, unsubscribe } = manager.subscribe(s1, t1, 1, (event) => {
    received.push(event.seq);
  });

  assert.deepEqual(replay.map((e) => e.seq), [2, 3]);

  // Emit during subscription — should be received live, not lost
  manager.append(s1, t1, { type: "text_delta", delta: "c" });
  manager.append(s1, t1, { type: "text_delta", delta: "d" });

  assert.deepEqual(received, [4, 5]);

  unsubscribe();

  // After unsubscribe, no more events
  manager.append(s1, t1, { type: "text_delta", delta: "e" });
  assert.deepEqual(received, [4, 5]);
});

test("subscribe with afterSeq filters correctly", () => {
  const manager = new TurnManager({ store: new InMemoryTurnLogStore() });
  const s1 = "s1", t1 = "t1";

  for (let i = 0; i < 5; i++) {
    manager.append(s1, t1, { type: "turn_started", limits: { maxSteps: 10, modelCallTimeoutMs: 1000, toolTimeoutMs: 1000, approvalTimeoutMs: 1000 }, message: "hi" });
    if (i === 0) continue;
    // Actually first append already turn_started, so we need different events
  }

  // Reset for clean test
  const manager2 = new TurnManager({ store: new InMemoryTurnLogStore() });
  manager2.append(s1, t1, { type: "turn_started", limits: { maxSteps: 10, modelCallTimeoutMs: 1000, toolTimeoutMs: 1000, approvalTimeoutMs: 1000 }, message: "hi" });
  manager2.append(s1, t1, { type: "text_delta", delta: "1" });
  manager2.append(s1, t1, { type: "text_delta", delta: "2" });
  manager2.append(s1, t1, { type: "text_delta", delta: "3" });
  manager2.append(s1, t1, { type: "text_delta", delta: "4" });

  const { replay: replay0 } = manager2.subscribe(s1, t1, 0, () => {});
  assert.equal(replay0.length, 5);

  const { replay: replay2 } = manager2.subscribe(s1, t1, 2, () => {});
  assert.deepEqual(replay2.map((e) => e.seq), [3, 4, 5]);

  const { replay: replay5 } = manager2.subscribe(s1, t1, 5, () => {});
  assert.equal(replay5.length, 0);
});

test("Last-Event-ID replay: client reconnects without missed events", () => {
  const manager = new TurnManager({ store: new InMemoryTurnLogStore() });
  const s1 = "s1", t1 = "t1";

  manager.append(s1, t1, { type: "turn_started", limits: { maxSteps: 10, modelCallTimeoutMs: 1000, toolTimeoutMs: 1000, approvalTimeoutMs: 1000 }, message: "hi" });
  manager.append(s1, t1, { type: "text_delta", delta: "a" });
  manager.append(s1, t1, { type: "text_delta", delta: "b" });

  // Client disconnects after seq 2
  const afterSeq = 2;

  // Server emits more while client disconnected
  manager.append(s1, t1, { type: "text_delta", delta: "c" });
  manager.append(s1, t1, { type: "text_delta", delta: "d" });

  // Client reconnects with Last-Event-ID = 2
  const { replay } = manager.subscribe(s1, t1, afterSeq, () => {});
  assert.deepEqual(replay.map((e) => e.seq), [3, 4, 5]);
  assert.equal(replay[0].type, "text_delta");
});

test("terminal state: subscribe after terminal returns replay and closes", () => {
  const manager = new TurnManager({ store: new InMemoryTurnLogStore() });
  const s1 = "s1", t1 = "t1";

  manager.append(s1, t1, { type: "turn_started", limits: { maxSteps: 10, modelCallTimeoutMs: 1000, toolTimeoutMs: 1000, approvalTimeoutMs: 1000 }, message: "hi" });
  manager.append(s1, t1, { type: "turn_completed" });

  const { replay, state } = manager.subscribe(s1, t1, 0, () => {});
  assert.equal(replay.length, 2);
  assert.equal(state.isTerminal, true);
  assert.equal(state.status, "completed");
});

test("replay race: event emitted between snapshot and subscribe is not lost (atomic)", () => {
  const manager = new TurnManager({ store: new InMemoryTurnLogStore() });
  const s1 = "s1", t1 = "t1";

  manager.append(s1, t1, { type: "turn_started", limits: { maxSteps: 10, modelCallTimeoutMs: 1000, toolTimeoutMs: 1000, approvalTimeoutMs: 1000 }, message: "hi" });
  manager.append(s1, t1, { type: "text_delta", delta: "1" });

  // Simulate old non-atomic pattern: snapshot then emit then subscribe
  // Old way would lose event 3
  const snap = manager.snapshot(s1, t1);
  assert.equal(snap.events.length, 2);

  // Event emitted between snapshot and subscribe
  manager.append(s1, t1, { type: "text_delta", delta: "2" });

  // New atomic way: subscribe with afterSeq = snapshot seq
  const afterSeq = snap.seq;
  const { replay } = manager.subscribe(s1, t1, afterSeq, () => {});

  // Should include event 3, not lost
  assert.deepEqual(replay.map((e) => e.seq), [3]);
  assert.equal(replay[0].type, "text_delta");
});
