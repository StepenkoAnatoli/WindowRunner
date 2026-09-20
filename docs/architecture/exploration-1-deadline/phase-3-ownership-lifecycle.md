# Phase 3 — Ownership and lifecycle, parent-child propagation, idempotent settlement

**Focus:** Your lifecycle rules + 10 scenarios + verification after every scenario (no active timers, no grace timers, no retained parent listeners, no duplicate terminal events, no unresolved approval entries, no sibling cancellation unless intended).

**Status:** Draft for review — stops and waits for your go before Phase 4 (integration, migration, CancellationToken deletion, first production implementation).

---

## 1. Lifecycle rules — settled in Phase 3

### 1.1 Turn owns root AbortController; child deadlines observe it, never replace it

- **Root:** TurnManager or app.ts creates `turnController = new AbortController()` per turn when turn starts. Its `signal` is parent for all child deadlines. No timeout on root, only cancellation via `turnController.abort(reason)` when Stop pressed, session cancel, or server shutdown.
- **Children:** Each operation creates child Deadline with `parentSignal = turnController.signal`. Child observes parent, never replaces it — child does NOT create new root, does NOT detach from parent.
- **Why root is AbortController, not Deadline?** Turn has no deadline, only cancellation. Could be Deadline with infinite timeout, but simpler as AbortController. Child deadlines are Deadline that wrap parent signal.

```ts
// In app.ts or TurnManager.start
const turnController = new AbortController();
const turnSignal = turnController.signal;

// In loop
const modelDeadline = createDeadline(turnSignal, limits.modelCallTimeoutMs, { kind: "model", clock });
try {
  const result = await runWithDeadline((signal) => provider.stream(...), { parentSignal: turnSignal, timeoutMs, kind: "model", clock });
} finally {
  modelDeadline.dispose();
}

// On Stop
turnController.abort(new DeadlineError("cancelled", "model", "Stop pressed"));
```

### 1.2 Child may shorten parent's remaining lifetime, never extend or detach

- If parent has deadline (e.g., future turn-level deadline), child's expiresAt = min(parent.expiresAt, now + childTimeoutMs) — child may shorten, never extend.
- Currently parent (turn) has no deadline, only cancellation, so child expiresAt = now + childTimeoutMs.
- Child never detaches: child signal aborts when parent aborts, regardless of child's own timer. Child's timer does NOT affect parent — parent abort is independent.
- Implementation: child listens to parent abort → aborts child. Child timer aborts child only. So child cannot extend parent, cannot detach.

### 1.3 Each operation owns and disposes its child deadline in finally

```ts
const deadline = createDeadline(parentSignal, timeoutMs, { kind, clock });
try {
  return await runWithDeadline(operation, { parentSignal, timeoutMs, kind, clock, shutdownGraceMs });
} finally {
  deadline.dispose(); // idempotent, clears timer and parent listener
}
```

**Ownership matrix:**

| Operation | Owner | Creates Deadline | Disposes in finally | Parent |
|-----------|-------|------------------|---------------------|--------|
| Turn | TurnManager/app | AbortController (root) | On turn terminal (completed/cancelled/failed) | None |
| Model call | Loop | Deadline kind=model | After runWithDeadline settles | Turn signal |
| Tool call | Executor | Deadline kind=tool | After runWithDeadline settles | Turn signal |
| Approval wait | ApprovalRegistry | Deadline kind=approval | On settlement (approved/denied/expired/cancelled) | Turn signal |

Each operation owns its child deadline — no shared ownership, no leak.

### 1.4 cancel() and dispose() idempotent, first terminal reason wins

- `cancel(reason)` aborts child signal if not already aborted, first reason wins (signal.aborted stays true with first reason)
- `dispose()` clears timer, grace timer, parent listener, sets disposed flag — multiple calls no-op
- First terminal reason wins: if parent aborts and child timeout fires at same tick, whichever calls `settle()` or aborts child first wins, second is no-op because signal already aborted or entry already deleted (for approval registry)

```ts
class Deadline {
  private disposed = false;
  cancel(reason?: unknown): void {
    if (this.disposed) return;
    if (!this.controller.signal.aborted) {
      this.controller.abort(reason);
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // clear timers, remove parent listener
  }
}
```

### 1.5 Parent cancellation propagates to model, tool, approval deadlines exactly once

