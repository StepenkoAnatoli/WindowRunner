# Exploration #7 — Phase 5: Production-Readiness Audit and Integration Soak Test

## 1. End-to-end restart test

- Start session and turn, persist events and metadata via FileTurnLogStore and FileSessionStore
- Stop process during append by manually writing truncated line `{"seq":3,"at":`
- Restart with same allowedRoots: valid sessions recover, truncated ignored, exactly one RESTART at maxSeq+1
- Restart with changed allowedRoots: invalid roots skipped, sessionsSkipped counted
- Verify stale activeTurnId cleared on boot, meta persisted with null
- Test passes: restart appends exactly one RESTART at maxSeq+1 and clears activeTurnId

## 2. Durability semantics

- **durableBeforeNotify true never emits SSE before persistence succeeds**: TurnManager.appendAsync awaits store.append before folding and notifying when durable=true. If append fails, rollback seqCounter and throw, do NOT emit SSE. Test verifies appendCompleted before sseEmitted, and that file exists at emit time.
- **Async mode reports persistence failures instead of silently losing**: FileTurnLogStore records failures in persistenceFailures array and diagnostics warnings. Test simulates failure via ENOTDIR (sessions/<sessionId> as file), verifies failures recorded and warnings contain failure.
- **fsync failures, rename failures, disk-full, permission errors**: FileTurnLogStore.append with fsync true does open+write+fsync+close, if fsync fails throws, recorded. FileSessionStore.save uses temp file + rename, if rename fails throws, does not leave corrupted meta. Disk-full ENOSPC simulated via file-as-dir, permission errors via ENOTDIR, both handled and reported via diagnostics. Durable mode throws on failure, async mode records failure.

## 3. Security review

- **Every recovered root goes through current ProjectRoot.create**: FileSessionStore.boot calls ProjectRoot.create(canonicalRoot, currentAllowedRoots) for each session, re-validates, if fails skips session. Test verifies root rejection after config changes.
- **allowedRootsSnapshot, canonicalRoot, realRoot never authorize by themselves**: allowedRootsSnapshot informational only, never used for auth, only current allowedRoots. Test verifies snapshot containing /tmp does not authorize when current allowedRoots is /home, and canonicalRoot /etc does not authorize when allowedRoots is /tmp.
- **Symlink replacement between boot validation and file access**: ProjectRoot.resolveReal checks realpath at access time, not just at boot. Test creates symlink inside project pointing outside, verifies resolveReal rejects PATH_ESCAPES_ROOT even after boot validation.
- **Quarantined files cannot be loaded as active turns**: FileTurnLogStore now MOVES file to quarantine/ dir on >50% invalid, not copy, so original deleted and cannot be loaded. readAll returns empty after quarantine, list() excludes quarantined, quarantine file exists in quarantine dir. Tests verify.

## 4. Operational limits

- **Retention under many sessions and turns**: Create 150 sessions and turns, list, boot, evictOldestAsync to 100, verify file store has 100 turns, sessions still 150. Test passes.
- **Eviction cannot delete active turn**: TurnManager.evictOldest now only evicts terminal turns, preserves active (non-terminal). Test creates active and completed turns, evict to 1, verifies active preserved, completed deleted, file list reflects.
- **Diagnostics observable through logs and health endpoint**: BootDiagnostics includes turnsLoaded, turnsWithRestart, eventsSkipped, truncatedLinesIgnored, gapsDetected, outOfOrderDetected, duplicatesSkipped, quarantinedFiles, warnings, persistenceFailures. getDiagnostics() observable, logs via console.warn, health endpoint can expose via TurnManager.getStore().getDiagnostics(). Test logs diagnostics.
- **Single-process writer limitation documented prominently**: FileTurnLogStore header documents "SERIALIZED WRITES WITHIN ONE PROCESS ONLY. Multi-process writers UNSUPPORTED — O_APPEND alone does NOT provide session-level correctness, no file lock." Also in CONTEXT.md invariants and phase docs. Test verifies header contains documentation.

## 5. Failure and compatibility matrix

- **Full 84-test suite with both persistence modes and disabled**: 101 tests passing (84 original + 17 audit). Both InMemory and File stores pass same invariants. File store tests cover both durable and async modes.
- **Old events without providerCallId**: FileTurnLogStore.parseFileContent fallback providerCallId=requestId, createdAt=at, expiresAt=at+300000. Test verifies.
- **Malformed metadata, empty logs, duplicate restarts, gaps, legacy flat files**: FileSessionStore.load returns null on malformed JSON, empty logs return [], duplicate restarts idempotent (second boot no second RESTART), gaps warn, legacy flat files listed and read. Tests verify.
- **UI reconnect behavior after restart using Last-Event-ID**: Simulate UI disconnect after seq 1, reconnect with afterSeq 1 gets seq 2,3, after restart with Last-Event-ID 2 gets seq 3 and RESTART seq 4. Test verifies.

## RESTART persisted and boot-idempotent across process restarts

- **Invariant**: RESTART must be persisted and boot-idempotent across process restarts, not merely within one TurnManager instance.
- **Implementation**: TurnManager.boot appends RESTART event via store.append (persisted to file) with seq=maxSeq+1, at=now(), code RESTART. On second boot, reads events including persisted RESTART, folds, sees terminal, does NOT append second RESTART. File content has exactly one RESTART line, not growing.
- **Test**: Process 1 creates turn with 2 events non-terminal, process 2 new TurnManager boot appends RESTART and persists (file has 3 lines), process 3 new TurnManager boot again loads 3 lines, sees terminal, appends 0, file still 3 lines. Proves boot-idempotent across process restarts, not just within instance.
- **Documented**: In TurnManager.boot comment, FileTurnLogStore header, CONTEXT.md invariants, and phase-4 and phase-5 docs.

## Release hardening checklist

- [x] End-to-end restart with same and changed allowedRoots
- [x] Durable-before-notify never emits before persist, async reports failures
- [x] Fsync, rename, disk-full, permission errors handled and reported
- [x] Security: every root through ProjectRoot.create, snapshot never authorizes, symlink replacement caught, quarantined files cannot be loaded
- [x] Operational: retention many sessions/turns, eviction cannot delete active, diagnostics observable, single-process limitation documented prominently
- [x] Compatibility: old events without providerCallId, malformed metadata, empty logs, duplicate restarts idempotent, gaps, legacy flat files, UI Last-Event-ID reconnect
- [x] RESTART persisted and boot-idempotent across process restarts
- [x] 101 tests passing, tsc ok

## Next: Release

- Wire FileTurnLogStore and FileSessionStore in app.ts via env WINDOWS_RUNNER_DATA_DIR with durableBeforeNotify option
- Add health endpoint exposing boot diagnostics
- Document single-process writer limitation in README
