# Phase 2 — Settlement paths, single expiry source, idempotent settlement

**Focus:** Contracts 3, 4, 7, 8 from your list, plus your Phase 2 requirements:
3. Exactly one settlement path wins: decision, expiry, or cancelTurn.
4. Expiry has one authoritative source.
7. Repeated decisions, stale decisions, cancellation races are idempotent.
8. Approval cleanup guaranteed after resolution, expiry, cancellation, terminal failure.

**Boundaries preserved (from your go):**
- ApprovalRegistry owns ID minting, createdAt, expiresAt, timers, indexes, promise settlement.
- providerCallId is correlation metadata only, never a registry key.
- Reducer consumes `turn_waiting_for_approval` and `approval_resolved` events but does NOT resolve live promises.
- Route authorization validates both URL sessionId and request's stored sessionId.

**Status:** Draft for review — stops and waits for your go before Phase 3 (disconnect vs settlement, replay state vs live promise).

---

## 1. Current settlement (after Phase 1 proposal, before Phase 2)

```ts
class ApprovalRegistry {
  entries = Map<requestId, { request, resolve, reject, promise, timeoutId }>
  byTurn = Map<turnId, Set<requestId>>

  request(input): ApprovalRequest // mints id, computes expiresAt
  wait(requestId): Promise<ApprovalDecision>
  resolve(requestId, decision): boolean // returns false if stale
  cancelTurn(turnId): void // deletes and rejects with "turn cancelled"
  snapshot(turnId): ApprovalRequest[]
}
```

**Settlement paths today:**
- `resolve()` — user approve/deny: clears timer, deletes entry, resolves promise, returns true; second call returns false (stale)
- expiry timer — `setTimeout` callback: deletes entry, rejects promise with ApprovalTimeoutError
- `cancelTurn()` — deletes all entries for turnId, rejects each with "turn cancelled"

**Problems:**
- Three separate code paths delete entry, clear timer, settle promise — easy to drift, not one internal `settle()` path
- Expiry rejects with error, while resolve resolves with decision — two different promise settlement modes (resolve vs reject) for what should be one `ApprovalResolution` union
- No `approval_resolved` event emitted by registry — loop emits it after `wait` resolves. So registry and loop both participate in settlement: registry settles promise, loop emits event. Two modules for one fact.
- Idempotency: second `resolve` returns false, but does it emit duplicate `approval_resolved`? No, because loop only emits after first `wait` resolves, and second `resolve` doesn't trigger second event (since promise already settled). But expiry vs approve race: if timer fires at same time as approve, which wins? Currently whichever deletes entry first wins, second returns false or does nothing — but timer callback rejects, approve resolves — race could cause both to try to settle same promise? We delete entry before settling, so second path finds no entry and does nothing. That's correct but implicit.
- Cleanup: `cancelTurn` in finally of loop cleans up, but what about terminal turn failure that is not cancellation? Loop finally also calls cancelTurn, so cleanup guaranteed. Good.

---

## 2. Proposed settlement model

### 2.1 ApprovalResolution — single union for all settlement reasons

```ts
type ApprovalResolution =
  | { kind: "approved"; input?: unknown } // user approved, optional modified input
  | { kind: "denied"; reason?: string }   // user denied
  | { kind: "expired" }                   // timeout
  | { kind: "cancelled" };                // turn cancelled or terminal failure
```

**Why union, not separate resolve/reject?**
- Today: `resolve(decision)` resolves, `timeout` rejects with error, `cancelTurn` rejects with error — two modes (resolve vs reject) for same concept
- Proposed: all settlements resolve with `ApprovalResolution`, never reject (except for programming error like not found). Loop then maps resolution to ToolResult or terminal failure.
- Benefits: `wait()` always resolves, never rejects (except for unexpected), easier to handle, no try/catch for timeout vs cancel vs decision — just switch on kind

**Mapping to existing:**

| Current | Proposed |
|---------|----------|
| `resolve(requestId, "approve")` | `settle(requestId, { kind: "approved" })` → wait resolves with approved |
| `resolve(requestId, "deny")` | `settle(requestId, { kind: "denied" })` → wait resolves with denied |
| expiry timer | `settle(requestId, { kind: "expired" })` |
| cancelTurn | `settle(requestId, { kind: "cancelled" })` for each pending in turn |

### 2.2 One internal settle path

