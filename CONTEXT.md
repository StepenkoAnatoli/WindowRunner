# CONTEXT.md — WindowsRunner Domain Vocabulary

> Seeded during exploration of #3 (Turn reducer + seq) + #6 (scripted fake provider). Terms are taken from README.md, AGENTS.md, and the Robust Turn Execution plan, sharpened by Phases 1-7.

## Server boot

- **Boot entry**: `packages/server/src/index.ts`, compiled and bundled to `packages/server/dist/index.cjs`, the executable behind `npm start` and `bin/windows-runner.js`. Sequence: `loadServerConfig(process.env)` → `startServer(config)` → banner + ready line `windows-runner listening on http://HOST:PORT` → signal handlers. Exits 1 with `configuration error (VARIABLE): …` on any invalid setting; nothing falls back silently.
- **Bundle artifact**: `packages/server/dist/index.cjs`, the self-contained CommonJS runtime artifact produced by `esbuild` during `npm run build` (`packages/server/scripts/bundle.mjs`). Inlines `@windows-runner/shared` and runtime dependencies (`express`), allowing the server to boot without `node_modules` in Docker or in a clean-install directory. CLI launcher: `bin/windows-runner.js` (`windows-runner`, `wr`).
- **ServerConfig**: Parsed by `config.ts` from `HOST`, `PORT`, `WINDOWS_RUNNER_ALLOW_REMOTE`, `WINDOWS_RUNNER_PROVIDER`, `WINDOWS_RUNNER_PERSISTENCE_MODE`, `WINDOWS_RUNNER_DATA_DIR`, `WINDOWS_RUNNER_DURABLE_BEFORE_NOTIFY`, `WINDOWS_RUNNER_FSYNC`, `WINDOWS_RUNNER_ALLOWED_ROOTS`, `WINDOWS_RUNNER_HOME`, `WINDOWS_RUNNER_SHUTDOWN_GRACE_MS`. Defaults: loopback `127.0.0.1:7634`, `mock` provider, `memory` persistence, `~/.windows-runner`, allowed roots = home directory, 5 s grace. `allowedRoots` is never empty from the boot path — the empty "allow any" list is a `ProjectRoot` test affordance.
- **Runtime**: `boot.ts` `createRuntime()` composes `TurnManager` (InMemory or File store), `ApprovalRegistry`, `SessionManager` (with `FileSessionStore` in file mode), provider from the registry, an empty tool map, and `createApp()`. In file mode it runs restart recovery *before* listening: `TurnManager.boot()` (RESTART for non-terminal turns) then `FileSessionStore.boot(currentAllowedRoots)`; the result is exposed as `diagnostics.boot` on `/api/health`.
- **Bind refusal**: `startServer` throws `BindRefusedError` (a `ConfigError`) for a non-loopback `HOST` unless `allowRemote` — the API has no authentication (P0-01), so exposure must be explicit.
- **Drain**: `close()` = stop validation timer → `server.close()` + `closeIdleConnections()` → `app.abortActiveTurns(reason)` (same path as `POST …/cancel`, so each turn records `turn_cancelled`) → wait until `getActiveTurnCount() === 0` and connections end, bounded by the grace period → `closeAllConnections()` if it expires. Idempotent; returns `{ abortedTurns, forced }`.
- **Live SSE ends at terminal**: the events route ends the response after writing a terminal event live, matching what the replay path already did for turns terminal at subscribe time.
- **Startup smoke**: `scripts/smoke-start.mjs` (`npm run smoke:start`) spawns the compiled/bundled entry with a clean env, `PORT=0`, file mode in a temp data dir; asserts ready line, health, a full mock turn over SSE with contiguous `seq`, JSONL + `meta.json` on disk, `403 PATH_ESCAPES_ROOT` outside allowed roots, SIGTERM → exit 0, recovery on a second boot, and refusal of `HOST=0.0.0.0` without opt-in. `test/boot.test.ts` covers the same contract in-process from sources.
- **Packed tarball smoke**: `scripts/smoke-packed-start.mjs` (`npm run smoke:packed:start`) packs the root package as `npm publish` would, unpacks it into an isolated temporary directory, runs `npm start`, and asserts `/healthz` and `/api/health` respond ok and SIGTERM terminates cleanly. Ensures zero reliance on monorepo workspace links.

## Core lifecycle

