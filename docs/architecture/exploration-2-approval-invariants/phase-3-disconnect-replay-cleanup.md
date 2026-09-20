# Phase 3 — Disconnect, replay vs live, cleanup, concurrent approvals, reconnect

**Focus:** Your Phase 3 requirements + contracts 5,6,8 and additional assertion to inspect global map and per-turn index after every scenario.

**Implementation constraints preserved (from your go):**
- `settle()` must be the only function that mutates registry settlement state.
- Callers may emit `approval_resolved` only when `settled: true`.
- Expected outcomes — approval, denial, expiry, cancellation — must resolve `wait()` normally; reserve rejection for unexpected internal failures.
- Reducer must remain independent of live promise state.
- Terminal cleanup must use same settlement path and must not emit duplicate resolution events.
- Preserve distinction: 404 request does not belong to URL session; 409 request belongs to session but already settled.

**Status:** Draft for review — stops and waits for your go before Phase 4 (integration, migration to deadline module).

---

## 1. Disconnect behavior — SSE unsubscribe must not settle

### 1.1 Current after #3+#6

**Manager:**

```ts
subscribe(sessionId, turnId, afterSeq, listener) => { replay, state, unsubscribe }
// unsubscribe = () => listeners.delete(listener)
// Does NOT call cancelTurn, settle, or clear registry
```

**Routes:**

```ts
app.get("/events", (req, res) => {
  const { replay, unsubscribe } = manager.subscribe(..., listener);
  // write replay
  req.on("close", () => unsubscribe()); // only removes listener
});
```

**ApprovalRegistry:**

- `wait(requestId)` no longer takes signal — fix for C2
- `cancelTurn` only called by explicit `POST /cancel` and loop `finally`, not by SSE close

