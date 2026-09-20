# ADR: ProjectRoot Capability Backed by Logical + Optional Realpath

Date: 2026-09-20
Status: Accepted
Context: Exploration #5 Tool contract & filesystem safety, Phase 2-4

## Problem

Previous `safePath` was trivially bypassable:

```ts
safePath: (requested) => {
  if (requested.includes("..") && (requested === ".." || requested.startsWith("../") || requested.includes("/../") || requested.endsWith("/.."))) throw...
  return requested;
}
```

- Allowed absolute paths `/etc/passwd`
- Missed `a/b/..`, `src/../..`, `a/../../b`
- No handling for `.`, encoded `%2e%2e`, platform `\`
- Returned relative string unchanged, tool used process cwd not root, so no confinement
- No symlink check: root containing symlink to `/etc` would escape
- No decision for missing nested paths (create vs reject)
- Raw ENOENT/EACCES leaked as unstable model-facing messages
- `cwd` string repeated per turn, no validated allowedRoots, concurrent roots could race
- No stable ToolErrorCode for filesystem

## Decision

Implement **ProjectRoot capability backed by logical + optional realpath** (Candidate C).

### Core design

- **Construction only from validated allowedRoots**: `ProjectRoot.create(requestedRoot, allowedRoots)` canonicalizes once `canonicalRoot = path.resolve(requestedRoot)`, retains real root separately `realRoot = realpath(canonicalRoot)`, checks `isInside(canonicalRequested, canonicalAllowed)` and `isInside(realRequested, realAllowed)`. Single validation per turn, not per tool call.

- **Single resolveSafePath() implementation centralized**: 
  - `resolve(requested): string` sync logical: rejects null byte, decodes URI and rejects encoded traversal `%2e%2e`, rejects absolute, normalizes `\` to `/`, `logical = path.resolve(canonicalRoot, requested)`, checks `isInside(logical, canonicalRoot)` via `path.relative`. No fs access, pure, testable without fs. For non-existing, returns logical if inside — allows creation.
  - `resolveReal(requested): Promise<string>` logical + realpath: calls resolve() then if exists `real = realpath(logical)` checks `isInside(real, realRoot)` else PATH_ESCAPES_ROOT. For non-existing, finds nearest existing parent, realpaths parent, checks inside realRoot, then allows logical for creation. Prevents symlink escape for existing files and for parent chain of non-existing.

- **Missing parent policy explicit**: `writeFile(requested, content, {createParents})` — if parent missing and createParents false -> PATH_NOT_FOUND, if true -> mkdir -p then write. Read never creates. Distinct from permission.

- **Stable errors**: `PathError` with `code: ToolErrorCode`, `retryable`, stable message, no raw ENOENT leak. Mapping: ENOENT->PATH_NOT_FOUND true, EACCES/EPERM->PERMISSION_DENIED false, EISDIR->IS_DIRECTORY true, ENOTDIR->NOT_A_DIRECTORY true, EEXIST->FILE_EXISTS true, traversal/absolute/symlink escape->PATH_ESCAPES_ROOT false.

- **Capability instances isolated**: Each turn gets its own ProjectRoot instance, concurrent turns cannot cross roots. `getRoot()` returns canonicalRoot for terminal tool cwd.

- **Migration away from duplicated cwd**: `RunTurnInput` cwd converted to ProjectRoot once in `TurnRunner.run()`, `ToolExecutionContext` now `{projectRoot, signal, cwd (deprecated), safePath (wrapper)}`. Deletes safePath closure and cwd repetition.

- **Deadline still applies**: Executor wraps tool execution in `runWithDeadline` kind=tool, ProjectRoot methods accept signal and race with abort, hanging fs returns TOOL_TIMED_OUT via deadline, no leak.

### Why C over A and B

- **A Strict realpath**: Most secure but not workable for non-existing paths without complex parent walk, async everywhere, high migration cost, testability needs real fs + symlink platform issues. Fails for write/mkdir/persistence future.
- **B Logical+optional realpath**: Solves non-existing by logical allow + realpath for existing, testable pure, low migration, but still allows tools to reimplement checks and doesn't centralize error mapping.
- **C Capability**: B's core + capability wrapper that owns fs safety, centralizes error mapping, reifies root vs repeated cwd, directly supports future write/mkdir/persistence, isolated concurrent roots, testable logical pure + capability mockable. Deletion test: deletes naive safePath closure, deletes cwd repetition, deletes ad-hoc fs error handling, replaces with single ProjectRoot owner.

### Deletion/complexity test

- Deletes: loop.ts inline safePath closure, cwd string repetition in RunTurnInput/ToolExecutionContext, ad-hoc fs error handling in tools
- Adds: ProjectRoot class ~150 lines, error mapping ~50 lines, capability methods ~100 lines. Net complexity similar but removes duplication, single owner.

## Consequences

- All path authorization centralized in ProjectRoot, tools never call `path.resolve` or `fs` directly with user path
- Stable ToolErrorCode values for filesystem, model sees "path escapes root" not "ENOENT"
- Symlink escapes blocked for existing files and for parent chain of non-existing
- Missing parent handling explicit via createParents flag
- Concurrent roots isolated
- Deadline cancellation/timeout still applies during fs operations
- Future file persistence can reuse ProjectRoot without duplicating authorization logic

## Tests (13)

- Valid relative, absolute rejected, traversal .. rejected, encoded rejected, platform separators, symlink escaping, missing parent with/without createParents, file vs dir, permission normalized, concurrent roots isolation, deadline timeout/cancel, exact ToolResult codes/messages stable, allowedRoots validation

## Rejected alternatives

- Keep safePath closure: insecure, bypassable, no symlink check, raw ENOENT leaks — rejected
- Strict realpath only: fails for non-existing paths, complex parent walk, async everywhere — rejected
- Logical only without realpath: allows symlink escape for existing files — rejected, need realpath for existing

## Follow-up

- ProjectRoot capability partially satisfies #4 minimum ProjectRoot model (reify root, concurrency policy). Remaining for #4: concurrency policy (at most one active turn per session) and session root pinning.
- File persistence (#7) can now reuse ProjectRoot for safe path resolution.
