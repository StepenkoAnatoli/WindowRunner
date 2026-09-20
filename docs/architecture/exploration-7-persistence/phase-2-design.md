# Exploration #7 — Phase 2: Storage Layout and Recovery Design

## Candidates

### A: Minimal Per-Turn JSONL Only, Session Derived from Events, Async Persistence

- Layout: `WINDOWS_RUNNER_DATA_DIR/turns/<turnId>.jsonl` — flat, no session dir
- Session metadata: derived from `turn_started` events (scan all turn files on boot, extract sessionId -> root from first turn_started)
- Append: `fs.appendFile` O_APPEND, no fsync, async (notify before persist as now)
- Recovery: read all turn files, parse each line JSON, ignore truncated last line (if parse fails and is last line), skip malformed middle lines with warning, deduplicate by seq (keep first), sort by seq, fold reducer, if not terminal append RESTART
- Sequence validation: seq >0, turnId must match filename? Not enforced, only event.turnId used
- Duplicate handling: InMemory idempotent on seq, file store also idempotent — if seq exists skip
- Out-of-order: sort by seq on readAll
- Concurrent writers: single process single writer via TurnManager seqCounter, O_APPEND atomic, no lock, multi-process not supported
- Durable-before-notify: async (current) — notify before persist, faster but possible loss on crash
- Session metadata: none, derived, so pinned root is from first turn_started event, not validated against allowedRoots on recovery? Would need to re-validate derived root against current allowedRoots, but if no meta, root is informational from event
- Retention/eviction: evictOldest deletes Map and file `turns/<turnId>.jsonl`, simple
- Security: persisted root from event is informational, but no meta.json to re-validate, so must still validate derived root against current allowedRoots via ProjectRoot.create on boot, if fails skip session turns
- Migration: old events missing providerCallId handled via fallback (providerCallId = requestId), no versioning
- Pros: Minimal, no session store, easy migration from in-memory
- Cons: No session metadata persistence, so session root pinning lost on restart unless turn_started present, activeTurnId not persisted, per-turn flat layout no session grouping, retention per session hard, security revalidation only from event not meta, no fsync durability

### B: Per-Session Directory with Meta.json + Per-Turn JSONL, Durable-Before-Notify, Strict Validation, File Lock

- Layout: `WINDOWS_RUNNER_DATA_DIR/sessions/<sessionId>/meta.json` + `turns/<turnId>.jsonl`
  - `sessions/<sessionId>/meta.json`: `{version:1, sessionId, canonicalRoot, realRoot, createdAt, lastActivityAt, activeTurnId}`
  - `sessions/<sessionId>/turns/<turnId>.jsonl`: JSONL per turn
