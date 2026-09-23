/**
 * The minimal built-in tool set (Phase 3): read_file, write_file, edit_file,
 * list_dir, run_terminal.
 *
 * Boundaries, in order of importance:
 *
 * 1. Every path goes through `ProjectRoot` — logical containment (`resolve`)
 *    and realpath containment (`resolveReal`) — so neither `..`, absolute
 *    paths, encoded traversal nor symlinks pointing out of the project can be
 *    read or written. Writes resolve the *target's* realpath too, so an
 *    existing symlink inside the project cannot be used as a write-through.
 * 2. Approval policy is per tool: reads and directory listings never ask;
 *    write_file and edit_file always ask (they change the user's files);
 *    run_terminal always asks. The loop enforces this; tools only declare it.
 * 3. run_terminal runs with cwd = project root, a bounded output buffer and a
 *    wall-clock limit, and is killed as a process tree on Stop or timeout
 *    (process-tree.ts). The abort signal handed to `execute` is the tool
 *    deadline's, so cancellation from the UI reaches the shell.
 * 4. Inputs are validated by hand (no schema library in the runtime); a bad
 *    input is a `TOOL_FAILED` result the model can correct, never a throw.
 */
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { ToolDefinition, ToolExecutionContext } from "./types.js";
import { PathError } from "../../project-root.js";
import { spawnTree, killTree } from "../../process-tree.js";
import { loadSkills, SKILL_NAME_RE } from "../skills.js";

export interface BuiltinToolOptions {
  /** Wall-clock limit for one terminal command; the loop's toolTimeoutMs still applies on top. */
  terminalTimeoutMs?: number;
  /** Max bytes of combined output kept (head + tail). */
  terminalOutputLimit?: number;
  /** Max bytes returned by read_file. Larger files are truncated with a note. */
  readLimit?: number;
  /** Environment for terminal commands. Default: process.env minus secrets we know about. */
  terminalEnv?: NodeJS.ProcessEnv;
}

const DEFAULTS = { terminalTimeoutMs: 60_000, terminalOutputLimit: 64 * 1024, readLimit: 256 * 1024 };

type Fail = { ok: false; code?: "TOOL_FAILED" | "PATH_ESCAPES_ROOT" | "PATH_NOT_FOUND" | "NOT_A_FILE" | "NOT_A_DIRECTORY" | "IS_DIRECTORY" | "PERMISSION_DENIED" | "FILE_EXISTS" | "IO_ERROR" | "TOOL_TIMED_OUT"; message: string; retryable?: boolean };
type Ok = { ok: true; output: string };

const fail = (message: string, code: Fail["code"] = "TOOL_FAILED", retryable = true): Fail => ({ ok: false, code, message, retryable });

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
}

function requireString(obj: Record<string, unknown>, key: string): string | Fail {
  const v = obj[key];
  if (typeof v !== "string") return fail(`"${key}" must be a string`);
  return v;
}

function requirePath(obj: Record<string, unknown>, key = "path"): string | Fail {
  const v = requireString(obj, key);
  if (typeof v !== "string") return v;
  if (v.trim() === "") return fail(`"${key}" must not be empty`);
  return v;
}

function isFail(v: unknown): v is Fail {
  return typeof v === "object" && v !== null && (v as any).ok === false;
}

export function createBuiltinTools(options: BuiltinToolOptions = {}): Map<string, ToolDefinition> {
  const opts = { ...DEFAULTS, ...options };
  const tools: ToolDefinition[] = [
    readFileTool(opts.readLimit),
    writeFileTool(),
    editFileTool(),
    listDirTool(),
    runTerminalTool(opts.terminalTimeoutMs, opts.terminalOutputLimit, options.terminalEnv),
    readSkillTool(),
  ];
  return new Map(tools.map((t) => [t.name, t]));
}

// ---------------------------------------------------------------------------

