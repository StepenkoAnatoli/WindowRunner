# ADR: AbortSignal replaces CancellationToken

Date: 2026-09-20
Status: Accepted
Context: Phase 4 integration of unified deadline module

## Problem

We had two cancellation mechanisms:
- `CancellationToken` custom class in `agent/cancellation.ts` with `isCancelled`, `onCancel` listeners
- `AbortSignal` from platform, used by fetch and LLM provider streaming

This caused:
- Duplicate propagation paths (token + signal)
- Wrong-way dependency `providers/model-call -> agent/timeout` and `agent/cancellation`
- Need to translate token to signal for providers that expect AbortSignal
- No standard `reason` carrying typed DeadlineError

## Decision

Delete `CancellationToken` and `agent/timeout.ts`, use only `AbortSignal` + `DeadlineError` as abort reason.

### Why AbortSignal wins

- **Standard**: Web platform, Node 18+, fetch, streams, LLM providers already accept it
- **Composes**: Parent abort propagates to child via `addEventListener("abort", ..., {once:true})`, child may shorten never extend
- **Reason**: `signal.reason` carries typed `DeadlineError` with `kind` and `operationKind`, no reconstruction at catch site
- **Single source**: `Deadline` owns timer + parent listener + grace timer, idempotent cancel/dispose, no duplicate timers
- **Dependency direction**: Infra `deadline.ts` has zero agent imports, providers can depend on infra without circular deps
- **Abort-and-await**: Signal first, then await shutdown with bounded grace, distinct `shutdown_timeout` without false claim dead — impossible with custom token that had no grace concept

### Deletion test

- No file imports `cancellation.ts` after migration
- `providers/model-call.ts` no longer imports `agent/timeout`
- All 40 tests pass with only AbortSignal
- FakeClock tests cover timeout vs cancellation races with exactly one terminal outcome

## Consequences

- `DeadlineError` is the only cancellation/timeout error type, with `kind` deadline_expired|cancelled|shutdown_timeout and `operationKind` model|tool|approval
- Mapping to shared codes (`MODEL_TIMEOUT`, `TOOL_TIMED_OUT`, etc) happens once at loop boundary via `mapDeadlineError`
- Approval expiry via `Deadline` timer, not `setTimeout` directly, single source of expiry
- No custom token to maintain

## Rejected alternative

Keep CancellationToken and wrap AbortSignal: adds translation layer, duplicate listeners, leak risk, and still needs deadline logic. Rejected because AbortSignal already provides everything token did plus standard integration.
