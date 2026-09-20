# Phase 4 — Integration, documentation, migration plan, deadline boundary, final verification

**Focus:** Your Phase 4 deliverables:
- Integration: wire minted requestId through loop, routes, events, reducer, UI; approval_resolved emitted exactly once with enough data for replay; reconnects with Last-Event-ID while approval pending
- Documentation: update CONTEXT.md with registry ownership, settlement union, settle() sole mutator, live vs replay state, disconnect and cleanup guarantees; ADR why providerCallId is correlation field
- Migration plan: callers still treating providerCallId as requestId, remove loop-owned expiresAt, update UI and fixtures to minted ids, compatibility for in-flight approvals
- Deadline boundary: define future Deadline interface, have ApprovalRegistry consume it later, do not duplicate timers now
- Final verification: run full test suite and TS checks, leak assertions, terminal cleanup no duplicate events, duplicate providerCallId across concurrent turns and reconnect replay

**Status:** Final exploration for #2 — ready for implementation after your go.

---

## 1. Integration — wiring minted requestId through all layers

### 1.1 Current wiring after #3+#6 (before #2 implementation)

```
Provider (toolCall.id = "c1") 
  → Loop: approvalRequest { requestId: "c1", turnId, sessionId, ... expiresAt: now+timeout }
  → Registry: register(request, timeoutMs) — key = "c1" (provider id)
  → Manager: append(turn_waiting_for_approval, request)
  → Reducer: pendingApprovals.set("c1", request) → status waiting_for_approval
  → SSE: id: seq, data: { type: "turn_waiting_for_approval", request: { requestId: "c1" } }
  → UI: ApprovalCard shows requestId "c1", calls POST /approve { requestId: "c1", decision }
  → Routes: approvals.resolve("c1", decision) → returns true/false
  → Registry: wait("c1") resolves → Loop emits approval_resolved { requestId: "c1", decision }
  → Manager: append(approval_resolved)
  → Reducer: pendingApprovals.delete("c1") → status running
```

**Problems:** requestId = providerCallId, collision across concurrent turns, two expiry sources.

### 1.2 Proposed wiring after #2 (minted id, single expiry, ApprovalResolution)

```
Provider (toolCall.id = "c1", providerCallId)
  → Loop: const req = approvals.request({ sessionId, turnId, providerCallId: "c1", toolName, input, reason, timeoutMs })
          // Registry mints requestId = "apr_...", computes expiresAt = now+timeoutMs, createdAt = now
          // Registry creates entry with promise, timer, byTurn index
  → Manager: append(turn_waiting_for_approval, request: req) // req has minted id + providerCallId + expiresAt
  → Reducer: pendingApprovals.set("apr_...", req) → status waiting_for_approval
  → SSE: id: seq, data: { type: "turn_waiting_for_approval", request: { requestId: "apr_...", providerCallId: "c1", expiresAt } }
  → UI: ApprovalCard shows toolName, reason, input preview, expiresAt countdown, uses requestId "apr_..." for approve call
  → Routes: POST /sessions/:sessionId/approve { requestId: "apr_...", decision }
          → peek(requestId) to get request, validate request.sessionId === URL sessionId → 404 if mismatch
          → if !has(requestId) → 409 already settled
          → approve/deny calls settle() → returns { settled: true/false, request }
          → if settled: true, loop's wait() will resolve and loop will emit approval_resolved (route does NOT emit)
          → if settled: false, return 409
  → Registry: wait("apr_...") resolves with ApprovalResolution { kind: "approved"|"denied"|"expired"|"cancelled" }
  → Loop: append(approval_resolved { requestId: "apr_...", decision, resolvedAt, resolution: { kind } })
          // Only emitted if settle() returned settled:true, so exactly once
  → Manager: append(approval_resolved)
  → Reducer: pendingApprovals.delete("apr_...") → status running (or terminal if expired/cancelled)
```

**Key changes:**

- Loop no longer creates ApprovalRequest object — it calls `approvals.request()` which mints id and computes expiry
- `providerCallId` preserved as correlation field in request, never used as registry key
- `approval_resolved` event carries `requestId` (minted), `decision` (approve/deny string for backward compat), `resolvedAt`, and full `resolution` union for replay — enough data for replay without registry
- Event emitted exactly once: only when `settle()` returns `settled:true`, loop emits; later duplicate approve returns `settled:false` and emits nothing

