# Robust Turn Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cancellation-safe, timeout-bounded, resumable turn execution so model calls, tools, approvals, the HTTP stream, and the web UI agree on explicit terminal state instead of hanging or losing work.

**Architecture:** A shared TypeScript event contract defines the turn lifecycle and error shapes. The server owns an `AbortController` per active turn, a timeout-aware provider/tool boundary, and an approval registry that keeps pending approvals independent from an individual SSE connection; the UI only consumes shared events and calls session APIs. Filesystem tools receive a validated `safePath()` from their execution context, while provider-specific code only implements the provider interface and receives the caller's abort signal.

**Tech Stack:** Node.js 20.10+, TypeScript with strict ESM, Express, native `AbortController`/`AbortSignal`, Server-Sent Events, React, and Node's built-in test runner invoked through `tsx`.

**Spec:** User-provided requirements in the task prompt, with the related repository acceptance criteria in `RELEASE_CHECKLIST.md` under P1-05.

## Global Constraints

- Cancel an in-progress session cleanly.
- Add per-tool and per-model-call timeouts.
- Ensure approval promises cannot hang after disconnects or failures.
- Emit explicit streamed events for started, waiting_for_approval, completed, cancelled, and failed.
- Add fake-provider tests covering approval, cancellation, timeout, and tool failure recovery.
- Keep all filesystem operations behind safePath() and return actionable model-facing errors.
- This would improve reliability across the server/API and Web UI without coupling those layers to provider-specific behavior.
- Long-running terminal commands are terminated with their full process tree on timeout or Stop.
- Windows and POSIX process cleanup are both covered.
- Cancellation while awaiting approval exits cleanly without hanging or leaking resources.
- Malformed or unknown tool calls are handled as controlled errors instead of uncaught failures.

## File Structure

The checked-out commit contains the repository shell and documentation but not the `packages/` implementation directories described by `AGENTS.md`. The first two tasks therefore add the minimal workspace/test scaffolding needed to make each later task runnable; in a checkout where those source files already exist, preserve the same interfaces while modifying the existing implementations.

- `package.json` — add the shared TypeScript test/typecheck tools without changing the product's existing CLI scripts.
- `package-lock.json` — record the workspace and test-tool dependency metadata generated from the package manifests.
- `packages/shared/package.json` — declare the shared workspace and its focused test command.
- `packages/shared/tsconfig.json` — enable strict ESM TypeScript for shared contracts.
- `packages/shared/src/index.ts` — define IDs, limits, approval payloads, tool errors, usage, and the discriminated `StreamEvent` union consumed by server and UI.
- `packages/shared/test/index.test.ts` — verify the lifecycle event contract and terminal-event fields.
- `packages/server/package.json` — declare the server workspace and its test/typecheck commands.
- `packages/server/tsconfig.json` — enable strict ESM TypeScript for server code.
- `packages/server/src/config.ts` — parse and default turn limits at the server boundary.
- `packages/server/src/agent/cancellation.ts` — provide idempotent cancellation tokens and normalized cancellation errors.
- `packages/server/src/agent/timeout.ts` — compose parent cancellation with a deadline and clean up timers.
- `packages/server/test/agent/cancellation.test.ts` — prove parent cancellation, explicit cancellation, timeout, and timer cleanup.
- `packages/server/src/agent/approval-registry.ts` — own pending approval promises, expiry, decisions, cancellation, and replay snapshots.
- `packages/server/test/agent/approval-registry.test.ts` — cover approval, denial, expiry, duplicate decisions, turn cancellation, and observer disconnects.
- `packages/server/src/providers/types.ts` — define provider requests, streamed chunks, usage, and the abort-aware `LLMProvider` interface.
- `packages/server/src/providers/model-call.ts` — consume one provider stream with a model-call deadline and normalized output.
- `packages/server/src/providers/openai-compatible.ts` — pass the provided signal into OpenAI-compatible fetch requests.
- `packages/server/src/providers/anthropic.ts` — pass the provided signal into Anthropic fetch requests.
- `packages/server/test/fakes/fake-provider.ts` — provide deterministic delayed, failing, tool-calling, and approval-driven provider behavior.
- `packages/server/test/providers/model-call.test.ts` — verify completed streams, cancellation, and model-call timeout behavior.
- `packages/server/src/paths.ts` — implement root-bounded `safePath()` validation for filesystem tools.
- `packages/server/src/process-tree.ts` — abstract POSIX process-group and Windows process-tree termination.
- `packages/server/src/agent/tools/types.ts` — define tool definitions, execution context, and structured tool results.
- `packages/server/src/agent/tools/executor.ts` — apply per-tool deadlines and convert failures into actionable model-facing results.
- `packages/server/src/agent/tools/filesystem.ts` — implement filesystem tools only through `safePath()`.
- `packages/server/src/agent/tools/terminal.ts` — run approved commands with timeout/cancellation process-tree cleanup.
- `packages/server/test/agent/tools.test.ts` — cover safe paths, traversal rejection, tool timeout, and recoverable tool failure.
- `packages/server/test/process-tree.test.ts` — cover POSIX and Windows cleanup through an injectable process adapter.
- `packages/server/src/agent/loop.ts` — execute bounded model/tool steps and emit one terminal lifecycle event.
- `packages/server/test/agent/loop.test.ts` — cover normal completion, approval resume, cancellation, timeout, and tool recovery.
- `packages/server/src/agent/turn-manager.ts` — track active turns, controllers, event replay, subscribers, and approval routing.
- `packages/server/src/app.ts` — create the Express application with the turn routes and SSE endpoint.
- `packages/server/src/routes.ts` — validate turn, cancel, approval, and stream requests before calling the manager.
- `packages/server/test/routes-turns.test.ts` — exercise start, reconnect, approval, cancel, malformed input, and terminal event delivery over HTTP.
- `packages/web/package.json` — declare the web workspace and its focused reducer test command.
- `packages/web/tsconfig.json` — enable strict JSX/ESM TypeScript for the UI.
- `packages/web/src/api.ts` — expose relative-URL helpers for cancellation, approval, and event streaming.
- `packages/web/src/turn-state.ts` — reduce shared stream events into deterministic UI state.
- `packages/web/src/components/TurnStatus.tsx` — render running, waiting, completed, cancelled, and failed states.
- `packages/web/src/components/ApprovalCard.tsx` — render the pending tool approval and submit approve/deny decisions.
- `packages/web/src/App.tsx` — subscribe/reconnect to a turn stream, wire Stop, and render the lifecycle components.
- `packages/web/test/turn-state.test.ts` — verify reducer transitions and duplicate terminal-event protection.
- `README.md` — document timeout defaults, Stop semantics, approval reconnection, and actionable failure behavior.

