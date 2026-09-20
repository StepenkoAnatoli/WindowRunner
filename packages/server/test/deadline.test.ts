import { strict as assert } from "node:assert";
import test from "node:test";
import { createDeadline, runWithDeadline, DeadlineError } from "../src/deadline.js";
import { FakeClock } from "./fakes/fake-clock.js";
import { ApprovalRegistry } from "../src/agent/approval-registry.js";

function assertNoLeaks(clock: FakeClock, deadline?: any) {
  assert.equal((clock as any).timers.length, 0, "no active deadline timers");
  if (deadline) {
    assert.equal(deadline._timer, undefined, "deadline timer cleared");
    assert.equal(deadline._disposed, true, "deadline disposed");
  }
}

// Helper to advance FakeClock while a promise is pending, yielding to microtasks
async function advanceUntilSettled<T>(clock: FakeClock, promise: Promise<T>, opts: { step?: number; maxSteps?: number } = {}): Promise<T> {
  const step = opts.step ?? 5;
  const maxSteps = opts.maxSteps ?? 200;
  let settled = false;
  let result: T | undefined;
  let error: any;

  promise.then(
    (r) => {
      settled = true;
      result = r;
    },
    (e) => {
      settled = true;
      error = e;
    }
  );

  for (let i = 0; i < maxSteps && !settled; i++) {
    clock.advance(step);
    // Yield to allow timer callbacks to run and promises to settle
    await new Promise((r) => setImmediate(r));
  }

  if (!settled) {
    throw new Error(`Promise not settled after ${maxSteps} clock steps, timers left: ${(clock as any).timers.length}`);
  }
  if (error) throw error;
  return result as T;
}

test("Scenario 1: Parent cancellation during model streaming", async () => {
  const clock = new FakeClock();
  const turnController = new AbortController();

  const operation = async (signal: AbortSignal) => {
    await new Promise<void>((_, reject) => {
      signal.addEventListener("abort", () => reject((signal as any).reason ?? new Error("aborted")), { once: true });
    });
  };

  const deadlinePromise = runWithDeadline(operation, {
    parentSignal: turnController.signal,
    timeoutMs: 10000,
    kind: "model",
    clock,
    shutdownGraceMs: 100,
  });

  await new Promise((r) => setImmediate(r));
  turnController.abort(new DeadlineError("cancelled", "model", "Stop pressed"));

  try {
    await deadlinePromise;
    assert.fail("should have thrown cancelled");
  } catch (err: any) {
    assert.equal(err.kind, "cancelled");
  }

  assertNoLeaks(clock);
});

test("Scenario 2: Parent cancellation during tool execution", async () => {
  const clock = new FakeClock();
  const turnController = new AbortController();

  const operation = async (signal: AbortSignal) => {
    await new Promise<void>((_, reject) => {
      signal.addEventListener("abort", () => reject(new DeadlineError("cancelled", "tool", "tool cancelled")), { once: true });
    });
  };

  const deadlinePromise = runWithDeadline(operation, {
    parentSignal: turnController.signal,
    timeoutMs: 10000,
    kind: "tool",
    clock,
    shutdownGraceMs: 100,
  });

  await new Promise((r) => setImmediate(r));
  turnController.abort(new DeadlineError("cancelled", "tool", "Stop pressed"));

  try {
    await deadlinePromise;
    assert.fail();
  } catch (err: any) {
    assert.equal(err.kind, "cancelled");
  }

  assertNoLeaks(clock);
});

test("Scenario 3: Parent cancellation during approval wait", async () => {
  const clock = new FakeClock();
  const turnController = new AbortController();
  const approvals = new ApprovalRegistry({ clock, now: () => clock.now() });

  const req = approvals.request({
    sessionId: "s1",
    turnId: "t1",
    providerCallId: "c1",
    toolName: "run_terminal",
    input: {},
    reason: "needs",
    timeoutMs: 10000,
    parentSignal: turnController.signal,
  });

  const waitPromise = approvals.wait(req.requestId);

  turnController.signal.addEventListener("abort", () => approvals.cancelTurn("t1"));
  turnController.abort(new DeadlineError("cancelled", "approval", "Stop pressed"));

  const resolution = await waitPromise;
  assert.equal(resolution.kind, "cancelled");

  assert.equal((approvals as any)._entries.size, 0);
  assert.equal((approvals as any)._byTurn.size, 0);
  assertNoLeaks(clock);
});

