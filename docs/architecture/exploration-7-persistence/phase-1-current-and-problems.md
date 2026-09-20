# Exploration #7 — File Persistence — Phase 1: Current and Problems

## Current implementation

### TurnLogStore seam (shared)

```ts
interface TurnLogStore {
  append(turnId, event): Promise<void>
  read(turnId, afterSeq): Promise<StreamEvent[]>
  readAll(turnId): Promise<StreamEvent[]>
  list(): Promise<TurnId[]>
}
```

### InMemoryTurnLogStore

- `Map<turnId, StreamEvent[]>`
- `append` idempotent on seq (checks some e.seq === event.seq)
- `read` filters seq > afterSeq
- `readAll` returns copy
- `list` returns keys
- No durability, no crash recovery, no eviction persistence

### TurnManager

- `logs = Map<turnId, TurnLog>` where TurnLog {events, state, seqCounter, listeners}
- `ensureLog(sessionId, turnId, limits)` creates initial state if not exists
- `append(sessionId, turnId, eventWithoutSeq)`:
  - If state.isTerminal, returns dummy event with current seq, does NOT append, does NOT notify, does NOT persist (prevents appending after terminal)
  - Else seqCounter++, stamps seq/at/sessionId/turnId, folds via reduceTurnState, pushes to events, updates state, notifies listeners synchronously, persists async via store.append(...).catch()
  - Persistence is async, not durable before notification — listeners get event before store confirms
- `subscribe(sessionId, turnId, afterSeq, listener)` atomic replay-then-live synchronous, no gap
- `snapshot` returns state + events
- `evictOldest(maxTurns)` deletes oldest logs from Map, but not from store
- `boot()` for restart simulation: lists turnIds from store, reads all events, folds to state, if not terminal appends RESTART failure event (seqCounter++, turn_failed RESTART), persists RESTART, sets log

### SessionManager

- `sessions = Map<sessionId, Session>` where Session {sessionId, projectRoot (pinned), activeTurnId, createdAt, lastActivityAt, allowedRoots}
- `pendingCreations` Map for atomic creation lock
- `createSession`, `getOrCreateSession` checks ROOT_MISMATCH, validates via ProjectRoot.create against allowedRoots
- `tryStartTurn` sync atomic 409 TURN_ALREADY_ACTIVE, `finishTurn` idempotent, `deleteSession`, `evictOldest`
- Currently in-memory only, no persistence

### App.ts

- Uses TurnManager + SessionManager + ApprovalRegistry + activeControllers Map<turnId, AbortController>
- POST /sessions/:sessionId creates session via SessionManager, 201/409/403
- POST /turns uses SessionManager.getOrCreateSession (implicit) + tryStartTurn 409, then TurnRunner.run with pinned projectRoot, finally finishTurn + evictOldest
- GET /events uses TurnManager.subscribe, SSE
- Persistence is async, not awaited before notifying

## Problems

### P1: No durable FileTurnLogStore

- InMemory store loses all on restart. boot() exists but only works if store is file-based. Currently comment says "Future: FileTurnLogStore implements same interface with JSONL per turn under WINDOWS_RUNNER_DATA_DIR, deferred to candidate #7"
- Need to implement FileTurnLogStore with JSONL format and atomic append

### P2: Storage layout undefined

- Per-session vs per-turn file layout under pinned ProjectRoot? Currently plan says JSONL per turn under WINDOWS_RUNNER_DATA_DIR, but should it be under pinned ProjectRoot or under global data dir? Security: persisted paths must remain informational and must never override newly validated allowedRoots. So layout must not allow persisted path to escape.
- Options: 
  - Global data dir: `WINDOWS_RUNNER_DATA_DIR/sessions/<sessionId>/turns/<turnId>.jsonl` — independent of ProjectRoot, safe
  - Under pinned ProjectRoot: `<projectRoot>/.windows-runner/turns/<turnId>.jsonl` — ties logs to project, but if projectRoot changes or is deleted, logs lost. Also security: if persisted metadata contains root path, must not override allowedRoots validation on restart.
- Need to decide per-session vs per-turn file layout, and where session metadata persisted

### P3: Session metadata persistence missing

- SessionManager currently in-memory only. On restart, sessions lost, so turns that were active become RESTART failures but session root pinning lost. Need to persist session metadata: pinned root (canonical), timestamps, active-turn state (but active-turn should be cleared on restart? Or marked RESTART?)
- Session metadata file: `sessions/<sessionId>/meta.json` with `{sessionId, canonicalRoot, realRoot, createdAt, lastActivityAt, allowedRoots}` — but realRoot and allowedRoots must be re-validated against current config on recovery, not trusted blindly.