- Session metadata store: separate `FileSessionStore` implements `SessionStore { save, load, list, delete }`, atomic write via temp file + rename
- Append: per-turn serialized queue, `fs.open` with `a` (O_APPEND), write JSON + "\n", `fsync` file after append for durability, await before notifying listeners (durable-before-notify)
- Recovery:
  - List sessions via readdir `sessions/`
  - For each session, load meta.json, validate canonicalRoot against current allowedRoots via ProjectRoot.create, realpath check realRoot matches canonicalRoot realpath, if fails skip session (log warning, do not load its turns)
  - Clear activeTurnId on recovery (set null) because turns will be marked RESTART
  - For each turn file in `sessions/<sessionId>/turns/`, read file, split lines, handle truncated last line (if file doesn't end with "\n", last line may be truncated, try parse, if fails ignore), handle malformed middle lines: skip with warning, continue
  - Sequence validation: seq must be >0, turnId must equal filename turnId, sessionId must equal directory sessionId, else skip line with warning
  - Duplicate seq: dedup by seq Map, keep first occurrence, log warning for duplicate
  - Out-of-order: collect valid events, sort by seq ascending, check monotonic (allow gaps but warn if gap >1)
  - Fold reducer, if not terminal append RESTART event with next seq, persist RESTART with fsync, clear activeTurnId
- Concurrent writers: per-turn async queue ensures serialized writes within process, plus file lock via `fs.flock` or advisory lock file `turnId.lock` to prevent multi-process concurrent writes, or document single process only but implement queue
- Durable-before-notify: await append + fsync before notify, ensures durability before SSE
- Session metadata and active-turn recovery: meta.json persisted on session creation and on activeTurnId change, activeTurnId cleared on boot, timestamps updated
- Retention/eviction: evictOldest deletes turn file and if session has >N turns or age > threshold, delete oldest turn files; session eviction deletes entire session dir including turns; configurable maxTurnsPerSession and maxSessions
- Security: persisted canonicalRoot and realRoot informational, must re-validate against current allowedRoots and realpath on recovery, never override current config; turn_started root also informational
- Migration: meta.json version field for future, old events missing providerCallId fallback to requestId, missing createdAt fallback to at, missing version fallback to 1
- Pros: Full session persistence, strict validation, durable, secure revalidation, retention per session, clear recovery invariants
- Cons: More complex, need file lock, fsync adds latency, session store separate, need atomic meta.json write (temp+rename)

### C: Hybrid Per-Session Meta + Per-Turn JSONL, Serialized Writers, Strict Validation, Async Option, Derived Fallback (Recommended)

- Layout: `WINDOWS_RUNNER_DATA_DIR/sessions/<sessionId>/meta.json` + `turns/<turnId>.jsonl` (same as B) BUT also supports flat fallback `turns/<turnId>.jsonl` for migration, and if meta.json missing, derive session metadata from turn_started events
  - Global data dir root: `WINDOWS_RUNNER_DATA_DIR` (env var, default `~/.windows-runner/data` or `./data`)
  - Session dir: `sessions/<sessionId>/`
  - Meta: `sessions/<sessionId>/meta.json` with `{version, sessionId, canonicalRoot, realRoot, createdAt, lastActivityAt, activeTurnId, allowedRootsSnapshot?}` — allowedRootsSnapshot informational only, not used for auth
  - Turn: `sessions/<sessionId>/turns/<turnId>.jsonl` — primary, but also support legacy `turns/<turnId>.jsonl` for migration
- Session metadata store: same as B but with fallback derivation
- Append:
  - Per-turn serialized queue via `Map<turnId, Promise>` chain to ensure writes serialized per turn within process
  - Write: `fs.appendFile` with O_APPEND, JSON.stringify(event) + "\n", no fsync by default for performance, but option `fsync: true` for durable mode
  - Durable-before-notify: configurable — default async (notify before persist) for backward compat, but provide `durable: true` option that awaits append before notify; for file persistence, recommend durable-before-notify for correctness, document trade-off
  - Atomicity: O_APPEND ensures each write <4KB atomic on POSIX, events typically <4KB, so safe; for larger events, still atomic for line append but may interleave if multi-process, so document single process single writer, and implement per-turn queue
- Recovery:
  - List sessions: readdir `sessions/`, for each load meta.json if exists, else derive from turn files
  - If meta.json exists: parse, validate schema, if version missing assume 1, validate canonicalRoot against current allowedRoots via ProjectRoot.create, realpath check, if fails skip session (do not load turns, log warning)
  - If meta.json missing: scan turn files in session dir, find first turn_started event, extract canonicalRoot and realRoot, attempt to validate against current allowedRoots, if fails skip
  - For each turn file: read file content, split by "\n", handle truncated final line: if file ends without "\n", last chunk may be incomplete, try JSON.parse, if fails ignore last chunk
  - Malformed lines: if JSON.parse fails and not last line, skip line with warning, continue (do not abort whole file)
  - Sequence validation: seq must be number >0, turnId must match file turnId (or event.turnId must match file, else skip), sessionId must match dir sessionId (or event.sessionId must match dir, else skip), seq must be unique, duplicate seq -> keep first, skip subsequent with warning
  - Out-of-order: collect valid events, sort by seq ascending, dedup, then fold reducer
  - Gaps: allow gaps (reducer resilience), but log warning if gap detected (seq jump >1)
  - After folding, if state not terminal, append RESTART failure event with seq = maxSeq+1, at = now(), code RESTART, message "server restarted", persist RESTART (via append), clear activeTurnId in meta
  - Also handle approval registry: pending approvals not persisted, so on RESTART they become cancelled via turn_failed
- Concurrent writers and crash:
  - Single process: per-turn queue ensures serialized
  - Multi-process: not supported in minimal, but O_APPEND atomic prevents corruption, seq may interleave but dedup and sort handle? Better to document single process, and optionally implement file lock via `proper-lockfile` or simple lock file
  - Crash during append: truncated last line ignored on recovery, as above
- Durable-before-notify vs async: default async for backward compat (notify before persist), but for file store recommend durable option: TurnManager.append could be made async and await store.append before notify if store is file-based, or keep async and document possible loss; for correctness, implement durable-before-notify when FileTurnLogStore used (await append then notify), with performance note
- Session metadata and active-turn recovery: meta.json persisted on session creation (createSession), on activeTurnId change (tryStartTurn, finishTurn), and on lastActivityAt update; on boot activeTurnId cleared; timestamps preserved
- Retention/eviction: TurnManager.evictOldest deletes Map and file; SessionManager.evictOldest deletes session dir if inactive; FileTurnLogStore.list() returns turnIds from filesystem; retention policy configurable: maxTurnsPerSession (default 100), maxSessions (default 100), maxAge (default 30 days), cleanup deletes oldest files
- Security: persisted canonicalRoot, realRoot, allowedRootsSnapshot are informational only, must never override current allowedRoots; on recovery, re-validate canonicalRoot via ProjectRoot.create(canonicalRoot, currentAllowedRoots), and realpath check; if fails, skip session; turn_started root also informational, not used for auth
- Migration: meta.json version field, old events missing providerCallId -> fallback to requestId, missing createdAt -> fallback to at, missing expiresAt -> fallback to at+300000, missing version -> assume 1; support legacy flat turns/ dir for migration by moving files to session dirs on first boot
- Deletion/complexity test: session metadata needs its own store because activeTurnId and timestamps cannot be derived safely from event logs alone (activeTurnId is transient, timestamps are session-level), but if meta.json missing we can derive minimal session from events for migration; so session store is justified but fallback derivation keeps complexity low
- Pros: Balanced complexity, supports migration, strict validation, handles all corruption cases, configurable durability, secure revalidation, retention, clear recovery
- Cons: More code than A, but less than B with file lock and fsync always

## Comparison Table

| Criteria | A Minimal flat, derived, async | B Strict per-session meta, durable, file lock | C Hybrid per-session meta + fallback, serialized, configurable durable (Recommended) |
|----------|---|---|---|
| JSONL append atomicity & crash recovery | O_APPEND, no fsync, truncated last line ignored, malformed skip, no durability guarantee | O_APPEND + fsync, temp+rename for meta, truncated ignored, malformed skip, durable | O_APPEND, optional fsync, per-turn queue serialized, truncated ignored, malformed skip, configurable durable |
| Per-session vs per-turn isolation | Flat per-turn only, no session dir, retention per session hard | Per-session dir sessions/<sessionId>/meta.json + turns/<turnId>.jsonl, isolated, retention per session easy | Per-session dir primary, flat fallback for migration, isolated, retention per session |
| Sequence validation & duplicate handling | seq>0 check, dedup by seq keep first, no turnId/sessionId validation | seq>0, turnId==filename, sessionId==dir, dedup, gap warning, strict | seq>0, turnId==filename, sessionId==dir, dedup, sort, gap warning, strict but fallback |
| Malformed / truncated final lines | Truncated last line ignored if parse fails and is last, malformed middle skip with warning | Same, plus fsync ensures less truncation | Same, plus per-turn queue reduces interleaving |
| Out-of-order events | Sort by seq on readAll | Sort by seq, gap warning | Sort by seq, gap warning |
| Concurrent writers & crash | Single process single writer via TurnManager seqCounter, O_APPEND atomic, multi-process not supported, crash truncated ignored | Per-turn queue + file lock (flock/lockfile), O_APPEND atomic, crash truncated ignored, fsync | Per-turn queue serialized, O_APPEND atomic, single process documented, optional lock, crash truncated ignored |
| Durable-before-notify vs async | Async (notify before persist) — current, faster but possible loss | Durable-before-notify (await append+fsync before notify) — correct but latency | Configurable — default async for compat, but recommend durable when FileTurnLogStore used (await before notify), document trade-off |
| Session metadata & active-turn recovery | None persisted, derived from turn_started, activeTurnId lost, no timestamps | meta.json persisted, activeTurnId cleared on boot, timestamps preserved, RESTART appended | meta.json persisted primary, fallback derivation if missing, activeTurnId cleared on boot, timestamps preserved, RESTART appended |
| Retention & eviction | evictOldest deletes file turns/<turnId>.jsonl, simple global | Per-session maxTurnsPerSession, maxSessions, maxAge, eviction deletes turn files and session dir | Same as B but with fallback, configurable, eviction deletes files |
| Security persisted roots | Derived root from event informational, must re-validate against current allowedRoots via ProjectRoot.create, if fails skip | Persisted canonicalRoot/realRoot informational, re-validate against current allowedRoots and realpath, never override, if fails skip | Same as B, plus allowedRootsSnapshot informational only, never override |
| Migration in-memory & old schemas | Old events missing providerCallId fallback to requestId, no versioning | meta.json version field, old events fallback, flat to per-session migration on boot | Same as B plus flat fallback dir support, version field, graceful handling |
| Deletion/complexity test — session store needed? | No session store, derived from events — simple but loses activeTurnId, timestamps, root pinning on restart if no turn_started | Session store separate justified — activeTurnId transient cannot be derived, timestamps session-level, root pinning needs persistence | Session store justified but with fallback derivation for migration — balanced complexity |
| Pros/Cons | Pros: minimal, easy migration; Cons: no session persistence, no durability, no retention per session | Pros: full persistence, strict, durable, secure; Cons: complex, file lock, fsync latency, separate store | Pros: balanced, migration support, strict validation, configurable durability, secure revalidation, retention; Cons: more code than A but less than B |

## Top Recommendation

**Candidate C Hybrid** — per-session metadata plus per-turn JSONL, serialized writers, strict validation, configurable durability, fallback derivation.

- Directory layout: `WINDOWS_RUNNER_DATA_DIR/sessions/<sessionId>/meta.json` + `turns/<turnId>.jsonl`, with legacy flat `turns/<turnId>.jsonl` fallback for migration
- Durable schemas:
  - Event: existing StreamEvent (seq, at, sessionId, turnId, type, ...), JSONL line = JSON.stringify(event)
  - Session meta: `{version:1, sessionId, canonicalRoot, realRoot, createdAt, lastActivityAt, activeTurnId|null, allowedRootsSnapshot?: string[]}` — allowedRootsSnapshot informational only
- Append: per-turn serialized queue via Map<turnId, Promise>, O_APPEND appendFile, optional fsync, durable-before-notify option (await before notify when file store)
- Recovery:
  - List sessions, load meta.json, re-validate canonicalRoot against current allowedRoots via ProjectRoot.create, realpath check, if fails skip session
  - If meta missing, derive from turn_started events, re-validate
  - For each turn file: split lines, truncated last line ignored if parse fails and is last chunk without newline, malformed middle lines skipped with warning, sequence validation (seq>0, turnId==file, sessionId==dir), duplicate seq dedup keep first, sort by seq, gap warning, fold reducer, if not terminal append RESTART with next seq, persist, clear activeTurnId
- Crash: truncated last line ignored, O_APPEND atomic prevents interleaving for <4KB, per-turn queue serializes
- Concurrent writers: single process documented, per-turn queue ensures serialized, optional file lock for multi-process
- Durability: configurable, recommend durable-before-notify for file store (await append then notify) for correctness, document async option for performance
- Session metadata and active-turn recovery: meta persisted on creation and activeTurnId change, activeTurnId cleared on boot, RESTART appended for non-terminal
- Retention: maxTurnsPerSession, maxSessions, maxAge, eviction deletes files and session dir
- Security: persisted roots informational only, re-validate against current allowedRoots and realpath on recovery, never override, turn_started root informational
- Migration: version field, fallback providerCallId=requestId, createdAt=at, expiresAt=at+300000, flat to per-session migration
- Deletion/complexity: session store justified because activeTurnId and timestamps cannot be derived from events, but fallback derivation keeps complexity low

## Next

- Define durable event/session schemas in code
- Specify crash and corruption behavior in detail
- Implement FileTurnLogStore + FileSessionStore
- Add restart recovery and integration tests
- Keep InMemory as test double
