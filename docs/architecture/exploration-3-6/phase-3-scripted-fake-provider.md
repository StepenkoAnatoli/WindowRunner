# Phase 3 — Scripted fake Provider with request recording

**Pair:** #3 + #6 — Phase 3 of 4
**Focus:** Your point 5 — a scripted-provider test for at least two model/tool steps, including exact requests sent to the provider. Builds on Phase 1 (reducer + seq) and Phase 2 (manager owns seq, atomic subscribe).
**Status:** Draft for review — stops and waits for your go before Phase 4 (integration, CONTEXT.md, ADR).

---

## 1. Current design (from plan)

**File:** `packages/server/test/fakes/fake-provider.ts`, `providers/types.ts`, `providers/model-call.ts`, `agent/loop.ts`, `test/agent/loop.test.ts`, `test/agent/reliability.integration.test.ts`

**What exists:**

```ts
// providers/types.ts (from plan)
interface LLMProvider {
  stream(request: LLMRequest, options: { signal: AbortSignal }): AsyncIterable<LLMChunk>
}
type LLMChunk = { type: "text_delta", text: string } | { type: "tool_call", call: { id, name, input } }

// fake-provider.ts (from plan)
class FakeProvider implements LLMProvider {
  constructor(chunks: LLMChunk[], opts?: { waitForAbort?: boolean })
  lastSignal?: AbortSignal
  stream(): AsyncIterable<LLMChunk>
}
```

