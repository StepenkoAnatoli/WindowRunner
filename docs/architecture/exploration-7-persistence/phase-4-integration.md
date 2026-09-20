# Exploration #7 — Phase 4: Integration — File Persistence C Hybrid

## Implemented

### FileTurnLogStore

- Location: `packages/server/src/agent/file-turn-log-store.ts`
- Options: `dataDir`, `fsync` default false, `maxLineBytes` 1MB
- Layout: `dataDir/sessions/<sessionId>/turns/<turnId>.jsonl` primary, `dataDir/turns/<turnId>.jsonl` legacy flat fallback
- Per-turn serialized queue: `Map<turnId, Promise>` chain ensures serialized writes within one process, prevents interleaving
- Append atomicity: `fs.appendFile` O_APPEND, <4KB atomic POSIX, "\n" terminator, truncated handling via checking last byte not newline and truncating to last newline before next append
- Fsync: optional, when true open file, write, fsync, close for durability
- Durable-before-notify: TurnManager option `durableBeforeNotify` — when true, `appendAsync` awaits store.append before notifying listeners (durable before SSE), when false async (notify before persist)
- Recovery:
  - Split by "\n", truncated final line: if file doesn't end with "\n" and last chunk parse fails, ignore truncated
  - Malformed middle: JSON.parse fails and not last truncated => skip with warning, continue
  - Identity mismatches: turnId != filename or sessionId != dir => skip warning, if >50% invalid quarantine to `quarantine/<turnId>.jsonl.quarantined`
  - Duplicate seq: Map seq->event keep first, skip subsequent warning
  - Out-of-order: collect file order seqs, compare to sorted seqs, diagnostic outOfOrder if differs, sort by seq asc on read (never rewrites file automatically)
  - Gaps: allow gaps (reducer resilience) but warn if jump >1, count gapsDetected
- Diagnostics: `BootDiagnostics` {turnsLoaded, turnsWithRestart, eventsSkipped, truncatedLinesIgnored, gapsDetected, outOfOrderDetected, duplicatesSkipped, quarantinedFiles, warnings}
- Methods: `append`, `read`, `readAll`, `list`, `deleteTurnFile`, `getDiagnostics`, `getDataDir`
- Concurrency boundary: serialized writes within one process guaranteed via queue, multi-process unsupported — documented explicitly, O_APPEND alone does not provide session-level correctness

### FileSessionStore

- Location: `packages/server/src/agent/file-session-store.ts`
- Layout: `dataDir/sessions/<sessionId>/meta.json`
- Schema versioned: `SessionMetaV1 {version:1, sessionId, canonicalRoot, realRoot, createdAt, lastActivityAt, activeTurnId|null, allowedRootsSnapshot?}` — allowedRootsSnapshot informational only
- Atomic write: temp file `meta.json.tmp.<rand>` + rename
- Methods: `save`, `load`, `list`, `delete`, `boot(currentAllowedRoots, now)`
- Boot recovery:
  - List sessions, load meta, re-validate canonicalRoot via `ProjectRoot.create(canonicalRoot, currentAllowedRoots)` — security critical, never override current config
  - If fails, skip session, count skipped, warning
  - Clear activeTurnId to null (transient), persist updated meta
  - Return diagnostics {sessionsLoaded, sessionsSkipped, sessionsWithClearedActiveTurn, warnings, skippedSessions}
- Security: persisted canonicalRoot, realRoot, allowedRootsSnapshot informational only, must re-validate against current allowedRoots and realpath, never trust old metadata for authorization

### TurnManager updates

- Added `durableBeforeNotify` option, `getStore()`, `appendAsync` that awaits store before notify when durable
- `boot()` now returns {turnsLoaded, turnsWithRestart, diagnostics}, appends exactly one RESTART at maxSeq+1 for non-terminal, idempotent (second boot does not append second RESTART)
- `evictOldest` and `evictOldestAsync` delete file via `deleteTurnFile` if store supports

### SessionManager updates

- Added `sessionStore` dependency (optional)
- `createSession` persists meta.json atomically
- `tryStartTurn` persists activeTurnId
- `finishTurn` clears activeTurnId and persists
- `deleteSession` deletes meta.json

### TurnRunner updates

- Now uses `appendAsync` (durable) for all events, awaits persistence when durableBeforeNotify true
- Ensures durability before SSE when file store used

## Tests (19 new, 84 total passing)

- FileTurnLogStore 12: atomic serialized appends, durable vs async ordering, truncated final ignored, malformed middle skip+warn, duplicate keep first, out-of-order sorted diagnostic never rewrites file, gaps and identity mismatches, quarantine >50% invalid, crash during append truncated ignored file not corrupted, legacy providerCallId fallback, retention and flat-layout migration, concurrency boundary serialized within one process
- FileSessionStore 4: save/load atomic, root rejection after config changes, restart recovery clears activeTurnId never trusts persisted roots, retention/eviction
- Integration 3: restart appends exactly one RESTART at maxSeq+1 clears activeTurnId, idempotency second boot no second RESTART, flat-layout fallback migration without changing source files (preserves original, appends RESTART only)

## Security and operational

- Persisted session metadata can request recovery, but only current configuration and ProjectRoot validation can authorize filesystem access — enforced in FileSessionStore.boot via ProjectRoot.create with current allowedRoots
- Turn_started root informational only, not used for auth
- Concurrency boundary clearly documented: serialized writes within one process via per-turn queue, multi-process unsupported, O_APPEND alone does not provide session-level correctness, no file lock
- Retention: evictOldest deletes files, session delete deletes dir, maxTurnsPerSession/maxSessions/maxAge configurable (future)
- Crash during append: truncated last line ignored, next append truncates incomplete tail before writing new event, file not corrupted
- Sorting out-of-order limited to recovery/read normalization, diagnostic emitted when file order differs from seq order, never rewrites original log automatically except for RESTART append and truncated tail cleanup

## Next

- Wire FileTurnLogStore and FileSessionStore in app.ts via env WINDOWS_RUNNER_DATA_DIR, with durableBeforeNotify option
- Add retention/eviction limits via config
- Add observability endpoint for boot diagnostics
- Keep InMemory as test double