### 1.3 Reconnects with Last-Event-ID while approval pending

**Scenario:**

1. Turn starts seq1
2. `turn_waiting_for_approval` seq2 with `requestId: apr_1, providerCallId: c1, expiresAt`
3. Client disconnects after seq1 (network blip)
4. Server still has approval pending in registry and in TurnState
5. Client reconnects with `Last-Event-ID:1` → `subscribe(afterSeq=1)` → replay `[2]` (approval request) — no duplicate live events, no settlement
6. User approves → `approve(apr_1)` → `settle(approved)` → `wait()` resolves → loop emits `approval_resolved` seq3
7. Live listener (reconnected client) receives seq3 via manager notification, reducer clears pending

**Implementation:** Already works after #3+#6 atomic subscribe — replay is `events.filter(seq > afterSeq)`, live is future notifications. No extra code needed, just ensure approval events are part of log (they are, via manager.append).

**Test:**

```ts
test("reconnect with Last-Event-ID while approval pending replays request and then resolution", async () => {
  const manager = new TurnManager({ store: new InMemoryTurnLogStore() });
  const approvals = new ApprovalRegistry();
  const s1 = "s1", t1 = "t1";

  // Simulate loop: request approval
  const req = approvals.request({ sessionId: s1, turnId: t1, providerCallId: "c1", toolName: "run_terminal", input: {}, reason: "needs", timeoutMs: 1000 });
  manager.append(s1, t1, { type: "turn_started", limits: DEFAULT_LIMITS, message: "hi" }); // seq1
  manager.append(s1, t1, { type: "turn_waiting_for_approval", request: req }); // seq2

  // Client disconnects after seq1
  const afterSeq = 1;

  // Reconnect
  const { replay } = manager.subscribe(s1, t1, afterSeq, () => {});
  assert.deepEqual(replay.map(e => e.seq), [2]);
  assert.equal(replay[0].type, "turn_waiting_for_approval");
  assert.equal((replay[0] as any).request.requestId, req.requestId);

  // Approve while reconnected client listening
  const received: StreamEvent[] = [];
  const { unsubscribe } = manager.subscribe(s1, t1, afterSeq, (e) => received.push(e));

  const waitPromise = approvals.wait(req.requestId);
  approvals.approve(req.requestId);
  const resolution = await waitPromise;
  assert.equal(resolution.kind, "approved");

  // Loop would emit approval_resolved
  manager.append(s1, t1, { type: "approval_resolved", requestId: req.requestId, decision: "approve", resolvedAt: Date.now(), resolution });

  // Reconnected client should have received resolution live (not via replay)
  assert.ok(received.some(e => e.type === "approval_resolved"));

  unsubscribe();
});
```

---

## 2. Documentation

### 2.1 CONTEXT.md update (to be applied)

Add to CONTEXT.md under "Tools and approvals":

```md
- **ApprovalRegistry**: Owns ID minting, createdAt, expiresAt, timers, byTurn index, and promise settlement. Only `settle()` mutates settlement state. providerCallId is correlation metadata only, never a registry key. Methods: `request(input) => ApprovalRequest` mints id and computes expiry (single source), `wait(requestId) => Promise<ApprovalResolution>`, `approve(requestId)`, `deny(requestId)`, `cancelTurn(turnId)`, `snapshot(turnId)`, `peek(requestId)` for auth. Internal: `Map<requestId, Entry>` global unique + `Map<turnId, Set<requestId>>` index.

- **ApprovalResolution**: Union `approved | denied | expired | cancelled` — single settlement type. `wait()` always resolves with this union for expected outcomes, never rejects; rejection reserved for unexpected internal failures.

- **settle() sole mutator**: Only function that removes from global map and turn index, clears timer, resolves promise exactly once, returns `{ settled: boolean, request }`. First caller wins, later callers get `settled:false` no-op, no duplicate `approval_resolved` events, no recreation.

- **Live promise state vs replay reducer state**: Registry owns live `Map<requestId, { promise, resolve, timeoutId }>` — `wait()` returns promise. Reducer owns `TurnState.pendingApprovals Map` — folds `turn_waiting_for_approval` (add) and `approval_resolved` (remove), no promise, no side effects. Replay reconstructs state without settling live promises.

- **Disconnect and cleanup guarantees**: SSE `unsubscribe` only removes listener from Set, never calls `cancelTurn`, `settle`, or clears registry. Approval remains pending after disconnect and is replayed on reconnect via `afterSeq`. Cleanup guaranteed after decision, expiry, cancellation, terminal failure, turn completion — registry `entries.size` and `byTurn.size` both 0, no leaked timers. Inspect both maps after every scenario, not just observable turn state.

- **Route errors**: 404 request does not belong to URL session (`request.sessionId !== urlSessionId`), 409 request belongs to session but already settled (`!has(requestId)`).
```

