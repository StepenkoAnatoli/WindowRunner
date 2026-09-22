/**
 * Built-in tools (src/agent/tools/builtin.ts) and process-tree control
 * (src/process-tree.ts) — RELEASE_CHECKLIST P0-03 (root confinement),
 * P1-05 (process trees, cancellation, malformed tool calls).
 *
 * Tools are exercised through `executeTool` (the loop's path) so PathErrors
 * and deadlines are mapped exactly as in production.
 */
import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createBuiltinTools, runCommand, sanitizedEnv } from "../src/agent/tools/builtin.js";
import { executeTool } from "../src/agent/tools/executor.js";
import { ProjectRoot } from "../src/project-root.js";
import { isAlive, IS_WINDOWS } from "../src/process-tree.js";
import { TurnRunner } from "../src/agent/loop.js";
import { TurnManager } from "../src/agent/turn-manager.js";
import { InMemoryTurnLogStore } from "../src/agent/turn-log-store.js";
import { ApprovalRegistry } from "../src/agent/approval-registry.js";
import { FakeProvider, Steps, type ProviderStep } from "./fakes/fake-provider.js";
import type { ToolExecutionContext } from "../src/agent/tools/types.js";
import { removeTempPath } from "../../../scripts/temp-path.mjs";

let base: string;
let project: string;
let outside: string;
let root: ProjectRoot;
const tools = createBuiltinTools({ terminalTimeoutMs: 5000, terminalOutputLimit: 2000, readLimit: 200 });

before(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wr-tools-")));
  project = path.join(base, "project");
  outside = path.join(base, "outside");
  await fs.mkdir(path.join(project, "src"), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(project, "src", "index.ts"), "line one\nline two\nline three\nline four\n");
  await fs.writeFile(path.join(project, "README.md"), "# hello\n");
  await fs.writeFile(path.join(outside, "secret.txt"), "TOP SECRET\n");
  if (!IS_WINDOWS) {
    await fs.symlink(path.join(outside, "secret.txt"), path.join(project, "leak-file"));
    await fs.symlink(outside, path.join(project, "leak-dir"));
  }
  root = await ProjectRoot.create(project, [base]);
});
after(async () => {
  await removeTempPath(base);
});

function ctx(signal = new AbortController().signal): ToolExecutionContext {
  return { projectRoot: root, signal, cwd: root.getRoot(), safePath: (p) => root.resolve(p) };
}
const run = (name: string, input: unknown, signal?: AbortSignal, timeoutMs = 5000) => executeTool(tools.get(name)!, input, ctx(signal), timeoutMs);

describe("built-in tool set: shape", () => {
  it("registers exactly the five tools with the documented approval policy and schemas", () => {
    assert.deepEqual([...tools.keys()], ["read_file", "write_file", "edit_file", "list_dir", "run_terminal"]);
    assert.equal(tools.get("read_file")!.requiresApproval({}), false);
    assert.equal(tools.get("list_dir")!.requiresApproval({}), false);
    assert.equal(tools.get("write_file")!.requiresApproval({}), true);
    assert.equal(tools.get("edit_file")!.requiresApproval({}), true);
    assert.equal(tools.get("run_terminal")!.requiresApproval({}), true);
    for (const t of tools.values()) {
      assert.equal((t.inputSchema as any).type, "object", `${t.name} has an object schema`);
      assert.equal(t.trust, undefined, `${t.name} runs no project-supplied configuration`);
    }
    assert.match(tools.get("run_terminal")!.reason!({ command: "npm test" }), /npm test/);
    assert.match(tools.get("write_file")!.reason!({ path: "a.txt", content: "abc" }), /3 bytes to a.txt/);
  });
});