**Problems (report C6):**
- **Flat list, not per step:** `new FakeProvider([tool_call c1, text "I recovered"])` for a 2-step turn (step1 → tool → result → step2 → text). Which chunks go to which `stream()` call? Unspecified. Either both arrive in step1 (then "I recovered" was generated before tool ran — test doesn't prove recovery) or fake has hidden per-call cursor not described.
- **No request recording:** No `requests[]`, so no test can assert "append every tool result to the next provider request" (plan l.674). Task 9 integration tests assert only `events.map(type)` and final status — a passing suite would not notice if tool result were never sent back.
- **Only 2 failure modes:** `waitForAbort` and "rejected stream" (prose). Missing: fail after partial text (P1-05: "partial-stream retries don't duplicate visible text"), tool_call with malformed input, unknown tool, stream that ignores abort (to prove deadline teardown), usage-only.
- **Wall-clock timing:** `setImmediate`, 5ms deadlines, real timers. `now?` injectable on runner but deadlines use real timers — flaky.
- **Deletion test on `runModelCall`:** Borderline shallow — only earns keep if it grows to "one bounded, retried model call with partial-output accounting" (P1-05 retry). Otherwise could be deleted into loop.

**What is right:** `LLMProvider` has 3 adapters (openai-compatible, anthropic, fake) = real seam. Keep.

---

## 2. Proposed FakeProvider — scripted by step, records requests

### 2.1 Core idea

Provider is scripted **per model call**, not per chunk. Each step is a function of the request it receives and returns behavior. The fake records every request it was sent, so tests can assert recovery.

### 2.2 Interface

```ts
// providers/types.ts — clarified
interface LLMRequest {
  messages: Array<{ role: "user"|"assistant"|"tool"|"system", content: string, toolCallId?: string, toolName?: string }>;
  tools: Array<{ name: string, description: string }>; // derived from tool registry, not hand-listed
  // optional: for explicit tool results
  // toolResults are encoded as messages with role:"tool" — no separate field needed
}

type LLMChunk =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; call: { id: string; name: string; input: unknown } }
  | { type: "usage"; usage: TurnUsage };

type ProviderStepResult = {
  chunks?: LLMChunk[];          // what to emit
  error?: Error;                // throw after chunks (or immediately)
  hang?: boolean;               // never complete, wait for abort
  ignoreAbort?: boolean;        // even if signal aborts, keep hanging
  delayMs?: number;             // fake clock delay between chunks
};

type ProviderStep = (request: LLMRequest) => ProviderStepResult | Promise<ProviderStepResult> | AsyncIterable<LLMChunk>;

interface FakeProviderOpts {
  clock?: FakeClock; // for deterministic timing
}

class FakeProvider implements LLMProvider {
  public requests: LLMRequest[] = []; // recorded, in order
  public lastSignal?: AbortSignal;
  public lastSignals: AbortSignal[] = []; // per step

  private steps: ProviderStep[];
  private stepIndex = 0;

  constructor(steps: ProviderStep[], opts?: FakeProviderOpts) {}

  stream(request: LLMRequest, options: { signal: AbortSignal }): AsyncIterable<LLMChunk>
}
```

**Key:** `requests[]` is the test surface. `steps` is the script.

### 2.3 FakeClock (for deadline testing, links to candidate #1)

```ts
class FakeClock {
  private nowMs = 0;
  private timers: Array<{ at: number, cb: () => void }> = [];

  now() { return this.nowMs; }
  advance(ms: number) { /* run timers <= now+ms */ }

  setTimeout(cb: () => void, ms: number) { /* register */ }
}
```

Provider and deadline module both use same clock — timeouts become deterministic, no `setTimeout` flakiness.

### 2.4 Step helpers — named failure scenarios

```ts
// helpers for readable tests
const Steps = {
  toolCall: (id: string, name: string, input: unknown): ProviderStep =>
    () => ({ chunks: [{ type: "tool_call", call: { id, name, input } }] }),

  text: (text: string): ProviderStep =>
    () => ({ chunks: [{ type: "text_delta", text }] }),

  failAfterPartialText: (partial: string, error: Error): ProviderStep =>
    () => ({ chunks: [{ type: "text_delta", text: partial }], error }),

  hang: (): ProviderStep =>
    () => ({ hang: true }),

  ignoreAbort: (): ProviderStep =>
    () => ({ hang: true, ignoreAbort: true }),

  malformedInput: (id: string, name: string, badInput: unknown): ProviderStep =>
    () => ({ chunks: [{ type: "tool_call", call: { id, name, input: badInput } }] }),

  unknownTool: (id: string, name: string): ProviderStep =>
    () => ({ chunks: [{ type: "tool_call", call: { id, name, input: {} } }] }),

  // assert on request, then return chunks
  assertThen: (assertFn: (req: LLMRequest) => void, next: ProviderStep): ProviderStep =>
    (req) => { assertFn(req); return next(req); },
};
```

---

## 3. Multi-step test with exact requests (your point 5)

### 3.1 The decisive test — tool failure recovery, proving result appended

This test is **unwritable** with the current flat-list fake, trivial with step-scripted + request recording:

```ts
import { strict as assert } from "node:assert";
import test from "node:test";
import { TurnRunner } from "../../src/agent/loop.js";
import { ApprovalRegistry } from "../../src/agent/approval-registry.js";
import { FakeProvider, Steps } from "../fakes/fake-provider.js";
import { InMemoryTurnLogStore } from "../../src/agent/turn-log-store.js";
import { TurnManager } from "../../src/agent/turn-manager.js";

test("tool failure is returned to model and next request contains actionable result", async () => {
  const store = new InMemoryTurnLogStore();
  const approvals = new ApprovalRegistry();

  // Script: step1 = model calls read_file missing, step2 = assert request contains TOOL_FAILED, then recover
  const provider = new FakeProvider([
    // Step 1: model requests read_file
    (req) => {
      assert.equal(req.messages.length, 1); // only user message
      assert.equal(req.messages[0].content, "read missing file");
      return {
        chunks: [{ type: "tool_call", call: { id: "c1", name: "read_file", input: { path: "missing.txt" } } }],
      };
    },
    // Step 2: should contain tool result with TOOL_FAILED, then model recovers
    (req) => {
      // THIS ASSERTION IS THE POINT — proves "append every tool result to next request"
      assert.equal(provider.requests.length, 2); // second call
      const toolMsg = req.messages.find(m => m.role === "tool" && m.toolCallId === "c1");
      assert.ok(toolMsg, "tool result must be appended to next request");
      assert.match(toolMsg!.content, /TOOL_FAILED|read the file again/);
      assert.equal(toolMsg!.toolName, "read_file");

      return {
        chunks: [{ type: "text_delta", text: "I recovered after seeing the error" }],
      };
    },
  ]);

  const events: any[] = [];
  const manager = new TurnManager({ provider, tools: new Map([[
    "read_file", {
      name: "read_file",
      description: "read a file",
      requiresApproval: () => false,
      execute: async () => { throw new Error("old_str was not found; read the file again"); }
    }
  ]]), approvals, store, emit: e => events.push(e) });

  const runner = new TurnRunner({ provider, tools: manager.tools, approvals, emit: e => events.push(e), store });

  const result = await runner.run({
    sessionId: "s1", turnId: "t1", cwd: "/workspace/project",
    request: { messages: [{ role: "user", content: "read missing file" }], tools: [{ name: "read_file", description: "read a file" }] },
    limits: { maxSteps: 3, modelCallTimeoutMs: 1000, toolTimeoutMs: 1000, approvalTimeoutMs: 1000 },
    signal: new AbortController().signal,
  });

  assert.equal(result.status, "completed");
  assert.equal(provider.requests.length, 2);
  assert.deepEqual(events.map(e => e.type), ["turn_started", "tool_started", "tool_completed", "turn_completed"]);
});
```

**What this proves:**
- Tool result **is** appended to next request (via `provider.requests[1]`)
- Model **can** correct after failure
- Event sequence is `turn_started → tool_started → tool_completed → turn_completed` (no duplicate terminal)
- With Phase 1 reducer, `TurnState` after fold has `status: completed`, `seq: 4`

### 3.2 Two more decisive tests (deterministic failures)

**Partial text then failure — P1-05 "don't duplicate visible text":**

```ts
test("partial text then failure does not duplicate on retry — seq prevents duplicate", async () => {
  const provider = new FakeProvider([
    () => ({ chunks: [{ type: "text_delta", text: "hello " }], error: new Error("stream failed mid-way") }),
    (req) => {
      // second request should NOT contain "hello " again as new delta — it should continue or fail
      // With seq, UI has seen seq 2 = "hello ", so retry must not re-emit seq 2
      return { chunks: [{ type: "text_delta", text: "world" }] };
    },
  ]);

  // With reducer that tracks accumulated text and seq, duplicate seq is ignored
  // This test would fail with current flat-list fake — no way to simulate mid-stream failure
});
```

**Ignores abort — proves deadline teardown (links to candidate #1):**

```ts
test("provider that ignores abort is killed by deadline module", async () => {
  const clock = new FakeClock();
  const provider = new FakeProvider([
    () => ({ hang: true, ignoreAbort: true }), // never completes, ignores signal
  ], { clock });

  const controller = new AbortController();
  const runPromise = runner.run({ signal: controller.signal, /* ... */ limits: { modelCallTimeoutMs: 10 } });

  clock.advance(15); // trigger timeout

  const result = await runPromise;
  assert.equal(result.status, "failed");
  assert.equal(provider.lastSignal?.aborted, true);
  // With deadline module (candidate #1), we can also assert process tree killed, not just signal
});
```

**Unknown tool and malformed input — controlled errors:**

```ts
test("unknown tool becomes TOOL_FAILED result, not uncaught", async () => {
  const provider = new FakeProvider([
    Steps.unknownTool("c1", "nonexistent_tool"),
    (req) => {
      const toolMsg = req.messages.find(m => m.toolCallId === "c1");
      assert.match(toolMsg!.content, /UNKNOWN_TOOL/);
      return { chunks: [{ type: "text_delta", text: "I see unknown tool, will try other" }] };
    },
  ]);
  // loop should emit tool_completed with UNKNOWN_TOOL, not turn_failed
});
```

---

## 4. How this enables Phase 1 + 2

**With step-scripted + request recording:**

- **Phase 1 reducer tests:** Can test `reduceTurnState` pure, but also integration: does loop correctly append tool results? Only observable via `requests[]`.
- **Phase 2 replay tests:** Can simulate concurrent append during subscribe:
  ```ts
  test("replay race — event emitted during replay write is not lost", async () => {
    const provider = new FakeProvider([
      () => ({ chunks: [{ type: "tool_call", call: { id: "c1", name: "read_file", input: {} } }] }),
      () => ({ chunks: [{ type: "text_delta", text: "done" }] }),
    ]);
    // start turn, subscribe with afterSeq=0, concurrently append, assert no gap
  });
  ```
- **Last-Event-ID test:** `provider.requests` proves client re-sent `Last-Event-ID`, server replayed only missed.

**One fake drives all layers:**
- `model-call.test.ts` — bounded, retried call with partial accounting
- `loop.test.ts` — recovery, approval, cancellation, maxSteps
- `routes-turns.test.ts` — disconnect/reconnect with `Last-Event-ID`
- `reliability.integration.test.ts` — 4 named cases from plan, but now asserting on `requests[]` not just event types

---

## 5. Design-it-twice for FakeProvider

### Option A: Steps are functions of request → result (recommended)

```ts
type ProviderStep = (request: LLMRequest) => ProviderStepResult
class FakeProvider { constructor(steps: ProviderStep[]) }
```

- Pros: Each step can assert on request, decide chunks based on request, maximally flexible, request recording natural
- Cons: Slightly more verbose than flat list

### Option B: Steps are declarative objects, requests recorded separately

```ts
type ScriptedStep = { assert?: (req) => void, chunks: LLMChunk[], error?: Error }
class FakeProvider { constructor(steps: ScriptedStep[]) }
```

- Pros: More declarative, easier to read for simple cases
- Cons: Less flexible for conditional logic, assert is optional bolt-on

**Recommendation:** Option A — function per step. It makes the decisive assertion ("tool result appended") a first-class part of the script, not an afterthought. For simple cases, helper `Steps.toolCall()` returns a function, so verbosity is same as flat list.

---

## 6. What this phase does NOT cover

- **Fake clock integration:** Phase 4 will wire `FakeClock` into deadline module (candidate #1) so timeouts are deterministic across provider + tool + approval.
- **File store:** Phase 2 seam, Phase 4 integration.
- **CONTEXT.md:** Phase 4 will seed terms: Turn, Step, Tool, Approval, Provider, ProjectRoot, Stop, StreamEvent, TurnState, TurnLogStore.

---

## 7. Benefits and risks

**Benefits:**
- **The interface is the test surface:** Recovery, denial, unknown-tool, max-steps become observable in `what model was sent`, not inferred from event-type lists
- **Leverage:** One fake drives model-call, loop, routes, integration — no product code moves, cheapest candidate
- **Locality:** Every provider-side failure mode declared in one file
- **Enables P1-05:** Partial-stream retry, usage accounting, malformed tool calls now testable

**Risks:**
- More complex fake — need to ensure fake itself is not buggy. Mitigate: test the fake with a simple "records requests" unit test.
- Request shape (where tool results go) must be decided — currently plan says `LLMRequest.tools` is list, but not where results go. Propose `messages` with `role:"tool"` — standard OpenAI/Anthropic pattern.

---

## 8. Implementation sketch for new fake-provider.ts

```ts
export class FakeProvider implements LLMProvider {
  public requests: LLMRequest[] = [];
  public lastSignal?: AbortSignal;
  public lastSignals: AbortSignal[] = [];

  private stepIndex = 0;

  constructor(private steps: ProviderStep[], private opts: FakeProviderOpts = {}) {}

  async *stream(request: LLMRequest, options: { signal: AbortSignal }): AsyncIterable<LLMChunk> {
    this.requests.push(structuredClone(request));
    this.lastSignal = options.signal;
    this.lastSignals.push(options.signal);

    if (this.stepIndex >= this.steps.length) {
      throw new Error(`FakeProvider: no more steps, requested step ${this.stepIndex}`);
    }

    const step = this.steps[this.stepIndex++];
    const result = await step(request);

    // handle AsyncIterable case
    if (result && typeof (result as any)[Symbol.asyncIterator] === "function") {
      for await (const chunk of result as AsyncIterable<LLMChunk>) {
        if (options.signal.aborted) throw new Error("aborted");
        yield chunk;
      }
      return;
    }

    const { chunks = [], error, hang, ignoreAbort, delayMs } = result as ProviderStepResult;

    for (const chunk of chunks) {
      if (options.signal.aborted && !ignoreAbort) throw new Error("aborted");
      if (delayMs) await this.opts.clock?.sleep(delayMs);
      yield chunk;
    }

    if (error) throw error;
    if (hang) {
      // wait until aborted, unless ignoreAbort
      await new Promise<void>((resolve, reject) => {
        if (options.signal.aborted && !ignoreAbort) reject(new Error("aborted"));
        options.signal.addEventListener("abort", () => {
          if (!ignoreAbort) reject(new Error("aborted"));
        });
      });
    }
  }
}
```

---

## 9. Next steps

**Phase 4:** Integration sketch — how Phase 1 (reducer + seq), Phase 2 (atomic subscribe + store seam + Last-Event-ID), Phase 3 (scripted fake) fit together. Update CONTEXT.md with terms, propose ADR for rejected alternatives (loop owns seq, flat-list fake), migration plan for existing plan tasks 1,6,7,8,9.

Please confirm go for Phase 4, or request changes to Phase 3.