function readFileTool(readLimit: number): ToolDefinition {
  return {
    name: "read_file",
    description: "Read a UTF-8 text file inside the project. Optional 1-based line range. Paths are relative to the project root.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file" },
        startLine: { type: "integer", minimum: 1, description: "First line to return (1-based, inclusive)" },
        endLine: { type: "integer", minimum: 1, description: "Last line to return (inclusive)" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    requiresApproval: () => false,
    async execute(input, ctx) {
      const obj = asRecord(input);
      if (!obj) return fail("input must be an object with a \"path\"");
      const p = requirePath(obj);
      if (isFail(p)) return p;
      const st = await ctx.projectRoot.stat(p, ctx.signal);
      if (st.isDirectory()) return fail(`${p} is a directory; use list_dir`, "IS_DIRECTORY");
      if (!st.isFile()) return fail(`${p} is not a regular file`, "NOT_A_FILE", false);
      const text = await ctx.projectRoot.readFile(p, "utf8", ctx.signal);
      const lines = text.split(/\r?\n/);
      const start = typeof obj.startLine === "number" ? Math.max(1, Math.floor(obj.startLine)) : 1;
      const end = typeof obj.endLine === "number" ? Math.min(lines.length, Math.floor(obj.endLine)) : lines.length;
      if (start > end) return fail(`empty range ${start}-${end} (file has ${lines.length} lines)`);
      let out = lines.slice(start - 1, end).join("\n");
      let note = "";
      if (Buffer.byteLength(out, "utf8") > readLimit) {
        out = Buffer.from(out, "utf8").subarray(0, readLimit).toString("utf8");
        note = `\n[truncated to ${readLimit} bytes; request a line range for more]`;
      }
      const header = start !== 1 || end !== lines.length ? `[lines ${start}-${end} of ${lines.length}]\n` : "";
      return { ok: true, output: header + out + note };
    },
  };
}

function writeFileTool(): ToolDefinition {
  return {
    name: "write_file",
    description: "Create or overwrite a UTF-8 text file inside the project with the given content. Creates parent directories. Requires approval.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file" },
        content: { type: "string", description: "Full new file content" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    requiresApproval: () => true,
    reason: (input) => {
      const obj = asRecord(input);
      const p = obj && typeof obj.path === "string" ? obj.path : "?";
      const bytes = obj && typeof obj.content === "string" ? Buffer.byteLength(obj.content, "utf8") : 0;
      return `write ${bytes} bytes to ${p}`;
    },
    async execute(input, ctx) {
      const obj = asRecord(input);
      if (!obj) return fail("input must be an object with \"path\" and \"content\"");
      const p = requirePath(obj);
      if (isFail(p)) return p;
      const content = requireString(obj, "content");
      if (isFail(content)) return content;
      const target = await safeWriteTarget(ctx, p);
      if (isFail(target)) return target;
      const existed = await exists(target);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, "utf8");
      return { ok: true, output: `${existed ? "overwrote" : "created"} ${p} (${Buffer.byteLength(content, "utf8")} bytes)` };
    },
  };
}