test("Scenario 4: Child timeout while sibling remains active", async () => {
  const clock = new FakeClock();
  const turnController = new AbortController();

  const tool1Promise = runWithDeadline(
    async (signal) => {
      await new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () => reject((signal as any).reason), { once: true });
      });
    },
    { parentSignal: turnController.signal, timeoutMs: 10, kind: "tool", clock, shutdownGraceMs: 50 }
  );

  let tool2Resolved = false;
  const tool2Promise = runWithDeadline(
    async (signal) => {
      await new Promise<void>((resolve) => {
        const timer = clock.setTimeout(() => {
          tool2Resolved = true;
          resolve();
        }, 20);
        signal.addEventListener("abort", () => {
          clock.clearTimeout(timer);
        });
      });
      return "tool2 ok";
    },
    { parentSignal: turnController.signal, timeoutMs: 1000, kind: "tool", clock, shutdownGraceMs: 50 }
  );

  try {
    await advanceUntilSettled(clock, tool1Promise);
    assert.fail();
  } catch (err: any) {
    assert.equal(err.kind, "deadline_expired");
  }

  const tool2Result = await advanceUntilSettled(clock, tool2Promise);
  assert.equal(tool2Result, "tool2 ok");
  assert.equal(tool2Resolved, true);

  assertNoLeaks(clock);
});

test("Scenario 5: Repeated parent abort and repeated child cancellation — idempotent", async () => {
  const clock = new FakeClock();
  const turnController = new AbortController();

  const operation = async (signal: AbortSignal) => {
    await new Promise<void>((_, reject) => {
      signal.addEventListener("abort", () => reject((signal as any).reason), { once: true });
    });
  };

  const deadlinePromise = runWithDeadline(operation, {
    parentSignal: turnController.signal,
    timeoutMs: 10000,
    kind: "model",
    clock,
    shutdownGraceMs: 50,
  });

  turnController.abort(new DeadlineError("cancelled", "model", "first cancel"));
  turnController.abort(new DeadlineError("cancelled", "model", "second cancel"));

  try {
    await deadlinePromise;
    assert.fail();
  } catch (err: any) {
    assert.equal(err.kind, "cancelled");
  }

  const deadline = createDeadline(turnController.signal, 10000, { kind: "model", clock });
  deadline.cancel(new DeadlineError("cancelled", "model", "first"));
  deadline.cancel(new DeadlineError("cancelled", "model", "second"));
  deadline.dispose();
  deadline.dispose();

  assertNoLeaks(clock, deadline as any);
});

test("Scenario 6: Timeout and cancellation at same clock tick — exactly one terminal outcome", async () => {
  const clock = new FakeClock();
  const turnController = new AbortController();

  const operation = async (signal: AbortSignal) => {
    await new Promise<void>((_, reject) => {
      signal.addEventListener("abort", () => reject((signal as any).reason), { once: true });
    });
  };

  const deadlinePromise = runWithDeadline(operation, {
    parentSignal: turnController.signal,
    timeoutMs: 100,
    kind: "model",
    clock,
    shutdownGraceMs: 50,
  });

  // Advance to trigger timeout, then abort at same tick
  clock.advance(100);
  turnController.abort(new DeadlineError("cancelled", "model", "cancelled at same tick"));

  try {
    await advanceUntilSettled(clock, deadlinePromise);
    assert.fail();
  } catch (err: any) {
    assert.ok(err.kind === "deadline_expired" || err.kind === "cancelled");
  }

  assertNoLeaks(clock);
});

test("Scenario 7: Provider resolves during shutdown grace period — confirmed stopped", async () => {
  const clock = new FakeClock();

  const operation = async (signal: AbortSignal) => {
    await new Promise<void>((_, reject) => {
      signal.addEventListener("abort", () => {
        clock.setTimeout(() => reject((signal as any).reason), 20);
      }, { once: true });
    });
  };

  const deadlinePromise = runWithDeadline(operation, {
    parentSignal: new AbortController().signal,
    timeoutMs: 10,
    kind: "model",
    clock,
    shutdownGraceMs: 100,
  });

  try {
    await advanceUntilSettled(clock, deadlinePromise);
    assert.fail();
  } catch (err: any) {
    assert.equal(err.kind, "deadline_expired");
  }

  assertNoLeaks(clock);
});

test("Scenario 8: Provider never resolves within grace — shutdown_timeout, then eventual cleanup", async () => {
  const clock = new FakeClock();

  let operationResolved = false;
  const operation = async (signal: AbortSignal) => {
    await new Promise<void>((resolve) => {
      clock.setTimeout(() => {
        operationResolved = true;
        resolve();
      }, 100);
    });
    return "late";
  };

  const deadlinePromise = runWithDeadline(operation, {
    parentSignal: new AbortController().signal,
    timeoutMs: 10,
    kind: "tool",
    clock,
    shutdownGraceMs: 50,
  });

  try {
    await advanceUntilSettled(clock, deadlinePromise);
    assert.fail();
  } catch (err: any) {
    assert.equal(err.kind, "shutdown_timeout");
    assert.match(err.message, /not confirmed stopped/);
  }

  // Advance to let operation resolve so no pending promise left
  clock.advance(50);
  await new Promise((r) => setImmediate(r));
  assert.equal(operationResolved, true);
  assert.equal((clock as any).timers.length, 0);
});

