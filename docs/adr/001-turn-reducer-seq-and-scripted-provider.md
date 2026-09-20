# ADR 001 — One Turn reducer in shared with seq, and step-scripted fake provider

**Date:** 2026-09-19
**Status:** Accepted (from exploration #3 + #6, Phases 1-3)
**Context:** Robust Turn Execution plan defines TurnStatus but no seq, derives status in 3 places, has non-atomic snapshot+subscribe replay race, and flat-list FakeProvider that cannot assert "tool result appended to next request".

## Decision

### 1. TurnState reducer in shared, seq owned by TurnManager

- Every StreamEvent has `{ seq, at, sessionId, turnId }`, seq per Turn monotonic from 1, owned by TurnManager single writer.
- `reduceTurnState(state, event) => state` pure, in `@windows-runner/shared`, used by server and UI. `TurnSnapshot.status` and `web/turn-state.ts` become readers, not re-derivers.
- `TurnResult` (returned from loop.run) removed — event log is single channel, usage also in terminal event.
- `turn_failed.code` narrowed to `TurnFailureCode` only, `ToolErrorCode` stays inside `ToolResult`.
- New events: `text_delta` (was missing), `tool_call` explicit with `callId`, `approval_resolved` explicit for replay.
- `TurnLogStore` seam: `append`, `read(afterSeq)`, `readAll`, `list`. `InMemoryTurnLogStore` now, `FileTurnLogStore` (JSONL) deferred.
- `subscribe(sessionId, turnId, afterSeq, listener) => { replay, state, unsubscribe }` atomic replay-then-live under one synchronous critical section.
- SSE: write `id: ${seq}`, honor `Last-Event-ID` header and `?afterSeq=` query now, not deferred.

### 2. Scripted fake provider with request recording

- `FakeProvider` takes `ProviderStep[]` where `ProviderStep = (request: LLMRequest) => ProviderStepResult`.
- Records `requests[]`, `lastSignal`, `lastSignals[]`.
- `ProviderStepResult = { chunks?, error?, hang?, ignoreAbort?, delayMs? }`.
- Helpers: `toolCall`, `text`, `failAfterPartialText`, `hang`, `ignoreAbort`, `malformedInput`, `unknownTool`, `assertThen`.
- `LLMRequest` tool results encoded as `role:"tool"` messages — standard, makes assertion possible.
- FakeClock for deterministic timing, shared with deadline module (candidate #1).

## Alternatives considered and rejected

### Alternative A — Loop owns seq, manager passive store (rejected)

- Loop maintains seq counter, emits sequenced events, manager just stores.
- **Why rejected:** Seq gaps if loop crashes mid-emit, duplicate seq if two runners for same turn, replay race still needs lock, restart recovery must trust loop, harder to enforce idempotency, deletion test moves complexity to already-busy loop. Manager as single writer is stronger invariant, matches event sourcing.

### Alternative B — Flat-list FakeProvider (current plan) (rejected)

- `new FakeProvider([chunk, ...])`, no request recording, only `waitForAbort` and rejected stream.
- **Why rejected:** Cannot express 2-step turns (which chunks go to which stream() call?), cannot assert "tool result appended", cannot simulate partial-then-fail, ignore-abort, malformed input, unknown tool deterministically. The interface is the test surface — flat list hides the decisive property. One adapter = hypothetical seam, but we have 3 adapters already, so seam is real — fake must be deep enough.

### Alternative C — Store = state + events, manager thin (rejected for persistence)

- Store saves both state and events, manager delegates.
- **Why rejected:** Two sources of truth can drift, file adapter harder to make atomic, bigger interface. Append-only log + manager as materialized view via reducer is simpler and standard.

### Alternative D — Defer Last-Event-ID (rejected)

- Implement seq but not Last-Event-ID, add later.
- **Why rejected:** With seq, Last-Event-ID is 3 lines (parse header, pass to subscribe, write id:). Without it, every reconnect replays full history, wasteful and UI must dedup. SSE spec already defines it, browsers send automatically. Cost negligible, benefit correctness.

## Consequences

- **Positive:** One state machine, one test suite (`shared/test/turn-reducer.test.ts`), closes replay race at source, enables idempotency, Last-Event-ID, future file store, transcript, crash recorder. FakeProvider makes recovery, denial, unknown-tool, max-steps observable in what model was sent.
- **Negative:** Migration: plan's `TurnResult`, `TurnSnapshot.status`, `web/turn-state.ts` must change. Acceptable because plan not yet implemented — cheap now, expensive later.
- **Follow-up:** #2 approval invariants, #1 deadline, #5 Tool contract, #4 ProjectRoot, #7 file store.

## References

- Phase 1: `docs/architecture/exploration-3-6/phase-1-turn-state-machine.md`
- Phase 2: `docs/architecture/exploration-3-6/phase-2-sequence-replay-persistence.md`
- Phase 3: `docs/architecture/exploration-3-6/phase-3-scripted-fake-provider.md`
- Report: `/tmp/architecture-review/architecture-review-20260919-192148.html` C3, C6