```ts
class ApprovalRegistry {
  private entries = new Map<ApprovalId, Entry>;
  private byTurn = new Map<TurnId, Set<ApprovalId>>;
  private now: () => number;

  // Entry holds resolve, not reject — all settlements resolve with ApprovalResolution
  private settle(requestId: ApprovalId, resolution: ApprovalResolution): { settled: boolean; request?: ApprovalRequest } {
    const entry = this.entries.get(requestId);
    if (!entry) {
      return { settled: false }; // already settled, idempotent no-op
    }

    // First caller wins: remove from global map and turn index, clear timer
    this.entries.delete(requestId);
    const turnSet = this.byTurn.get(entry.request.turnId);
    if (turnSet) {
      turnSet.delete(requestId);
      if (turnSet.size === 0) this.byTurn.delete(entry.request.turnId);
    }
    if (entry.timeoutId) clearTimeout(entry.timeoutId);

    // Resolve promise exactly once
    entry.resolve(resolution);

    // Do NOT emit event here — registry owns promise settlement, loop/manager owns event emission
    // But we return request so caller can emit approval_resolved event with session, turn, requestId, resolution
    return { settled: true, request: entry.request };
  }

  // Public APIs all go through settle()

  request(input: { sessionId, turnId, providerCallId, toolName, input, reason, timeoutMs }): ApprovalRequest {
    const now = this.now();
    const requestId = this.newId();
    const request: ApprovalRequest = {
      requestId,
      providerCallId: input.providerCallId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      toolName: input.toolName,
      input: input.input,
      reason: input.reason,
      expiresAt: now + input.timeoutMs,
      createdAt: now,
    };
    const entry = this.createEntry(request, input.timeoutMs);
    this.entries.set(requestId, entry);
    let set = this.byTurn.get(input.turnId);
    if (!set) { set = new Set(); this.byTurn.set(input.turnId, set); }
    set.add(requestId);
    return request;
  }

  private createEntry(request: ApprovalRequest, timeoutMs: number): Entry {
    let resolve!: (res: ApprovalResolution) => void;
    const promise = new Promise<ApprovalResolution>((res) => { resolve = res; });

    const entry: Entry = { request, resolve, promise };

    if (timeoutMs > 0) {
      entry.timeoutId = setTimeout(() => {
        this.settle(request.requestId, { kind: "expired" });
      }, timeoutMs);
    }

    return entry;
  }

  wait(requestId: ApprovalId): Promise<ApprovalResolution> {
    const entry = this.entries.get(requestId);
    if (!entry) {
      // Already settled — for replay, we should not wait, but return already settled? 
      // For live wait, if not found, it's stale — return cancelled? Or throw?
      // For idempotency, if already settled, we should return the resolution that won, but we deleted entry.
      // So we need to keep a short-lived tombstone? Or loop should not call wait if already settled.
      // For now, throw "not found" for programming error, but for replay we don't call wait.
      throw new Error(`Approval not found: ${requestId}`);
    }
    return entry.promise;
  }

  // approve / deny — public, go through settle
  approve(requestId: ApprovalId, input?: unknown): { settled: boolean; request?: ApprovalRequest } {
    return this.settle(requestId, { kind: "approved", input });
  }

  deny(requestId: ApprovalId, reason?: string): { settled: boolean; request?: ApprovalRequest } {
    return this.settle(requestId, { kind: "denied", reason });
  }

  // For compatibility with old API that takes decision string
  resolve(requestId: ApprovalId, decision: ApprovalDecision): boolean {
    const res = decision === "approve" ? this.approve(requestId) : this.deny(requestId);
    return res.settled;
  }

  cancelTurn(turnId: TurnId): void {
    const set = this.byTurn.get(turnId);
    if (!set) return;
    // Copy to avoid mutation during iteration
    const ids = [...set];
    for (const id of ids) {
      this.settle(id, { kind: "cancelled" });
    }
  }

  // For terminal cleanup (e.g., turn_failed) — same as cancelTurn but could be separate for clarity
  cleanupTurn(turnId: TurnId): void {
    this.cancelTurn(turnId);
  }

  snapshot(turnId: TurnId): ApprovalRequest[] {
    const set = this.byTurn.get(turnId);
    if (!set) return [];
    const result: ApprovalRequest[] = [];
    for (const id of set) {
      const entry = this.entries.get(id);
      if (entry) result.push(entry.request);
    }
    return result;
  }

  has(requestId: ApprovalId): boolean {
    return this.entries.has(requestId);
  }
}
```

**Key properties:**