function editFileTool(): ToolDefinition {
  return {
    name: "edit_file",
    description:
      "Replace an exact text snippet in a file with new text. \"oldText\" must occur exactly once (unless replaceAll is true). Returns a unified-style summary. Requires approval.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file" },
        oldText: { type: "string", description: "Exact text to find (must be unique unless replaceAll)" },
        newText: { type: "string", description: "Replacement text" },
        replaceAll: { type: "boolean", description: "Replace every occurrence. Default false." },
      },
      required: ["path", "oldText", "newText"],
      additionalProperties: false,
    },
    requiresApproval: () => true,
    reason: (input) => {
      const obj = asRecord(input);
      const p = obj && typeof obj.path === "string" ? obj.path : "?";
      const n = obj && typeof obj.oldText === "string" ? obj.oldText.split(/\r?\n/).length : 0;
      const m = obj && typeof obj.newText === "string" ? obj.newText.split(/\r?\n/).length : 0;
      return `edit ${p}: replace ${n} line(s) with ${m} line(s)`;
    },
    async execute(input, ctx) {
      const obj = asRecord(input);
      if (!obj) return fail("input must be an object with \"path\", \"oldText\" and \"newText\"");
      const p = requirePath(obj);
      if (isFail(p)) return p;
      const oldText = requireString(obj, "oldText");
      if (isFail(oldText)) return oldText;
      const newText = requireString(obj, "newText");
      if (isFail(newText)) return newText;
      if (oldText === "") return fail("\"oldText\" must not be empty; use write_file to create content");
      const replaceAll = obj.replaceAll === true;
      const target = await safeWriteTarget(ctx, p);
      if (isFail(target)) return target;
      const st = await ctx.projectRoot.stat(p, ctx.signal);
      if (!st.isFile()) return fail(`${p} is not a regular file`, st.isDirectory() ? "IS_DIRECTORY" : "NOT_A_FILE");
      const before = await ctx.projectRoot.readFile(p, "utf8", ctx.signal);
      const count = occurrences(before, oldText);
      if (count === 0) return fail(`oldText not found in ${p}; read the file and copy the exact text`);
      if (count > 1 && !replaceAll) return fail(`oldText occurs ${count} times in ${p}; include more context to make it unique or set replaceAll`);
      const after = replaceAll ? before.split(oldText).join(newText) : before.replace(oldText, () => newText);
      await fs.writeFile(target, after, "utf8");
      return { ok: true, output: `edited ${p}: ${count} replacement(s)\n${miniDiff(oldText, newText)}` };
    },
  };
}

function listDirTool(): ToolDefinition {
  return {
    name: "list_dir",
    description: "List entries of a directory inside the project (name, kind, size). Non-recursive; \".\" is the project root.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Relative directory path; default \".\"" } },
      additionalProperties: false,
    },
    requiresApproval: () => false,
    async execute(input, ctx) {
      const obj = asRecord(input) ?? {};
      const p = typeof obj.path === "string" && obj.path.trim() !== "" ? obj.path : ".";
      const abs = await ctx.projectRoot.resolveReal(p);
      let entries;
      try {
        entries = await fs.readdir(abs, { withFileTypes: true });
      } catch (err: any) {
        if (err.code === "ENOTDIR") return fail(`${p} is not a directory`, "NOT_A_DIRECTORY");
        throw err;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      const lines: string[] = [];
      for (const e of entries) {
        if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error("aborted");
        let kind = e.isDirectory() ? "dir" : e.isSymbolicLink() ? "link" : e.isFile() ? "file" : "other";
        let size = "";
        if (e.isFile()) {
          try {
            size = String((await fs.stat(path.join(abs, e.name))).size);
          } catch {}
        }
        lines.push(`${kind.padEnd(5)} ${size.padStart(9)}  ${e.name}${e.isDirectory() ? "/" : ""}`);
      }
      return { ok: true, output: lines.length === 0 ? `${p}: (empty)` : lines.join("\n") };
    },
  };
}

function runTerminalTool(timeoutMs: number, outputLimit: number, envOverride?: NodeJS.ProcessEnv): ToolDefinition {
  return {
    name: "run_terminal",
    description:
      "Run a shell command in the project root and return its exit code and output. Non-interactive, no stdin. Requires approval every time.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command line for the platform shell (sh on POSIX, cmd on Windows)" },
        timeoutMs: { type: "integer", minimum: 1000, description: `Optional limit; capped at ${timeoutMs}` },
      },
      required: ["command"],
      additionalProperties: false,
    },
    requiresApproval: () => true,
    reason: (input) => {
      const obj = asRecord(input);
      return `run in project root: ${obj && typeof obj.command === "string" ? obj.command : "?"}`;
    },
    async execute(input, ctx) {
      const obj = asRecord(input);
      if (!obj) return fail("input must be an object with a \"command\"");
      const command = requireString(obj, "command");
      if (isFail(command)) return command;
      if (command.trim() === "") return fail("\"command\" must not be empty");
      const limit = typeof obj.timeoutMs === "number" && obj.timeoutMs >= 1000 ? Math.min(obj.timeoutMs, timeoutMs) : timeoutMs;
      return runCommand(command, { cwd: ctx.projectRoot.getRealRoot(), signal: ctx.signal, timeoutMs: limit, outputLimit, env: envOverride ?? sanitizedEnv() });
    },
  };
}

