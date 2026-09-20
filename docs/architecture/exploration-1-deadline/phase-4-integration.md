# Phase 4 Integration — Unified Deadline Module

## What was migrated

- `packages/server/src/deadline.ts` implemented:
  - `Deadline` interface signal/expiresAt/kind/cancel/dispose
  - `DeadlineError` kind deadline_expired|cancelled|shutdown_timeout + operationKind model|tool|approval + partials
  - `createDeadline(parentSignal, timeoutMs, {kind, clock, now})` — parent listener once:true, deadline timer, expiresAt = min(parent.__deadline_expiresAt, now+timeout)
  - `runWithDeadline(operation(signal), {parentSignal, timeoutMs, kind, clock, shutdownGraceMs})` two-phase abort-and-await
  - Clock abstraction for FakeClock

- Consumers:
  - `providers/model-call.ts` kind=model, preserves partialText/ToolCalls/Usage on DeadlineError, no longer imports agent/timeout
  - `agent/tools/executor.ts` kind=tool, maps expired->TOOL_TIMED_OUT, shutdown_timeout->TOOL_FAILED with distinct message no false claim dead
  - `agent/approval-registry.ts` kind=approval, request() mints apr_ id with providerCallId correlation, byTurn index, deadline owner, settle() sole mutator first-wins, wait() returns ApprovalResolution union, cancelTurn via settle(cancelled)
  - `agent/loop.ts` uses new registry API request() with parentSignal, wait() resolves union, maps DeadlineError to shared codes at event boundary once, turn root AbortController remains only turn-level source, each consumer disposes in finally

- Deleted:
  - `agent/timeout.ts`
  - `agent/cancellation.ts`
  - Fixed wrong-way dep providers/model-call -> agent/timeout

- Shared types:
  - `ApprovalRequest` now includes providerCallId and createdAt, expiresAt single source from registry
  - `approval_resolved` includes optional resolution for replay

## Verification

- tsc shared/server/web passes
- 36 tests shared/agent/deadline/web + 4 routes = 40 passing
- 10 lifecycle scenarios + 2 integration with FakeClock + leak assertions:
  1. Parent cancel during model streaming
  2. Parent cancel during tool execution
  3. Parent cancel during approval wait
  4. Child timeout sibling isolation
  5. Repeated abort idempotent
  6. Same-tick timeout vs cancel exactly one terminal
  7. Provider resolves during grace -> confirmed stopped
  8. Provider never resolves within grace -> shutdown_timeout
  9. Disposal before expiry and after settlement no leaks
  10. Nested child outlive attempt child expiresAt <= parent
  11. Integration model vs tool vs approval sibling isolation
  12. Integration abort-ignoring provider shutdown_timeout distinct
- Leak checks: clock.timers==0, _timer undefined, disposed true, entries/byTurn size 0, exactly one terminal, no duplicate approval_resolved, no sibling cancel
- No infra->agent imports

## Ownership matrix

| Operation | Owner | TimeoutMs | Grace | Parent | Disposes in |
|-----------|-------|-----------|-------|--------|-------------|
| Turn | loop | none | - | none | finally cancelTurn |
| Model call | runModelCall | limits.modelCallTimeoutMs | 1000ms | turn signal | finally |
| Tool call | executor | limits.toolTimeoutMs | 5000ms | turn signal | finally |
| Approval | registry.request | limits.approvalTimeoutMs | 0 | turn signal | settle |

Child may shorten never extend/detach parent. Parent propagates exactly once via once:true listener removed in dispose.

## Abort-and-await contract

Phase1: race operation vs abort (deadline expiry or parent cancel) — signal aborts first
Phase2: await operation shutdown with bounded grace timer, race operation settlement vs grace timeout
- If operation settles within grace: throw signal.reason (expired or cancelled)
- If not within grace: throw shutdown_timeout with message "abort requested, operation not confirmed stopped"
No false claim dead.

## ADR

See adr-abort-signal-vs-cancellation-token.md — AbortSignal replaces CancellationToken because standard, composes, carries typed reason, fixes dependency direction, enables abort-and-await with grace.
