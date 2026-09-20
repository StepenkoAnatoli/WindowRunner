# Phase 2 — Proposed Deadline module design

**Focus:** Your design points — ownership per turn/model/tool/approval, parent-child propagation (child may shorten, never extend parent), abort-and-await contract, typed failure semantics, single timer/listener owner, FakeClock integration, abort-ignoring providers, dependency direction and deletion of CancellationToken.

**Status:** Draft for review — stops and waits for your go before Phase 3 (ownership and lifecycle, propagation, repeated cancellation).

---

## 1. Deadline ownership — per what?

### 1.1 One deadline per operation, parent is turn

- **Per turn:** One root Deadline (or just AbortController) per turn, created by TurnManager or app.ts when turn starts. No timeout, only cancellation (Stop pressed, session cancel). Its signal is parent for all child deadlines. When turn is cancelled, root's `cancel()` aborts signal, all children abort.
- **Per model call:** One child Deadline per `runModelCall`, with `timeoutMs = limits.modelCallTimeoutMs`, parent = turn signal, kind = `model`. Created inside loop before model call, disposed after model call settles (including abort-and-await grace).
- **Per tool call:** One child Deadline per `executeTool`, with `timeoutMs = limits.toolTimeoutMs`, parent = turn signal, kind = `tool`. Created inside executor, disposed after tool settles.
- **Per approval wait:** One child Deadline per `approvalRegistry.request()`, with `timeoutMs = limits.approvalTimeoutMs`, parent = turn signal, kind = `approval`. Currently approval uses setTimeout directly — after #1, it will use Deadline instead. Created inside registry's `request()`, disposed on settlement (approved/denied/cancelled/expired).

**Why per operation, not per turn only?** Each operation has different timeout, and we need `expiresAt` per operation for UI and for event mapping. Turn has no timeout, only cancellation.

### 1.2 Parent-child propagation — child may shorten, never extend

- Child deadline's `expiresAt = min(parent.expiresAt (if parent has deadline), now + childTimeoutMs)`? But turn has no deadline, only cancellation, so child expiresAt = now + timeoutMs. If parent also has deadline (e.g., turn has overall deadline? Currently not, but could in future), child must not extend parent — child timeout must be ≤ remaining parent time? For now, turn has no deadline, so child timeout is independent.
- More generally: child signal aborts when parent aborts OR child timeout fires — child never outlives parent. Child may have shorter timeout than parent, but never longer than parent's remaining time if parent has deadline.
- Implementation: child Deadline listens to parentSignal abort → aborts child signal with same reason. Child also has its own timer that aborts child signal on expiry. So child aborts on parent abort OR own expiry, whichever first.
- Child cannot extend parent — parent's abort does not depend on child's timer. Child's timer is independent but child signal is child of parent, so parent abort aborts child, but child expiry does not abort parent.

**State model:**

```
Turn (root): AbortController, no timer, only cancel()
  ├─ Model call 1: Deadline { parent: turn.signal, timeoutMs: 120s, kind: model, expiresAt: now+120s, signal: childSignal }
  ├─ Tool call 1: Deadline { parent: turn.signal, timeoutMs: 120s, kind: tool, expiresAt: now+120s }
  ├─ Approval 1: Deadline { parent: turn.signal, timeoutMs: 300s, kind: approval, expiresAt: now+300s }
  └─ Model call 2: Deadline { parent: turn.signal, timeoutMs: 120s, kind: model }
```

Each Deadline owns one timer, one child AbortController, one parent listener.

---

## 2. Abort-and-await contract

### 2.1 Current race vs proposed abort-and-await

**Before (withTimeout race):**

```ts
// Pseudo
const childController = new AbortController();
const timeoutPromise = new Promise((_, reject) => setTimeout(() => {
  childController.abort(TimeoutError);
  reject(TimeoutError);
}, timeoutMs));

return Promise.race([operation(childController.signal), timeoutPromise]);
// If timeout fires, we reject, but operation still running — leak, false claim dead
```

**After (deadline abort-and-await):**