describe("read_file / list_dir", () => {
  it("reads a file and a 1-based line range", async () => {
    const all = await run("read_file", { path: "src/index.ts" });
    assert.equal(all.ok, true);
    assert.equal((all as any).output, "line one\nline two\nline three\nline four\n");
    const range = await run("read_file", { path: "src/index.ts", startLine: 2, endLine: 3 });
    assert.equal((range as any).output, "[lines 2-3 of 5]\nline two\nline three");
  });

  it("truncates large files at the read limit with a note", async () => {
    await fs.writeFile(path.join(project, "big.txt"), "x".repeat(1000));
    const r = await run("read_file", { path: "big.txt" });
    assert.match((r as any).output, /\[truncated to 200 bytes/);
    assert.ok((r as any).output.length < 300);
  });

  it("lists a directory with kinds and sizes", async () => {
    const r = await run("list_dir", { path: "src" });
    assert.equal(r.ok, true);
    assert.match((r as any).output, /^file\s+39\s+index\.ts$/m);
    const top = await run("list_dir", {});
    assert.match((top as any).output, /dir\s+src\//);
  });

  it("returns controlled errors for missing paths, directories-as-files and bad input", async () => {
    assert.equal((await run("read_file", { path: "nope.txt" }) as any).code, "PATH_NOT_FOUND");
    assert.equal((await run("read_file", { path: "src" }) as any).code, "IS_DIRECTORY");
    assert.equal((await run("list_dir", { path: "README.md" }) as any).code, "NOT_A_DIRECTORY");
    assert.equal((await run("read_file", "src/index.ts") as any).code, "TOOL_FAILED");
    assert.equal((await run("read_file", { path: 42 }) as any).code, "TOOL_FAILED");
    assert.equal((await run("read_file", { path: "" }) as any).code, "TOOL_FAILED");
  });
});

describe("root confinement (P0-03)", () => {
  const escapes = ["../outside/secret.txt", "src/../../outside/secret.txt", "/etc/passwd", "..\\outside\\secret.txt", "%2e%2e/outside/secret.txt", "src/\0/x"];
  for (const p of escapes) {
    it(`refuses ${JSON.stringify(p)} for every tool that takes a path`, async () => {
      for (const [name, input] of [
        ["read_file", { path: p }],
        ["list_dir", { path: p }],
        ["write_file", { path: p, content: "pwned" }],
        ["edit_file", { path: p, oldText: "a", newText: "b" }],
      ] as const) {
        const r = await run(name, input);
        assert.equal(r.ok, false, `${name} ${p}`);
        assert.equal((r as any).code, "PATH_ESCAPES_ROOT", `${name} ${p}: ${(r as any).message}`);
      }
      assert.equal(await fs.readFile(path.join(outside, "secret.txt"), "utf8"), "TOP SECRET\n");
    });
  }

  it("refuses symlinks that point outside the root, for reads, listings and writes", { skip: IS_WINDOWS }, async () => {
    assert.equal((await run("read_file", { path: "leak-file" }) as any).code, "PATH_ESCAPES_ROOT");
    assert.equal((await run("list_dir", { path: "leak-dir" }) as any).code, "PATH_ESCAPES_ROOT");
    assert.equal((await run("read_file", { path: "leak-dir/secret.txt" }) as any).code, "PATH_ESCAPES_ROOT");
    assert.equal((await run("write_file", { path: "leak-file", content: "pwned" }) as any).code, "PATH_ESCAPES_ROOT");
    assert.equal((await run("write_file", { path: "leak-dir/new.txt", content: "pwned" }) as any).code, "PATH_ESCAPES_ROOT");
    assert.equal((await run("edit_file", { path: "leak-file", oldText: "TOP", newText: "X" }) as any).code, "PATH_ESCAPES_ROOT");
    assert.equal(await fs.readFile(path.join(outside, "secret.txt"), "utf8"), "TOP SECRET\n");
    await assert.rejects(fs.stat(path.join(outside, "new.txt")));
  });

  it("run_terminal executes with cwd = the real project root", async () => {
    const r = await run("run_terminal", { command: IS_WINDOWS ? "cd" : "pwd" });
    assert.equal(r.ok, true);
    assert.match((r as any).output, new RegExp(project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

describe("write_file / edit_file", () => {
  it("creates with parents, then overwrites", async () => {
    const a = await run("write_file", { path: "deep/er/new.txt", content: "v1" });
    assert.equal((a as any).output, "created deep/er/new.txt (2 bytes)");
    const b = await run("write_file", { path: "deep/er/new.txt", content: "v22" });
    assert.equal((b as any).output, "overwrote deep/er/new.txt (3 bytes)");
    assert.equal(await fs.readFile(path.join(project, "deep/er/new.txt"), "utf8"), "v22");
  });

  it("edit_file requires a unique match, reports ambiguity and misses, supports replaceAll", async () => {
    await fs.writeFile(path.join(project, "edit.txt"), "foo bar\nfoo baz\n");
    const ambiguous = await run("edit_file", { path: "edit.txt", oldText: "foo", newText: "qux" });
    assert.equal(ambiguous.ok, false);
    assert.match((ambiguous as any).message, /occurs 2 times/);
    const miss = await run("edit_file", { path: "edit.txt", oldText: "nothing here", newText: "x" });
    assert.match((miss as any).message, /not found/);
    const one = await run("edit_file", { path: "edit.txt", oldText: "foo bar", newText: "FOO BAR" });
    assert.equal(one.ok, true);
    assert.match((one as any).output, /1 replacement/);
    assert.match((one as any).output, /^- foo bar\n\+ FOO BAR$/m);
    const all = await run("edit_file", { path: "edit.txt", oldText: "foo", newText: "f", replaceAll: true });
    assert.match((all as any).output, /1 replacement/);
    assert.equal(await fs.readFile(path.join(project, "edit.txt"), "utf8"), "FOO BAR\nf baz\n");
    assert.equal((await run("edit_file", { path: "edit.txt", oldText: "", newText: "x" }) as any).code, "TOOL_FAILED");
    assert.equal((await run("edit_file", { path: "missing.txt", oldText: "a", newText: "b" }) as any).code, "PATH_NOT_FOUND");
  });
});

describe("run_terminal + process trees (P1-05)", () => {
  it("captures stdout, stderr and the exit code", async () => {
    const r = await run("run_terminal", { command: IS_WINDOWS ? "echo out & echo err 1>&2 & exit 3" : "echo out; echo err >&2; exit 3" });
    assert.equal(r.ok, true);
    assert.match((r as any).output, /^exit code 3/);
    assert.match((r as any).output, /out/);
    assert.match((r as any).output, /err/);
  });

  it("bounds output, keeping the head and the tail", async () => {
    const r = await run("run_terminal", { command: IS_WINDOWS ? 'for /L %i in (1,1,2000) do @echo line%i' : "for i in $(seq 1 2000); do echo line$i; done" });
    const out = (r as any).output as string;
    assert.ok(out.length < 2600, `output length ${out.length}`);
    assert.match(out, /line1\b/);
    assert.match(out, /line2000/);
    assert.match(out, /bytes omitted/);
  });

  it("does not hand the server's secrets to the shell", async () => {
    const env = sanitizedEnv({ PATH: "/bin", WINDOWS_RUNNER_AUTH_TOKEN: "t", WINDOWS_RUNNER_MODEL_API_KEY: "k", OPENAI_API_KEY: "o", MY_SECRET: "s", GITHUB_TOKEN: "g", HOME: "/h" });
    assert.deepEqual(env, { PATH: "/bin", HOME: "/h" });
  });

  it("kills the whole process tree on timeout, including grandchildren", { skip: IS_WINDOWS }, async () => {
    const pidFile = path.join(project, "grandchild.pid");
    const r = await runCommand(`(sleep 30 & echo $! > "${pidFile}"; wait)`, { cwd: project, signal: new AbortController().signal, timeoutMs: 500, outputLimit: 1000, env: sanitizedEnv() });
    assert.equal(r.ok, false);
    assert.equal((r as any).code, "TOOL_TIMED_OUT");
    assert.match((r as any).message, /process tree was killed/);
    const gpid = Number((await fs.readFile(pidFile, "utf8")).trim());
    assert.ok(gpid > 0);
    await new Promise((res) => setTimeout(res, 200));
    assert.equal(isAlive(gpid), false, `grandchild ${gpid} still alive`);
  });

  it("Stop cancels a running command, kills its tree and surfaces as a cancellation (not a tool result)", { skip: IS_WINDOWS }, async () => {
    const pidFile = path.join(project, "cancel.pid");
    const controller = new AbortController();
    const started = Date.now();
    const pending = run("run_terminal", { command: `(sleep 30 & echo $! > "${pidFile}"; wait)` }, controller.signal, 30_000);
    await new Promise((res) => setTimeout(res, 300));
    controller.abort(new Error("Stop pressed"));
    await assert.rejects(pending, /Stop pressed|cancelled/);
    assert.ok(Date.now() - started < 5000, "cancellation did not wait for the 30s sleep");
    const gpid = Number((await fs.readFile(pidFile, "utf8")).trim());
    await new Promise((res) => setTimeout(res, 200));
    assert.equal(isAlive(gpid), false);
  });

  it("a command that ignores SIGTERM is force-killed", { skip: IS_WINDOWS }, async () => {
    const r = await runCommand("trap '' TERM; sleep 30", { cwd: project, signal: new AbortController().signal, timeoutMs: 300, outputLimit: 1000, env: sanitizedEnv() });
    assert.equal((r as any).code, "TOOL_TIMED_OUT");
  });

  it("the loop's toolTimeoutMs still applies on top of the tool's own limit", async () => {
    const slow = createBuiltinTools({ terminalTimeoutMs: 60_000 }).get("run_terminal")!;
    const r = await executeTool(slow, { command: IS_WINDOWS ? "ping -n 30 127.0.0.1 > nul" : "sleep 30" }, ctx(), 300);
    assert.equal(r.ok, false);
    assert.equal((r as any).code, "TOOL_TIMED_OUT");
  });
});

describe("loop integration with real tools", () => {
  async function runTurn(steps: ProviderStep[], opts: { approve?: boolean } = {}) {
    const manager = new TurnManager({ store: new InMemoryTurnLogStore() });
    const approvals = new ApprovalRegistry();
    const provider = new FakeProvider(steps);
    const runner = new TurnRunner({ provider, tools, approvals, manager, allowedRoots: [base] });
    const events: any[] = [];
    manager.ensureLog("s", "t", { maxSteps: 5, modelCallTimeoutMs: 5000, toolTimeoutMs: 5000, approvalTimeoutMs: 5000 });
    manager.subscribe("s", "t", 0, (e: any) => {
      events.push(e);
      if (e.type === "turn_waiting_for_approval" && opts.approve !== undefined) {
        // Like the real API: the decision arrives after the loop started waiting.
        setTimeout(() => approvals.resolve(e.request.requestId, opts.approve ? "approve" : "deny"), 10);
      }
    });
    const result = await runner.run({
      sessionId: "s",
      turnId: "t",
      cwd: project,
      request: { messages: [{ role: "user", content: "go" }], tools: [...tools.values()].map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })) },
      limits: { maxSteps: 5, modelCallTimeoutMs: 5000, toolTimeoutMs: 5000, approvalTimeoutMs: 5000 },
      signal: new AbortController().signal,
    });
    return { result, events, provider };
  }

  it("read_file runs without approval and its output reaches the model on the next call", async () => {
    const { result, events, provider } = await runTurn([Steps.toolCall("c1", "read_file", { path: "README.md" }), Steps.text("ok")]);
    assert.equal(result.status, "completed");
    assert.equal(events.some((e) => e.type === "turn_waiting_for_approval"), false);
    const done = events.find((e) => e.type === "tool_completed");
    assert.equal(done.result.ok, true);
    assert.equal(done.result.output, "# hello\n");
    const second = provider.requests[1];
    assert.equal(second.messages.at(-1)?.role, "tool");
    assert.equal(second.messages.at(-1)?.content, "# hello\n");
    // The assistant message before it carries the tool call for wire formats that need it.
    assert.deepEqual(second.messages.at(-2)?.toolCalls?.[0].name, "read_file");
  });

  it("write_file asks for approval; approve writes, deny leaves the file untouched", async () => {
    const target = path.join(project, "approved.txt");
    const ok = await runTurn([Steps.toolCall("c1", "write_file", { path: "approved.txt", content: "yes" }), Steps.text("done")], { approve: true });
    assert.equal(ok.result.status, "completed", JSON.stringify(ok.events.map((e) => [e.type, e.result ?? e.message ?? ""])));
    assert.equal(await fs.readFile(target, "utf8"), "yes");
    const no = await runTurn([Steps.toolCall("c2", "write_file", { path: "approved.txt", content: "NO" }), Steps.text("fine")], { approve: false });
    assert.equal(no.result.status, "completed");
    assert.equal(no.events.find((e) => e.type === "tool_completed").result.code, "APPROVAL_DENIED");
    assert.equal(await fs.readFile(target, "utf8"), "yes");
  });

  it("a malformed tool call (unparsable arguments) is a controlled TOOL_FAILED the model sees, never a crash", async () => {
    const { result, events, provider } = await runTurn([
      () => ({ chunks: [{ type: "tool_call", call: { id: "c1", name: "write_file", input: undefined, inputError: "arguments are not valid JSON (Unexpected end)", rawInput: '{"path":' } }] }),
      Steps.text("sorry, retrying properly"),
    ]);
    assert.equal(result.status, "completed");
    const done = events.find((e) => e.type === "tool_completed");
    assert.equal(done.result.code, "TOOL_FAILED");
    assert.match(done.result.message, /malformed tool input for write_file/);
    assert.equal(events.some((e) => e.type === "turn_waiting_for_approval"), false, "never asks the user to approve garbage");
    assert.match(provider.requests[1].messages.at(-1)!.content, /TOOL_FAILED: malformed/);
  });
});