### 2.2 ADR — Why provider call IDs are correlation fields, not approval identity

Create `docs/adr/002-approval-identity-minted-not-provider-call.md`:

```md
# ADR 002 — Approval identity minted by registry, provider call ID is correlation metadata

Date: 2026-09-19
Status: Accepted (from exploration #2)
Context: Robust Turn Execution plan used provider's toolCall.id as approval requestId in global Map. OpenAI-compatible servers emit call_0, call_1 per turn, FakeProvider always c1 — concurrent turns collide, register throws "already exists", turn fails.

Decision:
- ApprovalRegistry mints requestId as apr_<now>_<counter>_<rand>, globally unique, per session/turn/provider call.
- Provider's call id stored as providerCallId field for correlation and debugging, never used as registry key.
- Registry computes expiresAt = now + timeoutMs once, single source, returns request with createdAt and expiresAt.
- Internal: Map<requestId, Entry> global unique + Map<turnId, Set<requestId>> index for cancelTurn and snapshot.

Alternatives:
- Option A (rejected): Loop mints turnId:callId namespaced — still two expiry sources, easy to forget namespacing, identity not owned by registry.
- Option B (rejected): Keep provider id as key but namespace by turnId in Map key — still provider-controlled, not globally unique, still collision if provider reuses id within same turn? Actually provider reuses per turn, so namespacing fixes collision but still not owned.

Consequences:
- Positive: No collision across concurrent turns, single expiry source, testable, clear ownership.
- Negative: ApprovalRequest shape adds providerCallId and createdAt — need to update shared type and all consumers, but cheap now.
- Follow-up: Update UI and test fixtures to use minted ids, keep providerCallId for display.

References: Phase 1 identity doc, Phase 2 settlement doc.
```

---

## 3. Migration plan

### 3.1 Callers still treating providerCallId as requestId

| File | Current | After #2 | Action |
|------|---------|----------|--------|
| `loop.ts` | `requestId: toolCall.id` | `providerCallId: toolCall.id`, `requestId` minted by registry | Change `approvals.request({ providerCallId: toolCall.id, ... })` instead of constructing request object |
| `approval-registry.ts` | `register(request, timeoutMs)` where request.requestId = provider id | `request(input) => ApprovalRequest` mints id, computes expiry | Replace `register` with `request` + internal `registerInternal`, keep `register` for backward compat but deprecate |
| `routes.ts` / `app.ts` | `POST /approve { requestId, decision }` where requestId is provider id, no session validation | `requestId` is minted, validate `request.sessionId === URL sessionId`, 404 vs 409 | Add `peek(requestId)` method for auth, check sessionId, return 404 if mismatch, 409 if already settled |
| `shared/src/index.ts` | `ApprovalRequest { requestId, turnId, toolName, input, reason, expiresAt }` | Add `providerCallId`, `sessionId`, `createdAt` | Update type, update tests |
| `web/src/components/ApprovalCard.tsx` | Uses `request.requestId` which is provider id | Uses minted `requestId` for approve call, shows `providerCallId` for debugging | Update UI to use minted id |
| `test/fakes/fake-provider.ts` | Emits `tool_call` with id `c1` | Same, but registry will mint different id, so test must not assert `requestId === "c1"` but `providerCallId === "c1"` | Update tests |
| `test/agent/loop.test.ts` | Asserts `requestId === "c1"` | Assert `providerCallId === "c1"` and `requestId` starts with `apr_` | Update |
| `test/routes-turns.test.ts` | `POST /approve { requestId: "c1" }` | `requestId` is minted, need to get it from snapshot or events | Update to fetch pending approvals from manager snapshot or events, then approve with minted id |

