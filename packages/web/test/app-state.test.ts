import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { activeTurn, describeTurn, initialAppState, pendingApprovals, reduceApp, previewApproval, type AppState } from "../src/app-state.js";

function ev(seq: number, type: string, extra: Record<string, unknown> = {}): any {
  return { seq, at: seq * 10, sessionId: "s", turnId: "t1", type, ...extra };
}

function withTurn(): AppState {
  let s = reduceApp(initialAppState, { type: "auth_ok", securityMode: "token", persistenceMode: "memory" });
  s = reduceApp(s, { type: "session_created", sessionId: "s", root: "/p" });
  s = reduceApp(s, { type: "turn_submitted", turnId: "t1", message: "hello" });
  return s;
}

describe("app reducer", () => {
  it("auth_invalid resets everything except the error", () => {
    const s = reduceApp(withTurn(), { type: "auth_invalid", message: "nope" });
    assert.equal(s.auth, "invalid");
    assert.equal(s.authError, "nope");
    assert.equal(s.session, undefined);
    assert.deepEqual(s.turns, []);
  });

  it("folds stream events through the shared reducer, tracks tools, and clears the active turn at terminal", () => {
    let s = withTurn();
    assert.equal(activeTurn(s)?.turnId, "t1");
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(1, "turn_started", { limits: {}, message: "hello", root: "/p" }) });
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(2, "text_delta", { delta: "Hel" }) });
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(2, "text_delta", { delta: "DUP" }) }); // duplicate seq ignored
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(3, "text_delta", { delta: "lo" }) });
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(4, "tool_call", { callId: "c1", toolName: "run_terminal", input: { cmd: "ls" } }) });
    const req = { requestId: "apr_1", providerCallId: "c1", turnId: "t1", sessionId: "s", toolName: "run_terminal", input: { cmd: "ls" }, reason: "needs approval", expiresAt: 999, createdAt: 40 };
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(5, "turn_waiting_for_approval", { request: req }) });
    assert.equal(s.turns[0].state.textAccumulated, "Hello");
    assert.equal(s.turns[0].state.status, "waiting_for_approval");
    assert.equal(pendingApprovals(s.turns[0])[0].requestId, "apr_1");
    assert.equal(describeTurn(s.turns[0]), "waiting for approval (1)");
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(6, "approval_resolved", { requestId: "apr_1", decision: "approve", resolvedAt: 60 }) });
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(7, "tool_started", { callId: "c1", toolName: "run_terminal" }) });
    assert.equal(s.turns[0].tools[0].status, "running");
    assert.match(describeTurn(s.turns[0]), /running run_terminal/);
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(8, "tool_completed", { callId: "c1", toolName: "run_terminal", result: { ok: true, output: "ok" } }) });
    assert.equal(s.turns[0].tools[0].status, "done");
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(9, "turn_completed", { usage: { totalTokens: 12 } }) });
    assert.equal(s.turns[0].state.isTerminal, true);
    assert.equal(activeTurn(s), undefined);
    assert.equal(describeTurn(s.turns[0]), "completed · 12 tokens");
    // Post-terminal events are ignored.
    const after = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(10, "text_delta", { delta: "late" }) });
    assert.equal(after, s);
  });

  it("raises a trust prompt from a PROJECT_NOT_TRUSTED tool result and clears it when trust loads", () => {
    let s = withTurn();
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(1, "turn_started", { limits: {}, message: "m", root: "/p" }) });
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(2, "tool_call", { callId: "c1", toolName: "mcp", input: {} }) });
    s = reduceApp(s, {
      type: "turn_event",
      turnId: "t1",
      event: ev(3, "tool_completed", { callId: "c1", toolName: "mcp", result: { ok: false, code: "PROJECT_NOT_TRUSTED", message: "x", retryable: false, details: { realRoot: "/real/p", configHash: "sha256:" + "a".repeat(64), source: ".mcp.json", staleConfigHash: "sha256:" + "b".repeat(64) } } }),
    });
    assert.equal(s.trustPrompt?.toolName, "mcp");
    assert.equal(s.trustPrompt?.realRoot, "/real/p");
    assert.equal(s.trustPrompt?.staleConfigHash, "sha256:" + "b".repeat(64));
    s = reduceApp(s, { type: "trust_loaded", grant: { configHash: "sha256:" + "a".repeat(64), source: ".mcp.json" } });
    assert.equal(s.trustPrompt, undefined);
    assert.equal(s.session?.trust?.source, ".mcp.json");
  });

  it("describes failures, cancellation, reconnects and stream errors", () => {
    let s = withTurn();
    s = reduceApp(s, { type: "turn_connection", turnId: "t1", connection: "reconnecting", attempt: 2 });
    assert.equal(describeTurn(s.turns[0]), "reconnecting (attempt 2)…");
    s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(1, "turn_started", { limits: {}, message: "m", root: "/p" }) });
    assert.match(describeTurn(s.turns[0]), /running — reconnecting \(attempt 2\)/);
    s = reduceApp(s, { type: "turn_connection", turnId: "t1", connection: "streaming" });
    assert.equal(describeTurn(s.turns[0]), "running…");
    const failed = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(2, "turn_failed", { code: "MODEL_TIMEOUT", message: "slow", retryable: true }) });
    assert.equal(describeTurn(failed.turns[0]), "failed: MODEL_TIMEOUT — slow (retryable)");
    const cancelled = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(2, "turn_cancelled", { reason: "stop" }) });
    assert.equal(describeTurn(cancelled.turns[0]), "cancelled");
    const broken = reduceApp(s, { type: "turn_stream_error", turnId: "t1", message: "gave up" });
    assert.equal(describeTurn(broken.turns[0]), "stream error: gave up");
    assert.equal(broken.turns[0].connection, "closed");
  });
});

describe("previewApproval", () => {
  it("renders edit_file as a removed/added diff with the uniqueness note", () => {
    const p = previewApproval("edit_file", { path: "src/a.ts", oldText: "a\nb", newText: "c" });
    assert.equal(p.kind, "diff");
    if (p.kind !== "diff") return;
    assert.equal(p.path, "src/a.ts");
    assert.deepEqual(p.lines, [{ type: "-", text: "a" }, { type: "-", text: "b" }, { type: "+", text: "c" }]);
    assert.match(p.note!, /exactly one/);
    assert.match((previewApproval("edit_file", { path: "x", oldText: "a", newText: "b", replaceAll: true }) as any).note, /every occurrence/);
  });

  it("renders write_file as all-added lines with the byte count, clipped for long files", () => {
    const p = previewApproval("write_file", { path: "big.txt", content: Array.from({ length: 100 }, (_, i) => `l${i}`).join("\n") });
    if (p.kind !== "diff") throw new Error("expected diff");
    assert.equal(p.lines.length, 61);
    assert.match(p.lines[60].text, /40 more line/);
    assert.match(p.note!, /bytes/);
  });

  it("renders run_terminal as a command and everything else as JSON", () => {
    assert.deepEqual(previewApproval("run_terminal", { command: "npm test" }).kind, "command");
    const j = previewApproval("mystery", { a: 1 });
    assert.equal(j.kind, "json");
    assert.match((j as any).text, /"a": 1/);
    assert.equal(previewApproval("edit_file", "not an object").kind, "json");
  });
});
