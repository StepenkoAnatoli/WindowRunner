# Persistence Configuration Defaults — Safe Defaults

## Environment

- `WINDOWS_RUNNER_DATA_DIR`: Root directory for file persistence. Default: OS temp dir or `./data` if not set. Must be inside allowedRoots? No, data dir is separate from project roots, but should be validated as absolute path.
- `WINDOWS_RUNNER_PERSISTENCE_MODE`: `memory` (default) or `file`. Memory is safe default for development, file for production.
- `WINDOWS_RUNNER_DURABLE_BEFORE_NOTIFY`: `true` (default for file mode) or `false`. When true, TurnManager awaits store.append (and fsync if enabled) before notifying SSE listeners — ensures durability before client sees event. When false, async notify before persist — faster but possible loss on crash, RESTART appended on recovery.
- `WINDOWS_RUNNER_FSYNC`: `false` (default) or `true`. When true, FileTurnLogStore does open+write+fsync+close for durability. False relies on OS buffer, faster, possible loss of last few events on crash, truncated handling recovers.
- `WINDOWS_RUNNER_ALLOWED_ROOTS`: Comma-separated list of allowed project roots. Default empty (allow any for tests, but production should set). Used for ProjectRoot validation and session recovery re-validation.

## FileTurnLogStoreOptions

```ts
{
  dataDir: string, // required, absolute, e.g. process.env.WINDOWS_RUNNER_DATA_DIR || os.tmpdir()
  fsync?: boolean, // default false for performance, true for durability
  maxLineBytes?: number, // default 1MB, max event line size
}
```

- Safe default: fsync false for dev, true for prod if durability required. maxLineBytes 1MB prevents huge events.

## FileSessionStoreOptions

```ts
{
  dataDir: string, // same as above
}
```

- Atomic write via temp file + rename, safe.

## TurnManagerDeps

```ts
{
  store?: TurnLogStore, // default InMemoryTurnLogStore
  now?: () => number,
  durableBeforeNotify?: boolean, // default false for backward compat, true recommended for file mode
}
```

- Safe default: durableBeforeNotify false for InMemory (no durability), true for File (durability before SSE).

## SessionManagerDeps

```ts
{
  now?: () => number,
  isTurnTerminal?: (turnId) => boolean,
  sessionStore?: FileSessionStore, // optional, for persistence
}
```

- Safe default: sessionStore undefined for memory mode, FileSessionStore for file mode.

## Security

- Persisted canonicalRoot, realRoot, allowedRootsSnapshot informational only, never authorize by themselves. Boot re-validates via ProjectRoot.create with current allowedRoots.
- Data dir should not be inside project root to avoid symlink attacks? Actually data dir can be separate, but if inside project root, still validated via ProjectRoot? Data dir is not validated via ProjectRoot, it's separate.

## Single-Process Writer Limitation

- FileTurnLogStore guarantees serialized writes within one process via per-turn queue Map<turnId, Promise>.
- Multi-process writers UNSUPPORTED — O_APPEND alone does NOT provide session-level correctness, no file lock.
- Documented prominently in FileTurnLogStore header, CONTEXT.md invariants, README, and RELEASE_CHECKLIST.
- For production, run single server instance per dataDir, or use external lock (future).

## Operational

- Retention: maxTurnsPerSession default 100, maxSessions default 100, maxAgeMs default 30 days (future config)
- Eviction: only terminal turns, preserves active
- Diagnostics: BootDiagnostics observable via getDiagnostics() and logs, health endpoint can expose
- Quarantine: >50% invalid lines moved to quarantine/ dir, cannot be loaded as active