### 3.2 Remove loop-owned expiresAt calculation

- Currently loop does `expiresAt: now + limits.approvalTimeoutMs`
- After #2, loop calls `approvals.request({ timeoutMs })` and registry computes expiresAt
- Remove expiresAt from loop, use returned request's expiresAt

### 3.3 Update UI and test fixtures to use minted approval IDs

- UI: ApprovalCard currently shows `requestId` which is provider id — change to show `toolName`, `reason`, `providerCallId` for debugging, but use `requestId` (minted) for approve call
- Tests: Update all fixtures that hardcode `requestId: "c1"` to use minted id or assert on `providerCallId`

### 3.4 Compatibility handling for in-flight approvals during deployment

- During deployment, there may be pending approvals with old requestId = provider id (e.g., "c1") in registry (in-memory, so only if deployment is rolling and old server still has pending)
- Since registry is in-memory, restart loses all pending approvals — in-flight approvals will be lost anyway, and turns will be failed with RESTART (future file store) or 404 (now)
- For file store future, need migration: old events have `requestId: "c1"` without `providerCallId`, new events have minted id + providerCallId — reducer should handle both: if `providerCallId` missing, treat `requestId` as providerCallId for backward compat
- For this slice (in-memory), no compatibility needed — just document that restart loses pending approvals

---

## 4. Deadline boundary — future Deadline interface

### 4.1 Define interface before implementing #1

```ts
// Proposed in Phase 4 doc, to be implemented in #1
interface Deadline {
  readonly signal: AbortSignal; // child signal that aborts on deadline or parent abort
  readonly expiresAt: number;   // absolute timestamp ms
  cancel(reason?: unknown): void; // explicit cancel (e.g., Stop pressed)
  dispose(): void; // cleanup timer, remove listeners
}

// Factory
function createDeadline(parentSignal: AbortSignal, timeoutMs: number, now?: () => number): Deadline;

// Usage
const deadline = createDeadline(signal, limits.approvalTimeoutMs);
try {
  const result = await operation(deadline.signal);
} finally {
  deadline.dispose();
}
```

### 4.2 ApprovalRegistry consumes Deadline later, not duplicates timers now

- Currently registry uses `setTimeout` for expiry — this is deadline logic embedded in registry
- For #1 unified deadline, we want one Deadline module that owns abort-and-await, not race, with FakeClock support
- For #2, keep `setTimeout` for now, but design so it can be replaced by Deadline later without changing registry API
- How: Registry's `request()` takes `timeoutMs`, creates timer internally — later, it will create `Deadline` instead of `setTimeout`, and `settle(expired)` will be called when deadline's signal aborts with timeout reason

**Do NOT duplicate deadline timers in registry during this phase** — keep current `setTimeout` but make it replaceable:

```ts
// Current
entry.timeoutId = setTimeout(() => this.settle(requestId, { kind: "expired" }), timeoutMs);

// Future with Deadline
const deadline = createDeadline(AbortSignal.timeout(timeoutMs), timeoutMs); // or parent signal?
deadline.signal.addEventListener("abort", () => {
  if (deadline.signal.reason?.code === "TIMEOUT") {
    this.settle(requestId, { kind: "expired" });
  }
});
entry.deadline = deadline; // instead of timeoutId
```

For now, keep timeoutId, but add comment that it will be replaced by Deadline.

---

## 5. Final verification

### 5.1 Run full test suite and both TypeScript checks

After implementing #2 (future PR), run:

```bash
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/server/tsconfig.json --noEmit
npx tsc -p packages/web/tsconfig.json --noEmit
npx tsx --test packages/shared/test/*.test.ts packages/server/test/agent/*.test.ts packages/server/test/routes-turns.test.ts packages/web/test/*.test.ts
```

Currently after #3+#6, we have 28 passing. After #2, we should still have 28 passing plus new approval tests (7 from Phase 2 + 6 from Phase 3).

