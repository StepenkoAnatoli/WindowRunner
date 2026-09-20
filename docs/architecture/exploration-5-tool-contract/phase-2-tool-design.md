# Exploration #5 — Phase 2: Tool Contract & Filesystem Safety Design

## Goals (from Phase 1 + user)

- Reject traversal `..`, `../`, nested `a/b/../../c`, absolute paths, encoded separators, platform `\`
- Resolve and compare canonical paths, including symlink behavior
- Decide missing nested paths: create, reject typed, distinct from permission
- Replace raw ENOENT with stable ToolErrorCode
- Tool failures remain recoverable (running, not terminal)
- Deadlines and abort cleanup still apply when fs fails/hangs
- Tests: absolute, `.`/`..`, encoded/platform separators, symlink escape, missing parent, file vs dir, permission, concurrent roots, timeout/cancel, exact ToolResult codes

## Shared concepts

### ProjectRoot (minimal, for all candidates)

```
class ProjectRoot {
  readonly canonicalRoot: string // path.resolve(root) normalized, no trailing slash
  readonly realRoot: string // fs.realpath(canonicalRoot) or canonical if not exist? Must exist
  static create(requestedRoot: string, allowedRoots: string[]): ProjectRoot
  resolve(requested: string): string // throws typed PathError with code
}
```

- Validated once against allowedProjectRoots (authorized roots) — reify root, not repeated cwd fields
- `resolve` is the single confinement check, owned by ProjectRoot, not loop.ts inline
- Tools receive ProjectRoot in context, not cwd string + closure
- Future: methods `readFile`, `writeFile`, `mkdir`, `stat` that use resolve internally and map errors

### Stable ToolErrorCode extension (proposed)

Current: TOOL_FAILED | TOOL_TIMED_OUT | APPROVAL_DENIED | UNKNOWN_TOOL | CANCELLED

Proposed addition for filesystem (keep backward compat, new codes are subset of TOOL_FAILED family but distinct):

- PATH_ESCAPES_ROOT (not retryable)
- PATH_NOT_FOUND (retryable? model may try other path — decide retryable true)
- NOT_A_FILE / NOT_A_DIRECTORY / IS_DIRECTORY (retryable true)
- PERMISSION_DENIED (not retryable)
- FILE_EXISTS (for create exclusive)
- IO_ERROR (generic)

Mapping: all filesystem errors become ToolResult ok:false with these codes, not raw ENOENT. Model-facing message is stable, e.g., "path escapes root: /etc/passwd" not "ENOENT: no such file".

### Error mapping table

| fs error | code | retryable | message |
|----------|------|-----------|---------|
| path escapes root (logical or realpath) | PATH_ESCAPES_ROOT | false | "path escapes project root: <requested>" |
| absolute path /etc/passwd | PATH_ESCAPES_ROOT | false | same |
| ENOENT parent missing | PATH_NOT_FOUND | true | "path not found: <resolved>, parent missing" |
| ENOENT file not found | PATH_NOT_FOUND | true | "file not found: <path>" |
| EACCES | PERMISSION_DENIED | false | "permission denied: <path>" |
| EISDIR when expecting file | NOT_A_FILE | true | "not a file: <path> is directory" |
| ENOTDIR when parent is file | NOT_A_DIRECTORY | true | "not a directory: <parent> is file" |
| EEXIST | FILE_EXISTS | true | "file exists: <path>" |

## Candidate A: Strict realpath confinement

### Design

- At ProjectRoot creation: `realRoot = await realpath(canonicalRoot)`, must exist, must be inside allowedRoots (realpath allowedRoots too)
- `resolve(requested)`:
  1. Reject if requested is absolute (path.isAbsolute) -> PATH_ESCAPES_ROOT
  2. Reject if contains null byte or encoded %2e%2e (decode URI component, if decoded != original and contains .. -> reject)
  3. Logical resolve: `logical = path.resolve(canonicalRoot, requested)` (posix + win32 normalized)
  4. Check `logical === canonicalRoot || logical.startsWith(canonicalRoot + sep)` else PATH_ESCAPES_ROOT
  5. Realpath: try `realpath(logical)`; if succeeds, check `realpathResult === realRoot || realpathResult.startsWith(realRoot+sep)` else PATH_ESCAPES_ROOT
  6. If realpath fails with ENOENT: walk up parents until existing, realpath that parent, check containment, then allow if parent contained. If no existing parent up to root -> PATH_NOT_FOUND
  7. Return logical (or realpath) as safe absolute path

- Async because realpath is async. So `resolve` becomes async, and `safePath` becomes async, which changes ToolExecutionContext to async resolve. Migration cost: tools that used sync safePath now need await.

### Before / After

Before (current):
```ts
safePath: (requested) => {
  if (requested.includes("..") && (requested === ".." || requested.startsWith("../") || requested.includes("/../") || requested.endsWith("/.."))) throw...
  return requested; // still relative, not confined
}
readFile(requested) => fs.readFile(requested) // uses process cwd, escapes
```

After A:
```ts
class ProjectRoot {
  async resolve(requested: string): Promise<string> {
    if (isAbsolute(requested)) throw PathError(PATH_ESCAPES_ROOT)
    const logical = resolve(this.canonicalRoot, requested)
    if (!isInside(logical, this.canonicalRoot)) throw PathError(PATH_ESCAPES_ROOT)
    try {
      const real = await realpath(logical)
      if (!isInside(real, this.realRoot)) throw PathError(PATH_ESCAPES_ROOT)
      return real
    } catch (e) {
      if (e.code === 'ENOENT') {
        const existingParent = await findExistingParent(logical)
        const realParent = await realpath(existingParent)
        if (!isInside(realParent, this.realRoot)) throw PathError(PATH_ESCAPES_ROOT)
        // parent ok, file not exist -> allow creation path
        return logical
      }
      throw mapFsError(e)
    }
  }
}
// Tool
const abs = await ctx.projectRoot.resolve(input.path)
const content = await fs.readFile(abs, 'utf8') // now confined
```

### Evaluation

- Traversal/absolute: strict, rejects absolute, logical + realpath double-check, good
- Symlink escape: prevents all escapes because realpath checked, even if symlink inside root points outside, rejected. Most secure.
- Missing file/parent: requires parent walking logic, more complex, async, but distinct PATH_NOT_FOUND vs parent missing. Supports future mkdir if we add createParents flag.
- Concurrent roots: ProjectRoot instances independent, each has own canonical/real root, safe for concurrent calls
- Stable error codes: central mapFsError, good
- Compatibility TurnManager/deadline: resolve is async, but executor already async, deadline still applies (runWithDeadline wraps execute which awaits resolve). If resolve hangs (realpath on network mount), deadline will abort — need to pass signal to realpath? realpath doesn't accept signal, but we can race with signal.
- Testability: needs real fs or mock fs for realpath. Can test with temp dir and symlink, but platform-specific (Windows symlink requires admin). More integration-heavy.
- Migration cost: high — safePath sync -> async, ToolExecutionContext changes cwd->projectRoot, all tools updated, tests updated
- Future write/mkdir/persistence: supports, but need extra logic for create
- Deletion/complexity: deletes naive safePath closure, adds ProjectRoot class ~100 lines, parent walking ~30 lines, error mapping ~50 lines. Complexity moderate-high due to async realpath and parent walk.

### Deletion test

- Deletes loop.ts inline safePath closure
- Deletes any ad-hoc path checks in tools
- Adds ProjectRoot, but can delete cwd string repetition

## Candidate B: Logical path confinement + optional realpath for existing files

### Design

- ProjectRoot creation: canonicalRoot = path.resolve(root), realRoot = realpath(canonicalRoot) if exists, else canonicalRoot. No need to realpath allowedRoots? Check logical containment for allowedRoots too, plus optional realpath.
- `resolve(requested)` sync for logical part, async only if file exists and we want realpath check:
  1. Reject absolute, null byte, encoded %2e%2e (decode check)
  2. Normalize: replace `\` with `/` on Windows? Use path.posix.normalize after converting? Or use path.normalize which handles platform.
  3. Logical: `logical = path.resolve(canonicalRoot, requested)` — path.resolve already handles `.`, `..`, absolute
  4. Check `isInside(logical, canonicalRoot)` else PATH_ESCAPES_ROOT
  5. If file exists (stat), then optionally `real = await realpath(logical)`, check `isInside(real, realRoot)` else PATH_ESCAPES_ROOT. If not exists, skip realpath, return logical.
  6. For missing parent: if parent doesn't exist, logical check still passes (since parent inside root), return logical, let tool decide to create or return PATH_NOT_FOUND. No parent walking needed.

- So resolve can be sync if we skip realpath, or async with optional realpath. We can make two methods: `resolveLogical(requested): string` sync, and `resolveReal(requested): Promise<string>` async that does extra realpath check for existing files. Tools that read existing files should use resolveReal, tools that create new files use resolveLogical.

### Before / After

Before same as A.

After B:
```ts
// sync logical check, no fs
function resolveLogical(root: string, requested: string): string {
  if (isAbsolute(requested)) throw PATH_ESCAPES_ROOT
  const logical = path.resolve(root, requested)
  if (!isInside(logical, root)) throw PATH_ESCAPES_ROOT
  return logical
}
// async with realpath for existing
async function resolveReal(root: string, realRoot: string, requested: string): Promise<string> {
  const logical = resolveLogical(root, requested)
  try {
    const st = await stat(logical)
    const real = await realpath(logical)
    if (!isInside(real, realRoot)) throw PATH_ESCAPES_ROOT
    return real
  } catch (e) {
    if (e.code === 'ENOENT') return logical // not exist, allow
    throw mapFsError(e)
  }
}
```

### Evaluation

- Traversal/absolute: logical resolve handles `.`, `..`, absolute, good. Encoded %2e%2e handled via decode check.
- Symlink escape: prevents logical escape, but for existing files, symlink escape only prevented if realpath check enabled. If we always enable realpath for existing files, then symlink inside root pointing outside is rejected. If we make realpath optional, could allow escape if disabled. So need policy: enable realpath by default for read operations.
- Missing file/parent: simple — logical check passes even if parent missing, returns logical path. Tool can then attempt fs operation and get PATH_NOT_FOUND distinct from permission. No parent walking needed, works for non-existing paths. Good for future write/mkdir.
- Concurrent roots: ProjectRoot instances independent, sync logical check safe
- Stable error codes: same mapping, but need to decide when to map ENOENT from stat vs from fs operation
- Compatibility: resolveLogical sync, so existing tools that used sync safePath can migrate to sync version with minimal change. Deadline still applies to fs operation, not to resolve (since resolve sync fast). If realpath needed, async but still within deadline.
- Testability: logical part testable without fs (pure path), realpath part needs fs but only for existing files. Easy to unit test logical escapes without temp dir.
- Migration cost: low-medium — change cwd to projectRoot, but resolveLogical sync keeps similar shape. Can keep backward compat safePath sync wrapper around resolveLogical.
- Future: supports write/mkdir well because non-existing paths allowed logically, then mkdir can create parents.
- Deletion/complexity: deletes naive check, adds ~60 lines logical + ~40 lines realpath optional. Less complex than A because no parent walking.

### Deletion test

- Deletes inline safePath
- Keeps sync path for simple cases, adds optional async realpath only where needed

## Candidate C: ProjectRoot as capability object (recommended direction)

### Design

Combines B's logical+optional realpath but wraps in capability object that owns fs operations and error mapping, not just path resolution.

```
class ProjectRoot {
  readonly canonicalRoot: string
  readonly realRoot: string
  readonly allowedRoots: string[]
  private constructor(...)