```ts
// Pseudo
const childController = new AbortController();
let timer: NodeJS.Timeout | FakeClock timer;

const abortChild = (reason) => {
  if (!childController.signal.aborted) {
    childController.abort(reason);
  }
};

// Listen to parent abort
parentSignal.addEventListener("abort", () => abortChild(parentSignal.reason), { once: true });

// Set timer for deadline
timer = clock.setTimeout(() => abortChild(new DeadlineExpiredError(kind)), timeoutMs);

try {
  const result = await operation(childController.signal);
  return result;
} catch (err) {
  // If operation threw because child aborted, check if it was timeout or cancellation
  // But we still need to await shutdown?
  throw err;
} finally {
  // On expiry or cancellation: signal abort first, then await operation shutdown with bounded grace
  // How to await shutdown? operation already awaited above — if it ignores abort, it will hang in await
  // So we need to race operation's settlement after abort with grace period
}
```

**The key distinction:** `withTimeout` reports "caller stopped waiting", `deadline` reports "operation stopped" (or "did not stop within grace").

### 2.2 Detailed abort-and-await lifecycle

```ts
interface Deadline {
  readonly signal: AbortSignal; // child signal, aborts on parent abort OR own expiry
  readonly expiresAt: number;   // absolute timestamp
  readonly kind: "model" | "tool" | "approval"; // for failure mapping at event boundary
  cancel(reason?: unknown): void; // explicit cancel (e.g., Stop pressed)
  dispose(): void; // idempotent cleanup: clear timer, remove parent listener
}

type DeadlineFailureKind = "deadline_expired" | "cancelled" | "shutdown_timeout";

class DeadlineError extends Error {
  kind: DeadlineFailureKind;
  operationKind: "model" | "tool" | "approval";
  constructor(kind: DeadlineFailureKind, operationKind: "model"|"tool"|"approval", message: string) {
    super(message);
    this.kind = kind;
    this.operationKind = operationKind;
  }
}
```

**Operation:**

```ts
async function runWithDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  opts: { parentSignal: AbortSignal; timeoutMs: number; kind: "model"|"tool"|"approval"; clock?: FakeClock; shutdownGraceMs?: number }
): Promise<T> {
  const { parentSignal, timeoutMs, kind, clock, shutdownGraceMs = 5000 } = opts;
  const controller = new AbortController();
  const signal = controller.signal;
  const expiresAt = (clock?.now() ?? Date.now()) + timeoutMs;

  let timer: any;
  let parentListener: () => void;
  let settled = false;

  const dispose = () => {
    if (timer) {
      if (clock) clock.clearTimeout(timer);
      else clearTimeout(timer);
      timer = undefined;
    }
    if (parentListener) {
      parentSignal.removeEventListener("abort", parentListener);
      parentListener = undefined as any;
    }
  };

  const abortChild = (reason: unknown) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  // Parent abort → abort child
  parentListener = () => abortChild(parentSignal.reason ?? new Error("parent cancelled"));
  if (parentSignal.aborted) {
    abortChild(parentSignal.reason);
  } else {
    parentSignal.addEventListener("abort", parentListener, { once: true });
  }

  // Deadline timer → abort child with expired error
  const onExpired = () => {
    abortChild(new DeadlineError("deadline_expired", kind, `${kind} deadline expired after ${timeoutMs}ms`));
  };
  timer = clock ? clock.setTimeout(onExpired, timeoutMs) : setTimeout(onExpired, timeoutMs);

  try {
    const result = await operation(signal);
    settled = true;
    return result;
  } catch (err) {
    // If operation threw because signal aborted, we need to distinguish timeout vs cancellation
    // But we still need to await shutdown? Actually operation already threw, so it did observe abort (or failed otherwise)
    // For operations that ignore abort, operation will NOT throw and will hang — we handle below in finally? No, finally runs after await, but if operation hangs, we never reach catch/finally
    // So we need to handle hanging operation differently: we need to race operation with abort, then await shutdown grace

    // To handle ignore-abort, we need to not just await operation, but race it with abort, then after abort, await operation with grace
    throw err;
  } finally {
    dispose();
  }
}
```