**Test that proves it (from #3+#6):**

```ts
test("approval remains pending after SSE disconnect", async () => {
  const { replay, unsubscribe } = manager.subscribe(s1, t1, 0, () => {});
  assert.ok(replay.some(e => e.type === "turn_waiting_for_approval"));
  unsubscribe();
  assert.equal(approvals.snapshot(t1).length, 1); // still pending
});
```

**What must stay:**

- `unsubscribe` must NEVER call `approvals.cancelTurn`, `approvals.settle`, or clear entries
- Only `POST /turns/:turnId/cancel` and loop `finally` may call `cancelTurn`
- `settle()` is the only mutator — disconnect path does not call it

**Implementation constraint:** Add lint rule or code comment: `subscribe` and `unsubscribe` must not import `ApprovalRegistry`.

### 1.2 Failure-path: client disconnects during approval wait

- Client disconnects (network blip) → server `req.on("close")` → `unsubscribe()` → listener removed, approval remains pending in registry and in TurnState.pendingApprovals
- Client reconnects with `Last-Event-ID` → `subscribe(afterSeq)` → replay includes `turn_waiting_for_approval` event, state still `waiting_for_approval`, UI shows ApprovalCard again
- User approves → `approve()` → `settle(approved)` → promise resolves → loop emits `approval_resolved` → manager appends and notifies new listener

**No duplicate settlement, no leak.**

---

## 2. Replay vs live settlement — reducer independent of promises

### 2.1 Separation

- **Live:** Registry owns `Map<requestId, { promise, resolve, timeoutId }>` — `wait()` returns promise that resolves with `ApprovalResolution`
- **Replay:** Reducer owns `TurnState.pendingApprovals Map` — folds `turn_waiting_for_approval` (add) and `approval_resolved` (remove), no promise involved

**Why separate?**

- On restart from persisted log (future file store), registry is empty, but TurnState can be re-derived from events — pending approvals reconstructed without live promises
- On SSE reconnect, client replays `approval_resolved` event — reducer removes from pending, but registry already settled and entry deleted — no second settlement, no promise resolver invoked

### 2.2 What must NOT happen on replay

- Replaying `approval_resolved` must NOT call `registry.settle()` or `registry.approve()` or `resolve()`
- Replaying must NOT create new entry in global map or per-turn index
- Replaying must only call `reduceTurnState`

**Implementation:**

```ts
// In TurnManager.boot() for file store future:
let state = createInitialTurnState();
for (const event of events) {
  state = reduceTurnState(state, event);
  // Do NOT call approvals.request or approvals.settle
}
// After boot, if state has pending approvals but registry is empty, we have a divergence
// For now (in-memory), boot is no-op. For file store, we will have pending approvals in state but not in registry
// Decision: on boot, if state is waiting_for_approval but registry empty, we should append turn_failed RESTART (as in Phase 2 doc)
// So replay does not need to restore registry — it just reconstructs state, and if state is not terminal, we fail it
```

**Test:**

```ts
test("replay reconstructing resolved approval without settling live promise twice", () => {
  const registry = new ApprovalRegistry();
  const req = registry.request({ sessionId: "s1", turnId: "t1", providerCallId: "c1", toolName: "run_terminal", input: {}, reason: "needs", timeoutMs: 1000 });

  // Live: approve
  const waitPromise = registry.wait(req.requestId);
  registry.approve(req.requestId);
  const resolution = await waitPromise;
  assert.equal(resolution.kind, "approved");
  assert.equal(registry.has(req.requestId), false); // cleaned up

  // Replay: fold events via reducer, no registry calls
  let state = createInitialTurnState();
  state = reduceTurnState(state, { seq: 1, at: 1, sessionId: "s1", turnId: "t1", type: "turn_started", limits: DEFAULT_LIMITS, message: "hi" });
  state = reduceTurnState(state, { seq: 2, at: 2, sessionId: "s1", turnId: "t1", type: "turn_waiting_for_approval", request: req });
  assert.equal(state.pendingApprovals.size, 1);

  state = reduceTurnState(state, { seq: 3, at: 3, sessionId: "s1", turnId: "t1", type: "approval_resolved", requestId: req.requestId, decision: "approve", resolvedAt: 3, resolution: { kind: "approved" } });
  assert.equal(state.pendingApprovals.size, 0);

  // Registry still empty, no second settlement, no leak
  assert.equal(registry.has(req.requestId), false);
  assert.equal(registry.snapshot("t1").length, 0);

  // Inspect both global map and per-turn index — not just observable state
  assert.equal((registry as any).entries.size, 0);
  assert.equal((registry as any).byTurn.size, 0);
});
```

**Constraint:** Reducer must remain pure, no import of ApprovalRegistry, no side effects.

---

## 3. Cleanup guarantees — registry empty after every terminal path

### 3.1 After decision (approved/denied)

```ts
test("cleanup after approved", () => {
  const registry = new ApprovalRegistry();
  const req = registry.request({ sessionId: "s1", turnId: "t1", providerCallId: "c1", toolName: "run_terminal", input: {}, reason: "needs", timeoutMs: 1000 });
  assert.equal(registry.has(req.requestId), true);
  assert.equal(registry.snapshot("t1").length, 1);
  assert.equal((registry as any).byTurn.get("t1")?.size, 1);

  registry.approve(req.requestId);

  // Inspect both maps, not just observable state
  assert.equal(registry.has(req.requestId), false);
  assert.equal(registry.snapshot("t1").length, 0);
  assert.equal((registry as any).entries.size, 0);
  assert.equal((registry as any).byTurn.has("t1"), false);
});
```

Same for denied.

### 3.2 After expiry

```ts
test("cleanup after expired — timer cleared, maps empty", async () => {
  const registry = new ApprovalRegistry();
  const req = registry.request({ sessionId: "s1", turnId: "t1", providerCallId: "c1", toolName: "run_terminal", input: {}, reason: "needs", timeoutMs: 10 });

  const waitPromise = registry.wait(req.requestId);
  const resolution = await waitPromise; // should resolve with expired after 10ms

  assert.equal(resolution.kind, "expired");
  assert.equal(registry.has(req.requestId), false);
  assert.equal((registry as any).entries.size, 0);
  assert.equal((registry as any).byTurn.size, 0);
  // Timer should be cleared — no leak
});
```

**Timer cleanup:** `settle()` clears `timeoutId` via `clearTimeout`. For expiry path, timer already fired, so clear is no-op, but we still call it for safety.

### 3.3 After cancellation (cancelTurn)

```ts
test("cleanup after cancelled — cancelTurn", async () => {
  const registry = new ApprovalRegistry();
  const req = registry.request({ sessionId: "s1", turnId: "t1", providerCallId: "c1", toolName: "run_terminal", input: {}, reason: "needs", timeoutMs: 1000 });

  const waitPromise = registry.wait(req.requestId);
  registry.cancelTurn("t1");

  const resolution = await waitPromise;
  assert.equal(resolution.kind, "cancelled");
  assert.equal((registry as any).entries.size, 0);
  assert.equal((registry as any).byTurn.size, 0);
});
```

### 3.4 After terminal failure (turn_failed) and turn completion

- Loop `finally` calls `cancelTurn(turnId)` — guarantees cleanup even if turn_failed before approval resolved
- Test: start turn that fails with MODEL_FAILED while waiting for approval — registry should be empty after

```ts
test("cleanup after terminal failure during approval wait", async () => {
  const registry = new ApprovalRegistry();
  const req = registry.request({ sessionId: "s1", turnId: "t1", providerCallId: "c1", toolName: "run_terminal", input: {}, reason: "needs", timeoutMs: 10000 });

  // Simulate terminal failure: loop would call cancelTurn in finally
  registry.cancelTurn("t1");

  assert.equal((registry as any).entries.size, 0);
  assert.equal((registry as any).byTurn.size, 0);
});
```

---

## 4. Concurrent approvals — one turn, multiple requests, other turns untouched

### 4.1 Current sequential executor has at most 1 pending, but type allows many

Future concurrent tools could have multiple pending approvals per turn. Even with sequential, we should test multiple.

```ts
test("concurrent approvals — turn with multiple requests, settle each exactly once", async () => {
  const registry = new ApprovalRegistry();
  const req1 = registry.request({ sessionId: "s1", turnId: "t1", providerCallId: "c1", toolName: "tool1", input: {}, reason: "needs", timeoutMs: 1000 });
  const req2 = registry.request({ sessionId: "s1", turnId: "t1", providerCallId: "c2", toolName: "tool2", input: {}, reason: "needs", timeoutMs: 1000 });
  const req3 = registry.request({ sessionId: "s1", turnId: "t2", providerCallId: "c3", toolName: "tool1", input: {}, reason: "needs", timeoutMs: 1000 });

  assert.equal(registry.snapshot("t1").length, 2);
  assert.equal(registry.snapshot("t2").length, 1);
  assert.equal((registry as any).entries.size, 3);
  assert.equal((registry as any).byTurn.size, 2);

  // Approve one, deny one, cancel other turn
  registry.approve(req1.requestId);
  registry.deny(req2.requestId);
  registry.cancelTurn("t2");

  assert.equal((registry as any).entries.size, 0);
  assert.equal((registry as any).byTurn.size, 0);
  assert.equal(registry.snapshot("t1").length, 0);
  assert.equal(registry.snapshot("t2").length, 0);
});
```

**Unrelated turns untouched:** `cancelTurn("t1")` must not affect `t2` — verified via byTurn index.

---

## 5. Reconnect behavior — replay according to afterSeq without duplicating live events

### 5.1 Scenario

- Turn starts, emits `turn_waiting_for_approval` seq 2
- Client disconnects after seq 1
- Server emits `approval_resolved` seq 3 while client disconnected
- Client reconnects with `Last-Event-ID: 1` → should replay seq 2 and 3 (request and resolution) in order, no duplicate live events

```ts
test("reconnect replays approval request and resolution according to afterSeq", () => {
  const store = new InMemoryTurnLogStore();
  const manager = new TurnManager({ store });
  const s1 = "s1", t1 = "t1";

  manager.append(s1, t1, { type: "turn_started", limits: DEFAULT_LIMITS, message: "hi" }); // seq1
  const req = { requestId: "apr_1", providerCallId: "c1", sessionId: s1, turnId: t1, toolName: "run_terminal", input: {}, reason: "needs", expiresAt: 10000, createdAt: 1 };
  manager.append(s1, t1, { type: "turn_waiting_for_approval", request: req as any }); // seq2
  // Client disconnects after seq1
  const afterSeq = 1;

  // Server resolves while disconnected
  manager.append(s1, t1, { type: "approval_resolved", requestId: "apr_1", decision: "approve", resolvedAt: 3, resolution: { kind: "approved" } }); // seq3
  manager.append(s1, t1, { type: "tool_completed", callId: "c1", toolName: "run_terminal", result: { ok: true, output: "ok" } }); // seq4

  // Reconnect
  const { replay } = manager.subscribe(s1, t1, afterSeq, () => {});
  assert.deepEqual(replay.map(e => e.seq), [2, 3, 4]);
  assert.equal(replay[0].type, "turn_waiting_for_approval");
  assert.equal(replay[1].type, "approval_resolved");
});
```

**No duplicating live events:** Listener added in subscribe only gets events with seq > current seqCounter after subscribe, not replay. So replay is exactly `seq > afterSeq`, live is future.

---

## 6. Failure-path testing

### 6.1 Timer cleanup

- Every `settle()` clears timer via `clearTimeout` — even for expiry path where timer already fired, clear is safe no-op
- Test: after approve, check that timeoutId is cleared and no timer leak (by checking that no extra expiry event after approve)

```ts
test("timer cleanup — approve clears timer, no expiry after", async () => {
  const registry = new ApprovalRegistry();
  const req = registry.request({ sessionId: "s1", turnId: "t1", providerCallId: "c1", toolName: "run_terminal", input: {}, reason: "needs", timeoutMs: 20 });

  registry.approve(req.requestId);

  // Wait past expiry time
  await new Promise(r => setTimeout(r, 30));

  // Should still be cleaned up, no second settlement, no leak
  assert.equal((registry as any).entries.size, 0);
});
```

### 6.2 Route errors — 404 vs 409

- 404: request does not belong to URL session — `entry.request.sessionId !== urlSessionId` → 404, registry not settled, approval remains pending
- 409: request belongs to session but already settled — `entries.has(requestId)` false → 409, no duplicate event

```ts
test("route errors — 404 vs 409", () => {
  const registry = new ApprovalRegistry();
  const req = registry.request({ sessionId: "s1", turnId: "t1", providerCallId: "c1", toolName: "run_terminal", input: {}, reason: "needs", timeoutMs: 1000 });

  // 404: wrong session
  const urlSessionId = "s2";
  const entry = (registry as any).entries.get(req.requestId);
  assert.equal(entry.request.sessionId, "s1");
  assert.notEqual(entry.request.sessionId, urlSessionId);
  // Route should return 404, not settle
  assert.equal(registry.has(req.requestId), true);

  // 409: already settled
  registry.approve(req.requestId);
  assert.equal(registry.has(req.requestId), false);
  // Second approve should be 409
  const second = registry.approve(req.requestId);
  assert.equal(second.settled, false);
});
```

### 6.3 Client disconnects during approval wait

- Already covered in 1.1 — unsubscribe only, no settlement

### 6.4 Duplicate requests — same providerCallId, different minted ids

- Two tool calls with same providerCallId `c1` in different turns → two different minted requestIds, both pending, no collision

```ts
test("duplicate providerCallId across turns — no collision", () => {
  const registry = new ApprovalRegistry();
  const req1 = registry.request({ sessionId: "s1", turnId: "t1", providerCallId: "c1", toolName: "run_terminal", input: {}, reason: "needs", timeoutMs: 1000 });
  const req2 = registry.request({ sessionId: "s1", turnId: "t2", providerCallId: "c1", toolName: "run_terminal", input: {}, reason: "needs", timeoutMs: 1000 });

  assert.notEqual(req1.requestId, req2.requestId);
  assert.equal(req1.providerCallId, req2.providerCallId);
  assert.equal((registry as any).entries.size, 2);
});
```

### 6.5 Terminal cleanup during active approval wait

- Turn fails with MODEL_FAILED while waiting for approval — loop finally calls cancelTurn, which settles pending with cancelled, cleans up

```ts
test("terminal cleanup during active approval wait", async () => {
  const registry = new ApprovalRegistry();
  const req = registry.request({ sessionId: "s1", turnId: "t1", providerCallId: "c1", toolName: "run_terminal", input: {}, reason: "needs", timeoutMs: 10000 });

  const waitPromise = registry.wait(req.requestId);

  // Simulate terminal failure: cancelTurn
  registry.cancelTurn("t1");

  const resolution = await waitPromise;
  assert.equal(resolution.kind, "cancelled");
  assert.equal((registry as any).entries.size, 0);
});
```

---

## 7. Additional assertion — inspect both maps after every scenario

After every test scenario, assert:

```ts
assert.equal((registry as any).entries.size, expectedGlobalSize);
assert.equal((registry as any).byTurn.size, expectedTurnIndexSize);
assert.equal(registry.snapshot(turnId).length, expectedPendingForTurn);
```

This catches leaked registry entries that reducer cannot reveal — reducer's pendingApprovals Map is derived from events, but registry's maps are live promise state. If they diverge, we have a leak.

**Example final assertions for all tests:**

```ts
// After approved
assert.equal((registry as any).entries.size, 0);
assert.equal((registry as any).byTurn.size, 0);

// After one turn cancelled, other intact
assert.equal((registry as any).entries.size, 1); // other turn's approval still pending
assert.equal((registry as any).byTurn.size, 1);
assert.equal((registry as any).byTurn.has("t1"), false);
assert.equal((registry as any).byTurn.has("t2"), true);
```

---

## 8. What Phase 3 does NOT cover (deferred to Phase 4)

- Integration with TurnManager and reducer — how approval_requested and approval_resolved events are appended via manager.append and folded via reducer, while registry owns promises
- Migration plan from current registry (global Map keyed by provider id, two expiry sources) to new registry (minted id, single expiry, byTurn index, ApprovalResolution union)
- How approval becomes consumer of unified deadline module (#1) rather than embedding timeout logic — use FakeClock and deadline contract, keep approval cancellation semantics as consumer

---

## 9. Next steps

**Phase 4:** Integration sketch, CONTEXT.md update, ADR for approval invariants, migration plan, how approval consumes deadline module.

Please confirm go for Phase 4, or request changes to Phase 3.