  static async create(requestedRoot: string, allowedRoots: string[]): ProjectRoot {
    // validate requestedRoot inside allowedRoots (logical + realpath)
    // canonicalRoot = resolve(requestedRoot)
    // realRoot = await realpath(canonicalRoot)
    // check isInside(realRoot, realpath(allowedRoot)) for some allowedRoot
    // return new ProjectRoot
  }

  resolve(requested: string): string // sync logical, throws PATH_ESCAPES_ROOT
  async resolveReal(requested: string): Promise<string> // logical + realpath if exists

  // Capability methods that enforce confinement and map errors
  async readFile(requested: string, encoding): Promise<string> // resolveReal then fs.readFile, map errors
  async writeFile(requested: string, content, options): Promise<void> // resolve then mkdir parent if needed? policy
  async stat(requested: string): Promise<Stats> // resolveReal
  async mkdir(requested: string, options): Promise<void>
  // etc

  // For tools that need raw absolute path (e.g., terminal tool cwd)
  getRoot(): string // returns canonicalRoot
}
```

- ToolExecutionContext becomes `{ projectRoot: ProjectRoot, signal: AbortSignal }` — no cwd string, no safePath closure
- Tools call `await ctx.projectRoot.readFile(input.path)` instead of `safePath + fs.readFile`
- Error mapping centralized in ProjectRoot methods: catches fs errors and throws PathError with stable code, which executor maps to ToolResult
- Missing parent handling: policy option in ProjectRoot — `writeFile` with `createParents: true` creates missing parents (mkdir -p), else throws PATH_NOT_FOUND distinct. For readFile, if parent missing, throws PATH_NOT_FOUND.
- Concurrent roots: each Turn has its own ProjectRoot instance created from turn cwd validated against allowedRoots, so concurrent turns with different roots are isolated
- Deadline/abort: ProjectRoot methods accept signal? fs.promises doesn't accept signal in older Node, but we can pass signal to methods that support it, or race with signal. Executor's runWithDeadline already aborts via signal, but fs operation may ignore signal — need to ensure abort cleanup still works (deadline will throw shutdown_timeout if fs hangs)
- Input validation: ToolDefinition can have inputSchema (zod), validated before execute, but that's separate — ProjectRoot focuses on path safety

### Before / After

Before:
```ts
// loop.ts
safePath: (requested) => { if (requested.includes("..")) throw...; return requested }
executeTool(tool, input, {cwd, signal, safePath}, timeout)
// tool
const p = ctx.safePath(input.path)
const data = await fs.readFile(p) // process cwd, not root, raw ENOENT leaks
```

After C:
```ts
// loop.ts
const projectRoot = await ProjectRoot.create(cwd, allowedRoots)
executeTool(tool, input, {projectRoot, signal}, timeout)
// tool
const data = await ctx.projectRoot.readFile(input.path) // confined, stable error codes
// or if need absolute for terminal
const abs = ctx.projectRoot.resolve(input.path) // sync, throws PATH_ESCAPES_ROOT
```

### Evaluation

- Traversal/absolute: same as B logical, strict, rejects absolute, handles `.`/`..`, encoded, platform `\` via path.normalize + decode check
- Symlink escape: uses realRoot check for existing files (resolveReal), prevents symlink escape, but allows non-existing paths. Best of both A and B.
- Missing file/parent: distinct handling — readFile -> PATH_NOT_FOUND if parent missing or file missing, writeFile with createParents option creates parents, else PATH_NOT_FOUND. Clear policy, supports future persistence.
- Concurrent roots: ProjectRoot per turn, validated once, isolated, good
- Stable ToolErrorCode: centralized mapFsError in ProjectRoot, all fs errors mapped to stable codes, no raw ENOENT leaks
- Compatibility TurnManager/deadline: ProjectRoot.create async (realpath), but can be done once per turn before loop. resolve sync fast, readFile async within deadline. Deadline still applies: if readFile hangs, runWithDeadline will abort and throw shutdown_timeout after grace.
- Testability: logical resolve pure, testable without fs. Capability methods testable with temp dir + symlink, but also mockable. Concurrent roots test easy: create two ProjectRoot with different temp dirs, ensure isolation.
- Migration cost: medium — changes ToolExecutionContext, loop, app, tools, tests. But aligns with CONTEXT.md plan to reify root and removes cwd repetition. Cost justified.
- Future write/mkdir/persistence: directly supports, as ProjectRoot owns mkdir, writeFile with createParents, persistence layer can use same ProjectRoot.
- Deletion/complexity: deletes naive safePath, deletes cwd string passing, deletes ad-hoc fs error handling in tools. Adds ProjectRoot class ~150 lines, error mapping ~50 lines. Net complexity similar to B but more capability, less duplication in tools. Single owner for fs safety.

### Deletion test

- Deletes loop.ts safePath closure
- Deletes cwd field repetition in RunTurnInput? Replace with projectRoot
- Deletes raw fs calls in tools, replaced by projectRoot methods
- Adds one class, but removes duplicated checks

## Comparison matrix

| Criteria | A Strict realpath | B Logical+optional realpath | C ProjectRoot capability |
|----------|-------------------|-----------------------------|--------------------------|
| Traversal/absolute handling | Strict, logical+realpath double | Logical strict, good | Same as B, strict |
| Symlink escape prevention | Prevents all, most secure | Prevents if realpath enabled, configurable | Prevents for existing, allows non-existing, secure |
| Missing file/parent | Complex parent walk, async | Simple, logical allows non-existing, distinct | Policy-based, createParents option, distinct codes |
| Concurrent roots | Isolated instances | Isolated | Isolated, validated once |
| Stable error codes | Central map | Central map | Central capability + map, best |
| Compatibility deadline | realpath async must race signal | resolve sync fast, fs async within deadline | Same as B, plus ProjectRoot.create once per turn |
| Testability | Needs fs for realpath, platform symlink issues | Logical pure testable without fs, realpath optional | Logical pure + capability mockable, best |
| Migration cost | High (sync->async, all tools) | Low-medium (sync wrapper possible) | Medium (context change, but aligns with plan) |
| Future write/mkdir/persistence | Supports but complex parent logic | Supports well | Directly supports, owns mkdir/write |
| Deletion/complexity | Deletes naive, adds 130+ lines + parent walk | Deletes naive, adds ~100 lines | Deletes naive + cwd repetition + ad-hoc fs, adds ~200 lines but removes duplication |

## Top recommendation

**Candidate C: ProjectRoot as capability object backed by logical + optional realpath (B's core) — essentially B + capability wrapper.**

Reasoning:
- User expected direction is ProjectRoot capability backed by strict canonical containment, and C matches that.
- Strict realpath (A) is not workable for paths that do not yet exist without complex parent walking and async everywhere. For new file creation, we need logical containment to allow non-existing paths. So A alone fails for write/mkdir/persistence future.
- B's logical+optional realpath solves non-existing path problem: logical check allows non-existing inside root, realpath check only for existing files prevents symlink escape. This is necessary.
- C adds capability wrapper around B's logic, centralizing error mapping and fs operations, which is required for stable ToolErrorCode and for future write/mkdir/persistence. It also reifies ProjectRoot as explicit object rather than repeated cwd fields, which is next step after #5 per CONTEXT.md follow-up order.
- Testability: C's logical resolve pure, capability methods mockable, concurrent roots isolated — satisfies all test criteria without platform-specific flakiness.
- Deletion test passes: deletes naive safePath closure, deletes cwd repetition, deletes ad-hoc fs error handling, replaces with single ProjectRoot owner.

### Implementation plan for C

1. Create `packages/server/src/project-root.ts`:
   - `PathError` class with code
   - `ProjectRoot` with canonicalRoot, realRoot, allowedRoots, resolve (sync), resolveReal (async), readFile/writeFile/stat/mkdir with error mapping, create factory validating against allowedRoots
2. Update `ToolExecutionContext` to `{ projectRoot: ProjectRoot, signal }`
3. Update `loop.ts` to create ProjectRoot from cwd + allowedRoots (allowedRoots from env or config, for now allow any? But validate)
4. Update `executor.ts` to keep deadline wrapping, but now tools use projectRoot methods which throw PathError -> mapped to ToolResult
5. Extend `ToolErrorCode` in shared with new codes, or map to existing TOOL_FAILED with distinct codes? Propose add new codes.
6. Add tests per user list.

## Open questions for user pick

- Should `resolve` be sync or async? C proposes sync logical + async real, but capability methods async. Keep sync resolve for simple cases?
- Missing parent policy: createParents true for writeFile by default or explicit? Recommend explicit flag, default false -> PATH_NOT_FOUND distinct.
- Encoded separators: decode URI component and reject if decoded contains .. or absolute? Or treat as literal? Recommend decode and reject if decoded != original and contains traversal.
- Platform separators: normalize `\` to `/` on Windows, or use path.win32? Recommend use path.normalize which handles platform, plus replace `\` with `/` for uniform check.
- Allowed roots: where configured? Env `WINDOWS_RUNNER_ALLOWED_ROOTS`? For now allow any absolute path but log warning? Need decision.

## Next step

Await user pick among A/B/C. If C picked (expected), proceed to Phase 3 ownership/lifecycle and Phase 4 integration similar to deadline exploration.