**The above still has race — if operation ignores abort and hangs, `await operation(signal)` never settles, so finally never runs, timer already fired but operation still hanging.**

**Correct abort-and-await needs two phases:**

1. **Phase 1: Run operation until it settles OR abort (parent or expiry) happens**
2. **Phase 2: If abort happened and operation still not settled, await its settlement with bounded grace period, then report shutdown_timeout if still not settled**

```ts
async function runWithDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  opts: { parentSignal: AbortSignal; timeoutMs: number; kind: "model"|"tool"|"approval"; clock?: FakeClock; shutdownGraceMs?: number }
): Promise<T> {
  const { parentSignal, timeoutMs, kind, clock, shutdownGraceMs = 5000 } = opts;
  const controller = new AbortController();
  const signal = controller.signal;
  const expiresAt = (clock?.now() ?? Date.now()) + timeoutMs;

  let timer: any;
  let parentListener: () => void;
  let expired = false;
  let cancelled = false;

  const dispose = () => {
    if (timer) {
      if (clock) clock.clearTimeout(timer);
      else clearTimeout(timer);
      timer = undefined;
    }
    if (parentListener) {
      parentSignal.removeEventListener("abort", parentListener);
      parentListener = undefined as any;
    }
  };

  const abortChild = (reason: unknown) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  parentListener = () => {
    cancelled = true;
    abortChild(parentSignal.reason ?? new DeadlineError("cancelled", kind, "cancelled"));
  };
  if (parentSignal.aborted) {
    cancelled = true;
    abortChild(parentSignal.reason);
  } else {
    parentSignal.addEventListener("abort", parentListener, { once: true });
  }

  const onExpired = () => {
    expired = true;
    abortChild(new DeadlineError("deadline_expired", kind, `${kind} deadline expired after ${timeoutMs}ms`));
  };
  timer = clock ? clock.setTimeout(onExpired, timeoutMs) : setTimeout(onExpired, timeoutMs);

  let operationPromise = operation(signal);

  // Wait for operation OR abort (parent or expiry)
  // We need to know when abort happens — signal has aborted event
  const abortPromise = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
    } else {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }
  });

  try {
    const result = await Promise.race([operationPromise, abortPromise]);
    // Operation settled before abort — success
    dispose();
    return result as T;
  } catch (err) {
    // Abort happened (either parent cancellation or deadline expiry) OR operation threw
    // If operation threw before abort, we should return its error (not deadline error)
    // How to distinguish? If signal not aborted, then operation threw on its own — return its error
    if (!signal.aborted) {
      dispose();
      throw err;
    }

    // Signal aborted — operation may still be running (if it ignores abort) or may have thrown because of abort
    // Now we need to await operation shutdown with bounded grace

    // Phase 2: await operation settlement with grace
    const graceTimer = new Promise<never>((_, reject) => {
      const timer = clock ? clock.setTimeout(() => reject(new DeadlineError("shutdown_timeout", kind, `${kind} shutdown timed out after ${shutdownGraceMs}ms`)), shutdownGraceMs) : setTimeout(() => reject(new DeadlineError("shutdown_timeout", kind, `${kind} shutdown timed out after ${shutdownGraceMs}ms`)), shutdownGraceMs);
      // If operation settles before grace, we will clear this timer in the race below
    });

    try {
      const shutdownResult = await Promise.race([operationPromise, graceTimer]);
      // Operation settled within grace — it observed abort and cleaned up
      dispose();
      // If operation settled with value after abort, should we return value or throw abort error?
      // For cancellation, we should throw cancelled, not return value — because caller stopped waiting and operation's value is stale
      // For expiry, we should throw deadline_expired, not return value
      // So we throw the abort reason (which is DeadlineError)
      throw signal.reason;
    } catch (shutdownErr) {
      dispose();
      if (shutdownErr instanceof DeadlineError && shutdownErr.kind === "shutdown_timeout") {
        // Operation did NOT terminate within grace — typed failure indicating not terminated, no false claim dead
        throw shutdownErr;
      }
      // Operation settled within grace but threw abort reason — throw abort reason (expired or cancelled)
      throw signal.reason ?? shutdownErr;
    }
  }
}
```