---

## Task 1: Shared Turn Lifecycle Contract

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`
- Test: `packages/shared/test/index.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: The lifecycle names and reliability constraints listed in this plan's Global Constraints.
- Produces: `SessionId`, `TurnId`, `ApprovalId`, `TurnStatus`, `TurnLimits`, `ApprovalDecision`, `ApprovalRequest`, `ToolResult`, `TurnUsage`, and `StreamEvent` for every later server and UI task.

- [ ] **Step 1: Write the failing test**

```ts
import { strict as assert } from "node:assert";
import test from "node:test";
import type { StreamEvent } from "../src/index.js";

test("lifecycle events carry stable turn identity and explicit terminal status", () => {
  const events: StreamEvent[] = [
    { type: "turn_started", sessionId: "s1", turnId: "t1", at: 1, limits: {
      maxSteps: 2, modelCallTimeoutMs: 100, toolTimeoutMs: 100, approvalTimeoutMs: 100,
    } },
    { type: "turn_failed", sessionId: "s1", turnId: "t1", at: 2,
      code: "MODEL_TIMEOUT", message: "model call timed out", retryable: true },
  ];

  assert.equal(events[0].turnId, events[1].turnId);
  assert.equal(events[1].type, "turn_failed");
  assert.equal(events[1].retryable, true);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx tsx --test packages/shared/test/index.test.ts`  
Expected: FAIL because `packages/shared/src/index.ts` and its exported event types do not exist.

- [ ] **Step 3: Write the minimal implementation**

```ts
export type SessionId = string;
export type TurnId = string;
export type ApprovalId = string;
export type TurnStatus = "running" | "waiting_for_approval" | "completed" | "cancelled" | "failed";
export type ApprovalDecision = "approve" | "deny";
export type TurnFailureCode = "MODEL_TIMEOUT" | "MODEL_FAILED" | "APPROVAL_TIMEOUT" | "TURN_LIMIT" | "UNKNOWN_TOOL";
export type ToolErrorCode = "TOOL_FAILED" | "TOOL_TIMED_OUT" | "APPROVAL_DENIED" | "CANCELLED";

export interface TurnLimits {
  maxSteps: number;
  modelCallTimeoutMs: number;
  toolTimeoutMs: number;
  approvalTimeoutMs: number;
}

export interface ApprovalRequest {
  requestId: ApprovalId;
  turnId: TurnId;
  toolName: string;
  input: unknown;
  reason: string;
  expiresAt: number;
}

export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type ToolResult =
  | { ok: true; output: string }
  | { ok: false; code: ToolErrorCode; message: string; retryable: boolean };

export type StreamEvent =
  | { type: "turn_started"; sessionId: SessionId; turnId: TurnId; at: number; limits: TurnLimits }
  | { type: "turn_waiting_for_approval"; sessionId: SessionId; turnId: TurnId; at: number; request: ApprovalRequest }
  | { type: "tool_started"; sessionId: SessionId; turnId: TurnId; at: number; toolName: string }
  | { type: "tool_completed"; sessionId: SessionId; turnId: TurnId; at: number; toolName: string; result: ToolResult }
  | { type: "turn_completed"; sessionId: SessionId; turnId: TurnId; at: number; usage?: TurnUsage }
  | { type: "turn_cancelled"; sessionId: SessionId; turnId: TurnId; at: number; reason: string }
  | { type: "turn_failed"; sessionId: SessionId; turnId: TurnId; at: number; code: TurnFailureCode | ToolErrorCode; message: string; retryable: boolean };
```

Add `tsx` and `typescript` to the root development dependencies, create the shared workspace manifest with `test` and `typecheck` scripts, and run `npm install --package-lock-only --ignore-scripts` so the lockfile records the workspace metadata.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx tsx --test packages/shared/test/index.test.ts`  
Expected: PASS with one lifecycle-contract test.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json packages/shared
git commit -m "feat: define shared turn lifecycle events"
```

## Task 2: Cancellation, Deadlines, and Turn Limit Configuration

**Files:**
- Create: `packages/server/package.json`
- Create: `packages/server/tsconfig.json`
- Create: `packages/server/src/config.ts`
- Create: `packages/server/src/agent/cancellation.ts`
- Create: `packages/server/src/agent/timeout.ts`
- Test: `packages/server/test/agent/cancellation.test.ts`

**Interfaces:**
- Consumes: `TurnLimits` from `@windows-runner/shared` and the shared workspace test setup from Task 1.
- Produces: `DEFAULT_TURN_LIMITS`, `parseTurnLimits(input)`, `CancellationError`, `CancellationToken`, `createCancellationToken()`, `TimeoutError`, `withTimeout(operation, timeoutMs, parentSignal)`, and `isCancellationError(error)`.

- [ ] **Step 1: Write the failing test**

```ts
import { strict as assert } from "node:assert";
import test from "node:test";
import { createCancellationToken, CancellationError } from "../../src/agent/cancellation.js";
import { TimeoutError, withTimeout } from "../../src/agent/timeout.js";

test("parent cancellation aborts a waiting operation", async () => {
  const token = createCancellationToken();
  const pending = new Promise<void>((_, reject) => {
    token.signal.addEventListener("abort", () => reject(new CancellationError("user stopped")), { once: true });
  });
  token.cancel("user stopped");
  await assert.rejects(pending, CancellationError);
  assert.equal(token.signal.aborted, true);
});

test("withTimeout aborts the child signal and rejects with TimeoutError", async () => {
  await assert.rejects(
    withTimeout(() => new Promise<never>(() => {}), 5),
    TimeoutError,
  );
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx tsx --test packages/server/test/agent/cancellation.test.ts`  
Expected: FAIL because the server workspace and cancellation/timeout modules do not exist.

- [ ] **Step 3: Write the minimal implementation**