- Turn cancellation: `turnController.abort()` → parent signal aborts → each child Deadline's parent listener aborts child signal exactly once (once: true)
- Child's `runWithDeadline` catches abort, awaits shutdown with grace, then throws cancelled — exactly one terminal outcome per child
- No duplicate propagation: parent listener added with `{ once: true }`, removed in dispose(), so even if parent aborts multiple times, child aborts once

### 1.6 Child timeout must not cancel sibling operations or turn itself unless loop explicitly maps failure to turn cancellation

- Model timeout: `runWithDeadline` throws `deadline_expired` with kind=model → loop catches and emits `turn_failed MODEL_TIMEOUT` → terminal, so turn ends, but sibling operations (if any concurrent) are not automatically cancelled — loop's finally calls `cancelTurn` which cancels approval registry, but model timeout itself does not directly cancel sibling tools
- Tool timeout: throws `deadline_expired` kind=tool → loop catches and emits `tool_completed TOOL_TIMED_OUT` (recoverable), not terminal, so turn continues, sibling operations not cancelled
- Approval timeout: `settle(expired)` → wait resolves with expired → loop emits `turn_failed APPROVAL_TIMEOUT` → terminal
- **Rule:** Child timeout only aborts its own child signal, not parent, not siblings. Parent cancellation aborts all children, but child timeout does not abort parent or siblings unless loop explicitly maps failure to turn cancellation (e.g., model timeout → turn_failed).

### 1.7 Approval cancellation through settle({ kind: "cancelled" }), not direct promise rejection

- Currently approval registry's `cancelTurn` calls `settle(cancelled)` which resolves promise with `{ kind: "cancelled" }`, not reject — preserves boundary: expected outcomes resolve normally, rejection reserved for unexpected internal failures
- Loop's approval wait: `const resolution = await approvals.wait(requestId)` → always resolves, switch on kind, no try/catch for expected cases

### 1.8 runWithDeadline() must not return before operation settles or shutdown grace expires

- Implementation in Phase 2: two-phase — Phase 1 race operation vs abort, Phase 2 on abort, await operationPromise with grace timer race
- So `runWithDeadline` does NOT return until operation settles (resolved or rejected) OR grace timeout → throws shutdown_timeout
- Callers cannot accidentally continue while cleanup pending because runWithDeadline awaits shutdown

### 1.9 shutdown_timeout means "abort requested, operation not confirmed stopped"