- **Session**: A conversation bound to one project folder. The unit the user creates, pins skills to, and stops. Owns project root (pinned ProjectRoot capability), concurrency policy (at most one active Turn), and history that seeds next LLMRequest. Session selects its authorized ProjectRoot once at creation, validated against allowedRoots, pinned. Later turns cannot silently change root — ROOT_MISMATCH 400. At most one active turn per session — second concurrent start rejected deterministically 409 TURN_ALREADY_ACTIVE with activeTurnId. Session cleanup releases pinned root and active-turn bookkeeping via finishTurn (on completion/cancel/failure) and DELETE /sessions (cancels active and deletes). Session metadata persisted via FileSessionStore meta.json with versioned schema, atomic temp+rename, activeTurnId cleared on boot, re-validated against current allowedRoots (never trust persisted roots for authorization).
- **Turn**: One user message and everything the agent does in response. Up to `maxSteps` model calls. Has `sessionId`, `turnId`, `limits`, `seq` counter, and a `TurnState`. Emits `StreamEvent`s with monotonic `seq`. Turn receives pinned ProjectRoot from session, not per-turn reconstruction. Turn events persisted via FileTurnLogStore JSONL per turn.
- **Step**: One model call within a Turn. Scripted in fake provider as `ProviderStep = (request) => result`. Each Step can assert on `LLMRequest` it was sent.
- **TurnState**: Authoritative state after folding events via `reduceTurnState(state, event)`. Fields: `sessionId`, `turnId`, `status`, `seq` (last applied), `limits`, `startedAt`, `updatedAt`, `stepsCompleted`, `pendingApprovals`, `activeTools`, `error`, `usage`, `isTerminal`. Pure, in `@windows-runner/shared`, used by server and UI.
- **TurnStatus**: `running | waiting_for_approval | completed | cancelled | failed`. Derived by reducer, never stored separately. Terminal: `completed`, `cancelled`, `failed`.

## Events and ordering

- **StreamEvent**: Union of `turn_started`, `text_delta`, `tool_call`, `turn_waiting_for_approval`, `approval_resolved`, `tool_started`, `tool_completed`, `turn_completed`, `turn_cancelled`, `turn_failed`. Every event has envelope `{ seq, at, sessionId, turnId, type }`. `seq` per Turn, monotonic from 1, owned by TurnManager. `turn_started` now includes `root` and `realRoot` for persistence and audit.
- **TurnLog**: In-memory or persisted list of StreamEvents for one Turn, plus materialized TurnState via reducer. `seqCounter` = last seq.
- **TurnLogStore**: Seam for persistence. Interface: `append(turnId, event)`, `read(turnId, afterSeq)`, `readAll(turnId)`, `list()`. Two adapters: `InMemoryTurnLogStore` (test double, deterministic) and `FileTurnLogStore` (JSONL per turn under `WINDOWS_RUNNER_DATA_DIR/sessions/<sessionId>/turns/<turnId>.jsonl` primary, `turns/<turnId>.jsonl` legacy flat fallback). File store handles corruption: truncated final line ignored, malformed middle skip+warn, duplicate seq keep first, out-of-order sorted on read with diagnostic, gaps warn, identity mismatches reject/quarantine, quarantine >50% invalid to `quarantine/` dir. Per-turn serialized queue via `Map<turnId, Promise>` ensures serialized writes within one process. O_APPEND atomic <4KB, optional fsync, crash recovery truncates incomplete last line before next append. Concurrency boundary: serialized within one process, multi-process unsupported documented explicitly, O_APPEND alone does not provide session-level correctness.
- **FileSessionStore**: Session metadata persistence. Layout `sessions/<sessionId>/meta.json` with versioned schema `SessionMetaV1 {version:1, sessionId, canonicalRoot, realRoot, createdAt, lastActivityAt, activeTurnId|null, allowedRootsSnapshot?}` — allowedRootsSnapshot informational only. Atomic write temp+rename. Boot re-validates canonicalRoot via `ProjectRoot.create(canonicalRoot, currentAllowedRoots)` with current config, never overrides, clears activeTurnId, persists updated meta. Diagnostics: sessionsLoaded, sessionsSkipped, sessionsWithClearedActiveTurn, warnings, skippedSessions.
- **Atomic subscribe**: `subscribe(sessionId, turnId, afterSeq, listener) => { replay, state, unsubscribe }` — replay and attach under one synchronous critical section, no gap. SSE handler writes `id: ${seq}` and honors `Last-Event-ID` header or `?afterSeq=` query. SSE disconnect is observational only: unsubscribe listeners but must NOT release active-turn lease or cancel turn — release only via actual completion/cancel/failure.
- **Durable-before-notify**: TurnManager option `durableBeforeNotify` — when true, `appendAsync` awaits store.append (and optional fsync) before notifying listeners (durable before SSE), when false async (notify before persist). For file persistence, durable mode recommended for correctness, async for performance. FileTurnLogStore supports both, with explicit notification ordering.