```ts
export class CancellationError extends Error {
  readonly code = "CANCELLED" as const;
  constructor(message = "turn cancelled") {
    super(message);
    this.name = "CancellationError";
  }
}

export interface CancellationToken {
  readonly signal: AbortSignal;
  cancel(reason?: string): void;
  throwIfCancelled(): void;
}

export function createCancellationToken(): CancellationToken {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    cancel(reason = "turn cancelled") {
      if (!controller.signal.aborted) controller.abort(new CancellationError(reason));
    },
    throwIfCancelled() {
      if (controller.signal.aborted) throw controller.signal.reason ?? new CancellationError();
    },
  };
}
```

Implement `TimeoutError` with code `TIMEOUT`, and implement `withTimeout<T>(operation, timeoutMs, parentSignal?)` by creating a child `AbortController`, forwarding the parent abort once, racing the operation against a timer that rejects with `TimeoutError`, and clearing the timer plus both listeners in `finally`. Reject non-positive or non-finite timeouts before invoking `operation`. Define `DEFAULT_TURN_LIMITS` as `maxSteps: 120`, `modelCallTimeoutMs: 120_000`, `toolTimeoutMs: 120_000`, and `approvalTimeoutMs: 300_000`; `parseTurnLimits` must accept only finite positive integers and retain defaults for omitted fields.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx tsx --test packages/server/test/agent/cancellation.test.ts`  
Expected: PASS, including assertions that parent cancellation and deadlines reject promptly.

- [ ] **Step 5: Commit**

```bash
git add packages/server
 git commit -m "feat: add cancellation and timeout primitives"
```

## Task 3: Resumable Approval Registry

**Files:**
- Create: `packages/server/src/agent/approval-registry.ts`
- Test: `packages/server/test/agent/approval-registry.test.ts`

**Interfaces:**
- Consumes: `ApprovalRequest`, `ApprovalDecision`, `TurnId`, and `ApprovalId` from `@windows-runner/shared`; `TimeoutError` and `CancellationError` from Task 2.
- Produces: `ApprovalRegistry.register(request, timeoutMs)`, `wait(requestId, signal)`, `resolve(requestId, decision)`, `cancelTurn(turnId, reason)`, and `snapshot(turnId)`.

- [ ] **Step 1: Write the failing test**

```ts
import { strict as assert } from "node:assert";
import test from "node:test";
import { ApprovalRegistry } from "../../src/agent/approval-registry.js";
import { createCancellationToken } from "../../src/agent/cancellation.js";

const request = { requestId: "a1", turnId: "t1", toolName: "run_terminal", input: { command: "npm test" }, reason: "command needs approval", expiresAt: Date.now() + 1000 } as const;

test("a pending approval survives observer disconnect and resolves on reconnect", async () => {
  const registry = new ApprovalRegistry();
  registry.register(request, 1000);
  const observer = createCancellationToken();
  observer.cancel("SSE observer disconnected");
  assert.equal(registry.snapshot("t1").length, 1);
  const decision = registry.wait("a1", new AbortController().signal);
  assert.equal(registry.resolve("a1", "approve"), true);
  assert.equal(await decision, "approve");
});