// ---------------------------------------------------------------------------

export interface RunCommandOptions {
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
  outputLimit: number;
  env: NodeJS.ProcessEnv;
}

/** Exposed for tests: run one command as a killable tree, capture bounded output. */
export async function runCommand(command: string, opts: RunCommandOptions): Promise<Ok | Fail> {
  if (opts.signal.aborted) throw opts.signal.reason ?? new Error("aborted");
  const child = spawnTree(command, { cwd: opts.cwd, env: opts.env });
  const out = new BoundedBuffer(opts.outputLimit);
  child.stdout?.on("data", (c: Buffer) => out.push(c));
  child.stderr?.on("data", (c: Buffer) => out.push(c));

  const started = Date.now();
  const state: { outcome: "exit" | "timeout" | "cancelled" | "spawn_error" } = { outcome: "exit" };
  let spawnError: Error | undefined;

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (err) => {
      spawnError = err;
      state.outcome = "spawn_error";
      resolve({ code: null, signal: null });
    });
  });

  const timer = setTimeout(() => {
    state.outcome = "timeout";
    void killTree(child);
  }, opts.timeoutMs);
  const onAbort = () => {
    state.outcome = "cancelled";
    void killTree(child);
  };
  opts.signal.addEventListener("abort", onAbort, { once: true });

  let result;
  try {
    result = await exited;
    // Drain remaining stdio after exit (pipes may still have buffered data).
    await new Promise<void>((r) => setImmediate(r));
  } finally {
    clearTimeout(timer);
    opts.signal.removeEventListener("abort", onAbort);
  }

  const elapsed = Date.now() - started;
  const outcome = state.outcome;
  if (outcome === "cancelled") throw opts.signal.reason ?? new Error("cancelled");
  if (outcome === "spawn_error") return fail(`could not start shell: ${spawnError?.message ?? "unknown error"}`, "TOOL_FAILED", false);
  const body = out.toString();
  if (outcome === "timeout") {
    return fail(`command timed out after ${opts.timeoutMs}ms and its process tree was killed\n${body}`, "TOOL_TIMED_OUT");
  }
  const status = result.signal ? `killed by ${result.signal}` : `exit code ${result.code}`;
  return { ok: true, output: `${status} (${elapsed}ms)\n${body}` };
}

/** Keeps the first and last half of the limit so both the start and the failure at the end survive. */
class BoundedBuffer {
  private head: Buffer[] = [];
  private tail: Buffer[] = [];
  private headBytes = 0;
  private tailBytes = 0;
  private dropped = 0;
  constructor(private readonly limit: number) {}
  push(chunk: Buffer): void {
    const half = Math.floor(this.limit / 2);
    if (this.headBytes < half) {
      const take = chunk.subarray(0, half - this.headBytes);
      this.head.push(take);
      this.headBytes += take.length;
      chunk = chunk.subarray(take.length);
      if (chunk.length === 0) return;
    }
    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    while (this.tailBytes > half && this.tail.length > 0) {
      const first = this.tail[0];
      const excess = this.tailBytes - half;
      if (first.length <= excess) {
        this.tail.shift();
        this.tailBytes -= first.length;
        this.dropped += first.length;
      } else {
        this.tail[0] = first.subarray(excess);
        this.tailBytes -= excess;
        this.dropped += excess;
      }
    }
  }
  toString(): string {
    const head = Buffer.concat(this.head).toString("utf8");
    const tail = Buffer.concat(this.tail).toString("utf8");
    return this.dropped > 0 ? `${head}\n[... ${this.dropped} bytes omitted ...]\n${tail}` : head + tail;
  }
}