## Tools and approvals

- **Tool**: Named capability model can call. Definition: `{ name, description, inputSchema, requiresApproval(input), reason(input), execute(parsedInput, ctx) }`. Executor is sole minter of `ToolResult`. `ctx` now contains `projectRoot: ProjectRoot` capability, not raw cwd string + safePath closure.
- **ToolResult**: `{ ok: true, output } | { ok: false, code: ToolErrorCode, message, retryable }`. `ToolErrorCode` includes filesystem codes: `TOOL_FAILED | TOOL_TIMED_OUT | APPROVAL_DENIED | UNKNOWN_TOOL | CANCELLED | PATH_ESCAPES_ROOT | PATH_NOT_FOUND | NOT_A_FILE | NOT_A_DIRECTORY | IS_DIRECTORY | PERMISSION_DENIED | FILE_EXISTS | IO_ERROR`. Filesystem errors never leak raw ENOENT/EACCES, mapped to stable codes.
- **Approval**: User decision gating a tool call. `ApprovalRequest { requestId (minted), providerCallId (correlation), turnId, sessionId, toolName, input, reason, expiresAt, createdAt }`. `requestId` minted by ApprovalRegistry as `apr_<now>_<counter>_<rand>`, globally unique per session/turn/provider call, not provider's call id. `providerCallId` is correlation metadata only, never registry key. Invariants: only settled by user decision, expiry, or `cancelTurn`; SSE disconnect does NOT settle; expiry computed once inside registry (single source).
- **ApprovalRegistry**: Owns ID minting, createdAt, expiresAt, timers, byTurn index `Map<turnId, Set<requestId>>`, and promise settlement. Only `settle()` mutates settlement state — removes from global `Map<requestId>` and turn index, clears timer, resolves promise exactly once, returns `{ settled: boolean, request }`. First caller wins, later callers get `settled:false` no-op, no duplicate `approval_resolved` events, no recreation. Methods: `request(input) => ApprovalRequest` mints id and computes expiry, `wait(requestId) => Promise<ApprovalResolution>`, `approve(requestId)`, `deny(requestId)`, `cancelTurn(turnId)`, `cleanupTurn(turnId)`, `snapshot(turnId)`, `peek(requestId)` for auth, `has(requestId)`. No signal passed to wait — approval lifetime independent of observer. Internal: `Map<requestId, Entry>` global unique + `Map<turnId, Set<requestId>>` index.
- **ApprovalResolution**: Union `approved | denied | expired | cancelled` — single settlement type. `wait()` always resolves with this union for expected outcomes (approval, denial, expiry, cancellation), never rejects; rejection reserved for unexpected internal failures. Loop switches on `kind`.
- **Live promise state vs replay reducer state**: Registry owns live `Map<requestId, { promise, resolve, timeoutId }>` — `wait()` returns promise. Reducer owns `TurnState.pendingApprovals Map` — folds `turn_waiting_for_approval` (add) and `approval_resolved` (remove), no promise, no side effects. Replay reconstructs state without settling live promises — `approval_resolved` event carries `requestId`, `decision`, `resolvedAt`, `resolution` for replay, enough data without registry. Reducer remains pure, no import of ApprovalRegistry.
- **Disconnect and cleanup guarantees**: SSE `unsubscribe` only removes listener from Set, never calls `cancelTurn`, `settle`, or clears registry. Approval remains pending after disconnect and is replayed on reconnect via `afterSeq` and Last-Event-ID. Cleanup guaranteed after decision, expiry, cancellation, terminal failure, turn completion — registry `entries.size` and `byTurn.size` both 0, no leaked timers. Inspect both maps after every scenario, not just observable turn state. Terminal cleanup uses same `settle()` path and must not emit duplicate `approval_resolved` events.
- **Route errors**: 404 request does not belong to URL session (`request.sessionId !== urlSessionId`), 409 request belongs to session but already settled (`!has(requestId)` or `settled:false`). Session errors: 409 SESSION_ALREADY_EXISTS, 404 SESSION_NOT_FOUND, 409 TURN_ALREADY_ACTIVE with activeTurnId, 400 ROOT_MISMATCH with pinned vs requested, 403 PATH_ESCAPES_ROOT, 400 PATH_NOT_FOUND.