**Key points:**

- **Signal abort first, then await shutdown:** On expiry or cancellation, we abort child signal immediately, then await operationPromise with grace period
- **Bounded shutdown grace:** e.g., 5s for tools (to kill process tree), 1s for model calls, 0 for approval (no cleanup needed)
- **Typed failure if not terminated:** If operation still not settled after grace, throw `shutdown_timeout` — indicates operation did NOT terminate, no false claim dead. Caller (loop) should log warning and maybe force kill process tree, but not claim success.
- **Callers cannot accidentally continue while cleanup pending:** `runWithDeadline` does NOT return until operation settled OR grace timeout — it awaits shutdown. So caller cannot continue while cleanup pending.

---

## 3. Typed failure semantics — kind-tagged at point of failure

### 3.1 Local explicit kinds

```ts
type DeadlineFailureKind = "deadline_expired" | "cancelled" | "shutdown_timeout";

class DeadlineError extends Error {
  kind: DeadlineFailureKind;
  operationKind: "model" | "tool" | "approval";
  constructor(kind: DeadlineFailureKind, operationKind: "model"|"tool"|"approval", message: string) {
    super(message);
    this.name = "DeadlineError";
    this.kind = kind;
    this.operationKind = operationKind;
  }
}
```

**Why local explicit kinds, not reconstructing at catch sites?**

- Before: `TimeoutError.code = "TIMEOUT"` → catchers in 3 places reconstruct `MODEL_TIMEOUT`, `TOOL_TIMED_OUT`, `APPROVAL_TIMEOUT` from context
- After: `DeadlineError` has `kind: deadline_expired` and `operationKind: model|tool|approval` at point of failure — no reconstruction, single source

### 3.2 Mapping to shared codes at event boundary

At event boundary (loop.ts), map DeadlineError to shared TurnFailureCode or ToolErrorCode:

```ts
function mapDeadlineErrorToEvent(err: DeadlineError): { code: TurnFailureCode | ToolErrorCode, message: string, retryable: boolean } {
  switch (err.operationKind) {
    case "model":
      if (err.kind === "deadline_expired") return { code: "MODEL_TIMEOUT", message: err.message, retryable: true };
      if (err.kind === "cancelled") return { code: "CANCELLED", message: err.message, retryable: false }; // but we emit turn_cancelled, not turn_failed
      if (err.kind === "shutdown_timeout") return { code: "MODEL_FAILED", message: `model shutdown timeout: ${err.message}`, retryable: false };
      break;
    case "tool":
      if (err.kind === "deadline_expired") return { code: "TOOL_TIMED_OUT", message: err.message, retryable: true };
      if (err.kind === "cancelled") return { code: "CANCELLED", message: err.message, retryable: false };
      if (err.kind === "shutdown_timeout") return { code: "TOOL_FAILED", message: `tool shutdown timeout: ${err.message}`, retryable: false };
      break;
    case "approval":
      if (err.kind === "deadline_expired") return { code: "APPROVAL_TIMEOUT", message: err.message, retryable: false };
      if (err.kind === "cancelled") return { code: "CANCELLED", message: err.message, retryable: false };
      if (err.kind === "shutdown_timeout") return { code: "APPROVAL_TIMEOUT", message: `approval shutdown timeout: ${err.message}`, retryable: false };
      break;
  }
}
```

**Mapping at event boundary, not in catchers scattered:** Loop has one place that maps DeadlineError to event, not three separate catchers.

- For `cancelled`, we emit `turn_cancelled`, not `turn_failed` — so mapping returns CANCELLED but we treat specially
- For `deadline_expired`, we emit `turn_failed` with appropriate code (MODEL_TIMEOUT, TOOL_TIMED_OUT as ToolResult, APPROVAL_TIMEOUT)
- For `shutdown_timeout`, we emit `turn_failed` with MODEL_FAILED or TOOL_FAILED, indicating operation did not terminate — no false claim dead

---

## 4. Single timer/listener owner — one module owns timer, cleanup, parent listeners, disposal

### 4.1 Owner

`deadline.ts` module owns:

