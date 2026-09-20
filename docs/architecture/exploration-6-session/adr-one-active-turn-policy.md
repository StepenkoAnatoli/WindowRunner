# ADR: One-Active-Turn Per Session Policy with Hybrid Session Creation

Date: 2026-09-20
Status: Accepted
Context: #4 minimum ProjectRoot model, session root pinning & concurrency

## Problem

No session object, no active guard, no root pinning: root could change silently, concurrent POST /turns could race, no cleanup, tools received per-turn root not pinned.

## Decision

SessionManager separate from TurnManager, hybrid implicit and explicit creation, one-active-turn as deliberate policy.

- Session {projectRoot pinned, activeTurnId, createdAt, lastActivityAt, allowedRoots}
- pendingCreations lock prevents duplicate concurrent creation
- createSession explicit 201/409/403, getOrCreateSession implicit checks ROOT_MISMATCH 400
- tryStartTurn sync atomic 409 TURN_ALREADY_ACTIVE + activeTurnId, finishTurn idempotent via finally
- DELETE cancels active and deletes, evictOldest deletes inactive
- SSE disconnect observational only — does not release lease
- turn_started includes root and realRoot for persistence

## Why C over A/B

- A Implicit in TurnManager: no new endpoint but async race on new session creation, mixes concerns
- B Explicit SessionManager: clear API but breaks backward compat
- C Hybrid: separate, implicit for compat + explicit optional, deterministic 409, pending lock, reuse for persistence

## Consequences

- Root pinned once, validated against allowedRoots at creation, later turns cannot change
- One-active-turn deterministic 409, pending lock prevents duplicate
- Every tool receives pinned capability
- Cleanup via finally, DELETE cancels active
- SSE disconnect observational only
- Future persistence can reuse SessionManager

## Tests

Root change, concurrent starts, cleanup after failure, cancel + new turn, two sessions different roots, rejected roots/symlink escapes, concurrent creation, SSE disconnect observational only, explicit creation routes