## Providers and execution

- **Provider (LLMProvider)**: `stream(request, {signal}) => AsyncIterable<LLMChunk>`. Three adapters = real seam: openai-compatible, anthropic, fake. Signal is cancellation interface.
- **LLMRequest**: `{ messages: {role, content, toolCallId?, toolName?}[], tools: {name, description}[] }`. Tool results encoded as `role:"tool"` messages — standard pattern, makes `requests[]` assertion possible.
- **LLMChunk**: `text_delta | tool_call | usage`.
- **ProviderStep**: `(request: LLMRequest) => ProviderStepResult | AsyncIterable<LLMChunk>`. Result: `{ chunks?, error?, hang?, ignoreAbort?, delayMs? }`. Used to script deterministic failures: `failAfterPartialText`, `ignoreAbort`, `malformedInput`, `unknownTool`.
- **FakeProvider**: Implements `LLMProvider`, records `requests[]`, `lastSignal`, `lastSignals[]`, scripted by `ProviderStep[]`. Drives `model-call`, `loop`, `routes`, `integration` tests. FakeClock for deterministic timing.
- **Deadline**: Infrastructure module `packages/server/src/deadline.ts` owning "run under signal + deadline, abort-and-await settlement". Exports `Deadline { signal, expiresAt, kind, cancel, dispose }`, `DeadlineError { kind: deadline_expired|cancelled|shutdown_timeout, operationKind: model|tool|approval }`, `createDeadline(parentSignal, timeoutMs, {kind, clock, now})`, `runWithDeadline(operation(signal), {parentSignal, timeoutMs, kind, clock, shutdownGraceMs, now})`. Single owner clears timer + parent listener + grace timer, idempotent cancel/dispose first wins. Clock interface `{ now(), setTimeout, clearTimeout }` for FakeClock deterministic tests. Parent-child: child observes parent signal never replaces, child may shorten never extend/detach, child expiry = min(parent.__deadline_expiresAt, now+timeout) if parent is Deadline, signal carries `__deadline_expiresAt` for shortening. Abort-and-await: Phase1 race operation vs abort (deadline expiry or parent cancel), Phase2 await operation shutdown with bounded grace (5s tool, 1s model, 0 approval), throw `shutdown_timeout` with message "abort requested, operation not confirmed stopped" if not confirmed stopped within grace — no false claim dead. Typed failures at point of failure, mapped once at loop boundary to `MODEL_TIMEOUT|MODEL_FAILED|TOOL_TIMED_OUT|TOOL_FAILED|APPROVAL_TIMEOUT|CANCELLED`. Dependency direction fixed: providers/model-call and tools/executor depend on infrastructure deadline.ts, not agent/timeout (deleted). `agent/cancellation.ts` deleted — AbortSignal replaces CancellationToken.

## Safety and roots