- **One path:** `settle()` is the only place that deletes from global map, removes from turn index, clears timer, resolves promise
- **First wins:** `settle()` checks `entries.has(requestId)` — if not found, returns `{ settled: false }` — no-op, no duplicate event, no recreation
- **No duplicate events:** Registry does NOT emit `approval_resolved` event — it returns request so caller (loop or manager) can emit exactly one event if `settled` is true. Later decisions get `settled: false` and emit nothing.
- **Single expiry source:** `request()` computes `expiresAt = now + timeoutMs` once, uses same `timeoutMs` for timer — no second source
- **Promise never rejects for expected settlements:** `wait()` always resolves with `ApprovalResolution`, never rejects (except programming error). Loop switches on kind.

### 2.3 Event emission — who emits approval_resolved?

**Current:** Loop emits after `wait` resolves.

**Proposed (preserve boundary):** Loop still emits, but now based on `ApprovalResolution`, not just decision string. Registry returns request and settled flag, loop emits if settled.

```ts
// In loop.ts
const approvalRequest = approvals.request({ sessionId, turnId, providerCallId: toolCall.id, toolName, input, reason, timeoutMs: limits.approvalTimeoutMs });
append({ type: "turn_waiting_for_approval", request: approvalRequest });

const resolution = await approvals.wait(approvalRequest.requestId);

append({
  type: "approval_resolved",
  requestId: approvalRequest.requestId,
  decision: resolution.kind === "approved" ? "approve" : resolution.kind === "denied" ? "deny" : resolution.kind,
  resolvedAt: now(),
  resolution, // new field with full union
});

switch (resolution.kind) {
  case "approved": // execute tool
  case "denied": // tool_completed APPROVAL_DENIED
  case "expired": // turn_failed APPROVAL_TIMEOUT
  case "cancelled": // turn_cancelled
}
```

**Why not registry emits?** Your boundary: "reducer consumes events but does not resolve live promises" — registry owns promises, manager/loop owns events. So loop should emit, not registry. Registry just settles promise and returns.

### 2.4 Route authorization — validate sessionId

```ts
// POST /api/sessions/:sessionId/approve
app.post("/api/sessions/:sessionId/approve", (req, res) => {
  const urlSessionId = req.params.sessionId;
  const { requestId, decision } = req.body;

  // Check registry has request and its sessionId matches URL sessionId
  const entry = approvals.getEntry(requestId); // need method to get request without settling
  if (!entry) return res.status(409).json({ error: "stale or already settled" });
  if (entry.request.sessionId !== urlSessionId) return res.status(404).json({ error: "session mismatch" });

  const result = decision === "approve" ? approvals.approve(requestId) : approvals.deny(requestId);
  if (!result.settled) return res.status(409).json({ error: "already settled" });

  // Emit approval_resolved via manager? Actually loop will emit when its wait resolves, but for HTTP API we need to ensure event is emitted even if loop already finished? Loop's wait will resolve and loop will emit. So route just settles promise, loop emits.
  res.status(204).end();
});
```

Need `getEntry` or `peek` method that returns request without settling, for auth.

---

## 3. Idempotency and races

### 3.1 First caller wins, later no-ops

- `settle()` deletes entry before resolving promise — so second concurrent caller finds no entry and returns `settled: false`
- No duplicate `approval_resolved` events because only caller with `settled: true` emits
- No recreation of registry state — entry is gone, not recreated

### 3.2 Race table

| Race | Expected winner | Loser behavior | Test |
|------|----------------|----------------|------|
| approve vs expiry (timer fires at same time as approve) | Whichever calls `settle()` first (depends on event loop) — but only one emits event, promise resolves once | Second returns `settled: false`, no event, no error | `approve vs expiry` test: set timeout 10ms, approve at 10ms, assert only one resolution, no duplicate events |
| deny vs cancelTurn (user denies at same time as Stop pressed) | First to call settle wins — if deny first, tool gets APPROVAL_DENIED and stays running; if cancel first, turn_cancelled | Second is no-op | `deny vs cancelTurn` test |
| repeated approve/deny (double-click UI) | First approve wins, second returns 409 stale | No second event, no second tool execution | `repeated approve/deny` test |
| stale request from another session (attacker guesses requestId) | Route validation fails: sessionId mismatch → 404, registry not settled | No settlement, approval remains pending for correct session | `stale request from another session` test |
| cancellation of one turn leaving another turn's approvals intact | `cancelTurn(turnId)` only deletes entries for that turnId via byTurn index | Other turn's approvals remain | `cancellation of one turn leaves another intact` test |
| expiry using registry-computed expiresAt | Registry computes expiresAt = now + timeoutMs, timer uses same timeoutMs — UI shows expiresAt, actual expiry at same time (within event loop) | No drift | `expiry using registry-computed expiresAt` test: check expiresAt - createdAt ≈ timeoutMs |
| replay reconstructing resolved approval without settling live promise twice | Reducer consumes `turn_waiting_for_approval` → pending, `approval_resolved` → not pending. Registry is empty after settlement, so replay does not call `wait()` or `settle()` again — just folds events | No live promise settlement on replay | `replay reconstructing resolved approval` test |

