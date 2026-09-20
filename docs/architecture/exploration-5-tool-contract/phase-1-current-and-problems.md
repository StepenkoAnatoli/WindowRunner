# Exploration #5 — Tool Contract & Filesystem Safety — Phase 1: Current and Problems

## Current implementation

### ToolDefinition
```ts
interface ToolExecutionContext {
  cwd: string;
  signal: AbortSignal;
  safePath: (requested: string) => string;
}
interface ToolDefinition {
  name: string;
  description: string;
  requiresApproval: (input: unknown) => boolean;
  reason?: (input: unknown) => string;
  execute: (input, ctx) => Promise<{ok:true; output:string} | {ok:false; code?:string; message:string; retryable?:boolean} | string>
}
```

### Executor
- Wraps execute in `runWithDeadline` kind=tool, timeoutMs, shutdownGraceMs 5s
- Maps DeadlineError expired->TOOL_TIMED_OUT retryable true, shutdown_timeout->TOOL_FAILED retryable false, cancelled throws
- Other errors -> TOOL_FAILED retryable true
- Raw string return coerced to ok:true

### Loop safePath (current)
```ts
safePath: (requested) => {
  if (requested.includes("..")) {
    if (requested === ".." || requested.startsWith("../") || requested.includes("/../") || requested.endsWith("/..")) {
      throw new Error("path is outside project root");
    }
  }
  return requested;
}
```

### Shared ToolResult
```ts
type ToolErrorCode = "TOOL_FAILED" | "TOOL_TIMED_OUT" | "APPROVAL_DENIED" | "UNKNOWN_TOOL" | "CANCELLED";
type ToolResult = {ok:true; output:string} | {ok:false; code:ToolErrorCode; message:string; retryable:boolean}
```

## Problems

### P1: safePath is trivially bypassable
- `..` check only looks for `/../` patterns, misses:
  - `a/../../b` -> after naive check passes? Actually contains `/../` so would throw, but `a/..` at end without slash? `endsWith("/..")` catches, but `a/../` with trailing slash? Not covered? `a/b/..` -> contains `/../`? No, `b/..` not `/../`. So `src/../..` escapes.
  - `...` or encoded `%2e%2e` not handled
  - Absolute paths `/etc/passwd` or `C:\Windows` pass through because no `..`
  - `.` segments not normalized: `./a/./b` should resolve to `a/b`
  - Platform separators `\` on Windows not checked
  - Empty string or `.` returns as-is
- Returns requested string unchanged, not resolved absolute path. Tool then does `fs.readFile(requested)` relative to process cwd, not project root, so root confinement not enforced.
- No canonicalization: symlink inside root pointing to `/etc` would be followed and escape. Need `realpath` check.
- No handling for missing nested paths: if tool wants to write `a/b/c.txt` where `a/b` doesn't exist, should we create, reject with typed error, or report distinct from permission failure? Current code doesn't decide.

### P2: No ProjectRoot abstraction
- `cwd` is raw string repeated per turn, not validated against authorized roots. `allowedProjectRoots` mentioned in CONTEXT.md but not implemented. Concurrent tool calls using different roots could race if they share process cwd. Need explicit ProjectRoot object with `resolve(requested)` method carrying canonical root, validation once.

### P3: Filesystem exceptions leak as raw messages
- If tool does `fs.readFile` and gets ENOENT, EACCES, EISDIR, ENOTDIR, it throws Error with message like "ENOENT: no such file or directory". Executor catches and returns TOOL_FAILED with that raw message. Model sees unstable, platform-specific message, not stable code.
- Need stable ToolErrorCode values: PATH_ESCAPES_ROOT, PATH_NOT_FOUND, NOT_A_FILE, NOT_A_DIRECTORY, PERMISSION_DENIED, etc., or map to TOOL_FAILED with distinct codes? Spec says replace raw ENOENT with stable codes.
- Also need to decide retryable: PATH_ESCAPES_ROOT not retryable, PATH_NOT_FOUND maybe retryable if model can try other path? Or not? Need policy.

### P4: Tool contract allows any return shape
- `execute` can return string, or object with optional code, or object with ok true/false. Executor coerces, but no validation of input schema. No `inputSchema` in current ToolDefinition (mentioned in CONTEXT.md but not implemented). So malformed input not caught early.
- No distinction between tool that creates file vs reads file vs runs terminal — all share same context.

### P5: Deadline and abort interaction with filesystem
- If filesystem operation hangs (e.g., reading FIFO, network mount), deadline should abort and cleanup. Current executor uses `runWithDeadline` with signal passed to ctx, but tool may ignore signal. Need to ensure tool checks signal and that abort cleanup still works.
- If safePath throws synchronously, does it count as TOOL_FAILED or escape? Currently would be caught as TOOL_FAILED, but should be typed PATH_ESCAPES_ROOT.

### P6: Error codes not exhaustive for filesystem
- Current ToolErrorCode has 5 values, none for filesystem. Need to extend or decide mapping: keep 5 but use message to distinguish, or add new codes like PATH_ESCAPES_ROOT, etc. Adding codes is breaking change for shared, but necessary for stable model-facing messages.

### P7: Concurrent roots
- Loop passes `cwd` from turn input directly, no validation. Two turns with different cwd could interleave tool calls that use same underlying fs but different roots. If safePath uses `path.resolve(cwd, requested)`, it would at least confine, but current safePath doesn't resolve. Need to ensure each tool call resolves against its own root, not process cwd.

## Tests missing (from user request)

- absolute paths
- `.` and `..` segments
- encoded or platform-specific separators
- symlinks escaping root
- missing parent directories
- files vs directories
- permission errors
- concurrent tool calls using different roots
- timeout/cancellation during tool execution
- exact ToolResult error codes and model-facing messages

## Next phase

Propose module design for ProjectRoot + safePath + ToolResult error codes, with options for:
- canonicalization strategy (realpath vs lstat)
- symlink policy (reject symlink escaping vs follow but check realpath)
- missing parent handling (create vs reject)
- error code taxonomy
- ToolDefinition input validation
