# Phase 1 — Current cancellation/timeout design and problems

**Focus:** Folding `cancellation.ts` + `timeout.ts` into one `deadline.ts`, wrong-way dependency, deletion test for CancellationToken, current race vs abort-and-await semantics.

**Status:** Draft for review — stops and waits for your go before Phase 2 (proposed Deadline module).

---

## 1. Current design (after #3+#6 implementation, before #1)

**Files:**

- `packages/server/src/agent/cancellation.ts` — `CancellationError`, `CancellationToken` (wrapper over AbortController), `createCancellationToken()`, `isCancellationError()`
- `packages/server/src/agent/timeout.ts` — `TimeoutError` code TIMEOUT, `withTimeout(operation(signal), timeoutMs, parentSignal)` races timer vs operation
- `packages/server/src/providers/model-call.ts` — `runModelCall(provider, request, signal, timeoutMs)` uses `withTimeout`, preserves partialText on failure
- `packages/server/src/agent/tools/executor.ts` — `executeTool(tool, input, ctx, timeoutMs)` uses `withTimeout`, returns TOOL_TIMED_OUT as value, rethrows CancellationError
- `packages/server/src/agent/approval-registry.ts` — uses `setTimeout` for expiry, calls `settle(expired)` on timer, `cancelTurn` settles with cancelled
- `packages/server/src/agent/loop.ts` — owns per-turn AbortController, passes signal to model-call and tools, listens to signal abort during approval wait to call cancelTurn

**Current flow for a tool call with timeout:**

```
Turn signal (AbortSignal from TurnManager)
  → withTimeout(operation(childSignal), toolTimeoutMs, parentSignal=turnSignal)
    → creates child AbortController
    → listens to parentSignal abort → aborts child
    → sets timeoutId = setTimeout(() => { child.abort(TimeoutError); reject(TimeoutError) }, timeoutMs)
    → Promise.race([operation(childSignal), timeoutPromise])
    → finally: clearTimeout, remove parent listener
```

**For model call:**

```
Turn signal → withTimeout((childSignal) => provider.stream(request, { signal: childSignal }), modelTimeoutMs, turnSignal)
```

**For approval:**

```
setTimeout(() => settle(expired), approvalTimeoutMs) — separate timer, not using withTimeout
```

### 1.1 What is right

- `AbortSignal` is the cancellation interface — used everywhere, correct
- `withTimeout` composes parent cancellation with deadline — correct idea
- `FakeProvider` has `waitForAbort` and `ignoreAbort` modes to test abort handling — good seam

### 1.2 Problems (from report C1, C5, C6 and your focus list)

**1. Race vs abort-and-await semantics:**

`withTimeout` does `Promise.race([operation(childSignal), timeoutPromise])`. When timer fires, it aborts child signal and rejects timeoutPromise, but `operation` is still running — whether it stops depends on whether it observes child signal. So `TOOL_TIMED_OUT` means "we stopped waiting", not "it is dead". Two Global Constraints — "terminated with their full process tree on timeout" and "exits cleanly without leaking resources" — cannot be expressed or tested through this interface.

Example:

```ts
await withTimeout(
  async (signal) => {
    // tool that ignores signal
    await new Promise(() => {}); // never resolves, never checks signal
  },
  100,
  parentSignal
);
// withTimeout rejects after 100ms, but operation still running forever — leak
// Loop then emits tool_completed with TOOL_TIMED_OUT and continues to next step
// Process tree may still be running
```

**The interface is the test surface — this surface cannot express "did it actually stop?"**

**2. One TimeoutError, three shared codes, three translators:**

`TimeoutError.code = "TIMEOUT"` matches none of shared codes `MODEL_TIMEOUT`, `TOOL_TIMED_OUT`, `APPROVAL_TIMEOUT`. The "where did it time out" fact is reconstructed by three catchers from call-site context:

- `model-call.ts` → `MODEL_TIMEOUT`
- `executor.ts` → `TOOL_TIMED_OUT`
- `approval-registry.ts` → `APPROVAL_TIMEOUT` (via ApprovalTimeoutError)

No locality — kind-tagging happens in catchers, not at point of failure.

**3. Wrong-way dependency:**

`providers/model-call.ts → agent/timeout.ts` while `agent/loop.ts → providers/model-call.ts`. A timer is infrastructure, not agent logic; it belongs beside `paths.ts` and `process-tree.ts` (or at top-level `src/`), not under `agent/`. Dependency direction: `agent` should depend on infrastructure, not `providers` depending on `agent`.

