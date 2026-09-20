# ADR 002 — Approval identity minted by registry, provider call ID is correlation metadata

**Date:** 2026-09-19
**Status:** Accepted (from exploration #2, Phases 1-4)
**Context:** Robust Turn Execution plan used provider's toolCall.id as approval requestId in global Map. OpenAI-compatible servers emit call_0, call_1 per turn, FakeProvider always c1 — concurrent turns collide, register throws "already exists", turn fails. Also expiry had two sources: request.expiresAt (computed in loop for UI) and timeoutMs (passed to registry for timer) — can drift.

**Decision:**

- **ApprovalRegistry mints requestId** as `apr_<now>_<counter>_<rand>`, globally unique, per session/turn/provider call. Counter deterministic for tests, random suffix for prod uniqueness.
- **Provider's call id stored as providerCallId field** for correlation and debugging, never used as registry key. ApprovalRequest shape: `{ requestId (minted), providerCallId, sessionId, turnId, toolName, input, reason, expiresAt, createdAt }`.
- **Registry computes expiresAt = now + timeoutMs once**, single source, returns request with createdAt and expiresAt. Loop no longer computes expiry.
- **Internal:** `Map<requestId, Entry>` global unique + `Map<turnId, Set<requestId>>` index for cancelTurn and snapshot, O(1) cleanup per turn.
- **Settlement:** One internal `settle(requestId, resolution)` path used by approve/deny, expiry timer, cancelTurn, terminal cleanup. First caller removes from global map and turn index, clears timer, resolves promise exactly once with ApprovalResolution union, returns `{ settled: boolean, request }`. Later callers get `settled:false` no-op, no duplicate approval_resolved events, no recreation. Callers may emit approval_resolved only when settled:true.
- **ApprovalResolution union:** `approved | denied | expired | cancelled` — single settlement type. wait() always resolves with union for expected outcomes, never rejects; rejection reserved for unexpected internal failures.
- **Live vs replay separation:** Registry owns live promises, reducer owns TurnState.pendingApprovals Map. Replaying approval_resolved only folds reducer state, never invokes pending promise resolver. Reducer remains pure.
- **Disconnect:** SSE unsubscribe only removes listener, never calls cancelTurn or settle. Approval remains pending after disconnect and is replayed on reconnect via afterSeq and Last-Event-ID.
- **Route auth:** Validate URL sessionId vs request's stored sessionId — 404 if mismatch (request does not belong to session), 409 if already settled (belongs but stale).
- **Cleanup:** Guaranteed after decision, expiry, cancellation, terminal failure, turn completion — both maps empty, no leaked timers. Inspect both maps after every scenario.

**Alternatives considered:**

- **Option A (rejected):** Loop mints turnId:callId namespaced — still two expiry sources, easy to forget namespacing, identity not owned by registry.
- **Option B (rejected):** Keep provider id as key but namespace by turnId in Map key — still provider-controlled, not globally unique, still collision if provider reuses id within same turn.
- **Option C (rejected for settlement):** Keep resolve/reject separate (resolve for approve/deny, reject for expired/cancelled) — two promise modes for same concept, need try/catch for expected cases, harder race reasoning.

**Consequences:**

- Positive: No collision across concurrent turns, single expiry source, testable, clear ownership, race-safe settlement, disconnect semantics correct, replay separation, leak detection via map inspection.
- Negative: ApprovalRequest shape adds providerCallId and createdAt — need to update shared type and all consumers (loop, routes, UI, tests), but cheap now before many consumers. Minted id random, not deterministic — need deterministic counter + FakeClock for tests or injectable id generator.
- Follow-up: Update UI and test fixtures to use minted ids, keep providerCallId for display. Define future Deadline interface and have ApprovalRegistry consume it for expiry, not duplicate timers. After #2, proceed to #1 unified deadline, using approval expiry as first consumer.

**References:**

- Phase 1: `docs/architecture/exploration-2-approval-invariants/phase-1-identity-and-ownership.md`
- Phase 2: `docs/architecture/exploration-2-approval-invariants/phase-2-settlement-paths.md`
- Phase 3: `docs/architecture/exploration-2-approval-invariants/phase-3-disconnect-replay-cleanup.md`
- Phase 4: `docs/architecture/exploration-2-approval-invariants/phase-4-integration.md`
- Report: `/tmp/architecture-review/architecture-review-20260919-192148.html` C2