- Timer creation (via FakeClock or real setTimeout)
- Parent signal listener (aborts child on parent abort)
- Child signal (AbortController)
- Grace timer for shutdown
- Disposal (clear timer, remove parent listener, clear grace timer)

### 4.2 Idempotent cancel() and dispose()

```ts
class Deadline {
  private disposed = false;
  private timer: any;
  private graceTimer: any;
  private parentListener: () => void;

  cancel(reason?: unknown): void {
    if (this.disposed) return;
    if (!this.controller.signal.aborted) {
      this.controller.abort(reason ?? new DeadlineError("cancelled", this.kind, "cancelled"));
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) {
      if (this.clock) this.clock.clearTimeout(this.timer);
      else clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.graceTimer) {
      if (this.clock) this.clock.clearTimeout(this.graceTimer);
      else clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
    }
    if (this.parentListener) {
      this.parentSignal.removeEventListener("abort", this.parentListener);
      this.parentListener = undefined as any;
    }
  }
}
```

**Idempotent:** Multiple calls to `cancel()` or `dispose()` are no-ops after first.

### 4.3 Leak assertions

After every operation, assert:

```ts
// After runWithDeadline settles (success or failure)
assert.equal((deadline as any).timer, undefined); // timer cleared
assert.equal((deadline as any).graceTimer, undefined); // grace timer cleared
assert.equal((deadline as any).disposed, true); // disposed
// Parent listener removed — check by counting listeners? Or by checking that parentSignal has no listener for abort that references child?
// For FakeClock, check clock.timers is empty
assert.equal(clock.timers.length, 0);
```

**No timer, listener, promise leaks.**

---

## 5. FakeClock integration — deterministic advancement

### 5.1 Use deterministic clock for expiry and grace

```ts
class FakeClock {
  now(): number
  setTimeout(cb, ms): id
  clearTimeout(id)
  advance(ms): void // runs timers <= now+ms
  sleep(ms): Promise<void>
}
```

**Deadline uses clock:**

```ts
const deadline = createDeadline(parentSignal, timeoutMs, { clock, kind: "model", shutdownGraceMs: 1000 });
```

**Test timeout vs cancel race:**

```ts
test("timeout vs cancellation race — exactly one terminal outcome", async () => {
  const clock = new FakeClock();
  const parentController = new AbortController();

  const operation = async (signal: AbortSignal) => {
    // Hang until aborted
    await new Promise<void>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason));
    });
  };

  const deadlinePromise = runWithDeadline(operation, {
    parentSignal: parentController.signal,
    timeoutMs: 100,
    kind: "model",
    clock,
    shutdownGraceMs: 50,
  });

  // Race: timeout at 100ms vs cancel at 90ms
  clock.advance(90);
  parentController.abort(new Error("cancelled"));

  clock.advance(10); // now 100, timeout would fire but already cancelled

  try {
    await deadlinePromise;
    assert.fail("should have thrown");
  } catch (err) {
    // Should be cancelled, not expired — first wins
    assert.equal((err as any).kind, "cancelled");
  }

  // Leak assertions
  assert.equal(clock.timers.length, 0);
});
```

**Exactly one terminal outcome:** Either `deadline_expired` or `cancelled`, not both, no duplicate events.

---

## 6. Abort-ignoring providers — aborted vs confirmed stopped

### 6.1 FakeProvider.ignoreAbort

**Current:**

```ts
ignoreAbort: () => ({ hang: true, ignoreAbort: true })
// Stream never ends even when signal aborted
```

**Proposed for deadline tests:**

Two modes:

- **Intentionally remains hung:** For testing shutdown_timeout — provider ignores abort forever, deadline should throw shutdown_timeout after grace
- **Eventually resolves after controlled delay:** For testing abort-and-await — provider ignores abort for e.g., 20ms then resolves, deadline should await and return within grace, not throw shutdown_timeout

