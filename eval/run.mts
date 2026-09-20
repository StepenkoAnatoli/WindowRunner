#!/usr/bin/env -S npx tsx
/**
 * windows-runner evaluation harness (RELEASE_CHECKLIST P2-02).
 *
 *   npx tsx eval/run.mts                       # scripted mode: no key, no network
 *   npx tsx eval/run.mts --provider openai-compatible --model gpt-4o-mini \
 *       --base-url https://api.openai.com/v1   # real model; needs WINDOWS_RUNNER_MODEL_API_KEY
 *   npx tsx eval/run.mts --task bug-fix --approve deny
 *
 * Each task in eval/tasks/<id>/ has a `project/` fixture, a `task.json` prompt
 * and a `check.js` the model never sees. The harness copies the fixture to a
 * temp dir, boots the REAL server (auth on, built-in tools, memory mode) with
 * that dir as the only allowed root, drives one turn over the HTTP API exactly
 * as the UI would (bearer, SSE, approvals answered per --approve policy), then
 * runs check.js in the working copy and records metrics.
 *
 * Scripted mode uses an in-process OpenAI-shaped fake server that plays each
 * task's `solution` (tool calls the way a competent model would issue them) —
 * it exercises the adapter, the loop, the tools, approvals and the checks with
 * zero spend, so CI can prove the harness itself works. Real-provider runs are
 * deliberately NOT part of ordinary CI: they cost money and are not
 * reproducible; run them manually and commit the JSON report under
 * eval/results/ with the model name and date.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { startServer } from "../packages/server/src/boot.js";
import type { ServerConfig } from "../packages/server/src/config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const TOKEN = "eval-token-0123456789abcdef";
const TASKS_DIR = path.join(here, "tasks");

interface TaskSpec { id: string; category: string; prompt: string; check: string; }
interface TaskResult {
  id: string; category: string; passed: boolean; turnStatus: string; failure?: string;
  steps: number; toolCalls: number; toolFailures: number; approvalsAsked: number; approvalsDenied: number;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }; elapsedMs: number;
  checkOutput: string;
}

async function main() {
  const ids = (await fs.readdir(TASKS_DIR)).filter((d) => !args.task || d === args.task).sort();
  const results: TaskResult[] = [];
  const runStarted = Date.now();
  const provider = args.provider ?? "scripted";
  console.log(`eval: provider=${provider}${args.model ? ` model=${args.model}` : ""} approve=${args.approve} tasks=${ids.join(",")}`);

  for (const id of ids) {
    const r = await runTask(id, provider);
    results.push(r);
    console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${id.padEnd(14)} turn=${r.turnStatus.padEnd(10)} steps=${r.steps} tools=${r.toolCalls} toolFail=${r.toolFailures} approvals=${r.approvalsAsked}/${r.approvalsDenied}denied tokens=${r.usage.totalTokens ?? "?"} ${r.elapsedMs}ms${r.failure ? `  (${r.failure})` : ""}`);
  }

  const report = {
    at: new Date().toISOString(),
    provider,
    model: args.model ?? (provider === "scripted" ? "scripted-solutions" : undefined),
    baseUrl: args.baseUrl,
    approvePolicy: args.approve,
    limits: { maxSteps: 10, modelCallTimeoutMs: 30_000, toolTimeoutMs: 30_000, approvalTimeoutMs: 300_000 },
    node: process.version,
    platform: process.platform,
    summary: {
      tasks: results.length,
      passed: results.filter((r) => r.passed).length,
      completionRate: results.length ? results.filter((r) => r.passed).length / results.length : 0,
      userInterventions: results.reduce((n, r) => n + r.approvalsAsked, 0),
      totalTokens: results.reduce((n, r) => n + (r.usage.totalTokens ?? 0), 0),
      elapsedMs: Date.now() - runStarted,
    },
    results,
  };
  const outDir = path.join(here, "results");
  await fs.mkdir(outDir, { recursive: true });
  const outFile = args.out ?? path.join(outDir, `${provider === "scripted" ? "scripted" : `${provider}-${(args.model ?? "model").replace(/[^a-z0-9.-]/gi, "_")}`}-${new Date().toISOString().slice(0, 10)}.json`);
  await fs.writeFile(outFile, JSON.stringify(report, null, 2) + "\n");
  console.log(`eval: ${report.summary.passed}/${report.summary.tasks} passed; report ${path.relative(process.cwd(), outFile)}`);
  if (args.expectPass && report.summary.passed !== report.summary.tasks) process.exit(1);
}

async function runTask(id: string, provider: string): Promise<TaskResult> {
  const dir = path.join(TASKS_DIR, id);
  const spec: TaskSpec = JSON.parse(await fs.readFile(path.join(dir, "task.json"), "utf8"));
  const work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `wr-eval-${id}-`)));
  await fs.cp(path.join(dir, "project"), work, { recursive: true });

  let fakeClose: (() => Promise<void>) | undefined;
  let baseUrl = args.baseUrl;
  let model = args.model;
  if (provider === "scripted") {
    const solution = (await import(path.join(dir, "solution.mjs"))).default as ScriptedStep[];
    const fake = await startScriptedOpenAI(solution);
    fakeClose = fake.close;
    baseUrl = fake.url;
    model = "scripted";
  }

  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    allowRemote: false,
    provider: "openai-compatible",
    model: { baseUrl: baseUrl!, model: model!, apiKey: process.env.WINDOWS_RUNNER_MODEL_API_KEY ?? process.env.OPENAI_API_KEY },
    tools: { enabled: true, terminalTimeoutMs: 60_000, terminalOutputLimit: 64 * 1024 },
    auth: { mode: "token", token: TOKEN, allowedHosts: [], allowedOrigins: [] },
    persistence: { mode: "memory", dataDir: path.join(os.tmpdir(), "unused"), durableBeforeNotify: false, fsync: false },
    allowedRoots: [work],
    shutdownGraceMs: 2000,
  };
  const server = await startServer(config);
  const started = Date.now();
  const result: TaskResult = {
    id, category: spec.category, passed: false, turnStatus: "unknown", steps: 0, toolCalls: 0, toolFailures: 0,
    approvalsAsked: 0, approvalsDenied: 0, usage: {}, elapsedMs: 0, checkOutput: "",
  };
  try {
    const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const created = await fetch(`${server.url}/api/sessions/${id}/turns`, { method: "POST", headers: auth, body: JSON.stringify({ cwd: work, message: spec.prompt }) });
    if (created.status !== 202) throw new Error(`turn not accepted: ${created.status} ${await created.text()}`);
    const { turnId } = await created.json();
    const res = await fetch(`${server.url}/api/sessions/${id}/turns/${turnId}/events`, { headers: auth });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    outer: while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const line = block.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const ev = JSON.parse(line.slice(6));
        switch (ev.type) {
          case "model_call":
            result.steps = ev.step;
            break;
          case "tool_call":
            result.toolCalls++;
            break;
          case "tool_completed":
            if (ev.result?.ok === false) result.toolFailures++;
            break;
          case "turn_waiting_for_approval": {
            result.approvalsAsked++;
            const decision = args.approve === "deny" ? "deny" : "approve";
            if (decision === "deny") result.approvalsDenied++;
            await fetch(`${server.url}/api/sessions/${id}/approve`, { method: "POST", headers: auth, body: JSON.stringify({ requestId: ev.request.requestId, decision }) });
            break;
          }
          case "turn_completed":
            result.turnStatus = "completed"; result.usage = ev.usage ?? {}; break outer;
          case "turn_failed":
            result.turnStatus = "failed"; result.failure = `${ev.code}: ${ev.message}`; break outer;
          case "turn_cancelled":
            result.turnStatus = "cancelled"; break outer;
        }
      }
    }
  } catch (err: any) {
    result.turnStatus = "error";
    result.failure = err?.message ?? String(err);
  } finally {
    result.elapsedMs = Date.now() - started;
    await server.close().catch(() => {});
    if (fakeClose) await fakeClose();
  }

  // Hidden check, run in the working copy. check.js lives outside the project so the model cannot read or edit it.
  const checkPath = path.join(dir, "check.js");
  await fs.copyFile(checkPath, path.join(work, "check.js"));
  const check = spawnSync(process.execPath, ["check.js"], { cwd: work, encoding: "utf8", timeout: 60_000 });
  result.checkOutput = (check.stdout + check.stderr).trim().slice(-2000);
  result.passed = check.status === 0 && result.turnStatus === "completed";
  if (!result.passed && !result.failure) result.failure = check.status === 0 ? `turn ${result.turnStatus}` : `check failed: ${result.checkOutput.split("\n").find((l) => /Error|assert/i.test(l)) ?? "see checkOutput"}`;
  if (!args.keep) await fs.rm(work, { recursive: true, force: true });
  return result;
}

// ---------------------------------------------------------------------------
// Scripted OpenAI-shaped fake: plays the task's solution steps in order.

export type ScriptedStep =
  | { text: string }
  | { toolCalls: Array<{ name: string; args: Record<string, unknown> }>; text?: string };

async function startScriptedOpenAI(steps: ScriptedStep[]) {
  let i = 0;
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const step = steps[i++] ?? { text: "(scripted solution exhausted)" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] });
    if ("toolCalls" in step) {
      if (step.text) send(chunk({ content: step.text }));
      step.toolCalls.forEach((c, index) => send(chunk({ tool_calls: [{ index, id: `call_${i}_${index}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }] })));
      send(chunk({}, "tool_calls"));
    } else {
      send(chunk({ content: step.text }));
      send(chunk({}, "stop"));
    }
    const promptTokens = Math.ceil(raw.length / 4);
    send({ id: "x", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 20, total_tokens: promptTokens + 20 } });
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as any;
  return { url: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function parseArgs(argv: string[]) {
  const out: { provider?: string; model?: string; baseUrl?: string; task?: string; approve: "approve" | "deny"; out?: string; keep: boolean; expectPass: boolean } = { approve: "approve", keep: false, expectPass: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--provider") out.provider = next();
    else if (a === "--model") out.model = next();
    else if (a === "--base-url") out.baseUrl = next();
    else if (a === "--task") out.task = next();
    else if (a === "--approve") out.approve = next() === "deny" ? "deny" : "approve";
    else if (a === "--out") out.out = next();
    else if (a === "--keep") out.keep = true;
    else if (a === "--expect-pass") out.expectPass = true;
    else if (a === "--help" || a === "-h") { console.log("see header comment in eval/run.mts"); process.exit(0); }
    else throw new Error(`unknown argument ${a}`);
  }
  if (out.provider === "openai-compatible" && !out.model) throw new Error("--model is required with --provider openai-compatible");
  return out;
}

main().catch((err) => { console.error(err); process.exit(1); });