### 3.3 Tombstone or not?

If `wait()` is called after settlement (e.g., loop already finished, but someone calls wait again), should it return already-settled resolution or throw "not found"? For idempotency, we could keep a short-lived tombstone Map<requestId, ApprovalResolution> for e.g., 5 minutes, so repeated wait returns same resolution. But simpler: throw "not found" and loop should not call wait after settlement — it already has resolution. For HTTP API, `resolve` returns 409 if already settled, which is correct.

For replay, we never call `wait()` — we just fold events. So no need for tombstone.

---

## 4. Cleanup guarantees (contract 8)

- After `approved`/`denied`: entry removed from global map and turn index, timer cleared, promise resolved — cleanup done
- After `expired`: timer callback calls `settle(expired)` which removes and clears — cleanup done (timer already fired, so no need to clear, but we clear anyway)
- After `cancelled` via `cancelTurn`: removes all for turnId, clears timers, resolves promises — cleanup done
- After terminal turn failure: loop finally calls `cancelTurn(turnId)` which cleans up any remaining pending approvals for that turn — guaranteed
- After `turn_completed`: loop finally also calls `cancelTurn` — but there should be no pending approvals at that point (all resolved), so no-op

**No leaks:** Every path goes through `settle()` which clears timer and removes from both maps.

---

## 5. Tests for Phase 2 (as you requested)