- **ProjectRoot**: Capability object `packages/server/src/project-root.ts` owning filesystem safety. Constructed only from validated `allowedRoots` (env `WINDOWS_RUNNER_ALLOWED_ROOTS` or config). Canonicalizes root once (`canonicalRoot = path.resolve(requested)`), retains real root separately (`realRoot = realpath(canonicalRoot)`). Methods: `resolve(requested): string` sync logical containment (rejects absolute, traversal, encoded %2e%2e, null byte, platform `\\`, checks `isInside(logical, canonicalRoot)`), `resolveReal(requested): Promise<string>` logical + realpath containment for existing paths (prevents symlink escape), `readFile`, `writeFile({createParents})`, `stat`, `mkdir` with stable error mapping. Centralizes all path authorization in `resolveSafePath()` — tools never reimplement checks. Instances isolated, concurrent turns cannot cross roots. Migration: loop creates ProjectRoot once per turn from cwd + allowedRoots, passes via ToolExecutionContext `projectRoot`, not duplicated cwd fields. `safePath` closure deleted.
- **SessionManager**: `packages/server/src/agent/session-manager.ts` owning session lifecycle. `Session { sessionId, projectRoot (pinned), activeTurnId, createdAt, lastActivityAt, allowedRoots }`. Methods: `createSession(sessionId, requestedRoot, allowedRoots)` validates via ProjectRoot.create, pins, uses pendingCreations Map as lock to prevent duplicate concurrent creation, throws SESSION_ALREADY_EXISTS, PATH_ESCAPES_ROOT, PATH_NOT_FOUND; `getOrCreateSession` for implicit backward compat — if session exists checks root pinning (canonicalRequested must equal pinned canonicalRoot else ROOT_MISMATCH 400), if pending awaits same promise; `getSession`; `tryStartTurn(sessionId, turnId)` sync atomic — if activeTurnId exists and not terminal (via isTurnTerminal callback), returns 409 TURN_ALREADY_ACTIVE with activeTurnId, else sets activeTurnId and persists via FileSessionStore if present; `finishTurn(sessionId, turnId)` idempotent clears guard on completion/cancel/failure via finally and persists; `deleteSession` cancels active via activeControllers and deletes and removes meta.json; `evictOldest` deletes oldest sessions where activeTurnId null. One-active-turn as deliberate policy documented in ADR. SSE disconnect is observational only — does not release lease. SessionStore optional dependency for persistence.
- **FileTurnLogStore**: `packages/server/src/agent/file-turn-log-store.ts` — C Hybrid file persistence. Layout `sessions/<sessionId>/turns/<turnId>.jsonl` primary, `turns/<turnId>.jsonl` legacy fallback. Per-turn serialized queue `Map<turnId, Promise>` chain ensures serialized writes within one process. O_APPEND atomic <4KB, optional fsync, crash recovery truncates incomplete last line before next append. Recovery: truncated final line ignored, malformed middle skip+warn, identity mismatches reject/quarantine, duplicate seq keep first, out-of-order sorted on read with diagnostic (never rewrites file automatically except RESTART append and truncated cleanup), gaps warn. Boot diagnostics: turnsLoaded, turnsWithRestart, eventsSkipped, truncatedLinesIgnored, gapsDetected, outOfOrderDetected, duplicatesSkipped, quarantinedFiles, warnings. Retention: deleteTurnFile for eviction. Concurrency boundary: serialized within one process, multi-process unsupported documented explicitly.
- **FileSessionStore**: `packages/server/src/agent/file-session-store.ts` — session metadata persistence. Layout `sessions/<sessionId>/meta.json` versioned `SessionMetaV1 {version:1, sessionId, canonicalRoot, realRoot, createdAt, lastActivityAt, activeTurnId|null, allowedRootsSnapshot?}`. Atomic write temp+rename. Boot re-validates canonicalRoot via `ProjectRoot.create(canonicalRoot, currentAllowedRoots)` with current config, never overrides, clears activeTurnId, persists. Security: persisted roots informational only, never trust old metadata for authorization.
- **PathError**: Typed error with `code: ToolErrorCode`, `retryable`, stable message, no raw ENOENT leak. Mapping: ENOENT->PATH_NOT_FOUND retryable true, EACCES/EPERM->PERMISSION_DENIED false, EISDIR->IS_DIRECTORY true, ENOTDIR->NOT_A_DIRECTORY true, EEXIST->FILE_EXISTS true, else IO_ERROR true. Traversal/absolute/symlink escape -> PATH_ESCAPES_ROOT false.
- **Stop**: User cancel action. Must propagate to model signal, tool process tree, pending approvals. Maps to `turn_cancelled`. Cancellation followed immediately by new turn allowed because finishTurn clears guard in finally.

## UI

- **TurnUiState**: Materialized from `TurnState` via same reducer, or directly `TurnState`. `applyEvent` becomes import of `reduceTurnState`.
- **Last-Event-ID**: SSE `id:` = `seq`, client sends header automatically (EventSource) or `?afterSeq=` (fetch). Server replays `seq > afterSeq`. Supported now, not deferred.

## Ownership and lifecycle (Phase 4-7)