### 5.2 Re-run leak assertions for every settlement path

After every test scenario, inspect:

```ts
assert.equal((registry as any).entries.size, expectedGlobal);
assert.equal((registry as any).byTurn.size, expectedTurnIndex);
```

This catches leaked registry entries that reducer cannot reveal.

**Scenarios to check:**

- After approved: both 0
- After denied: both 0
- After expired: both 0
- After cancelled (cancelTurn): both 0 for that turn, other turns intact
- After terminal failure during approval wait: both 0 for that turn
- After turn completion: both 0

### 5.3 Confirm terminal cleanup does not generate duplicate approval_resolved events

- Start turn, request approval, then fail turn with MODEL_FAILED while waiting — loop finally calls cancelTurn which settles with cancelled, but should NOT emit approval_resolved event? Actually should emit? For cancelled, we emit turn_cancelled, not approval_resolved? Need to decide: on cancelTurn, should we emit approval_resolved with cancelled or just turn_cancelled? Current loop emits turn_cancelled after cancelTurn, not approval_resolved. For expired, we emit turn_failed APPROVAL_TIMEOUT, not approval_resolved. So approval_resolved only emitted for approved/denied, not for expired/cancelled? But Phase 2 says approval_resolved should carry resolution with kind expired/cancelled for replay. So we should emit approval_resolved for all settlement kinds? Or only for approved/denied? Let's decide: emit approval_resolved for all kinds, with resolution field, so replay reconstructs correctly. Then terminal cleanup should not emit duplicate.

**Test:**

```ts
test("terminal cleanup does not generate duplicate approval_resolved", async () => {
  const manager = new TurnManager({ store: new InMemoryTurnLogStore() });
  const approvals = new ApprovalRegistry();
  const s1 = "s1", t1 = "t1";

  const req = approvals.request({ sessionId: s1, turnId: t1, providerCallId: "c1", toolName: "run_terminal", input: {}, reason: "needs", timeoutMs: 10000 });
  manager.append(s1, t1, { type: "turn_started", limits: DEFAULT_LIMITS, message: "hi" });
  manager.append(s1, t1, { type: "turn_waiting_for_approval", request: req });

  // Simulate terminal failure: cancelTurn
  approvals.cancelTurn(t1);
  // Loop would emit turn_cancelled, not approval_resolved? Or both?
  // For this test, ensure only one approval_resolved emitted, not duplicate
  const eventsBefore = manager.snapshot(s1, t1).events.length;

  // Second cancelTurn should be no-op, no duplicate event
  approvals.cancelTurn(t1);
  const eventsAfter = manager.snapshot(s1, t1).events.length;

  assert.equal(eventsBefore, eventsAfter); // no duplicate
  assert.equal((approvals as any).entries.size, 0);
});
```

### 5.4 Test duplicate provider call IDs across concurrent turns and reconnect replay

- Already covered in Phase 3: duplicate providerCallId across turns no collision, reconnect replay with afterSeq

**Final verification checklist:**

- [ ] `npx tsc -p packages/shared/tsconfig.json --noEmit` passes
- [ ] `npx tsc -p packages/server/tsconfig.json --noEmit` passes
- [ ] `npx tsc -p packages/web/tsconfig.json --noEmit` passes
- [ ] `npx tsx --test` all 28 + new approval tests pass
- [ ] Leak assertions: entries.size and byTurn.size checked after every settlement path
- [ ] No duplicate approval_resolved events on terminal cleanup
- [ ] Duplicate providerCallId across concurrent turns no collision
- [ ] Reconnect replay with Last-Event-ID while approval pending works

---

## 6. Next steps — after Phase 4, proceed to #1 unified deadline

- Approval expiry becomes first consumer of Deadline module, preserving settle()/reducer separation
- Deadline module: `createDeadline(parentSignal, timeoutMs, clock?) => Deadline` with `signal`, `expiresAt`, `cancel()`, `dispose()`, abort-and-await not race, FakeClock support
- ApprovalRegistry will consume Deadline for expiry instead of setTimeout, but keep settle() as sole mutator
- Loop's model-call and tool timeouts will also consume Deadline, replacing withTimeout race

Please confirm go for implementation of #2, or request changes to Phase 4.

