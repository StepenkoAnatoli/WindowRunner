# Exploration #6 (aka #4) — Session Root Pinning & Concurrency — Phase 1: Current and Problems

## Current

- No explicit Session object. TurnManager stores Map<turnId, TurnLog> with sessionId inside TurnState, but no session-level state.
- Each turn receives cwd string and creates ProjectRoot inside TurnRunner.run() via ProjectRoot.create(cwd, allowedRoots). So root can change between turns silently.
- No validation that requested root is inside allowedRoots at session creation vs turn creation.
- No active-turn guard: app.ts stores activeControllers Map<turnId, AbortController> but not per session. Two concurrent POST /turns for same sessionId could both start.
- No session cleanup.
- Tools receive ProjectRoot per turn, not pinned session root.

## Problems

- P1: Session root not pinned — first turn /workspace/project, second /workspace/other should be rejected but allowed
- P2: Root not validated against allowedRoots at session creation, only per turn
- P3: No active-turn guard — at most one active turn per session required, second should get 409 deterministically
- P4: Session cleanup not releasing bookkeeping
- P5: Every tool should receive pinned capability, not per-turn reconstruction
- P6: No session creation endpoint

## Tests missing

- root changes between turns -> 400 ROOT_MISMATCH
- two concurrent starts -> 409 TURN_ALREADY_ACTIVE
- cleanup after failure, cancel + new turn, two sessions different roots, rejected roots/symlink escapes at session creation