/**
 * read_skill (ADR 003, phase 2) — the single mechanism behind both activation
 * modes. A `/`-command in the UI and the model's own decision both end up here,
 * which is why there is no second code path that injects skill text into a
 * turn.
 *
 * Instructions only. It returns the markdown body of
 * `.windowrunner/skills/<name>/SKILL.md` and executes nothing, so it declares no
 * `trust` and asks no approval: it is a read of a file inside the project root
 * that `read_file` could already return. If a future version lets skills carry
 * executable payloads, that is when `ToolDefinition.trust` gets declared — not
 * here, and not silently.
 *
 * The name is a skill name, not a path. Anything that is not a bare
 * `SKILL_NAME_RE` name is refused as `PATH_ESCAPES_ROOT` before any filesystem
 * access, so `../x`, absolute paths and encoded traversal cannot be used to
 * reach outside the skills directory even in principle. `loadSkills` then
 * re-checks containment via ProjectRoot, because the two guards are independent
 * and either one alone would be a gap.
 */
function readSkillTool(): ToolDefinition {
  return {
    name: "read_skill",
    description:
      "Load one of this project's skills by name. A skill is a markdown instruction file the project ships under .windowrunner/skills/. Reading a skill does not run anything; if a skill asks for a command to be run, use run_terminal, which still requires approval.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Skill name, e.g. \"release-notes\". Lowercase letters, digits and dashes; not a path.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    requiresApproval: () => false,
    async execute(input, ctx) {
      const obj = asRecord(input);
      if (!obj) return fail('input must be an object with a "name"');
      const name = requireString(obj, "name");
      if (isFail(name)) return name;
      if (name.trim() === "") return fail('"name" must not be empty');
      if (!SKILL_NAME_RE.test(name)) {
        // Reported as an escape rather than a lookup miss: `..` is not a
        // misspelled skill name, and the model should learn that distinction.
        return fail(
          `"${name}" is not a skill name. A skill name is not a path: lowercase letters, digits and dashes only.`,
          "PATH_ESCAPES_ROOT",
          false
        );
      }

      const { skills, diagnostics } = await loadSkills(ctx.projectRoot);
      const skill = skills.find((s) => s.name === name);
      if (skill) return { ok: true, output: skill.body };

      // A skill directory that exists but failed validation is a different
      // situation from one that was never there, and the model should be told
      // which it hit rather than guessing.
      const brokenFor = diagnostics.find((d) => d.file.split(/[\\/]/).includes(name));
      if (brokenFor) {
        return fail(
          `the skill "${name}" exists but was not loaded: ${brokenFor.reason} — ${brokenFor.message}`,
          "TOOL_FAILED",
          false
        );
      }
      if (skills.length === 0) {
        return fail(
          `no skill named "${name}": this project has no skills. Skills live under .windowrunner/skills/<name>/SKILL.md.`,
          "TOOL_FAILED",
          false
        );
      }
      const available = skills.map((s) => s.name).join(", ");
      return fail(`no skill named "${name}". Available skills: ${available}.`, "TOOL_FAILED", false);
    },
  };
}

const SECRET_ENV = /(^|_)(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)$|^WINDOWS_RUNNER_(AUTH_TOKEN|MODEL_API_KEY)$|^OPENAI_API_KEY$|^ANTHROPIC_API_KEY$/i;

/** The agent's shell must not inherit the server's own secrets. */
export function sanitizedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || SECRET_ENV.test(k)) continue;
    env[k] = v;
  }
  return env;
}

async function safeWriteTarget(ctx: ToolExecutionContext, requested: string): Promise<string | Fail> {
  try {
    // resolveReal follows an existing target's symlink and rejects it if it
    // leaves the root; for a new file it checks the nearest existing parent.
    return await ctx.projectRoot.resolveReal(requested);
  } catch (err) {
    if (err instanceof PathError) return { ok: false, code: err.code as Fail["code"], message: err.message, retryable: err.retryable };
    throw err;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    count++;
    i += needle.length;
  }
  return count;
}

function miniDiff(oldText: string, newText: string): string {
  const a = oldText.split(/\r?\n/).slice(0, 20).map((l) => `- ${l}`);
  const b = newText.split(/\r?\n/).slice(0, 20).map((l) => `+ ${l}`);
  return [...a, ...b].join("\n");
}
