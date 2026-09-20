# Exploration #7 — Phase 3: Detailed Specification for C Hybrid

## 1. Schemas

### Directory layout

```
WINDOWS_RUNNER_DATA_DIR (env var, default OS temp or ./data)
  sessions/
    <sessionId>/
      meta.json
      turns/
        <turnId>.jsonl
  turns/  # legacy flat fallback for migration
    <turnId>.jsonl
```

- `sessionId` and `turnId` validated: alphanumeric, dash, underscore, max 128 chars, no path separators, no ".."
- `meta.json` atomic write: write to temp file `meta.json.tmp.<rand>` then rename to `meta.json` (atomic on POSIX)
- Turn file: `<turnId>.jsonl` where turnId matches filename without extension

### Session meta schema versioned

```ts
interface SessionMetaV1 {
  version: 1
  sessionId: SessionId
  canonicalRoot: string // e.g. "/home/user/projects/foo" — informational, must re-validate
  realRoot: string      // realpath(canonicalRoot) — informational, re-validated
  createdAt: number     // ms since epoch
  lastActivityAt: number
  activeTurnId: TurnId | null // transient, cleared on boot
  allowedRootsSnapshot?: string[] // informational only, never override current config
}
```

Validation on load:
- version must be 1, if missing assume 1 for migration
- sessionId must equal directory name, else reject file
- canonicalRoot must be string, non-empty
- realRoot must be string, non-empty
- createdAt, lastActivityAt must be numbers >0
- activeTurnId must be string or null
- allowedRootsSnapshot optional, if present array of strings, informational only

Security: canonicalRoot and realRoot are informational only. On recovery, must call `ProjectRoot.create(canonicalRoot, currentAllowedRoots)` where currentAllowedRoots from env/config, not from snapshot. If fails (PATH_ESCAPES_ROOT, PATH_NOT_FOUND), skip entire session, log warning, do not load its turns. realRoot must match realpath(canonicalRoot) after validation, if mismatch log warning but use validated realRoot.

### Event JSONL schema versioned

Each line: JSON.stringify(StreamEvent) + "\n"

```ts
type StreamEvent = {
  seq: number // >0, monotonic per turn, unique
  at: number // ms
  sessionId: SessionId
  turnId: TurnId
  type: string // turn_started, text_delta, tool_call, etc
  // ... rest per type
  // legacy: providerCallId may be missing, createdAt may be missing
}
```

Required identity fields per line:
- seq: number >0 integer
- at: number >0
- sessionId: string must equal directory sessionId (for per-session layout) or if flat fallback, any but will be grouped by file's session? Actually turn file contains events for one turn, so sessionId should be consistent across all events in file
- turnId: string must equal filename turnId (without .jsonl)

Validation rules:
- seq must be integer >0
- at must be number >0
- sessionId must be string non-empty, must equal expected sessionId (directory name) if per-session layout, else if mismatch skip line
- turnId must equal expected turnId (filename), else skip line
- type must be known StreamEvent type, if unknown skip line with warning (forward compat)
- For approval events: if providerCallId missing, fallback to requestId (migration). If createdAt missing, fallback to at. If expiresAt missing, fallback to at+300000. If resolution missing, fallback.

Legacy fallback:
- Old events missing providerCallId: set providerCallId = requestId || ""
- Old events missing createdAt: set createdAt = at
- Old events missing expiresAt: set expiresAt = at + 5min
- Old events missing version: assume version 1

## 2. Append and durability

### Per-turn serialization

- FileTurnLogStore maintains `Map<turnId, Promise>` chain to serialize writes per turn within process
- `append(turnId, event)` does:
  1. Validate event identity fields (seq>0, turnId matches arg, sessionId present)
  2. Get or create queue promise for turnId: `queue = (queues.get(turnId) || Promise.resolve()).then(() => doAppend)`
  3. `doAppend`: open file in append mode, write JSON.stringify(event)+"\n", optionally fsync, handle errors
  4. Store queue back to map, remove on completion