```ts
const Steps = {
  ignoreAbortForever: (): ProviderStep => () => ({ hang: true, ignoreAbort: true }),
  ignoreAbortThenResolve: (delayMs: number, chunks: LLMChunk[]): ProviderStep => () => ({
    chunks: [], // no chunks initially
    hang: true,
    ignoreAbort: true,
    // After delayMs, resolve? Need to implement in FakeProvider: if ignoreAbort, we can still have a timer that resolves after delay
  }),
};
```

**Production contract must distinguish "aborted" from "confirmed stopped":**

- **Aborted:** Child signal aborted (deadline expired or parent cancelled) — we have signaled abort, but operation may still be running
- **Confirmed stopped:** Operation promise settled (resolved or rejected) after abort — we have awaited shutdown and it completed within grace

`runWithDeadline` distinguishes:

- If operation settles within grace after abort → throw abort reason (expired or cancelled) — operation confirmed stopped
- If operation does NOT settle within grace → throw shutdown_timeout — operation did NOT stop, no false claim dead, caller should log warning and maybe force kill

**For process-tree:** Tool that ignores abort — deadline aborts signal, then awaits process-tree kill with grace. If process still alive after grace, throw shutdown_timeout, caller logs and maybe does taskkill /T.

---

## 7. Dependency direction and deletion — move out of agent/, delete CancellationToken

### 7.1 Move deadline abstraction out of agent/

**Before:**

```
packages/server/src/agent/timeout.ts
packages/server/src/agent/cancellation.ts
packages/server/src/providers/model-call.ts → agent/timeout.ts (wrong-way)
```

**After:**

```
packages/server/src/deadline.ts (or src/infrastructure/deadline.ts, or src/lib/deadline.ts)
  — owns Deadline, DeadlineError, runWithDeadline, createDeadline
  — no dependency on agent/ or providers/, only on AbortSignal and FakeClock interface

packages/server/src/agent/loop.ts → deadline.ts
packages/server/src/providers/model-call.ts → deadline.ts (now correct: providers depends on infrastructure, not agent)
packages/server/src/agent/tools/executor.ts → deadline.ts
packages/server/src/agent/approval-registry.ts → deadline.ts (for expiry)
```

**Dependency direction fixed:** `agent` and `providers` both depend on `deadline` (infrastructure), not `providers` depending on `agent`.

### 7.2 Delete CancellationToken, retain raw AbortSignal

**Deletion test:** Would deleting `cancellation.ts` concentrate complexity somewhere sensible?

- `CancellationToken` wraps AbortController with `signal`, `cancel()`, `throwIfCancelled()`
- All callers already use `AbortController` and `AbortSignal` directly
- `cancel()` is `controller.abort(new CancellationError(reason))` — callers can do `controller.abort()` directly
- `throwIfCancelled()` checks `signal.aborted` and throws — callers can check `signal.aborted` themselves or rely on operation to observe signal
- No module depends on CancellationToken interface

**Conclusion:** Delete `cancellation.ts` file, keep `CancellationError` (or `CancelledError`) as typed error with code CANCELLED, move to `deadline.ts` as part of `DeadlineError` with kind cancelled.

**What remains:**

- `DeadlineError` with `kind: cancelled` and `operationKind` — replaces `CancellationError`
- `AbortSignal` and `AbortController` are the cancellation interface — retained, raw, no wrapper

**Migration:**

- Remove `packages/server/src/agent/cancellation.ts`
- Move `CancellationError` to `deadline.ts` as `DeadlineError` with kind cancelled, or keep as separate but re-export from deadline.ts
- Update imports: `import { CancellationError } from "../cancellation.js"` → `import { DeadlineError } from "../deadline.js"` or `import { CancellationError } from "../deadline.js"`
- Loop and executor currently catch `CancellationError` — change to catch `DeadlineError` with kind cancelled or check `signal.aborted`

---

## 8. Interface, lifecycle/state model, failure mapping, migration/deletion plan (summary for Phase 2)

### 8.1 Interface