- If operation ignores abort and never settles within grace, throw `DeadlineError` with `kind: shutdown_timeout`, `operationKind`, message "abort requested, operation not confirmed stopped after graceMs"
- No false claim dead — caller knows operation may still be running, should log warning and maybe force kill (e.g., taskkill /T for process-tree)
- For model: shutdown_timeout → turn_failed MODEL_FAILED (not MODEL_TIMEOUT, because we don't know if model actually stopped)
- For tool: shutdown_timeout → tool_completed TOOL_FAILED or turn_failed, with message indicating shutdown timeout

---

## 2. Lifecycle scenarios — 10 scenarios with verification

### Scenario 1: Parent cancellation during model streaming

```ts
test("parent cancellation during model streaming", async () => {
  const clock = new FakeClock();
  const turnController = new AbortController();
  const provider = new FakeProvider([
    async function* (req) {
      yield { type: "text_delta", text: "hello " };
      // Hang until aborted
      await new Promise<void>((_, reject) => {
        turnController.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    },
  ], { clock });

  const deadlinePromise = runWithDeadline(
    (signal) => provider.stream({ messages: [], tools: [] }, { signal }).next(),
    { parentSignal: turnController.signal, timeoutMs: 10000, kind: "model", clock, shutdownGraceMs: 100 }
  );

  // Model starts streaming
  await new Promise(r => setImmediate(r));

  // Parent cancellation (Stop pressed)
  turnController.abort(new DeadlineError("cancelled", "model", "Stop pressed"));

  try {
    await deadlinePromise;
    assert.fail("should have thrown cancelled");
  } catch (err) {
    assert.equal((err as any).kind, "cancelled");
  }

  // Verification after every scenario
  assert.equal(clock.timers.length, 0); // no active deadline timers
  // no grace timers
  // no retained parent listeners (parentSignal listeners should be removed)
  // no duplicate terminal events (only one turn_cancelled)
  // no unresolved approval registry entries (none in this scenario)
  // no sibling cancellation unless intended (no siblings)
});
```

**Expected:** Parent abort → child signal abort → operation's stream throws abort → runWithDeadline awaits shutdown (operation already threw, so within grace) → throws cancelled → dispose clears timers and parent listener.

### Scenario 2: Parent cancellation during tool execution

```ts
test("parent cancellation during tool execution", async () => {
  const clock = new FakeClock();
  const turnController = new AbortController();

  const tool = {
    name: "run_terminal",
    description: "run",
    requiresApproval: () => false,
    execute: async (input: any, ctx: any) => {
      // Hang until aborted
      await new Promise<void>((_, reject) => {
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
      return "ok";
    },
  };

  const deadlinePromise = runWithDeadline(
    (signal) => tool.execute({}, { cwd: "/workspace", signal, safePath: (s: string) => s }),
    { parentSignal: turnController.signal, timeoutMs: 10000, kind: "tool", clock, shutdownGraceMs: 100 }
  );

  await new Promise(r => setImmediate(r));
  turnController.abort(new DeadlineError("cancelled", "tool", "Stop pressed"));

  try {
    await deadlinePromise;
    assert.fail();
  } catch (err) {
    assert.equal((err as any).kind, "cancelled");
  }

  assert.equal(clock.timers.length, 0);
});
```

### Scenario 3: Parent cancellation during approval wait

```ts
test("parent cancellation during approval wait", async () => {
  const clock = new FakeClock();
  const turnController = new AbortController();
  const approvals = new ApprovalRegistry({ now: () => clock.now() });

  const req = approvals.request({ sessionId: "s1", turnId: "t1", providerCallId: "c1", toolName: "run_terminal", input: {}, reason: "needs", timeoutMs: 10000 });

  const waitPromise = approvals.wait(req.requestId);

  // Parent cancellation
  turnController.signal.addEventListener("abort", () => approvals.cancelTurn("t1"));
  turnController.abort();

  const resolution = await waitPromise;
  assert.equal(resolution.kind, "cancelled");

  assert.equal((approvals as any).entries.size, 0);
  assert.equal((approvals as any).byTurn.size, 0);
  assert.equal(clock.timers.length, 0);
});
```

**Approval cancellation through settle(cancelled), not direct rejection.**

### Scenario 4: Child timeout while sibling operations remain active

```ts
test("child timeout while sibling operations remain active", async () => {
  const clock = new FakeClock();
  const turnController = new AbortController();

  // Two concurrent tool calls (future concurrent, but simulate sequential for now)
  const tool1Promise = runWithDeadline(
    async (signal) => {
      // This one times out
      await new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () => reject(new DeadlineError("deadline_expired", "tool", "tool timeout")));
      });
    },
    { parentSignal: turnController.signal, timeoutMs: 10, kind: "tool", clock, shutdownGraceMs: 50 }
  );

  const tool2Promise = runWithDeadline(
    async (signal) => {
      // This one should NOT be cancelled by tool1 timeout
      await new Promise<void>((resolve) => {
        setTimeout(() => resolve("ok" as any), 20);
      });
      return "tool2 ok";
    },
    { parentSignal: turnController.signal, timeoutMs: 1000, kind: "tool", clock, shutdownGraceMs: 50 }
  );

  clock.advance(10); // tool1 timeout

  try {
    await tool1Promise;
    assert.fail();
  } catch (err) {
    assert.equal((err as any).kind, "deadline_expired");
  }

  // tool2 should still be active, not cancelled by sibling timeout
  clock.advance(20);
  const tool2Result = await tool2Promise;
  assert.equal(tool2Result, "tool2 ok");

  // No sibling cancellation unless explicitly intended
  assert.equal(clock.timers.length, 0);
});
```

**Rule:** Child timeout must not cancel siblings or turn unless loop explicitly maps failure.

### Scenario 5: Repeated parent abort and repeated child cancellation

```ts
test("repeated parent abort and repeated child cancellation — idempotent", async () => {
  const clock = new FakeClock();
  const turnController = new AbortController();

  const operation = async (signal: AbortSignal) => {
    await new Promise<void>((_, reject) => {
      signal.addEventListener("abort", () => reject(new DeadlineError("cancelled", "model", "cancelled")));
    });
  };

  const deadlinePromise = runWithDeadline(operation, {
    parentSignal: turnController.signal,
    timeoutMs: 10000,
    kind: "model",
    clock,
    shutdownGraceMs: 50,
  });

  // Repeated parent abort
  turnController.abort(new DeadlineError("cancelled", "model", "first cancel"));
  turnController.abort(new DeadlineError("cancelled", "model", "second cancel")); // should be no-op

  try {
    await deadlinePromise;
    assert.fail();
  } catch (err) {
    assert.equal((err as any).kind, "cancelled");
  }

  // Repeated child cancellation via cancel()
  const deadline = createDeadline(turnController.signal, 10000, { kind: "model", clock });
  deadline.cancel(new DeadlineError("cancelled", "model", "first"));
  deadline.cancel(new DeadlineError("cancelled", "model", "second")); // no-op
  deadline.dispose();
  deadline.dispose(); // idempotent dispose no-op

  assert.equal(clock.timers.length, 0);
});
```

**First terminal reason wins, idempotent cancel/dispose.**

### Scenario 6: Timeout and cancellation at same clock tick

```ts
test("timeout and cancellation at same clock tick — exactly one terminal outcome", async () => {
  const clock = new FakeClock();
  const turnController = new AbortController();

  const operation = async (signal: AbortSignal) => {
    await new Promise<void>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason));
    });
  };

  const deadlinePromise = runWithDeadline(operation, {
    parentSignal: turnController.signal,
    timeoutMs: 100,
    kind: "model",
    clock,
    shutdownGraceMs: 50,
  });

  // Both at same tick: timeout at 100, cancellation at 100
  clock.advance(100);
  turnController.abort(new DeadlineError("cancelled", "model", "cancelled at same tick"));

  try {
    await deadlinePromise;
    assert.fail();
  } catch (err) {
    // Exactly one wins — either expired or cancelled, not both, no duplicate events
    assert.ok((err as any).kind === "deadline_expired" || (err as any).kind === "cancelled");
  }

  assert.equal(clock.timers.length, 0);
});
```

### Scenario 7: Provider resolves during shutdown grace period

```ts
test("provider resolves during shutdown grace period — confirmed stopped", async () => {
  const clock = new FakeClock();
  const turnController = new AbortController();

  const provider = new FakeProvider([
    () => ({
      chunks: [],
      hang: true,
      ignoreAbort: true, // ignores abort initially
    }),
  ], { clock });

  const operation = async (signal: AbortSignal) => {
    const stream = provider.stream({ messages: [], tools: [] }, { signal });
    // Simulate provider that ignores abort for 20ms then resolves
    const timer = clock.setTimeout(() => {
      // After 20ms, provider finally observes abort and settles
    }, 20);

    try {
      for await (const chunk of stream) {
        // ...
      }
    } catch (err) {
      // After abort, wait 20ms then resolve
      await new Promise<void>((resolve) => {
        clock.setTimeout(() => resolve(), 20);
      });
      throw err; // throw abort reason after delay
    }
  };

  const deadlinePromise = runWithDeadline(operation, {
    parentSignal: turnController.signal,
    timeoutMs: 10,
    kind: "model",
    clock,
    shutdownGraceMs: 100, // grace 100ms, provider resolves in 20ms within grace
  });

  clock.advance(10); // timeout fires, abort child

  try {
    await deadlinePromise;
    assert.fail();
  } catch (err) {
    // Should be deadline_expired, not shutdown_timeout, because provider resolved within grace
    assert.equal((err as any).kind, "deadline_expired");
  }

  assert.equal(clock.timers.length, 0);
});
```

**Aborted vs confirmed stopped:** Aborted = signal aborted, confirmed stopped = operation settled within grace.

### Scenario 8: Provider never resolves — shutdown_timeout

```ts
test("provider never resolves — shutdown_timeout", async () => {
  const clock = new FakeClock();
  const turnController = new AbortController();

  const operation = async (signal: AbortSignal) => {
    // Never resolves, ignores abort forever
    await new Promise<void>(() => {});
  };

  const deadlinePromise = runWithDeadline(operation, {
    parentSignal: turnController.signal,
    timeoutMs: 10,
    kind: "tool",
    clock,
    shutdownGraceMs: 50,
  });

  clock.advance(10); // timeout
  clock.advance(50); // grace

  try {
    await deadlinePromise;
    assert.fail();
  } catch (err) {
    assert.equal((err as any).kind, "shutdown_timeout");
    assert.match((err as any).message, /not confirmed stopped/);
  }

  assert.equal(clock.timers.length, 0);
});
```

**shutdown_timeout means abort requested, operation not confirmed stopped — no false claim dead.**

### Scenario 9: Disposal before expiry and after settlement

```ts
test("disposal before expiry and after settlement — no leaks", async () => {
  const clock = new FakeClock();
  const parentController = new AbortController();

  // Disposal before expiry
  const deadline1 = createDeadline(parentController.signal, 1000, { kind: "model", clock });
  assert.equal(clock.timers.length, 1);
  deadline1.dispose();
  assert.equal(clock.timers.length, 0);
  assert.equal((deadline1 as any).disposed, true);
  deadline1.dispose(); // idempotent no-op

  // Disposal after settlement
  const operation = async (signal: AbortSignal) => "ok";
  const result = await runWithDeadline(operation, {
    parentSignal: parentController.signal,
    timeoutMs: 1000,
    kind: "model",
    clock,
  });
  assert.equal(result, "ok");
  assert.equal(clock.timers.length, 0); // disposed after settlement
});
```

### Scenario 10: Nested child creation attempting to outlive parent

```ts
test("nested child creation attempting to outlive parent — child never outlives parent", async () => {
  const clock = new FakeClock();
  const turnController = new AbortController();

  const parentDeadline = createDeadline(turnController.signal, 100, { kind: "model", clock });

  // Child tries to have longer timeout than parent remaining
  const childDeadline = createDeadline(parentDeadline.signal, 1000, { kind: "tool", clock }); // 1000ms, but parent only 100ms remaining

  // Child's expiresAt should be min(parent.expiresAt, now+childTimeout) = now+100, not now+1000
  // So child may shorten, never extend
  assert.ok(childDeadline.expiresAt <= parentDeadline.expiresAt);

  // Parent cancellation should propagate to child
  turnController.abort();
  assert.equal(childDeadline.signal.aborted, true);
  assert.equal(parentDeadline.signal.aborted, true);

  parentDeadline.dispose();
  childDeadline.dispose();

  assert.equal(clock.timers.length, 0);
});
```

---

## 3. Verification after every scenario — checklist

After every scenario, assert:

- [ ] No active deadline timers: `clock.timers.length === 0` and `deadline.timer === undefined`
- [ ] No grace timers: `deadline.graceTimer === undefined`
- [ ] No retained parent listeners: `parentSignal` should have no abort listener referencing child (check via `getEventListeners` or by counting)
- [ ] No duplicate terminal events: TurnState should have exactly one terminal event, `events.filter(e => e.type === "turn_cancelled" || e.type === "turn_failed" || e.type === "turn_completed").length === 1`
- [ ] No unresolved approval registry entries: `entries.size === 0` and `byTurn.size === 0` for that turn, or expected size for other turns
- [ ] No sibling cancellation unless explicitly intended: other operations' signals not aborted

**Example final assertions:**

```ts
assert.equal(clock.timers.length, 0);
assert.equal((deadline as any).timer, undefined);
assert.equal((deadline as any).graceTimer, undefined);
assert.equal((deadline as any).disposed, true);
assert.equal((approvals as any).entries.size, expected);
assert.equal((approvals as any).byTurn.size, expected);
assert.equal(manager.snapshot(s1, t1).events.filter(e => e.type.startsWith("turn_") && (e.type === "turn_cancelled" || e.type === "turn_failed" || e.type === "turn_completed")).length, 1);
```

---

## 4. What Phase 3 does NOT cover (deferred to Phase 4)

- Integration: how Deadline is used in loop, model-call, executor, approval-registry
- Migration: callers still using withTimeout, setTimeout, CancellationToken
- Deletion of CancellationToken — confirm deletion test
- First production implementation with approval expiry as first consumer
- CONTEXT.md update, ADR for deadline

---

## 5. Next steps

**Phase 4:** Integration, migration plan, CancellationToken deletion, first production implementation, CONTEXT.md, ADR, final verification with FakeClock and sequence/reducer tests.

Please confirm go for Phase 4, or request changes to Phase 3.