- This prevents interleaving of JSON lines for same turn even if TurnManager calls append concurrently (should not happen due to seqCounter single writer, but queue provides safety)

### Append atomicity

- Use `fs.appendFile` with O_APPEND flag (Node default for appendFile)
- POSIX guarantees O_APPEND writes < PIPE_BUF (typically 4096) are atomic (no interleaving)
- Events typically <4KB JSON, so atomic
- For larger events (>4KB), atomicity not guaranteed but per-turn queue prevents interleaving within process; multi-process interleaving could still happen but documented as single process only
- Write is single `write` syscall with "\n" terminator, so truncated only if crash during write

### Flush/fsync behavior by configuration

```ts
interface FileTurnLogStoreOptions {
  dataDir: string
  fsync?: boolean // default false for performance, true for durability
  durableBeforeNotify?: boolean // default false for backward compat, true recommended for file store
}
```

- If fsync=false: rely on OS buffer, faster, possible loss of last few events on crash (but truncated handling recovers)
- If fsync=true: after appendFile, open file descriptor and fsync (or use `fs.open` + `write` + `fsync` + `close`), ensures durability before returning
- Recommendation: fsync=false for dev, fsync=true for production if durability required

### Notification ordering for durable and async modes

- TurnManager currently notifies listeners synchronously before store.append completes (async mode)
- For file store with durableBeforeNotify=true:
  - TurnManager.append should await store.append before notifying listeners
  - Implementation: make TurnManager.append async? Currently sync. Options:
    - Option 1: TurnManager.append remains sync for InMemory but for File store, make it async and await in TurnRunner loop before next step? But loop already awaits model calls
    - Option 2: Keep TurnManager.append sync but have FileTurnLogStore.append return promise that TurnManager awaits before notify only if durableBeforeNotify=true — requires TurnManager to accept async store and await
  - For minimal, implement FileTurnLogStore.append as async and TurnManager will have new method `appendAsync` that awaits store before notify when durable option set, or keep current async but document possible loss and that RESTART will mark turn as failed if non-persisted events lost
  - Decision: implement FileTurnLogStore with durableBeforeNotify option in TurnManager: if store is FileTurnLogStore and durableBeforeNotify=true, then TurnManager.append will await store.append before notifying (make append async). For backward compat, InMemory remains sync but async wrapper.
- Notification ordering:
  - Async mode (current): notify listeners immediately, persist in background, faster, possible inconsistency on crash (client saw event not persisted, on restart event missing, client replay from afterSeq will miss)
  - Durable mode: persist first (await append+optional fsync), then notify, ensures durability before SSE, slower but correct, no inconsistency

## 3. Recovery

### Truncated final line: ignore

- On read, read entire file content as utf8
- Check if content ends with "\n": if not, last chunk after last "\n" may be incomplete
- Split by "\n", for each chunk:
  - If chunk is empty (from trailing newline) skip
  - If chunk is last chunk and file does not end with "\n" and JSON.parse fails, ignore last chunk (truncated), log warning
  - Else try parse
- This handles crash during append where last line incomplete

### Malformed middle line: skip and warn

- If JSON.parse fails and chunk is not last truncated case, skip line with warning, continue to next line
- Do not abort whole file, one bad line should not lose entire turn
- Log warning with turnId, line number, error
- Observability: count skipped lines, expose via boot diagnostics

### Duplicate sequence: keep first

- Maintain Map<seq, event> for dedup
- On parsing valid event, if seq already exists in Map, skip subsequent with warning, keep first occurrence
- Log warning duplicate seq
- This handles idempotent append (InMemory already idempotent) and crash retry

### Out-of-order sequence: sort only if policy remains unambiguous