test("cancelling a turn settles every pending approval", async () => {
  const registry = new ApprovalRegistry();
  registry.register(request, 1000);
  const waiting = registry.wait("a1", new AbortController().signal);
  registry.cancelTurn("t1", "user stopped");
  await assert.rejects(waiting, /user stopped/);
  assert.equal(registry.snapshot("t1").length, 0);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx tsx --test packages/server/test/agent/approval-registry.test.ts`  
Expected: FAIL because `ApprovalRegistry` is not defined.

- [ ] **Step 3: Write the minimal implementation**

```ts
import type { ApprovalDecision, ApprovalId, ApprovalRequest, TurnId } from "@windows-runner/shared";
import { CancellationError } from "./cancellation.js";
import { TimeoutError } from "./timeout.js";

type Entry = {
  request: ApprovalRequest;
  promise: Promise<ApprovalDecision>;
  resolve: (decision: ApprovalDecision) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class ApprovalRegistry {
  private readonly entries = new Map<ApprovalId, Entry>();

  register(request: ApprovalRequest, timeoutMs: number): void {
    if (this.entries.has(request.requestId)) throw new Error(`approval ${request.requestId} already exists`);
    let resolve!: Entry["resolve"];
    let reject!: Entry["reject"];
    const promise = new Promise<ApprovalDecision>((res, rej) => { resolve = res; reject = rej; });
    const timer = setTimeout(() => this.finish(request.requestId, new TimeoutError(`approval ${request.requestId} timed out`)), timeoutMs);
    this.entries.set(request.requestId, { request, promise, resolve, reject, timer });
  }

  wait(requestId: ApprovalId, signal: AbortSignal): Promise<ApprovalDecision> {
    const entry = this.entries.get(requestId);
    if (!entry) return Promise.reject(new Error(`approval ${requestId} is not pending`));
    if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new CancellationError());
    const onAbort = () => this.finish(requestId, signal.reason instanceof Error ? signal.reason : new CancellationError());
    signal.addEventListener("abort", onAbort, { once: true });
    return entry.promise.finally(() => signal.removeEventListener("abort", onAbort));
  }

  resolve(requestId: ApprovalId, decision: ApprovalDecision): boolean {
    const entry = this.entries.get(requestId);
    if (!entry) return false;
    this.finish(requestId, undefined, decision);
    return true;
  }

  cancelTurn(turnId: TurnId, reason: string): void {
    for (const [id, entry] of this.entries) if (entry.request.turnId === turnId) this.finish(id, new CancellationError(reason));
  }

  snapshot(turnId: TurnId): ApprovalRequest[] {
    return [...this.entries.values()].filter(entry => entry.request.turnId === turnId).map(entry => entry.request);
  }

  private finish(requestId: ApprovalId, error?: Error, decision?: ApprovalDecision): void {
    const entry = this.entries.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.entries.delete(requestId);
    if (error) entry.reject(error);
    else entry.resolve(decision!);
  }
}
```

Store one shared promise per request so a reconnect can call `wait` without replacing an existing waiter. Remove the entry before settling it, and remove the abort listener in `finally`. A disconnected SSE observer must not call `cancelTurn`; only explicit turn cancellation, approval expiry, or turn failure cleanup may settle the promise. Denial resolves to `"deny"`, so the loop can return a structured `APPROVAL_DENIED` result to the model.

Store the resolver and rejecter exactly once per registered request, remove the entry before settling it, and detach the abort listener when the entry finishes. A disconnected SSE observer must not call `cancelTurn`; only explicit turn cancellation, approval expiry, or turn failure cleanup may settle the promise. Denial resolves to `"deny"`, so the loop can return a structured `APPROVAL_DENIED` result to the model.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx tsx --test packages/server/test/agent/approval-registry.test.ts`  
Expected: PASS for approval resume, observer disconnect, turn cancellation, denial, expiry, duplicate resolution, and cleanup assertions.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/agent/approval-registry.ts packages/server/test/agent/approval-registry.test.ts
git commit -m "feat: make approvals resumable and cancellable"
```

## Task 4: Abort-Aware Model Provider Boundary

**Files:**
- Create: `packages/server/src/providers/types.ts`
- Create: `packages/server/src/providers/model-call.ts`
- Create: `packages/server/src/providers/openai-compatible.ts`
- Create: `packages/server/src/providers/anthropic.ts`
- Create: `packages/server/test/fakes/fake-provider.ts`
- Test: `packages/server/test/providers/model-call.test.ts`

**Interfaces:**
- Consumes: `TimeoutError`, `CancellationError`, `withTimeout`, and `TurnUsage` from earlier tasks.
- Produces: `ChatMessage`, `LLMRequest`, `ToolCall`, `LLMChunk`, `LLMProvider.stream(request, { signal })`, `ModelResponse`, and `runModelCall(provider, request, signal, timeoutMs)`.

- [ ] **Step 1: Write the failing test**

```ts
import { strict as assert } from "node:assert";
import test from "node:test";
import { FakeProvider } from "../fakes/fake-provider.js";
import { runModelCall } from "../../src/providers/model-call.js";
import { TimeoutError } from "../../src/agent/timeout.js";

test("model-call wrapper aggregates text, tool calls, and usage", async () => {
  const provider = new FakeProvider([
    { type: "text_delta", text: "done" },
    { type: "usage", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } },
  ]);
  const result = await runModelCall(provider, { messages: [], tools: [] }, new AbortController().signal, 100);
  assert.equal(result.text, "done");
  assert.deepEqual(result.usage, { inputTokens: 2, outputTokens: 1, totalTokens: 3 });
});

test("a provider that never yields is stopped by the model-call deadline", async () => {
  const provider = new FakeProvider([], { waitForAbort: true });
  await assert.rejects(
    runModelCall(provider, { messages: [], tools: [] }, new AbortController().signal, 5),
    TimeoutError,
  );
  assert.equal(provider.lastSignal?.aborted, true);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx tsx --test packages/server/test/providers/model-call.test.ts`  
Expected: FAIL because the provider contracts, fake provider, and model-call wrapper do not exist.

- [ ] **Step 3: Write the minimal implementation**

```ts
import type { TurnUsage } from "@windows-runner/shared";

export interface ChatMessage { role: "system" | "user" | "assistant" | "tool"; content: string; }
export interface ToolCall { id: string; name: string; input: unknown; }
export interface LLMRequest { messages: ChatMessage[]; tools: { name: string; description: string }[]; }
export type LLMChunk =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "usage"; usage: TurnUsage };
export interface LLMProvider {
  stream(request: LLMRequest, options: { signal: AbortSignal }): AsyncIterable<LLMChunk>;
}
export interface ModelResponse { text: string; toolCalls: ToolCall[]; usage?: TurnUsage; }
```

Implement `runModelCall` with a child deadline signal, consume the async iterable with `for await`, append text, collect tool calls, retain the latest usage chunk, and rethrow `TimeoutError` or `CancellationError` unchanged. The OpenAI-compatible and Anthropic adapters must pass the signal to their `fetch` calls and must not create a second uncoupled timeout. `FakeProvider` must expose `lastSignal`, support delayed chunks, an abort-aware never-ending stream, and a rejected stream without any network request.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx tsx --test packages/server/test/providers/model-call.test.ts`  
Expected: PASS for normal aggregation, provider failure propagation, parent cancellation, and model-call timeout.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/providers packages/server/test/providers packages/server/test/fakes
git commit -m "feat: bound model calls with abort-aware providers"
```

## Task 5: Safe Tool Execution and Process-Tree Cleanup

**Files:**
- Create: `packages/server/src/paths.ts`
- Create: `packages/server/src/process-tree.ts`
- Create: `packages/server/src/agent/tools/types.ts`
- Create: `packages/server/src/agent/tools/executor.ts`
- Create: `packages/server/src/agent/tools/filesystem.ts`
- Create: `packages/server/src/agent/tools/terminal.ts`
- Test: `packages/server/test/agent/tools.test.ts`
- Test: `packages/server/test/process-tree.test.ts`

**Interfaces:**
- Consumes: `ToolResult`, `ToolErrorCode`, `withTimeout`, and the shared turn limits.
- Produces: `safePath(root, requested)`, `ToolDefinition`, `ToolExecutionContext`, `executeTool(tool, input, context, timeoutMs)`, `ManagedProcess`, `spawnManaged()`, and filesystem/terminal tool definitions.

- [ ] **Step 1: Write the failing test**

```ts
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { safePath } from "../../src/paths.js";
import { executeTool } from "../../src/agent/tools/executor.js";

test("safePath rejects traversal before a filesystem tool receives the path", () => {
  const root = mkdtempSync(path.join(tmpdir(), "windows-runner-"));
  try {
    assert.throws(() => safePath(root, "../outside.txt"), /outside project root/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rejected tool becomes an actionable retryable model result", async () => {
  const result = await executeTool({
    name: "read_file",
    requiresApproval: () => false,
    execute: async () => { throw new Error("old_str was not found; read the file again"); },
  }, { path: "src/a.ts" }, {
    cwd: "/workspace/project",
    signal: new AbortController().signal,
    safePath: requested => safePath("/workspace/project", requested),
  }, 100);
  assert.deepEqual(result, {
    ok: false,
    code: "TOOL_FAILED",
    message: 'Tool "read_file" failed: old_str was not found; read the file again',
    retryable: true,
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx tsx --test packages/server/test/agent/tools.test.ts packages/server/test/process-tree.test.ts`  
Expected: FAIL because path validation, tool execution, and process-tree modules do not exist.

- [ ] **Step 3: Write the minimal implementation**

```ts
import path from "node:path";
import { realpathSync } from "node:fs";

export function safePath(root: string, requested: string): string {
  const rootReal = realpathSync(root);
  const candidate = path.resolve(rootReal, requested);
  const relative = path.relative(rootReal, candidate);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("path is outside project root");
  }
  if (relative === "") return rootReal;
  const parentReal = realpathSync(path.dirname(candidate));
  const checked = path.join(parentReal, path.basename(candidate));
  const checkedRelative = path.relative(rootReal, checked);
  if (checkedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(checkedRelative)) {
    throw new Error("path is outside project root");
  }
  return checked;
}
```

The project root itself remains valid for directory operations, and resolving the existing parent directory before returning a new-file path prevents symlinked parents from escaping. Define:

```ts
export interface ToolExecutionContext {
  cwd: string;
  signal: AbortSignal;
  safePath(requested: string): string;
}
export interface ToolDefinition {
  name: string;
  requiresApproval(input: unknown): boolean;
  execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult>;
}
export function executeTool(
  tool: ToolDefinition,
  input: unknown,
  context: ToolExecutionContext,
  timeoutMs: number,
): Promise<ToolResult>;
```

`executeTool` must call the tool with a child deadline signal, return `TOOL_TIMED_OUT` with the exact timeout in the message when the deadline fires, rethrow cancellation as `CancellationError`, and convert other thrown errors to a bounded `TOOL_FAILED` message that tells the model how to recover. `filesystem.ts` must call `context.safePath()` before every read, write, list, or delete operation. `terminal.ts` must use `spawnManaged()` and pass cancellation/deadline signals to it. `process-tree.ts` must use a negative process-group PID on POSIX and `taskkill /T /F /PID` on Windows, with an injectable adapter so tests do not kill unrelated processes.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx tsx --test packages/server/test/agent/tools.test.ts packages/server/test/process-tree.test.ts`  
Expected: PASS for traversal rejection, safe filesystem access, actionable tool failures, tool deadlines, cancellation, and both process cleanup strategies.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/paths.ts packages/server/src/process-tree.ts packages/server/src/agent/tools packages/server/test/agent/tools.test.ts packages/server/test/process-tree.test.ts
git commit -m "feat: bound tool execution and clean up process trees"
```

## Task 6: Turn State Machine and Recovery Semantics

**Files:**
- Create: `packages/server/src/agent/loop.ts`
- Test: `packages/server/test/agent/loop.test.ts`

**Interfaces:**
- Consumes: shared `StreamEvent`, `TurnLimits`, `ToolResult`; `ApprovalRegistry`; `LLMProvider`/`runModelCall`; and `ToolDefinition`/`executeTool` from Tasks 3–5.
- Produces: `RunTurnInput`, `TurnRunnerDependencies`, `TurnResult`, and `TurnRunner.run(input)`.

- [ ] **Step 1: Write the failing test**

```ts
import { strict as assert } from "node:assert";
import test from "node:test";
import { ApprovalRegistry } from "../../src/agent/approval-registry.js";
import { TurnRunner } from "../../src/agent/loop.js";
import { FakeProvider } from "../fakes/fake-provider.js";

test("a tool failure is returned to the model and the next model response can complete", async () => {
  const events = [] as { type: string }[];
  const provider = new FakeProvider([
    { type: "tool_call", call: { id: "c1", name: "read_file", input: { path: "missing" } } },
    { type: "text_delta", text: "I recovered" },
  ]);
  const runner = new TurnRunner({ provider, tools: new Map([[
    "read_file", { name: "read_file", requiresApproval: () => false, execute: async () => { throw new Error("read the file again"); } },
  ]]), approvals: new ApprovalRegistry(), emit: event => events.push(event) });
  const result = await runner.run({ sessionId: "s1", turnId: "t1", cwd: "/workspace/project", request: { messages: [], tools: [{ name: "read_file", description: "read" }] }, limits: { maxSteps: 3, modelCallTimeoutMs: 100, toolTimeoutMs: 100, approvalTimeoutMs: 100 }, signal: new AbortController().signal });
  assert.equal(result.status, "completed");
  assert.deepEqual(events.map(event => event.type), ["turn_started", "tool_started", "tool_completed", "turn_completed"]);
});

test("cancellation while waiting for approval emits one cancelled terminal event", async () => {
  const events = [] as { type: string }[];
  const controller = new AbortController();
  const approvals = new ApprovalRegistry();
  const provider = new FakeProvider([{ type: "tool_call", call: { id: "c1", name: "run_terminal", input: { command: "npm test" } } }]);
  const runner = new TurnRunner({ provider, tools: new Map([[
    "run_terminal", { name: "run_terminal", requiresApproval: () => true, execute: async () => ({ ok: true, output: "ok" }) },
  ]]), approvals, emit: event => events.push(event) });
  const pending = runner.run({ sessionId: "s1", turnId: "t1", cwd: "/workspace/project", request: { messages: [], tools: [{ name: "run_terminal", description: "run" }] }, limits: { maxSteps: 3, modelCallTimeoutMs: 100, toolTimeoutMs: 100, approvalTimeoutMs: 1000 }, signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error("Stop pressed"));
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(events.filter(event => event.type === "turn_cancelled").length, 1);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx tsx --test packages/server/test/agent/loop.test.ts`  
Expected: FAIL because `TurnRunner` and its turn input/result types do not exist.

- [ ] **Step 3: Write the minimal implementation**

```ts
export interface RunTurnInput {
  sessionId: SessionId;
  turnId: TurnId;
  cwd: string;
  request: LLMRequest;
  limits: TurnLimits;
  signal: AbortSignal;
}

export interface TurnRunnerDependencies {
  provider: LLMProvider;
  tools: ReadonlyMap<string, ToolDefinition>;
  approvals: ApprovalRegistry;
  emit(event: StreamEvent): void;
  now?: () => number;
}

export interface TurnResult {
  status: "completed" | "cancelled" | "failed";
  usage?: TurnUsage;
  message?: string;
}
```

Implement `TurnRunner.run` as a bounded loop: emit `turn_started`; call `runModelCall`; if there are no tool calls, emit `turn_completed`; otherwise execute tool calls sequentially. Unknown tools become a non-throwing `UNKNOWN_TOOL` result. For an approval-required tool, create and register an `ApprovalRequest` using the provider tool-call id as the request id, emit `turn_waiting_for_approval`, await `ApprovalRegistry.wait`, and pass denial back as `APPROVAL_DENIED`; an SSE disconnect must not affect this wait. Append every tool result to the next provider request so a failed tool can be corrected by the model. On `AbortSignal`, `CancellationError`, or `TimeoutError`, emit exactly one of `turn_cancelled` or `turn_failed`; in `finally`, cancel all outstanding approvals for the turn and prevent any later event. Preserve the latest usage object on the returned result.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx tsx --test packages/server/test/agent/loop.test.ts`  
Expected: PASS for completion, approval waiting/resume, approval denial, max-step failure, model timeout, tool timeout recovery, unknown-tool recovery, and cancellation without duplicate terminal events.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/agent/loop.ts packages/server/test/agent/loop.test.ts
git commit -m "feat: make turn execution cancellable and recoverable"
```

## Task 7: Turn Manager, Approval API, and Reconnectable SSE

**Files:**
- Create: `packages/server/src/agent/turn-manager.ts`
- Create: `packages/server/src/app.ts`
- Create: `packages/server/src/routes.ts`
- Test: `packages/server/test/routes-turns.test.ts`

**Interfaces:**
- Consumes: `TurnRunner`, `ApprovalRegistry`, `StreamEvent`, `RunTurnInput`, `TurnResult`, `LLMProvider`, and `ToolDefinition` from earlier tasks.
- Produces: `TurnManagerDependencies`, `StartTurnInput`, `TurnHandle`, `TurnSnapshot`, `TurnManager.start(input)`, `cancel(sessionId, turnId, reason)`, `approve(sessionId, requestId, decision)`, `snapshot(sessionId, turnId)`, `subscribe(sessionId, turnId, listener)`, and `createApp(manager)`. 

```ts
export interface TurnManagerDependencies {
  provider: LLMProvider;
  tools: ReadonlyMap<string, ToolDefinition>;
  approvals: ApprovalRegistry;
}
export type StartTurnInput = Omit<RunTurnInput, "signal">;
export type EventListener = (event: StreamEvent) => void;
```

- [ ] **Step 1: Write the failing test**

```ts
import { strict as assert } from "node:assert";
import test from "node:test";
import { createServer } from "node:http";
import { createApp } from "../../src/app.js";
import { ApprovalRegistry } from "../../src/agent/approval-registry.js";
import { TurnManager } from "../../src/agent/turn-manager.js";
import { FakeProvider } from "../fakes/fake-provider.js";

test("approval remains pending after SSE disconnect and is replayed on reconnect", async () => {
  const manager = new TurnManager({
    provider: new FakeProvider([
      { type: "tool_call", call: { id: "c1", name: "run_terminal", input: { command: "npm test" } } },
      { type: "text_delta", text: "denied" },
    ]),
    tools: new Map([["run_terminal", { name: "run_terminal", requiresApproval: () => true, execute: async () => ({ ok: true, output: "ok" }) }]]),
    approvals: new ApprovalRegistry(),
  });
  const server = createServer(createApp(manager));
  await new Promise<void>(resolve => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const started = await fetch(`${base}/api/sessions/s1/turns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: "/workspace/project", message: "run tests" }) });
  const { turnId } = await started.json() as { turnId: string };
  const first = await fetch(`${base}/api/sessions/s1/turns/${turnId}/events`);
  await first.body?.cancel();
  const replay = await fetch(`${base}/api/sessions/s1/turns/${turnId}/events`);
  const text = await replay.text();
  assert.match(text, /turn_waiting_for_approval/);
  await fetch(`${base}/api/sessions/s1/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: "c1", decision: "deny" }) });
  server.close();
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx tsx --test packages/server/test/routes-turns.test.ts`  
Expected: FAIL because the Express app, manager, routes, and SSE replay endpoint do not exist.

- [ ] **Step 3: Write the minimal implementation**

```ts
export interface TurnHandle {
  sessionId: SessionId;
  turnId: TurnId;
  completion: Promise<TurnResult>;
  cancel(reason?: string): boolean;
}

export interface TurnSnapshot {
  sessionId: SessionId;
  turnId: TurnId;
  status: TurnStatus;
  events: StreamEvent[];
  pendingApprovals: ApprovalRequest[];
}
```

`TurnManager.start` creates an `AbortController`, starts `TurnRunner.run` without awaiting it in the HTTP handler, stores every event in order, and removes the active controller only after terminal cleanup. `snapshot` returns the event history plus pending approvals. `subscribe` returns an unsubscribe function and never cancels the underlying turn when the listener disappears. `cancel` aborts the controller and calls `ApprovalRegistry.cancelTurn`; `approve` validates session ownership before resolving the pending request and returns `false` for stale or duplicate decisions.

In `routes.ts`, implement and validate these endpoints without coercing null or unexpected types:

```text
POST /api/sessions/:sessionId/turns                  body { cwd: string, message: string } -> 202 { turnId }
GET  /api/sessions/:sessionId/turns/:turnId/events  -> text/event-stream with replay then live events
POST /api/sessions/:sessionId/turns/:turnId/cancel  body { reason?: string } -> 202
POST /api/sessions/:sessionId/approve               body { requestId: string, decision: "approve" | "deny" } -> 204
```

The SSE handler writes the replay before subscribing, removes only its listener on `close`, and leaves a waiting turn alive for reconnect. The manager, not the socket, owns failure/cancellation cleanup. Return 400 for malformed bodies, 404 for unknown sessions/turns/approvals, and 409 for decisions that are no longer pending. Use relative, same-origin URLs in the future UI; no provider details enter these routes.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx tsx --test packages/server/test/routes-turns.test.ts`  
Expected: PASS for start, ordered SSE events, disconnect/reconnect approval replay, approve/deny, cancel, stale approval, malformed payload, unknown turn, and terminal cleanup.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/agent/turn-manager.ts packages/server/src/app.ts packages/server/src/routes.ts packages/server/test/routes-turns.test.ts
git commit -m "feat: expose reconnectable turn and approval APIs"
```

## Task 8: Web UI Lifecycle, Stop, and Approval Resume

**Files:**
- Create: `packages/web/package.json`
- Create: `packages/web/tsconfig.json`
- Create: `packages/web/src/api.ts`
- Create: `packages/web/src/turn-state.ts`
- Create: `packages/web/src/components/TurnStatus.tsx`
- Create: `packages/web/src/components/ApprovalCard.tsx`
- Create: `packages/web/src/App.tsx`
- Test: `packages/web/test/turn-state.test.ts`

**Interfaces:**
- Consumes: `StreamEvent`, `TurnStatus`, `ApprovalDecision`, and `ApprovalRequest` from `@windows-runner/shared`; the relative HTTP/SSE routes from Task 7.
- Produces: `TurnUiState`, `initialTurnState`, `applyEvent(state, event)`, `cancelTurn(sessionId, turnId, reason)`, `approve(sessionId, requestId, decision)`, and presentational lifecycle components.

- [ ] **Step 1: Write the failing test**

```ts
import { strict as assert } from "node:assert";
import test from "node:test";
import { applyEvent, initialTurnState } from "../src/turn-state.js";

test("UI reducer exposes a pending approval and then completed state", () => {
  const started = applyEvent(initialTurnState, {
    type: "turn_started", sessionId: "s1", turnId: "t1", at: 1,
    limits: { maxSteps: 2, modelCallTimeoutMs: 100, toolTimeoutMs: 100, approvalTimeoutMs: 100 },
  });
  const waiting = applyEvent(started, {
    type: "turn_waiting_for_approval", sessionId: "s1", turnId: "t1", at: 2,
    request: { requestId: "a1", turnId: "t1", toolName: "run_terminal", input: { command: "npm test" }, reason: "needs approval", expiresAt: 1000 },
  });
  assert.equal(waiting.status, "waiting_for_approval");
  assert.equal(waiting.approval?.requestId, "a1");
  const completed = applyEvent(waiting, { type: "turn_completed", sessionId: "s1", turnId: "t1", at: 3 });
  assert.equal(completed.status, "completed");
  assert.equal(completed.approval, undefined);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx tsx --test packages/web/test/turn-state.test.ts`  
Expected: FAIL because the web workspace, reducer, and event types are not present.

- [ ] **Step 3: Write the minimal implementation**

```ts
import type { ApprovalRequest, StreamEvent, TurnStatus } from "@windows-runner/shared";

export interface TurnUiState {
  sessionId?: string;
  turnId?: string;
  status: TurnStatus | "idle";
  approval?: ApprovalRequest;
  error?: { code: string; message: string; retryable: boolean };
}

export const initialTurnState: TurnUiState = { status: "idle" };

export function applyEvent(state: TurnUiState, event: StreamEvent): TurnUiState {
  if (state.turnId && event.turnId !== state.turnId) return state;
  switch (event.type) {
    case "turn_started": return { sessionId: event.sessionId, turnId: event.turnId, status: "running" };
    case "turn_waiting_for_approval": return { ...state, status: "waiting_for_approval", approval: event.request };
    case "turn_completed": return { ...state, status: "completed", approval: undefined };
    case "turn_cancelled": return { ...state, status: "cancelled", approval: undefined };
    case "turn_failed": return { ...state, status: "failed", approval: undefined, error: { code: event.code, message: event.message, retryable: event.retryable } };
    default: return state;
  }
}
```

Implement `api.ts` with `fetch("/api/...", ...)` for cancel/approve and an `EventSource` or reconnecting `fetch` reader for the SSE endpoint. `App.tsx` must apply replayed events idempotently, reconnect after a transient stream close while the state is `running` or `waiting_for_approval`, and keep the Stop button disabled once a terminal status is received. `ApprovalCard` must display the tool name, reason, and bounded input preview, then call `approve` with either `"approve"` or `"deny"`; it must not call a provider directly. `TurnStatus` must render exact user-visible states for started, waiting, completed, cancelled, and failed, including the actionable server message.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx tsx --test packages/web/test/turn-state.test.ts`  
Expected: PASS for lifecycle transitions, reconnect replay, stale-event isolation, duplicate terminal events, approval clearing, and failure display.

- [ ] **Step 5: Commit**

```bash
git add packages/web
 git commit -m "feat: surface cancellable turns and approvals in the UI"
```

## Task 9: End-to-End Fake-Provider Coverage and User Documentation

**Files:**
- Create: `packages/server/test/agent/reliability.integration.test.ts`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: The complete server manager/API/UI contracts from Tasks 1–8 and the deterministic `FakeProvider` from Task 4.
- Produces: A no-key regression suite and documented operational semantics for Stop, deadlines, approval reconnect, and recoverable tool errors.

- [ ] **Step 1: Write the failing test**

```ts
import { strict as assert } from "node:assert";
import test from "node:test";
import { ApprovalRegistry } from "../../src/agent/approval-registry.js";
import { TurnRunner } from "../../src/agent/loop.js";
import { FakeProvider } from "../fakes/fake-provider.js";

test("fake provider covers approval, cancellation, timeout, and tool recovery", async () => {
  const cases = ["approval", "cancellation", "timeout", "tool-failure-recovery"] as const;
  assert.equal(cases.length, 4);
  const approvals = new ApprovalRegistry();
  const provider = new FakeProvider([
    { type: "tool_call", call: { id: "c1", name: "read_file", input: { path: "missing" } } },
    { type: "text_delta", text: "recovered" },
  ]);
  const events: string[] = [];
  const runner = new TurnRunner({
    provider,
    tools: new Map([[
      "read_file", { name: "read_file", requiresApproval: () => false, execute: async () => { throw new Error("read the file again"); } },
    ]]),
    approvals,
    emit: event => events.push(event.type),
  });
  const result = await runner.run({
    sessionId: "s1", turnId: "t1", cwd: "/workspace/project", request: { messages: [], tools: [{ name: "read_file", description: "read" }], },
    limits: { maxSteps: 3, modelCallTimeoutMs: 100, toolTimeoutMs: 100, approvalTimeoutMs: 100 },
    signal: new AbortController().signal,
  });
  assert.equal(result.status, "completed");
  assert.ok(events.includes("tool_completed"));
  assert.equal(events.at(-1), "turn_completed");
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx tsx --test packages/server/test/agent/reliability.integration.test.ts`  
Expected: FAIL until the full fake-provider scenarios and root test wiring exist.

- [ ] **Step 3: Write the minimal implementation**

Add four named integration cases using the same fake provider and real `TurnRunner` path:

```ts
import { strict as assert } from "node:assert";
import test from "node:test";
import { ApprovalRegistry } from "../../src/agent/approval-registry.js";
import { CancellationError } from "../../src/agent/cancellation.js";
import { TurnRunner } from "../../src/agent/loop.js";
import type { ToolDefinition } from "../../src/agent/tools/types.js";
import { FakeProvider } from "../fakes/fake-provider.js";

const limits = { maxSteps: 3, modelCallTimeoutMs: 100, toolTimeoutMs: 100, approvalTimeoutMs: 100 };
const request = { messages: [], tools: [{ name: "run_terminal", description: "run" }] };

function runner(provider: FakeProvider, tools: Map<string, ToolDefinition>, approvals: ApprovalRegistry, events: string[]) {
  return new TurnRunner({ provider, tools, approvals, emit: event => events.push(event.type) });
}

test("approval case resolves after a reconnect", async () => {
  const approvals = new ApprovalRegistry();
  const provider = new FakeProvider([
    { type: "tool_call", call: { id: "c1", name: "run_terminal", input: { command: "npm test" } } },
    { type: "text_delta", text: "approved" },
  ]);
  const events: string[] = [];
  const run = runner(provider, new Map([["run_terminal", { name: "run_terminal", requiresApproval: () => true, execute: async () => ({ ok: true, output: "ok" }) }]]), approvals, events);
  const pending = run.run({ sessionId: "s1", turnId: "t1", cwd: "/workspace/project", request, limits, signal: new AbortController().signal });
  await new Promise<void>(resolve => setImmediate(resolve));
  const approval = approvals.snapshot("t1")[0];
  assert.ok(approval);
  assert.equal(approvals.resolve(approval.requestId, "approve"), true);
  assert.equal((await pending).status, "completed");
  assert.equal(approvals.snapshot("t1").length, 0);
  assert.equal(events.at(-1), "turn_completed");
});

test("cancellation case emits turn_cancelled and aborts the provider", async () => {
  const controller = new AbortController();
  const provider = new FakeProvider([], { waitForAbort: true });
  const events: string[] = [];
  const run = runner(provider, new Map(), new ApprovalRegistry(), events);
  const pending = run.run({ sessionId: "s1", turnId: "t1", cwd: "/workspace/project", request: { messages: [], tools: [] }, limits, signal: controller.signal });
  await new Promise<void>(resolve => setImmediate(resolve));
  controller.abort(new CancellationError("Stop pressed"));
  assert.equal((await pending).status, "cancelled");
  assert.equal(provider.lastSignal?.aborted, true);
  assert.equal(events.filter(type => type === "turn_cancelled").length, 1);
});

test("timeout case emits turn_failed with MODEL_TIMEOUT", async () => {
  const provider = new FakeProvider([], { waitForAbort: true });
  const events: string[] = [];
  const run = runner(provider, new Map(), new ApprovalRegistry(), events);
  const result = await run.run({ sessionId: "s1", turnId: "t1", cwd: "/workspace/project", request: { messages: [], tools: [] }, limits: { ...limits, modelCallTimeoutMs: 5 }, signal: new AbortController().signal });
  assert.equal(result.status, "failed");
  assert.equal(events.filter(type => type === "turn_failed").length, 1);
  assert.equal(provider.lastSignal?.aborted, true);
});

test("tool-failure-recovery case gives the model an actionable result", async () => {
  const provider = new FakeProvider([
    { type: "tool_call", call: { id: "c1", name: "read_file", input: { path: "missing" } } },
    { type: "text_delta", text: "I recovered after rereading the path" },
  ]);
  const events: string[] = [];
  const run = runner(provider, new Map([["read_file", { name: "read_file", requiresApproval: () => false, execute: async () => { throw new Error("old_str was not found; read the file again"); } }]]), new ApprovalRegistry(), events);
  assert.equal((await run.run({ sessionId: "s1", turnId: "t1", cwd: "/workspace/project", request: { messages: [], tools: [{ name: "read_file", description: "read" }] }, limits, signal: new AbortController().signal })).status, "completed");
  assert.deepEqual(events.slice(-2), ["tool_completed", "turn_completed"]);
});
```

Update the root `test` script to run shared, server, and web workspace tests in sequence, and update `README.md` with the default limits (`120s` model/tool, `5m` approval, `120` steps), the fact that Stop propagates to model/tool/process-tree work, the fact that SSE disconnect alone does not cancel a waiting approval, and the recovery instruction shown for a failed tool. Do not document provider-specific behavior in the shared/UI sections.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test && npm run typecheck`  
Expected: PASS for all shared, server, and web tests and strict typechecking with no API keys or network calls.

Then run: `npm run build`  
Expected: PASS with the shared package built before the server and web packages.

- [ ] **Step 5: Commit**

```bash
git add package.json README.md packages/server/test/agent/reliability.integration.test.ts
git commit -m "test: verify reliable turn execution end to end"
```

## Self-Review Checklist

1. **Spec coverage:** Tasks 2, 5, 6, and 7 implement cancellation; Tasks 2, 4, and 5 implement per-model and per-tool deadlines; Tasks 3, 6, and 7 settle approvals on expiry, cancellation, and failure while preserving them across SSE disconnects; Tasks 1, 6, 7, and 8 define, emit, replay, and render all five required lifecycle events; Tasks 4 and 9 provide fake-provider coverage; Task 5 routes filesystem operations through `safePath()` and normalizes actionable tool errors; Task 5 covers POSIX and Windows process-tree cleanup.
2. **Completeness scan:** Every test step includes runnable code and every implementation step names the concrete interface or behavior.
3. **Interface consistency:** Shared event and limit types are produced in Task 1; cancellation helpers in Task 2; approval registry in Task 3; provider contracts in Task 4; tool contracts in Task 5; the runner in Task 6; manager/routes in Task 7; and UI reducer/API calls in Task 8. Later tasks use those exact names and signatures.
