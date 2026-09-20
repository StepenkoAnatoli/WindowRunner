# Phase 2: Session Root Pinning & Concurrency Design

## Candidates

### A: Implicit session in TurnManager
- sessions Map<sessionId, {projectRoot, activeTurnId}>
- getOrCreateSession checks root pinning, throws ROOT_MISMATCH if different
- tryStartTurn sync atomic 409 TURN_ALREADY_ACTIVE
- Pros: No new endpoint, minimal. Cons: async race on new session creation

### B: Explicit SessionManager + POST /sessions
- New SessionManager class separate
- POST /api/sessions {sessionId, cwd} -> 201 pinned, 409 exists, 403 not allowed
- POST /turns requires session exists else 404, tryStartTurn 409
- Pros: Explicit lifecycle. Cons: New endpoint, client update

### C: Hybrid SessionManager + implicit + explicit, one-active-turn policy (Recommended)
- SessionManager separate, implicit creation allowed for backward compat, explicit optional
- Root pinning once, deterministic 409, pending creation lock for concurrent first-turn race
- Reuse for #7 persistence, ProjectRoot serialized as canonicalRoot
- API: POST /sessions/:sessionId {cwd} 201/409/403, POST /turns {cwd?, message} checks ROOT_MISMATCH 400, active guard 409, DELETE cancels active + deletes
- Top recommendation

## Comparison

| Criteria | A | B | C Recommended |
|----------|---|---|----------------|
| Root pinning | Yes | Yes explicit | Yes both |
| Validation at creation | Per turn | At explicit | At creation (explicit or implicit first) |
| Pinned capability | Yes | Yes | Yes |
| One-active-turn 409 | Yes but race on new session | Yes deterministic | Yes + pending lock |
| Cleanup | finishTurn | deleteSession | Both + eviction |
| Migration cost | Low | Medium | Low-medium, backward compat |
| Future persistence | Harder | Easy | Easy |
