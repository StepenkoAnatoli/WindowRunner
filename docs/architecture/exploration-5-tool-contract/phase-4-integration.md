# Exploration #5 — Phase 4: Integration — ProjectRoot Capability

## What was implemented

### ProjectRoot module `packages/server/src/project-root.ts`

- `PathError` class with `code: ToolErrorCode`, `retryable`, stable message
- `ProjectRoot` with `canonicalRoot`, `realRoot`, `allowedRoots`, `realAllowedRoots`
- `static async create(requestedRoot, allowedRoots)`:
  - Rejects null byte, requires absolute
  - Canonicalizes `path.resolve`
  - Validates inside allowedRoots logically and realpath
  - Realpaths root, checks isDirectory, allows non-existing when allowedRoots empty (for tests)
  - Returns isolated instance
- `resolve(requested): string` sync logical:
  - Null byte, encoded traversal `%2e%2e` via decodeURIComponent, absolute, platform `\` normalized to `/`
  - `logical = path.resolve(canonicalRoot, normalizedRequested)`
  - `isInside(logical, canonicalRoot)` via `path.relative`
  - Returns logical, no fs
- `resolveReal(requested): Promise<string>` async logical+realpath:
  - Calls resolve(), then realpath if exists, checks inside realRoot, else PATH_ESCAPES_ROOT
  - For non-existing, finds existing parent via `findExistingParent`, realpaths parent, checks inside realRoot, returns logical for creation
- `findExistingParent(p)` walks up dirname until stat succeeds
- Capability methods: `readFile`, `writeFile({createParents, signal})`, `stat`, `mkdir({recursive, signal})` with signal abort support and error mapping
- `mapFsError` central mapping ENOENT->PATH_NOT_FOUND, EACCES/EPERM->PERMISSION_DENIED, EISDIR->IS_DIRECTORY, ENOTDIR->NOT_A_DIRECTORY, EEXIST->FILE_EXISTS, else IO_ERROR

### Shared types

- Extended `ToolErrorCode` with `PATH_ESCAPES_ROOT`, `PATH_NOT_FOUND`, `NOT_A_FILE`, `NOT_A_DIRECTORY`, `IS_DIRECTORY`, `PERMISSION_DENIED`, `FILE_EXISTS`, `IO_ERROR`

### Tool contract migration

- `ToolExecutionContext` now `{projectRoot: ProjectRoot, signal, cwd (deprecated), safePath (wrapper)}`
- `executor.ts` wraps execute in `runWithDeadline` kind=tool, creates childCtx with projectRoot, cwd, safePath wrapper around projectRoot.resolve, maps PathError to ToolResult stable codes, maps raw ENOENT/EACCES defense in depth
- `loop.ts` constructs ProjectRoot once per turn from cwd + allowedRoots (allowedRoots from deps or input), passes to executeTool, deletes naive safePath closure, validates root once
- `app.ts` adds `allowedRoots` to AppDeps and passes to TurnRunner

### Tests (13 new + 40 existing = 53)

ProjectRoot tests covering user requirements:
- valid relative paths (., ./a/./b)
- absolute paths rejected (/etc/passwd, C:\Windows)
- traversal .. rejected (../, a/../../b, .., ../../etc) but a/b/.. allowed if stays inside
- encoded traversal rejected (%2e%2e, %2F)
- platform separators (..\..\, a\b/c)
- symlink escaping root (link->/etc rejected, linkInside->subdir allowed)
- missing parent (read PATH_NOT_FOUND, write without createParents PATH_NOT_FOUND, with createParents creates)
- files vs directories (mkdir where file exists FILE_EXISTS, read dir IS_DIRECTORY, write where parent is file NOT_A_DIRECTORY)
- permission normalized (EACCES->PERMISSION_DENIED, no raw leak)
- concurrent roots isolation (two ProjectRoot instances, different temp dirs, cannot cross via ../)
- deadline cancellation/timeout during fs (signal abort, executor timeout -> TOOL_TIMED_OUT)
- exact ToolResult codes/messages stable (PATH_ESCAPES_ROOT message, PATH_NOT_FOUND retryable, no ENOENT leak)
- allowedRoots validation (inside allowed passes, outside fails)

All 53 tests passing, tsc shared/server/web passing.

## Ownership and lifecycle

- **ProjectRoot single owner for fs safety**: Constructed only from validated allowedRoots, canonicalizes once, retains realRoot separately. Centralizes all path authorization in resolve() + resolveReal(). Logical containment synchronously before fs, realpath verification for existing paths to block symlink escapes, nearest existing parent verification for nonexistent targets, explicit createParents policy.
- **Loop owns ProjectRoot creation**: Once per turn, validated, passed to tools, not duplicated cwd fields
- **Executor owns deadline**: Wraps tool execution, deadline still applies when fs hangs, returns TOOL_TIMED_OUT, no leak
- **Tools never reimplement path checks**: Use projectRoot.readFile/writeFile or resolve() for cwd, get stable error codes automatically

## Verification

- tsc shared/server/web ok
- 53 tests ok (13 project-root + 12 deadline + 6 loop + 8 shared + 3 web + 4 routes + 7 others)
- No infra->agent imports (project-root is infra, no agent imports)
- No raw ENOENT/EACCES leak in ToolResult messages
- Concurrent roots isolated
- Deadline cancellation/timeout during fs works

## Documentation

- CONTEXT.md updated with ProjectRoot capability, PathError, stable codes, ownership, invariants, scenarios
- ADR `adr-project-root-capability.md` explains why C chosen over A/B, deletion/complexity test
- Phase 1-4 docs in `docs/architecture/exploration-5-tool-contract/`

## Next step

#4 minimum ProjectRoot model — partially done via ProjectRoot capability, remaining: concurrency policy (at most one active turn per session) and session root pinning. File persistence (#7) can reuse ProjectRoot.
