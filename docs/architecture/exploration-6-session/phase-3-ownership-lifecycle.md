# Phase 3: Session Lifecycle, Ownership, API Contracts — Chosen C Hybrid

## Session type

```ts
interface Session {
  sessionId
  projectRoot: ProjectRoot // pinned, never changes
  activeTurnId: TurnId | null
  createdAt, lastActivityAt
  allowedRoots
}
```

## SessionManager

- sessions Map, pendingCreations Map as lock
- createSession: if exists or pending throw SESSION_ALREADY_EXISTS 409, else pending promise ProjectRoot.create validates against allowedRoots, stores pinned
- getOrCreateSession for implicit: if exists check canonicalRequested == pinned else ROOT_MISMATCH 400, if pending await same promise, else create
- getSession sync
- tryStartTurn sync atomic: if activeTurnId exists and not terminal (via isTurnTerminal callback) return 409 TURN_ALREADY_ACTIVE + activeTurnId, else set activeTurnId
- finishTurn idempotent clears guard on completion/cancel/failure via finally
- deleteSession aborts active and deletes, evictOldest deletes inactive oldest

## Atomic creation

- pendingCreations Map<sessionId, Promise<Session>> lock prevents duplicate concurrent creation
- Explicit create throws if pending, implicit returns existing after pending

## Cleanup

- Completion/cancel/failure via finally clears activeTurnId
- SSE disconnect observational only — does NOT clear lease
- DELETE cancels active + deletes

## Error payloads

- 409 TURN_ALREADY_ACTIVE {code, activeTurnId}
- 400 ROOT_MISMATCH {code, pinnedRoot, requestedRoot}
- 409 SESSION_ALREADY_EXISTS, 404 SESSION_NOT_FOUND, 403 PATH_ESCAPES_ROOT, 400 PATH_NOT_FOUND

## Persisted events

- turn_started includes root and realRoot for audit and future persistence
- SessionManager separate from TurnManager, ProjectRoot serialized as canonicalRoot

## Tests

- root change, concurrent starts, cleanup after failure, cancel + new turn, two sessions different roots, rejected roots/symlink escapes, concurrent creation pending lock, SSE disconnect observational only