- Decision: sort by seq ascending after collecting valid events, because seq is authoritative ordering, file order may be out-of-order due to concurrent writers (though per-turn queue prevents within process, but if file edited manually or multi-process, could be out-of-order)
- Sorting is unambiguous because seq is unique and monotonic per turn, so sorting by seq restores correct order
- However, if out-of-order is due to corruption (e.g., seq reused), dedup handles
- Policy: sort by seq ascending, but if gap detected or duplicate, warn
- Alternative: reject out-of-order and quarantine file — but sorting is safer and matches InMemory behavior where events are pushed in seq order but readAll filters by afterSeq, not file order
- So: sort only if needed, but always sort to ensure monotonic

### Sequence gaps: warn and expose diagnostics

- After sorting by seq, check for gaps: for i from 1 to len-1, if events[i].seq != events[i-1].seq +1, log warning gap detected (e.g., missing seq 3, jump from 2 to 4)
- Allow gaps (reducer resilience: reducer allows gaps, it folds events regardless of gap, but seq is used for replay filtering)
- Expose diagnostics: return {events, warnings: [{type:"gap", expected, actual, turnId}]}
- Gaps could occur if append failed for some seq but later succeeded, or if file truncated and middle lines skipped

### Identity mismatches: reject/quarantine rather than silently merge