- **Turn owns root AbortController**: Created in loop.run(), never replaced, only source of cancellation. Child deadlines observe it, never detach.
- **Each operation owns its Deadline and disposes in finally**: model-call, tool executor, approval request each create Deadline via `createDeadline` or `runWithDeadline` and dispose in finally. No leak: clock.timers==0, timer/grace undefined, disposed true.
- **Parent propagates exactly once**: parent listener registered once:true, removed in dispose. Child timeout does NOT cancel siblings or turn unless loop explicitly maps (model timeout -> turn_failed, tool timeout -> tool_completed recoverable, approval expiry -> APPROVAL_TIMEOUT).
- **Approval cancellation via settle({kind:cancelled})**: Not direct rejection. `settle` sole mutator first-wins, removes from both maps, clears timer, resolves promise. `cancelTurn` calls settle(cancelled) for all byTurn.
- **runWithDeadline never returns before settle or grace**: Phase1 race, Phase2 await shutdown with bounded grace. If operation ignores abort beyond grace, throws `shutdown_timeout` distinct from `deadline_expired`/`cancelled`.
- **shutdown_timeout meaning**: Abort requested, operation not confirmed stopped within grace. Message never claims dead. Mapped to MODEL_FAILED/TOOL_FAILED at boundary, not TIMEOUT.
- **ProjectRoot single owner for fs safety**: Constructed only from validated allowedRoots, canonicalizes once, retains realRoot separately. Centralizes all path authorization in `resolve()` (sync logical) + `resolveReal()` (async logical+realpath). Logical containment synchronously before fs access. For existing paths, verifies realpath containment to block symlink escapes. For nonexistent targets, resolves and verifies nearest existing parent's realpath is inside realRoot, then applies explicit `createParents` policy (default false -> PATH_NOT_FOUND, true -> mkdir -p). Rejects absolute, traversal, encoded, unauthorized roots with stable codes. Capability instances isolated, concurrent turns cannot cross roots. Loop creates ProjectRoot once per turn, passes to tools via context, migrates away from duplicated cwd fields.
- **SessionManager owns session lifecycle**: Session selects ProjectRoot once at creation, validated against allowedRoots, pinned. Later turns cannot silently change root — getOrCreateSession checks canonicalRequested == pinned canonicalRoot else ROOT_MISMATCH 400. At most one active turn per session — tryStartTurn sync atomic, second concurrent start rejected deterministically 409 TURN_ALREADY_ACTIVE with activeTurnId. Pending creation lock prevents duplicate sessions during concurrent first-turn requests. Cleanup: finishTurn clears activeTurnId on completion/cancellation/failure via finally (idempotent), DELETE /sessions cancels active turn and deletes session, evictOldest deletes oldest inactive sessions. SSE disconnect is observational only — unsubscribe listeners but must NOT release active-turn lease or cancel turn — release only via actual completion/cancel/failure. Every tool invocation receives pinned capability from session. Session metadata persisted via FileSessionStore with atomic temp+rename, activeTurnId cleared on boot, re-validated against current allowedRoots.
- **FileTurnLogStore owns per-turn JSONL persistence**: Per-turn serialized queue via Map<turnId, Promise> ensures serialized writes within one process, O_APPEND atomic <4KB, optional fsync, crash recovery truncates incomplete last line before next append. Recovery handles truncated final line ignored, malformed middle skip+warn, identity mismatches reject/quarantine, duplicate seq keep first, out-of-order sorted on read with diagnostic (never rewrites file automatically except RESTART and truncated cleanup), gaps warn. Boot appends exactly one RESTART at maxSeq+1 for non-terminal turns, idempotent (second boot no second RESTART). Retention via deleteTurnFile, eviction deletes files. Concurrency boundary: serialized within one process, multi-process unsupported documented explicitly, O_APPEND alone does not provide session-level correctness.
- **FileSessionStore owns session meta persistence**: Versioned meta.json with canonicalRoot, realRoot, timestamps, activeTurnId, allowedRootsSnapshot informational only. Atomic write temp+rename. Boot re-validates canonicalRoot via ProjectRoot.create with current allowedRoots, never overrides, clears activeTurnId, persists updated meta. Security: persisted roots informational only, never trust old metadata for authorization.

## Invariants (from Phases 1-7)

