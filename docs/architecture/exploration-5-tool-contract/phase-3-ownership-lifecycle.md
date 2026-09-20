# Exploration #5 — Phase 3: Ownership, Lifecycle, Propagation

## Chosen: Candidate C — ProjectRoot capability backed by logical + optional realpath

### Principle: Single owner for filesystem safety

- **ProjectRoot** is the sole owner of path confinement, canonicalization, realpath verification, and fs error mapping
- Tools never reimplement path checks, never call `fs` directly with user-supplied path, never use `path.resolve` themselves
- Loop owns ProjectRoot creation per turn, validates against allowedRoots once, passes capability to tools via context
- Executor owns deadline wrapping, not path safety — path safety is inside ProjectRoot, deadline outside

## Construction and validation

### Inputs

- `requestedRoot: string` — cwd from turn request (e.g., `/workspace/project`)
- `allowedRoots: string[]` — from env `WINDOWS_RUNNER_ALLOWED_ROOTS` or config, e.g., `["/workspace", "/tmp"]`. If empty, allow any absolute? For safety, require explicit allowedRoots in prod, but for tests allow any.

### Steps (ProjectRoot.create)

1. **Normalize requestedRoot**: `canonicalRequested = path.resolve(requestedRoot)` — absolute, no `.`/`..`, platform normalized
2. **Check absolute**: must be absolute, else throw `PATH_NOT_ABSOLUTE`
3. **Check inside allowedRoots**: for each allowedRoot, `canonicalAllowed = path.resolve(allowedRoot)`, check `isInside(canonicalRequested, canonicalAllowed)` or equal. If none matches and allowedRoots non-empty, throw `PATH_ESCAPES_ROOT` (requested root not authorized)
4. **Realpath requestedRoot**: `realRequested = await realpath(canonicalRequested)` — must exist? For ProjectRoot, root must exist and be directory, else throw `PATH_NOT_FOUND` or `NOT_A_DIRECTORY`. This ensures root is real directory, not file.
5. **Realpath allowedRoots**: for each allowedRoot, realpath it (if exists), then check `isInside(realRequested, realAllowed)` — ensures real root also inside allowed real root (prevents symlink allowedRoot bypass)
6. **Return ProjectRoot** with `canonicalRoot = canonicalRequested`, `realRoot = realRequested`, `allowedRoots = canonicalAllowed[]`

- **Idempotent**: same requestedRoot + allowedRoots yields same canonical/real roots
- **Single validation**: done once per turn, not per tool call
- **Disposal**: no disposal needed, just object, but realpath cache could be cleared

### Canonical root handling

- `canonicalRoot` is logical root: `path.resolve(root)` normalized, no trailing slash, platform-specific sep
- `realRoot` is physical root: `realpath(canonicalRoot)` — resolves symlinks, e.g., `/workspace` might be symlink to `/data/workspace`, realRoot = `/data/workspace`
- Both stored, used for different checks:
  - Logical check uses canonicalRoot (fast, sync, works for non-existing)
  - Real check uses realRoot (for existing files, prevents symlink escape)

## Single resolveSafePath() implementation

### resolve(requested): string (sync, logical)