- If event.sessionId != expected sessionId (directory name), reject line (skip) with warning, do not merge into wrong session
- If event.turnId != expected turnId (filename), reject line with warning
- If sessionId inconsistent across events in same file (e.g., file contains events for different sessions), reject inconsistent lines, keep only those matching expected sessionId (first event's sessionId or directory)
- Quarantine: if file has >50% invalid lines, consider quarantining entire file (move to .quarantine dir) and log warning, but for minimal, just skip invalid lines and keep valid

## 4. Restart

### Clear persisted activeTurnId

- On boot, for each session meta.json, set activeTurnId to null (transient, cannot survive restart)
- Persist updated meta.json with activeTurnId=null after recovery
- This ensures no session thinks it has active turn after restart

### Revalidate persisted root against current allowedRoots

- For each session meta, call `ProjectRoot.create(canonicalRoot, currentAllowedRoots)` where currentAllowedRoots from env/config (not from snapshot)
- If fails (PATH_ESCAPES_ROOT, PATH_NOT_FOUND), skip session entirely, log warning, do not load its turns, optionally delete or quarantine meta.json
- If succeeds, compare realRoot from meta with realpath(canonicalRoot) from validation, if mismatch log warning but use validated realRoot
- Never use allowedRootsSnapshot to authorize, only current config
- Turn_started event's root is informational, not used for auth, only session meta's canonicalRoot after re-validation

### Append RESTART for non-terminal turns using next sequence

- After reading and folding events for a turn, check if state.isTerminal
- If not terminal, append RESTART event:
  ```ts
  {
    seq: maxSeq+1,
    at: now(),
    sessionId: state.sessionId,
    turnId: state.turnId,
    type: "turn_failed",
    code: "RESTART",
    message: "server restarted",
    retryable: false
  }
  ```
- Persist RESTART via store.append (with same durability guarantees)
- Update in-memory state via reducer
- This matches existing TurnManager.boot() behavior

### Never let old metadata authorize access

- Key rule: persisted session metadata can request recovery, but only current configuration and ProjectRoot validation can authorize filesystem access
- Implementation: on boot, re-validate all session roots against current allowedRoots, reject if not inside
- On turn execution after boot, TurnRunner receives pinned ProjectRoot from session (re-validated), not from event
- Persisted paths in events (e.g., tool inputs containing paths) are not trusted for authorization, only validated via ProjectRoot.resolve at execution time

## 5. Operational behavior

### Retention and eviction ordering

- Retention config:
  ```ts
  interface RetentionOptions {
    maxTurnsPerSession?: number // default 100
    maxSessions?: number // default 100
    maxAgeMs?: number // default 30 days
  }
  ```
- Eviction ordering:
  1. List sessions sorted by lastActivityAt ascending (oldest first)
  2. For each session, list turns sorted by last event at ascending
  3. If session count > maxSessions, delete oldest sessions where activeTurnId==null (inactive), including their turn files
  4. If per-session turn count > maxTurnsPerSession, delete oldest turn files in that session
  5. If turn age > maxAgeMs, delete turn file
  6. Eviction triggered on TurnManager.evictOldest and SessionManager.evictOldest, and on boot if retention exceeded
- Deletion: delete file via fs.unlink, delete session dir via fs.rm recursive if empty or if session evicted
- Complexity: session eviction deletes turn logs (since session owns turns), but could be configurable to keep logs

### Crash recovery during append

- Crash during appendFile: last line may be truncated (no newline or incomplete JSON)
- Recovery: truncated last line ignored as above, so crash loses at most last event, which is acceptable if durable-before-notify=false, but if durable=true and fsync=true, crash after fsync should not lose, crash before fsync may lose
- For meta.json atomic write: write to temp file then rename, so crash during write leaves old meta intact, not corrupted, temp file may be left but ignored on next boot (cleanup temp files)

### Concurrent process/session access

- Single process: per-turn queue ensures serialized writes, TurnManager seqCounter single writer, safe
- Multi-process: not supported in minimal, but O_APPEND atomic prevents corruption for <4KB writes, but seq may interleave if two processes write to same turn file concurrently (should not happen because only one server should own turn)
- For session meta: atomic write via temp+rename prevents corruption, but concurrent writes from two processes could still race (last write wins), so document single process ownership
- Optional file lock: could implement via `proper-lockfile` or simple lock file `meta.json.lock` with exclusive create, but for minimal document single process and rely on queue

### Fallback-layout migration

- On boot, check for legacy flat `turns/<turnId>.jsonl` files
- For each legacy file, parse first event to get sessionId, then move file to `sessions/<sessionId>/turns/<turnId>.jsonl` (create dir if needed)
- If session dir does not have meta.json, derive meta from first turn_started event in legacy file (canonicalRoot, realRoot) and attempt to validate against current allowedRoots, if valid create meta.json
- After migration, delete legacy flat file or keep as backup
- This enables migration from in-memory or flat layout to per-session layout

### Observability for skipped, quarantined, or incomplete records

- Boot should return diagnostics:
  ```ts
  interface BootDiagnostics {
    sessionsLoaded: number
    sessionsSkipped: number // due to root re-validation failure
    turnsLoaded: number
    turnsWithRestart: number
    eventsSkipped: number // malformed, identity mismatch, duplicate
    truncatedLinesIgnored: number
    gapsDetected: number
    quarantinedFiles: string[]
    warnings: string[]
  }
  ```
- Log warnings via console.warn or structured logger
- For skipped lines, log turnId, line number, reason
- For quarantined files (if >50% invalid), move to `quarantine/` dir and log

## 6. Decision on sorting out-of-order events

- Decision: sort by seq ascending after dedup, because seq is authoritative ordering per turn, file order may be out-of-order due to crash, manual edit, or multi-process, but seq defines correct order for replay and reducer
- Sorting is unambiguous because seq is unique per turn and monotonic intended, so sorting restores intended order
- If out-of-order due to corruption (e.g., seq reused), dedup handles
- So policy: always sort by seq ascending after collecting valid events, with warning if out-of-order detected (original file order != sorted order)
- This matches InMemory behavior where events are stored in append order which is seq order, but readAll sorts? Currently InMemory readAll returns [...events] in append order, which is seq order if append is serialized, but if out-of-order file, sorting ensures correct replay

## 7. Versioning and backward compatibility

- Session meta version field for future migration, currently 1
- Event JSONL: no version field per line, but StreamEvent type includes versioning via optional fields, old events missing fields handled via fallback
- FileTurnLogStore version: if data dir contains version file `VERSION`, check, if missing assume 1
- Backward compat: support reading old flat layout, old events missing providerCallId, etc.

## Next

- Implement FileTurnLogStore + FileSessionStore with above spec
- Add restart recovery and integration tests
- Keep InMemory as test double