```ts
// deadline.ts

export type DeadlineOperationKind = "model" | "tool" | "approval";
export type DeadlineFailureKind = "deadline_expired" | "cancelled" | "shutdown_timeout";

export class DeadlineError extends Error {
  kind: DeadlineFailureKind;
  operationKind: DeadlineOperationKind;
  constructor(kind: DeadlineFailureKind, operationKind: DeadlineOperationKind, message: string);
}

export interface Deadline {
  readonly signal: AbortSignal;
  readonly expiresAt: number;
  readonly kind: DeadlineOperationKind;
  cancel(reason?: unknown): void;
  dispose(): void;
}

export function createDeadline(
  parentSignal: AbortSignal,
  timeoutMs: number,
  opts: { kind: DeadlineOperationKind; clock?: FakeClock; now?: () => number }
): Deadline;

export async function runWithDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  opts: {
    parentSignal: AbortSignal;
    timeoutMs: number;
    kind: DeadlineOperationKind;
    clock?: FakeClock;
    shutdownGraceMs?: number;
    now?: () => number;
  }
): Promise<T>;
```

### 8.2 Lifecycle/state model

```
Created: timer set, parent listener added, child signal not aborted, expiresAt = now+timeoutMs
  ├─ Operation settles before abort → dispose() → success, return result
  ├─ Parent abort → abort child with cancelled → await shutdown with grace → dispose() → throw cancelled
  ├─ Deadline expiry → abort child with deadline_expired → await shutdown with grace → dispose() → throw expired
  └─ Operation ignores abort → await shutdown grace → grace timeout → throw shutdown_timeout (no false claim dead)

Disposed: timer cleared, parent listener removed, grace timer cleared, disposed flag true, no leaks
```

### 8.3 Failure mapping at event boundary

| DeadlineError | OperationKind | Shared code | Event | Retryable |
|---------------|---------------|-------------|-------|-----------|
| deadline_expired | model | MODEL_TIMEOUT | turn_failed | true |
| deadline_expired | tool | TOOL_TIMED_OUT | tool_completed ok:false | true |
| deadline_expired | approval | APPROVAL_TIMEOUT | turn_failed | false |
| cancelled | any | CANCELLED | turn_cancelled | false |
| shutdown_timeout | model | MODEL_FAILED | turn_failed | false |
| shutdown_timeout | tool | TOOL_FAILED | tool_completed ok:false or turn_failed | false |
| shutdown_timeout | approval | APPROVAL_TIMEOUT | turn_failed | false |

Mapping done in one place at event boundary (loop.ts), not scattered.

### 8.4 Migration/deletion plan

| File | Current | After #1 | Action |
|------|---------|----------|--------|
| `agent/cancellation.ts` | CancellationError, CancellationToken | Deleted | Move CancellationError to deadline.ts as DeadlineError kind cancelled, delete file |
| `agent/timeout.ts` | TimeoutError, withTimeout race | Deleted, replaced by deadline.ts | Delete file, replace with deadline.ts with abort-and-await |
| `providers/model-call.ts` | Imports from agent/timeout, uses withTimeout | Imports from deadline.ts, uses runWithDeadline | Change import, replace withTimeout with runWithDeadline, handle partialText and DeadlineError mapping |
| `agent/tools/executor.ts` | Uses withTimeout | Uses runWithDeadline | Change import, replace, handle shutdown_timeout |
| `agent/approval-registry.ts` | Uses setTimeout directly | Uses Deadline for expiry | Replace setTimeout with createDeadline, settle(expired) on deadline abort, dispose on settlement |
| `agent/loop.ts` | Creates AbortController per turn, passes signal | Creates Deadline root? Or keep AbortController for turn, but child operations use Deadline | Keep turn AbortController as parent, child operations use runWithDeadline with parentSignal = turn signal |
| `test/fakes/fake-provider.ts` | ignoreAbort hangs forever | Keep both modes: ignoreAbortForever and ignoreAbortThenResolve(delay) | Add second mode for abort-and-await tests |

**Do not implement fold yet** — Phase 2 is interface and design, Phase 3 will be ownership and lifecycle, Phase 4 integration and tests.

---

## 9. Next steps

**Phase 3:** Ownership and lifecycle — per turn, model call, tool call, approval wait; propagation through nested operations without replacing parent signals incorrectly; repeated cancellation; behavior when providers ignore abort.

Please confirm go for Phase 3, or request changes to Phase 2.