- **Purpose**: for tools that need absolute path string but will do their own fs operation (e.g., terminal tool needs cwd), or for quick validation
- **Steps**:
  1. Reject if requested contains null byte `\0` -> PATH_ESCAPES_ROOT
  2. Decode URI component: try `decodeURIComponent(requested)`, if decoded != original and decoded contains `..` or absolute, reject PATH_ESCAPES_ROOT (prevents `%2e%2e` bypass)
  3. Normalize platform separators: replace `\` with `/` on Windows? Use `path.normalize` which handles platform, but also check for `\\` UNC paths -> reject if absolute UNC
  4. Reject if `path.isAbsolute(requested)` -> PATH_ESCAPES_ROOT (absolute paths not allowed, must be relative to root)
  5. Logical resolve: `logical = path.resolve(canonicalRoot, requested)` — handles `.`, `..`, `a/b/../c`
  6. Check `isInside(logical, canonicalRoot)` — `logical === canonicalRoot || logical.startsWith(canonicalRoot + sep)` — else PATH_ESCAPES_ROOT
  7. Return logical (absolute, normalized, still may contain symlink components not yet resolved)

- **No fs access**, sync, pure, testable without fs
- **For non-existing paths**: returns logical even if file doesn't exist, as long as inside root — allows future creation

### resolveReal(requested): Promise<string> (async, logical + realpath)

- **Purpose**: for tools that read existing files, need to ensure realpath also inside realRoot (prevents symlink escape)
- **Steps**:
  1. Call `resolve(requested)` to get logical, ensures inside canonicalRoot
  2. Try `stat(logical)` — if ENOENT, return logical (file doesn't exist, no realpath check, allow)
  3. If exists, `real = await realpath(logical)` — resolves symlinks
  4. Check `isInside(real, realRoot)` else PATH_ESCAPES_ROOT
  5. Return real (or logical? Return real for safety, as it is the actual file)
- **For missing parent**: if parent doesn't exist, stat will fail with ENOENT, but we return logical — then caller (readFile) will attempt fs operation and get PATH_NOT_FOUND distinct

### isInside helper

```
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
```

- Handles `.` and `..` correctly, platform-aware
- Use path.relative, not string prefix, to avoid `/workspace` vs `/workspace2` false positive

## Behavior for nonexistent targets and missing parent directories

### Read operations (readFile, stat)

- If file doesn't exist: throw PATH_NOT_FOUND with message "file not found: <requested>"
- If parent directory doesn't exist: throw PATH_NOT_FOUND with message "parent not found: <parent> for <requested>" — distinct from file not found? Could use same code but different message, or distinct code PARENT_NOT_FOUND. For simplicity, use PATH_NOT_FOUND for both, but message distinguishes.
- No creation.

### Write operations (writeFile)

- Policy: `createParents` option explicit, default false
- If `createParents=false` and parent doesn't exist: throw PATH_NOT_FOUND (parent missing)
- If `createParents=true` and parent doesn't exist: `mkdir(parent, {recursive:true})` then write
- If file exists and exclusive flag true: throw FILE_EXISTS
- If parent is file (ENOTDIR): throw NOT_A_DIRECTORY

### Mkdir

- Similar: if parent missing and recursive false -> PATH_NOT_FOUND, if recursive true -> create

### Why distinct from permission?

- PATH_NOT_FOUND retryable true (model can try other path)
- PERMISSION_DENIED retryable false (model cannot fix permission)
- So error mapping must distinguish ENOENT vs EACCES

## Symlink handling for existing path components

- **Root symlink**: handled at creation — realRoot resolves root symlink, so child realpath check uses realRoot
- **Intermediate symlink**: e.g., root contains `link -> /etc`, requested `link/passwd`
  - Logical resolve: `logical = /root/link/passwd` which is inside canonicalRoot, passes logical check
  - Realpath: `real = /etc/passwd`, check inside realRoot? `/etc/passwd` not inside `/realRoot`, so reject PATH_ESCAPES_ROOT
  - So symlink escape prevented for existing files
- **Symlink inside root pointing inside root**: e.g., `link -> /root/subdir/file`, logical inside, real `/root/subdir/file` inside realRoot, allowed — permissive for valid use case
- **Symlink chain**: realpath resolves full chain, so checked
- **Non-existing path with symlink parent**: e.g., `link` exists and is symlink to `/etc`, requested `link/newfile` where newfile doesn't exist
  - Logical: inside, passes
  - Stat: `link/newfile` doesn't exist, but `link` exists and is symlink, stat of `link/newfile` will fail ENOENT, but we return logical without realpath check, so would allow creation inside /etc? That's unsafe.
  - Need to handle: for non-existing file, we should realpath parent, not just skip. So for writeFile, we should realpath existing parent chain.
  - Solution: for non-existing, find existing parent via `findExistingParent(logical)` walking up until exists, realpath that parent, check inside realRoot, then allow. If parent chain contains symlink escaping, parent realpath will be outside and reject.
  - So for writeFile with createParents false, we need to realpath parent even if file doesn't exist.

### Updated resolveReal for write

- For read: if file exists, realpath file and check; if not exists, throw PATH_NOT_FOUND (no need to check parent realpath for read, because file doesn't exist)
- For write: if file exists, realpath file and check; if not exists, find existing parent, realpath parent, check inside realRoot, then allow logical path for creation

## Stable errors for traversal, absolute, escape, missing, dir, permission

### PathError class

```
class PathError extends Error {
  code: ToolErrorCode // PATH_ESCAPES_ROOT etc
  retryable: boolean
  constructor(code, message, retryable)
}
```

### ToolErrorCode extension (proposed)

Add to shared:

```
type ToolErrorCode = 
  | "TOOL_FAILED"
  | "TOOL_TIMED_OUT"
  | "APPROVAL_DENIED"
  | "UNKNOWN_TOOL"
  | "CANCELLED"
  | "PATH_ESCAPES_ROOT"
  | "PATH_NOT_FOUND"
  | "NOT_A_FILE"
  | "NOT_A_DIRECTORY"
  | "IS_DIRECTORY"
  | "PERMISSION_DENIED"
  | "FILE_EXISTS"
  | "IO_ERROR"
