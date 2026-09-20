#!/usr/bin/env -S npx tsx
/**
 * Real-provider validation (manual; spends money; never part of CI).
 *
 *   WINDOWS_RUNNER_PROVIDER=openai-compatible \
 *   WINDOWS_RUNNER_MODEL=<model-id> \
 *   WINDOWS_RUNNER_MODEL_BASE_URL=<base>/v1 \
 *   WINDOWS_RUNNER_MODEL_API_KEY=<key> \
 *   npm run validate:provider            # add -- --stage 3 to stop after stage 3
 *                                        # add -- --price-in 0.15 --price-out 0.60 (USD/1M tokens) for an estimated cost
 *
 * Walks the checks in the order they should be trusted, stopping at the first
 * failure so a wrong base URL never leads to a tool-calling test that burns
 * balance:
 *
 *   1  text      one short streamed request → text_delta events, usage
 *   2  cancel    a long request is stopped after the first delta → turn_cancelled
 *                and the upstream connection is torn down (timed)
 *   3  failures  invalid key → MODEL_AUTH; unknown model → MODEL_BAD_REQUEST /
 *                MODEL_UNAVAILABLE (both are normalised, neither is a crash)
 *   4  tools     read-only tool call (list_dir/read_file) arrives assembled;
 *                traversal is refused with PATH_ESCAPES_ROOT; write_file needs
 *                approval (denied here → nothing written); run_terminal needs
 *                approval and sees no secret env vars (approved: prints $X)
 *
 * Every stage boots the REAL server (auth on, memory mode, the temp project as
 * the only root) and drives it over HTTP exactly like the UI. Cost is bounded:
 * every turn runs with maxSteps=3 and a 60 s call timeout; stage 4 sends four
 * turns. Expect well under $0.05 on a small model.
 *
 * The report (eval/results/validate-<provider>-<model>-<date>.json) contains
 * provider, model, base URL, timestamps, per-stage pass/fail with observed
 * event codes, token usage — and never the key. The key is only ever read
 * from the environment by the adapter.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, type StartedServer } from "../packages/server/src/boot.js";
import { loadServerConfig, type ServerConfig } from "../packages/server/src/config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = "validate-token-0123456789abcdef";
const argNum = (flag: string) => { const i = process.argv.indexOf(flag); return i === -1 ? undefined : Number(process.argv[i + 1]); };
const priceIn = argNum("--price-in");
const priceOut = argNum("--price-out");
const stageArg = process.argv.indexOf("--stage");
const untilStage = stageArg === -1 ? 4 : Math.max(1, Math.min(4, Number(process.argv[stageArg + 1]) || 4));

interface StageResult { stage: number; name: string; passed: boolean; detail: string; elapsedMs: number; usage?: any; events?: string[] }
interface TurnOutcome { status: "completed" | "failed" | "cancelled" | "error"; code?: string; message?: string; text: string; events: string[]; toolCalls: Array<{ name: string; input: any }>; toolResults: Array<{ name: string; ok: boolean; code?: string; output?: string }>; approvals: string[]; usage?: any; firstDeltaMs?: number; elapsedMs: number }

async function main() {
  const base = loadServerConfig(process.env, { homedir: os.homedir() });
  if (base.provider === "mock") {
    console.error("validate: set WINDOWS_RUNNER_PROVIDER=openai-compatible or anthropic (plus MODEL, BASE_URL, API_KEY) — the mock proves nothing here.");
    process.exit(2);
  }
  const work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wr-validate-")));
  await fs.mkdir(path.join(work, "src"));
  await fs.writeFile(path.join(work, "README.md"), "# validate\n\nA tiny project used to validate the model endpoint.\n");
  await fs.writeFile(path.join(work, "src", "hello.txt"), "hello from the project\n");
  const config: ServerConfig = {
    ...base,
    host: "127.0.0.1",
    port: 0,
    allowRemote: false,
    auth: { mode: "token", token: TOKEN, allowedHosts: [], allowedOrigins: [] },
    persistence: { mode: "memory", dataDir: path.join(os.tmpdir(), "unused"), durableBeforeNotify: false, fsync: false },
    allowedRoots: [work],
    model: { ...base.model, maxSteps: 3, callTimeoutMs: 60_000 },
    tools: { ...base.tools, terminalTimeoutMs: 15_000 },
  };
  console.log(`validate: provider=${config.provider} model=${config.model.model} base=${config.model.baseUrl} key=${config.model.apiKey ? "set" : "NONE"} retries=${config.model.maxRetries}`);
  console.log(`validate: project=${work}  stages 1..${untilStage}\n`);

  const results: StageResult[] = [];
  const startedAt = new Date().toISOString();
  const stages: Array<[string, (cfg: ServerConfig) => Promise<{ passed: boolean; detail: string; usage?: any; events?: string[] }>]> = [
    ["text", stageText],
    ["cancel", stageCancel],
    ["failures", stageFailures],
    ["tools", (cfg) => stageTools(cfg, work)],
  ];
  for (let i = 0; i < stages.length && i < untilStage; i++) {
    const [name, fn] = stages[i];
    const t0 = Date.now();
    let r: { passed: boolean; detail: string; usage?: any; events?: string[] };
    try {
      r = await fn(config);
    } catch (err: any) {
      r = { passed: false, detail: `harness error: ${err?.message ?? err}` };
    }
    results.push({ stage: i + 1, name, ...r, elapsedMs: Date.now() - t0 });
    console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${i + 1} ${name.padEnd(9)} ${r.detail}`);
    if (!r.passed) {
      console.log("\nvalidate: stopping at the first failure (fix it before spending on later stages).");
      break;
    }
  }

  const totalUsage = sumUsage(results.map((r) => ({ usage: r.usage })));
  const report = {
    kind: "provider-validation",
    at: startedAt,
    finishedAt: new Date().toISOString(),
    provider: config.provider,
    model: config.model.model,
    baseUrl: config.model.baseUrl,
    apiKey: config.model.apiKey ? "set (not recorded)" : "none",
    limits: { maxSteps: 3, callTimeoutMs: 60_000, maxRetries: config.model.maxRetries },
    stagesRequested: untilStage,
    passed: results.length === untilStage && results.every((r) => r.passed),
    stages: results,
    totalUsage,
    pricingUsdPer1M: priceIn !== undefined || priceOut !== undefined ? { input: priceIn ?? 0, output: priceOut ?? 0 } : undefined,
    estimatedCostUsd: priceIn !== undefined || priceOut !== undefined ? +((totalUsage.inputTokens * (priceIn ?? 0) + totalUsage.outputTokens * (priceOut ?? 0)) / 1_000_000).toFixed(6) : undefined,
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
  };
  await fs.mkdir(path.join(here, "results"), { recursive: true });
  const file = path.join(here, "results", `validate-${config.provider}-${(config.model.model ?? "model").replace(/[^a-z0-9._-]+/gi, "_")}-${startedAt.slice(0, 10)}.json`);
  const json = JSON.stringify(report, null, 2);
  if (config.model.apiKey && json.includes(config.model.apiKey)) throw new Error("refusing to write report: it contains the API key");
  await fs.writeFile(file, json + "\n");
  await fs.rm(work, { recursive: true, force: true });
  console.log(`\nvalidate: ${report.passed ? "ALL PASSED" : "NOT PASSED"}; tokens in=${totalUsage.inputTokens} out=${totalUsage.outputTokens}${report.estimatedCostUsd !== undefined ? `; est. $${report.estimatedCostUsd.toFixed(4)}` : ""}; report ${path.relative(process.cwd(), file)}`);
  process.exit(report.passed ? 0 : 1);
}

// ---------------------------------------------------------------------------

async function stageText(cfg: ServerConfig) {
  const t = await runTurn(cfg, "t1", "Reply with exactly the single word: pong", { approve: "deny" });
  const ok = t.status === "completed" && /pong/i.test(t.text);
  return { passed: ok, detail: ok ? `streamed "${t.text.trim().slice(0, 40)}" in ${t.elapsedMs}ms (first delta ${t.firstDeltaMs}ms), usage ${fmtUsage(t.usage)}` : describe(t), usage: t.usage, events: t.events };
}

async function stageCancel(cfg: ServerConfig) {
  const t = await runTurn(cfg, "t2", "Count slowly from 1 to 300, one number per line, no other text.", { approve: "deny", cancelAfterFirstDelta: true });
  const ok = t.status === "cancelled";
  return { passed: ok, detail: ok ? `turn_cancelled ${t.elapsedMs - (t.firstDeltaMs ?? 0)}ms after Stop (stream had ${t.text.length} chars)` : describe(t), usage: t.usage, events: t.events };
}

async function stageFailures(cfg: ServerConfig) {
  const badKey = await runTurn({ ...cfg, model: { ...cfg.model, apiKey: "invalid-key-for-validation-000000", maxRetries: 0 } }, "t3a", "ping", { approve: "deny" });
  const badModel = await runTurn({ ...cfg, model: { ...cfg.model, model: "no-such-model-windows-runner-validate", maxRetries: 0 } }, "t3b", "ping", { approve: "deny" });
  const authOk = badKey.status === "failed" && badKey.code === "MODEL_AUTH";
  const modelOk = badModel.status === "failed" && ["MODEL_BAD_REQUEST", "MODEL_UNAVAILABLE"].includes(badModel.code ?? "");
  const leak = [badKey.message, badModel.message].some((m) => m && cfg.model.apiKey && m.includes(cfg.model.apiKey));
  const detail = `invalid key → ${badKey.status}/${badKey.code ?? "-"}; unknown model → ${badModel.status}/${badModel.code ?? "-"}${leak ? "; KEY LEAKED IN MESSAGE" : ""}`;
  return { passed: authOk && modelOk && !leak, detail, events: [...badKey.events, ...badModel.events] };
}

async function stageTools(cfg: ServerConfig, work: string) {
  const notes: string[] = [];
  let ok = true;

  const read = await runTurn(cfg, "t4a", "Use the list_dir tool on '.' and then read_file on 'src/hello.txt'. Reply with the file's contents only.", { approve: "deny" });
  const usedTools = read.toolCalls.some((c) => c.name === "list_dir" || c.name === "read_file");
  const gotText = /hello from the project/.test(read.text) || read.toolResults.some((r) => r.output?.includes("hello from the project"));
  if (read.status === "completed" && usedTools && gotText) notes.push(`read-only tools ok (${read.toolCalls.map((c) => c.name).join(",")})`);
  else { ok = false; notes.push(`read-only tools FAILED: ${describe(read)} tools=${read.toolCalls.map((c) => c.name).join(",") || "none"}`); }

  const trav = await runTurn(cfg, "t4b", "Call read_file with path '../../etc/hostname' and tell me exactly what the tool returned.", { approve: "deny" });
  const refused = trav.toolResults.some((r) => r.name === "read_file" && !r.ok && r.code === "PATH_ESCAPES_ROOT");
  if (refused) notes.push("traversal → PATH_ESCAPES_ROOT");
  else { ok = false; notes.push(`traversal NOT refused: ${trav.toolResults.map((r) => `${r.name}:${r.ok ? "ok" : r.code}`).join(",") || describe(trav)}`); }

  const write = await runTurn(cfg, "t4c", "Use write_file to create 'DENIED.txt' containing 'x'. If the tool is denied, just say denied.", { approve: "deny" });
  const asked = write.approvals.includes("write_file");
  const exists = await fs.stat(path.join(work, "DENIED.txt")).then(() => true, () => false);
  if (asked && !exists) notes.push("write_file asked approval; denied → not written");
  else { ok = false; notes.push(`write_file approval ${asked ? "asked" : "NOT asked"}, file ${exists ? "WRITTEN" : "absent"}`); }

  const term = await runTurn(cfg, "t4d", "Use run_terminal to run exactly this command and reply with its raw output: echo \"KEY=[$WINDOWS_RUNNER_MODEL_API_KEY][$OPENAI_API_KEY][$ANTHROPIC_API_KEY]\"", { approve: "approve" });
  const termResult = term.toolResults.find((r) => r.name === "run_terminal");
  const askedTerm = term.approvals.includes("run_terminal");
  const leaked = !!(cfg.model.apiKey && (termResult?.output?.includes(cfg.model.apiKey) || term.text.includes(cfg.model.apiKey)));
  if (askedTerm && termResult?.ok && !leaked) notes.push(`run_terminal asked approval; output ${JSON.stringify((termResult.output ?? "").trim().slice(0, 30))} (secrets stripped)`);
  else { ok = false; notes.push(`run_terminal approval ${askedTerm ? "asked" : "NOT asked"}, result ${termResult ? (termResult.ok ? "ok" : termResult.code) : "none"}${leaked ? ", KEY LEAKED" : ""}`); }

  const usage = sumUsage([read, trav, write, term]);
  return { passed: ok, detail: notes.join("; "), usage, events: [...read.events, ...trav.events, ...write.events, ...term.events] };
}

// ---------------------------------------------------------------------------

async function runTurn(cfg: ServerConfig, sessionId: string, message: string, opts: { approve: "approve" | "deny"; cancelAfterFirstDelta?: boolean }): Promise<TurnOutcome> {
  const server: StartedServer = await startServer(cfg);
  const out: TurnOutcome = { status: "error", text: "", events: [], toolCalls: [], toolResults: [], approvals: [], elapsedMs: 0 };
  const t0 = Date.now();
  try {
    const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const created = await fetch(`${server.url}/api/sessions/${sessionId}/turns`, { method: "POST", headers: auth, body: JSON.stringify({ cwd: cfg.allowedRoots[0], message }) });
    if (created.status !== 202) throw new Error(`turn not accepted: ${created.status} ${await created.text()}`);
    const { turnId } = await created.json();
    const res = await fetch(`${server.url}/api/sessions/${sessionId}/turns/${turnId}/events`, { headers: auth });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let cancelled = false;
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
        out.events.push(ev.type);
        switch (ev.type) {
          case "text_delta":
            out.text += ev.delta ?? "";
            if (out.firstDeltaMs === undefined) out.firstDeltaMs = Date.now() - t0;
            if (opts.cancelAfterFirstDelta && !cancelled) {
              cancelled = true;
              const c = await fetch(`${server.url}/api/sessions/${sessionId}/turns/${turnId}/cancel`, { method: "POST", headers: auth, body: JSON.stringify({ reason: "validate: stop" }) });
              if (c.status !== 202) throw new Error(`cancel rejected: ${c.status} ${await c.text()}`);
            }
            break;
          case "tool_call":
            out.toolCalls.push({ name: ev.toolName, input: ev.input });
            break;
          case "tool_completed":
            out.toolResults.push({ name: ev.toolName, ok: ev.result?.ok !== false, code: ev.result?.code, output: typeof ev.result?.output === "string" ? ev.result.output : ev.result?.output !== undefined ? JSON.stringify(ev.result.output) : undefined });
            break;
          case "turn_waiting_for_approval":
            out.approvals.push(ev.request?.toolName ?? "?");
            await fetch(`${server.url}/api/sessions/${sessionId}/approve`, { method: "POST", headers: auth, body: JSON.stringify({ requestId: ev.request.requestId, decision: opts.approve }) });
            break;
          case "turn_completed":
            out.status = "completed"; out.usage = ev.usage; break outer;
          case "turn_failed":
            out.status = "failed"; out.code = ev.code; out.message = ev.message; break outer;
          case "turn_cancelled":
            out.status = "cancelled"; break outer;
        }
      }
    }
  } catch (err: any) {
    out.status = "error";
    out.message = err?.message ?? String(err);
  } finally {
    out.elapsedMs = Date.now() - t0;
    await server.close().catch(() => {});
  }
  return out;
}

function describe(t: TurnOutcome): string {
  return `${t.status}${t.code ? ` ${t.code}` : ""}${t.message ? `: ${t.message.slice(0, 160)}` : ""}${t.text ? ` text="${t.text.trim().slice(0, 60)}"` : ""}`;
}
function fmtUsage(u: any): string {
  return u ? `in=${u.inputTokens ?? "?"} out=${u.outputTokens ?? "?"}` : "n/a";
}
function sumUsage(turns: Array<{ usage?: any }>): { inputTokens: number; outputTokens: number } {
  return turns.reduce((a, t) => ({ inputTokens: a.inputTokens + (t.usage?.inputTokens ?? 0), outputTokens: a.outputTokens + (t.usage?.outputTokens ?? 0) }), { inputTokens: 0, outputTokens: 0 });
}

main().catch((err) => {
  console.error(`validate: ${err?.message ?? err}`);
  process.exit(1);
});