```ts
test("approve vs expiry — first wins, no duplicate events", async () => {
  const registry = new ApprovalRegistry({ now: () => Date.now() });
  const req = registry.request({ sessionId: "s1", turnId: "t1", providerCallId: "c1", toolName: "run_terminal", input: {}, reason: "needs approval", timeoutMs: 10 });
  const waitPromise = registry.wait(req.requestId);

  // Race approve and expiry at same time
  setTimeout(() => registry.approve(req.requestId), 10);
  // expiry timer also at 10ms

  const resolution = await waitPromise;
  // Either approved or expired, but not both, and only one settlement
  assert.ok(resolution.kind === "approved" || resolution.kind === "expired");
  assert.equal(registry.has(req.requestId), false);
  assert.equal(registry.snapshot("t1").length, 0);
});

test("deny vs cancelTurn", async () => {
  const registry = new ApprovalRegistry();
  const req = registry.request({ sessionId: "s1", turnId: "t1", providerCallId: "c1", toolName: "run_terminal", input: {}, reason: "needs", timeoutMs: 1000 });
  const waitPromise = registry.wait(req.requestId);

  // Deny and cancelTurn concurrently
  registry.deny(req.requestId);
  registry.cancelTurn("t1");

  const resolution = await waitPromise;
  // First wins (deny), second is no-op
  assert.equal(resolution.kind, "denied");
  assert.equal(registry.has(req.requestId), false);
});

test("repeated approve/deny — second is no-op 409", () => {
  const registry = new ApprovalRegistry();
  const req = registry.request({ sessionId: "s1", turnId: "t1", providerCallId: "c1", toolName: "run_terminal", input: {}, reason: "needs", timeoutMs: 1000 });

  const first = registry.approve(req.requestId);
  assert.equal(first.settled, true);

  const second = registry.approve(req.requestId);
  assert.equal(second.settled, false);

  const third = registry.deny(req.requestId);
  assert.equal(third.settled, false);
});

test("stale request from another session — 404", () => {
  const registry = new ApprovalRegistry();
  const req = registry.request({ sessionId: "s1", turnId: "t1", providerCallId: "c1", toolName: "run_terminal", input: {}, reason: "needs", timeoutMs: 1000 });

  // Simulate route auth: URL sessionId s2, request's sessionId s1
  const urlSessionId = "s2";
  const entry = registry.peek(req.requestId); // need peek method
  assert.equal(entry.request.sessionId, "s1");
  assert.notEqual(entry.request.sessionId, urlSessionId);
  // Route should return 404, not settle
  assert.equal(registry.has(req.requestId), true);
});

test("cancellation of one turn leaves another turn's approvals intact", () => {
  const registry = new ApprovalRegistry();
  const req1 = registry.request({ sessionId: "s1", turnId: "t1", providerCallId: "c1", toolName: "run_terminal", input: {}, reason: "needs", timeoutMs: 1000 });
  const req2 = registry.request({ sessionId: "s1", turnId: "t2", providerCallId: "c2", toolName: "run_terminal", input: {}, reason: "needs", timeoutMs: 1000 });

  registry.cancelTurn("t1");

  assert.equal(registry.has(req1.requestId), false);
  assert.equal(registry.has(req2.requestId), true);
  assert.equal(registry.snapshot("t1").length, 0);
  assert.equal(registry.snapshot("t2").length, 1);
});

test("expiry using registry-computed expiresAt", () => {
  let now = 1000;
  const registry = new ApprovalRegistry({ now: () => now });
  const req = registry.request({ sessionId: "s1", turnId: "t1", providerCallId: "c1", toolName: "run_terminal", input: {}, reason: "needs", timeoutMs: 5000 });

  assert.equal(req.createdAt, 1000);
  assert.equal(req.expiresAt, 6000);
  assert.equal(req.expiresAt - req.createdAt, 5000);
});

test("replay reconstructing resolved approval without settling live promise twice", () => {
  // Simulate: turn_waiting_for_approval event, then approval_resolved event, then replay via reducer
  const { createInitialTurnState, reduceTurnState } = require("@windows-runner/shared");

  let state = createInitialTurnState();
  state = reduceTurnState(state, { seq: 1, at: 1, sessionId: "s1", turnId: "t1", type: "turn_started", limits: { maxSteps: 10, modelCallTimeoutMs: 1000, toolTimeoutMs: 1000, approvalTimeoutMs: 1000 }, message: "hi" });
  state = reduceTurnState(state, { seq: 2, at: 2, sessionId: "s1", turnId: "t1", type: "turn_waiting_for_approval", request: { requestId: "apr_1", providerCallId: "c1", sessionId: "s1", turnId: "t1", toolName: "run_terminal", input: {}, reason: "needs", expiresAt: 10000, createdAt: 2 } });
  assert.equal(state.pendingApprovals.size, 1);

  state = reduceTurnState(state, { seq: 3, at: 3, sessionId: "s1", turnId: "t1", type: "approval_resolved", requestId: "apr_1", decision: "approve", resolvedAt: 3, resolution: { kind: "approved" } });
  assert.equal(state.pendingApprovals.size, 0);
  assert.equal(state.status, "running");

  // Replay same events again — should be idempotent, no second settlement, no error
  const state2 = reduceTurnState(state, { seq: 3, at: 3, sessionId: "s1", turnId: "t1", type: "approval_resolved", requestId: "apr_1", decision: "approve", resolvedAt: 3, resolution: { kind: "approved" } });
  assert.equal(state2, state); // same object, duplicate seq ignored
});
```

---

## 6. Design-it-twice for settlement

### Option A — Single settle() with ApprovalResolution union, promise always resolves (recommended, as above)

- All settlements resolve with union, never reject for expected cases
- One internal path, first wins, later no-ops, no duplicate events
- Clear separation: registry owns promise, loop owns event emission

Pros: One path, easy to reason about races, idempotent, matches your required boundaries
Cons: Need to update loop to switch on kind, not just decision string

### Option B — Keep resolve/reject separate, but still one internal settle

- `settle()` still single path, but resolves for approve/deny, rejects for expired/cancelled
- Loop needs try/catch to distinguish

Pros: Closer to current code
Cons: Two promise modes (resolve vs reject) for same concept, harder to handle races, need to catch errors for expected cases

**Recommendation:** Option A — union, always resolves.

---

## 7. What Phase 2 does NOT cover (deferred to Phase 3)

- Disconnect vs settlement separation: already fixed in #3+#6 (no signal in wait), but need to prove with test that SSE disconnect only unsubscribes, never settles
- Replay state vs live promise: reducer represents approval state, registry owns live promises — need to ensure replay does not call wait() or settle(), just folds
- Cleanup after terminal failure: loop finally calls cancelTurn — need to test that approval cleanup guaranteed after turn_failed

---

## 8. Next steps

**Phase 3:** Disconnect only unsubscribes, replay state vs live promise separation, cleanup guarantees.

Please confirm go for Phase 3, or request changes to Phase 2.