```

- All filesystem errors map to these, not raw ENOENT
- Executor maps PathError to ToolResult with same code, message stable, retryable per table

### Mapping table (final)

| Condition | Code | Retryable | Message example |
|-----------|------|-----------|-----------------|
| requested absolute /etc/passwd | PATH_ESCAPES_ROOT | false | "path escapes root: absolute path not allowed: /etc/passwd" |
| traversal a/../../b | PATH_ESCAPES_ROOT | false | "path escapes root: a/../../b resolves outside root" |
| encoded %2e%2e | PATH_ESCAPES_ROOT | false | "path escapes root: encoded traversal: %2e%2e" |
| symlink escape link->/etc | PATH_ESCAPES_ROOT | false | "path escapes root: symlink /root/link -> /etc outside root" |
| file not found | PATH_NOT_FOUND | true | "file not found: a.txt" |
| parent not found | PATH_NOT_FOUND | true | "parent not found: a/b for a/b/c.txt" |
| EACCES | PERMISSION_DENIED | false | "permission denied: a.txt" |
| EISDIR when file expected | IS_DIRECTORY | true | "is directory, expected file: a" |
| ENOTDIR parent is file | NOT_A_DIRECTORY | true | "not a directory: a is file, for a/b" |
| EEXIST exclusive | FILE_EXISTS | true | "file exists: a.txt" |
| other IO | IO_ERROR | true | "io error: <message>" |

## Whether callers receive path string or narrower capability

- **Option 1**: Callers receive absolute path string from resolve(), then do fs themselves — requires them to not re-check, but they could still misuse path string to escape if they do path.join again. Less safe.
- **Option 2**: Callers receive only capability methods readFile/writeFile/stat/mkdir, not raw path — more safe, centralizes error mapping, prevents misuse. Recommended for file tools.
- **Option 3**: Hybrid — resolve() returns string for tools that need cwd (terminal tool), but file tools use capability methods. So ToolExecutionContext has both projectRoot.resolve (sync) and projectRoot.readFile etc.

Chosen: Hybrid — ProjectRoot has resolve (sync) for terminal tool cwd, and capability methods for file tools. Tools that need raw path (terminal) use resolve, but still confined. File tools should use capability methods to get stable error codes automatically.

## Migration from duplicated cwd fields

- **Before**: RunTurnInput has `cwd: string`, ToolExecutionContext has `cwd: string` + `safePath` closure, loop creates safePath inline per tool call
- **After**: RunTurnInput has `projectRoot: ProjectRoot` (or cwd string that is converted to ProjectRoot at start of run), ToolExecutionContext has `projectRoot: ProjectRoot`
- **Steps**:
  1. Create ProjectRoot in loop.run() from input cwd + allowedRoots (allowedRoots from env or passed in deps)
  2. Pass projectRoot to executeTool context
  3. Update executor to accept projectRoot
  4. Update tools to use projectRoot.readFile etc
  5. Update TurnManager? No, TurnManager doesn't need root
  6. Update app.ts to pass allowedRoots from config, create ProjectRoot? Actually ProjectRoot creation should be inside TurnRunner, not app.ts, to keep validation once per turn
  7. Update tests: create ProjectRoot with temp dir, not cwd string

- **Deletion**: deletes safePath closure, deletes cwd string repetition, deletes ad-hoc fs error handling in tools (now in ProjectRoot)

## Tests across concurrent roots, symlink escapes, nonexistent nested, platform separators

### Test plan (from user list)

- absolute paths: `"/etc/passwd"` -> PATH_ESCAPES_ROOT
- `.` and `..` segments: `"a/./b"`, `"a/../b"`, `"a/b/../../c"` -> inside or escape
- encoded: `"%2e%2e/%2e%2e/etc"` -> PATH_ESCAPES_ROOT
- platform separators: `"a\\b\\..\\c"` on Windows, `"a/b\\c"` mixed -> normalized and checked
- symlinks escaping: create temp root with symlink `link -> /etc`, request `link/passwd` -> PATH_ESCAPES_ROOT; symlink inside pointing inside allowed
- missing parent: `a/b/c.txt` where `a` doesn't exist, read -> PATH_NOT_FOUND, write with createParents false -> PATH_NOT_FOUND, with true -> creates and writes
- files vs directories: write file where dir exists, read dir as file -> IS_DIRECTORY, mkdir where file exists -> FILE_EXISTS or NOT_A_DIRECTORY
- permission errors: chmod 000 file, read -> PERMISSION_DENIED (if not root)
- concurrent roots: two ProjectRoot instances with different temp dirs, tool calls interleaved, ensure isolation
- timeout/cancellation during tool execution: tool that hangs (e.g., read FIFO), deadline aborts, returns TOOL_TIMED_OUT, cleanup
- exact ToolResult codes and messages: assert code, retryable, message stable not raw ENOENT

### Leak and cleanup

- After each test, check ProjectRoot no timers, no open handles
- Deadline still applies: tool that hangs should be aborted via signal, executor returns TOOL_TIMED_OUT, no leak

## Next phase

Phase 4 integration: implement ProjectRoot, update Tool contract, extend ToolErrorCode, migrate loop/executor/tools, add tests, verify deadlines still apply, update CONTEXT.md with ProjectRoot ownership.