### P4: Restart recovery for non-terminal turns using RESTART

- boot() already appends RESTART failure for non-terminal turns, but only if store.list() returns turnIds. For file store, list() must read filesystem. Also need to handle session recovery: if session had activeTurnId that is non-terminal, on restart activeTurnId should be cleared and turn marked RESTART, session remains pinned.
- Also need to handle approval registry recovery? Approvals are in-memory, not persisted, so on restart pending approvals should be cancelled? Or should they be recovered? Currently approvals.cancelTurn called in TurnRunner finally, but on restart no finally. So boot() should also cancel approvals? Or approvals should be persisted? For minimal, on restart pending approvals become cancelled via RESTART failure.

### P5: Recovery behavior for truncated, malformed, duplicated, out-of-order event lines

- JSONL: each line is JSON event. What if file has truncated last line (crash during append), malformed JSON line, duplicated seq, out-of-order seq?
- Need to define:
  - Truncated: last line incomplete -> ignore last line, recover up to last complete line
  - Malformed: line not JSON -> skip line, log warning, continue? Or treat as corruption and ignore rest?
  - Duplicated seq: InMemory already idempotent on seq, file store should also be idempotent — if append with same seq already exists, skip
  - Out-of-order: events should be sorted by seq on read, not file order? Or file order should be seq order, but if out-of-order due to concurrent writers, need to sort and deduplicate by seq on readAll
  - Sequence validation: seq must be monotonic increasing per turn, starting from 1, no gaps? Or allow gaps but reducer handles? Currently reducer allows gaps (resilience). For persistence, should validate seq > 0 and turnId matches file, sessionId matches?

### P6: Concurrent writers and process-crash scenarios

- TurnManager.append is single writer per turn (seqCounter owned by TurnManager, single writer, monotonic, no gaps). But if two processes write to same file (e.g., two server instances), concurrent appends could interleave and corrupt JSONL. Need to handle:
  - Single process, single writer: TurnManager ensures seqCounter single writer, so file appends are serialized per turn if we make FileTurnLogStore.append atomic (e.g., appendFile with O_APPEND, which is atomic for small writes on POSIX)
  - Multiple processes: need file lock or rely on O_APPEND atomicity? For minimal, assume single process, single writer per turn, document that concurrent writers not supported, or use file lock via fs.open with exclusive?
  - Process crash during append: last line may be truncated, need to handle truncated line on recovery

### P7: Durability before notification vs async

- Currently TurnManager.append notifies listeners synchronously before store.append completes (async, not awaited). So SSE clients get event before durability. If crash after notify but before persist, event lost on restart, but client already saw it — inconsistency.
- Options:
  - Durable before notification: await store.append before notifying listeners — ensures durability, but adds latency, and if store is slow, SSE delayed
  - Async remains: keep current, but document that persistence may lag notification, and on restart client may need to replay from last persisted seq, not last seen seq? Or client should handle missing events via Last-Event-ID replay that will miss non-persisted events, but that's ok if we treat non-persisted as lost and RESTART will mark turn as failed?
- Need to decide and document.

### P8: Retention, eviction, cleanup

- TurnManager.evictOldest deletes from Map but not from store. File store should also delete files when evicted, or have retention policy.
- SessionManager.evictOldest deletes sessions where activeTurnId null, but not their turn logs. Need to define: evict session also deletes its turn logs? Or keep turn logs for history?
- Need retention: keep last N turns per session or global? Cleanup old sessions/turn logs based on age or count.

### P9: Security — persisted paths informational, never override allowedRoots

- Persisted session meta contains canonicalRoot and realRoot. On recovery, must NOT trust persisted root blindly — must re-validate against current allowedRoots config and current filesystem realpath. If persisted root not inside current allowedRoots, reject session recovery (mark turns as failed? Or delete session?).
- Persisted turn_started event contains root and realRoot — informational, must not override newly validated allowedRoots. On boot, should use session's pinned root, not event's root, for authorization.
- Key rule: persisted session metadata can request recovery, but only current configuration and ProjectRoot validation can authorize filesystem access.

### P10: Migration for existing in-memory logs and older events missing providerCallId

- Existing InMemory logs have events without providerCallId (old ApprovalRequest). File store should handle migration: on read, if ApprovalRequest missing providerCallId, set providerCallId = requestId or empty? Or handle gracefully.
- Also older events missing createdAt, expiresAt, etc. Need to handle missing fields with defaults.
- Migration from in-memory to file: on first boot with file store, if in-memory logs exist, should they be persisted? For minimal, start fresh.

## Next phase

Propose storage layout and recovery invariants, define durable schemas, specify crash/corruption behavior, with candidates for file layout and durability.