1. `seq` owned by TurnManager, single writer, monotonic, no gaps.
2. `subscribe(afterSeq)` atomic replay-then-live, no gap, no duplicate (seq makes idempotency property of stream).
3. `TurnState.status` derived only by `reduceTurnState`, never stored separately. `TurnResult` removed — event log is single channel.
4. Tool failures (`TOOL_FAILED`, `TOOL_TIMED_OUT`, `APPROVAL_DENIED`, `UNKNOWN_TOOL`, `PATH_ESCAPES_ROOT`, `PATH_NOT_FOUND`, etc) stay `running`, result appended to next LLMRequest. Model failures (`MODEL_TIMEOUT`, `MODEL_FAILED`), approval timeout (`APPROVAL_TIMEOUT`), `TURN_LIMIT` are terminal `failed`. Cancellation always terminal `cancelled`. Mapping happens once at loop boundary via `mapDeadlineError` and executor maps PathError to ToolResult.
5. Approval lifetime independent of SSE observer — disconnect does not settle. Single expiry source via Deadline, no duplicate timers.
6. `FakeProvider.requests[]` is test surface for "tool result appended".
7. `TurnLogStore` seam: InMemory as test double (deterministic), FileTurnLogStore JSONL per turn under WINDOWS_RUNNER_DATA_DIR with corruption handling and diagnostics. Restart with file store: boot reads all turn files, folds, appends exactly one RESTART at maxSeq+1 for non-terminal, idempotent.
8. **Deadline single owner**: Each operation creates Deadline, owns timer/parent listener/grace timer, disposes in finally, idempotent. No duplicate expiry calcs.
9. **Abort-and-await**: Signal first, then await provider shutdown. `shutdown_timeout` distinct, no false claim dead.
10. **Dependency direction**: infra `deadline.ts` and `project-root.ts` have no agent imports. `providers/model-call` and `agent/tools/executor` depend on infra, not agent. Wrong-way `providers -> agent/timeout` deleted.
11. **Leak checks**: After every scenario verify clock.timers==0, deadline._timer undefined, disposed true, entries/byTurn size 0, exactly one terminal event, no duplicate approval_resolved, no sibling cancel.
12. **ProjectRoot single owner for fs safety**: All path authorization centralized in ProjectRoot.resolve/resolveReal, not reimplemented in tools. Logical containment synchronously before fs, realpath verification for existing paths to block symlink escapes, nearest existing parent verification for nonexistent targets, explicit createParents policy, stable error codes, no raw ENOENT leak, isolated concurrent instances, deadline still applies.
13. **Tool failures recoverable**: Filesystem errors become ToolResult ok:false with stable code, not terminal turn_failed, so model can retry with other path.
14. **Session root pinning**: Session selects ProjectRoot once at creation, validated against allowedRoots, pinned. Later turns cannot change root — ROOT_MISMATCH 400.
15. **One-active-turn policy**: At most one active turn per session, second concurrent start rejected deterministically 409 TURN_ALREADY_ACTIVE with activeTurnId. Guard cleared on completion/cancellation/failure via finally, not on SSE disconnect. Cancellation followed immediately by new turn allowed. Two sessions different roots isolated, concurrent active allowed (different sessions). Pending creation lock prevents duplicate sessions during concurrent first-turn requests.
16. **Session cleanup**: finishTurn clears activeTurnId, DELETE /sessions cancels active and deletes, evictOldest deletes inactive oldest. SSE disconnect remains observational only.
17. **File persistence C Hybrid**: Per-session meta.json + per-turn JSONL, serialized per-turn queue, O_APPEND atomic, optional fsync, configurable durable-before-notify, strict validation (seq>0, turnId==filename, sessionId==dir, duplicate keep first, out-of-order sorted with diagnostic never rewrites file automatically), truncated final ignored with crash recovery truncating incomplete tail before next append, malformed middle skip+warn, gaps warn, identity mismatches reject/quarantine, quarantine >50% invalid, flat-layout fallback migration without changing source files (preserves original, appends RESTART only), legacy providerCallId fallback, retention/eviction via deleteTurnFile and delete session dir, security persisted roots informational only re-validated via ProjectRoot.create against current allowedRoots never override, boot clears activeTurnId and appends exactly one RESTART at maxSeq+1 idempotent, concurrency boundary serialized within one process documented explicitly multi-process unsupported.
18. **Durable-before-notify**: TurnManager durableBeforeNotify option — when true appendAsync awaits store.append (and fsync if enabled) before notifying listeners (durable before SSE), when false async notify before persist. For file store, durable recommended for correctness.

## Scenarios verified

### Deadline (10 + 2 integration)