```
Before:
  agent/loop → providers/model-call → agent/timeout
  agent/tools/executor → agent/timeout
  agent/approval-registry → (setTimeout directly, not via timeout.ts)

After (proposed):
  agent/loop → src/deadline
  providers/model-call → src/deadline
  agent/tools/executor → src/deadline
  agent/approval-registry → src/deadline (for expiry)
```

**4. CancellationToken thin wrapper — deletion test:**

`CancellationToken` is 3 methods: `signal`, `cancel()`, `throwIfCancelled()` — interface ≈ implementation over AbortController. Nothing downstream uses it:

- `TurnRunner.run` takes raw `AbortSignal`
- `TurnManager` creates `AbortController` directly (via `ensureLog` abortController? Actually we have abortController in TurnLog but not used via token)
- Every test does `new AbortController()`

Deletion test: deleting it moves nothing, because callers already bypass it. It is a shallow module (wide and short). Should be deleted, AbortSignal is the cancellation interface.

**5. Timer, listener, promise leaks:**

- `withTimeout` clears timeoutId in finally, removes parent listener — good, but if operation ignores signal and never settles, the childSignal's abort event listeners (added by operation) may leak? Actually operation's signal is childSignal, and operation may add listeners to it that never get cleaned up if operation never settles.
- `approval-registry` uses `setTimeout` directly — if `cancelTurn` called, it clears timeoutId, good, but if `approve` called, it also clears — good. But if turn completes without approval resolved, finally calls cancelTurn which clears — good. No leak in current code, but three separate places manage timers, not one.

**6. Behavior when providers ignore abort:**

FakeProvider has `ignoreAbort` mode — stream never ends even when signal aborted. Current `withTimeout` will reject timeoutPromise, but operation (provider.stream) still hanging, never cleaned up. Loop will emit turn_failed and return, but provider's stream still running in background — leak, and `lastSignal.aborted` true but stream not stopped.

We need abort-and-await: on deadline, abort child signal AND await operation's settlement with hard grace cap, then throw.

**7. Whether deadlines are per turn, model call, tool call, approval wait:**

Currently:

- Per turn: AbortController per turn, created in TurnManager or app.ts, passed as parent signal to all operations
- Per model call: withTimeout with modelCallTimeoutMs, child signal
- Per tool call: withTimeout with toolTimeoutMs, child signal
- Per approval wait: setTimeout with approvalTimeoutMs, not using withTimeout, no child signal

So 3 different mechanisms for same concept (deadline). Should be one.

---

## 2. Deletion test for CancellationToken

**Question:** Would deleting `cancellation.ts` concentrate complexity somewhere sensible, or just move it?

- `CancellationToken` wraps AbortController with `cancel()` and `throwIfCancelled()`
- `cancel()` is just `controller.abort(new CancellationError(reason))` — callers can do `controller.abort()` directly
- `throwIfCancelled()` checks `signal.aborted` and throws reason — callers can check `signal.aborted` and throw themselves, or just rely on operation to observe signal
- No module depends on CancellationToken interface — all use AbortSignal or AbortController directly
- `isCancellationError` checks `code === "CANCELLED"` — could be `isCancelError` that checks `signal.aborted` or error code

**Conclusion:** Deleting it concentrates complexity in zero places — it is already bypassed. The semantic need is already served by AbortSignal + CancellationError. Deletion test says delete.

**What remains:** `CancellationError` class with code CANCELLED — keep as typed error, but move to deadline.ts as `CancelledError` kind-tagged.

---

## 3. What we need for #1 (preview for Phase 2)

- One `deadline.ts` module at `src/deadline.ts` (or `packages/server/src/deadline.ts`) that owns "run this operation under parent signal and deadline, abort-and-await settlement"
- Interface: `Deadline { signal: AbortSignal, expiresAt: number, cancel(reason?), dispose() }` + `runWithDeadline(operation(signal), { parentSignal, timeoutMs, kind, clock }) => result` that aborts child signal on deadline and awaits operation settlement with grace cap
- Kind-tagged failures: `timeout`, `cancelled`, `shutdown` with kind field `model | tool | approval` so shared code chosen at point of failure, not by catcher
- FakeClock integration: deadline uses clock for timers, not real setTimeout, so tests deterministic
- Leak prevention: dispose() clears timer and removes parent listener, even if operation ignores abort
- Abort-ignoring provider: deadline's abort-and-await with grace cap — if operation still not settled after grace, log warning and force cleanup? Or throw with partial? Need to decide.

---

## 4. Next steps

**Phase 2:** Proposed Deadline module design — interface, abort-and-await semantics, kind-tagged failures, FakeClock, leak prevention, dependency direction fix.

Please confirm go for Phase 2, or request changes to Phase 1.