test("Scenario 9: Disposal before expiry and after settlement — no leaks", async () => {
  const clock = new FakeClock();
  const parentController = new AbortController();

  const deadline1 = createDeadline(parentController.signal, 1000, { kind: "model", clock });
  assert.equal((clock as any).timers.length, 1);
  deadline1.dispose();
  assert.equal((clock as any).timers.length, 0);
  assert.equal((deadline1 as any)._disposed, true);
  deadline1.dispose();

  const operation = async (signal: AbortSignal) => "ok";
  const result = await runWithDeadline(operation, {
    parentSignal: parentController.signal,
    timeoutMs: 1000,
    kind: "model",
    clock,
  });
  assert.equal(result, "ok");
  assert.equal((clock as any).timers.length, 0);
});

test("Scenario 10: Nested child attempting to outlive parent — child never outlives parent", async () => {
  const clock = new FakeClock();
  const turnController = new AbortController();

  const parentDeadline = createDeadline(turnController.signal, 100, { kind: "model", clock });
  const childDeadline = createDeadline(parentDeadline.signal, 1000, { kind: "tool", clock });

  assert.ok(childDeadline.expiresAt <= parentDeadline.expiresAt + 5);

  turnController.abort();
  assert.equal(childDeadline.signal.aborted, true);
  assert.equal(parentDeadline.signal.aborted, true);

  parentDeadline.dispose();
  childDeadline.dispose();

  assert.equal((clock as any).timers.length, 0);
});

test("Integration: model timeout vs tool timeout vs approval expiry — sibling isolation", async () => {
  const clock = new FakeClock();
  const turnController = new AbortController();
  const approvals = new ApprovalRegistry({ clock, now: () => clock.now() });

  const modelPromise = runWithDeadline(
    async (signal) => {
      await new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () => reject((signal as any).reason), { once: true });
      });
    },
    { parentSignal: turnController.signal, timeoutMs: 10, kind: "model", clock, shutdownGraceMs: 10 }
  );

  let toolDone = false;
  const toolPromise = runWithDeadline(
    async (signal) => {
      await new Promise<void>((resolve) => {
        clock.setTimeout(() => {
          toolDone = true;
          resolve();
        }, 20);
      });
      return "tool ok";
    },
    { parentSignal: turnController.signal, timeoutMs: 1000, kind: "tool", clock, shutdownGraceMs: 10 }
  );

  const approvalReq = approvals.request({
    sessionId: "s1",
    turnId: "t1",
    providerCallId: "c1",
    toolName: "run_terminal",
    input: {},
    reason: "needs",
    timeoutMs: 1000,
    parentSignal: turnController.signal,
  });

  try {
    await advanceUntilSettled(clock, modelPromise);
    assert.fail();
  } catch (err: any) {
    assert.equal(err.kind, "deadline_expired");
    assert.equal(err.operationKind, "model");
  }

  assert.equal(approvals.has(approvalReq.requestId), true);
  assert.equal((approvals as any)._entries.size, 1);

  const toolResult = await advanceUntilSettled(clock, toolPromise);
  assert.equal(toolResult, "tool ok");
  assert.equal(toolDone, true);

  approvals.cancelTurn("t1");
  assert.equal((approvals as any)._entries.size, 0);
  assert.equal((clock as any).timers.length, 0);
});

test("Integration: abort-ignoring provider — shutdown_timeout distinct", async () => {
  const clock = new FakeClock();

  let opResolved = false;
  const operation = async (signal: AbortSignal) => {
    await new Promise<void>((resolve) => {
      clock.setTimeout(() => {
        opResolved = true;
        resolve();
      }, 100);
    });
    return "late";
  };

  const deadlinePromise = runWithDeadline(operation, {
    parentSignal: new AbortController().signal,
    timeoutMs: 10,
    kind: "model",
    clock,
    shutdownGraceMs: 30,
  });

  try {
    await advanceUntilSettled(clock, deadlinePromise);
    assert.fail();
  } catch (err: any) {
    assert.equal(err.kind, "shutdown_timeout");
  }

  clock.advance(70);
  await new Promise((r) => setImmediate(r));
  assert.equal(opResolved, true);
  assert.equal((clock as any).timers.length, 0);
});