1. Parent cancel during model streaming -> cancelled, no leak
2. Parent cancel during tool execution -> cancelled, no leak
3. Parent cancel during approval wait -> resolution cancelled, maps empty
4. Child timeout sibling isolation -> expired one, sibling still ok
5. Repeated abort idempotent -> first wins, second no-op
6. Same-tick timeout vs cancel -> exactly one terminal
7. Provider resolves during grace -> confirmed stopped, expired within grace
8. Provider never resolves -> shutdown_timeout, no false dead claim
9. Disposal before expiry and after settlement -> no leak
10. Nested child outlive attempt -> child expiresAt <= parent expiresAt, child aborted when parent aborts
11. Integration model vs tool vs approval sibling isolation
12. Integration abort-ignoring provider shutdown_timeout distinct

### ProjectRoot (13)

1. Valid relative paths (., ./a/./b)
2. Absolute paths rejected (/etc/passwd, C:\Windows)
3. Traversal .. rejected (../, a/../../b, .., ../../etc) but a/b/.. allowed if stays inside
4. Encoded traversal rejected (%2e%2e, %2F)
5. Platform separators (..\\..\\, a\\b/c)
6. Symlink escaping root (link->/etc rejected, linkInside->subdir allowed)
7. Missing parent directories (read PATH_NOT_FOUND, write without createParents PATH_NOT_FOUND, with createParents creates)
8. Files vs directories (mkdir where file exists FILE_EXISTS, read dir IS_DIRECTORY, write where parent is file NOT_A_DIRECTORY)
9. Permission errors normalized (EACCES->PERMISSION_DENIED, no raw leak)
10. Concurrent roots isolation (two ProjectRoot instances, different temp dirs, cannot cross via ../)
11. Deadline cancellation/timeout during fs (signal abort, executor timeout -> TOOL_TIMED_OUT)
12. Exact ToolResult error codes and model-facing messages (PATH_ESCAPES_ROOT stable message, PATH_NOT_FOUND retryable, no ENOENT leak)
13. AllowedRoots validation (inside allowed passes, outside fails)

### SessionManager (8) + Routes (8)

1. Session selects root once, later turns cannot change -> ROOT_MISMATCH 400
2. Two concurrent starts -> second 409 TURN_ALREADY_ACTIVE
3. Cleanup after model/tool/approval failure -> guard cleared
4. Cancellation followed immediately by new turn -> allowed
5. Two sessions different roots isolated, concurrent active allowed
6. Rejected roots and symlink escapes at session creation -> 403 PATH_ESCAPES_ROOT
7. Concurrent creation pending lock prevents duplicate -> one succeeds, one 409 SESSION_ALREADY_EXISTS
8. SSE disconnect observational only — does not release lease
9. Routes: explicit session creation 201, duplicate 409, turn with pinned root, root mismatch 400, concurrent 409, cancel + new turn allowed

### File Persistence (19)

1. FileTurnLogStore atomic serialized appends per turn
2. Durable vs async notification ordering
3. Truncated final record ignored
4. Malformed middle record skipped and warned
5. Duplicate sequence keep first
6. Out-of-order sequences sorted on read, diagnostic emitted, never rewrites file automatically
7. Gaps and identity mismatches
8. Quarantine behavior >50% invalid
9. Crash during append — truncated last line ignored, file not corrupted, next append truncates incomplete tail
10. Legacy providerCallId fallback
11. Retention and flat-layout migration
12. Concurrency boundary: serialized writes within one process, multi-process unsupported documented
13. FileSessionStore save/load atomic
14. Root rejection after configuration changes
15. Restart recovery clears activeTurnId and never trusts persisted roots for authorization
16. Retention and eviction
17. Integration restart appends exactly one RESTART at maxSeq+1 and clears activeTurnId
18. Idempotency of restart recovery — second boot does not append second RESTART
19. Flat-layout fallback migration without changing source files

## Follow-up order (from report)

1. #2 approval invariants (done)
2. #1 unified deadline (done)
3. #5 Tool contract / filesystem safety (done — ProjectRoot capability)
4. #4 minimum ProjectRoot model (done — session root pinning + one-active-turn policy)
5. #7 event log persistence (file adapter) — done (C Hybrid per-session meta + per-turn JSONL, serialized, configurable durable, strict validation, crash recovery, security revalidation, retention)
