import { strict as assert } from "node:assert";
import test from "node:test";
import { createServer } from "node:http";
import { createApp } from "../src/app.js";
import { TurnManager } from "../src/agent/turn-manager.js";
import { InMemoryTurnLogStore } from "../src/agent/turn-log-store.js";
import { ApprovalRegistry } from "../src/agent/approval-registry.js";
import { FakeProvider } from "./fakes/fake-provider.js";
import { SessionManager } from "../src/agent/session-manager.js";

function createTestDeps(provider: FakeProvider) {
  const store = new InMemoryTurnLogStore();
  const manager = new TurnManager({ store });
  const approvals = new ApprovalRegistry();
  const sessionManager = new SessionManager({
    isTurnTerminal: (turnId: string) => {
      const log = manager.getLog(turnId);
      return log ? log.state.isTerminal : true;
    },
  });
  const tools = new Map<string, any>([
    [
      "run_terminal",
      {
        name: "run_terminal",
        description: "run a terminal command",
        requiresApproval: (): boolean => true,
        reason: (): string => "needs approval",
        execute: async (): Promise<string> => "ok",
      },
    ],
    [
      "read_file",
      {
        name: "read_file",
        description: "read a file",
        requiresApproval: (): boolean => false,
        execute: async (): Promise<string> => "file content",
      },
    ],
  ]);

  const app = createApp({ manager, provider, tools, approvals, sessionManager });

  return { app, manager, approvals, store, sessionManager };
}

async function readSSEUntil(url: string, pattern: RegExp, opts: { headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);

  const res = await fetch(url, {
    headers: opts.headers,
    signal: controller.signal,
  });

  if (!res.body) throw new Error("no body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (pattern.test(buffer)) {
        break;
      }
    }
  } finally {
    clearTimeout(timeout);
    try {
      await reader.cancel();
    } catch {}
    try {
      await res.body.cancel();
    } catch {}
  }

  return buffer;
}

test("POST /turns starts a turn and GET /events replays with id", async () => {
  const provider = new FakeProvider([() => ({ chunks: [{ type: "text_delta", text: "hello" }] })]);
  const { app } = createTestDeps(provider);

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const started = await fetch(`${base}/api/sessions/s1/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: "/workspace/project", message: "hi" }),
  });
  assert.equal(started.status, 202);
  const { turnId } = (await started.json()) as { turnId: string };

  // Wait a bit for turn to complete
  await new Promise((r) => setTimeout(r, 100));

  const text = await readSSEUntil(`${base}/api/sessions/s1/turns/${turnId}/events`, /turn_completed/);

  assert.match(text, /id: 1/);
  assert.match(text, /turn_started/);
  assert.match(text, /turn_completed/);

  server.close();
});

test("approval remains pending after SSE disconnect and is replayed on reconnect with Last-Event-ID", async () => {
  const provider = new FakeProvider([
    () => ({ chunks: [{ type: "tool_call", call: { id: "c1", name: "run_terminal", input: { command: "npm test" } } }] }),
    () => ({ chunks: [{ type: "text_delta", text: "denied" }] }),
  ]);

  const { app, approvals } = createTestDeps(provider);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const started = await fetch(`${base}/api/sessions/s1/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: "/workspace/project", message: "run tests" }),
  });
  const { turnId } = (await started.json()) as { turnId: string };

  // Wait for approval to be pending
  await new Promise((r) => setTimeout(r, 50));

  // First SSE fetch — read until waiting_for_approval then disconnect
  const firstText = await readSSEUntil(`${base}/api/sessions/s1/turns/${turnId}/events`, /turn_waiting_for_approval/);
  assert.match(firstText, /turn_waiting_for_approval/);

  // Approval should still be pending after disconnect (fix for C2)
  assert.equal(approvals.snapshot(turnId).length, 1);

  // Second fetch with Last-Event-ID = 0 should replay approval (atomic replay)
  const replayText = await readSSEUntil(`${base}/api/sessions/s1/turns/${turnId}/events`, /turn_waiting_for_approval/, {
    headers: { "Last-Event-ID": "0" },
  });
  assert.match(replayText, /turn_waiting_for_approval/);

  // Get minted requestId from registry (providerCallId is c1, but requestId is minted)
  const pending = approvals.snapshot(turnId);
  assert.equal(pending.length, 1);
  const mintedId = pending[0].requestId;
  assert.ok(mintedId.startsWith("apr_"));
  assert.equal((pending[0] as any).providerCallId, "c1");

  // Approve with deny using minted id
  const approveRes = await fetch(`${base}/api/sessions/s1/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: mintedId, decision: "deny" }),
  });
  assert.equal(approveRes.status, 204);

  // Wait and check final — should be completed
  const finalText = await readSSEUntil(`${base}/api/sessions/s1/turns/${turnId}/events`, /turn_completed/, { timeoutMs: 5000 });
  assert.match(finalText, /turn_completed/);

  server.close();
});

test("Last-Event-ID: reconnect with afterSeq replays only missed events", async () => {
  const provider = new FakeProvider([() => ({ chunks: [{ type: "text_delta", text: "hello" }] })]);
  const { app } = createTestDeps(provider);

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const started = await fetch(`${base}/api/sessions/s1/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: "/workspace", message: "hi" }),
  });
  const { turnId } = (await started.json()) as { turnId: string };

  await new Promise((r) => setTimeout(r, 100));

  // Get all events (terminal, so will close)
  const allText = await readSSEUntil(`${base}/api/sessions/s1/turns/${turnId}/events`, /turn_completed/);
  const allIds = [...allText.matchAll(/id: (\d+)/g)].map((m) => parseInt(m[1], 10));
  assert.ok(allIds.length >= 2);

  // Reconnect with Last-Event-ID = first id, should get rest
  const firstId = allIds[0];
  const partialText = await readSSEUntil(`${base}/api/sessions/s1/turns/${turnId}/events`, /turn_completed/, {
    headers: { "Last-Event-ID": String(firstId) },
  });
  const partialIds = [...partialText.matchAll(/id: (\d+)/g)].map((m) => parseInt(m[1], 10));

  assert.ok(partialIds.every((id) => id > firstId));
  assert.ok(partialIds.length === allIds.length - 1);

  server.close();
});

test("cancel endpoint aborts turn", async () => {
  const provider = new FakeProvider([() => ({ hang: true })]);
  const { app } = createTestDeps(provider);

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const started = await fetch(`${base}/api/sessions/s1/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: "/workspace", message: "hang" }),
  });
  const { turnId } = (await started.json()) as { turnId: string };

  await new Promise((r) => setTimeout(r, 50));

  const cancelRes = await fetch(`${base}/api/sessions/s1/turns/${turnId}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "Stop pressed" }),
  });
  assert.equal(cancelRes.status, 202);

  const text = await readSSEUntil(`${base}/api/sessions/s1/turns/${turnId}/events`, /turn_cancelled/, { timeoutMs: 5000 });
  assert.match(text, /turn_cancelled/);

  server.close();
});

test("session root pinning — second turn with different cwd rejected", async () => {
  const provider = new FakeProvider([() => ({ chunks: [{ type: "text_delta", text: "hello" }] })]);
  const { app } = createTestDeps(provider);

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const started1 = await fetch(`${base}/api/sessions/s1/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: "/workspace/project", message: "hi" }),
  });
  assert.equal(started1.status, 202);
  await new Promise((r) => setTimeout(r, 100));

  const started2 = await fetch(`${base}/api/sessions/s1/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: "/workspace/other", message: "hi" }),
  });
  assert.equal(started2.status, 400);
  const body = await started2.json() as any;
  assert.equal(body.code, "ROOT_MISMATCH");

  server.close();
});

test("concurrent starts — second gets 409 TURN_ALREADY_ACTIVE", async () => {
  const provider = new FakeProvider([() => ({ hang: true })]);
  const { app } = createTestDeps(provider);

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const started1 = await fetch(`${base}/api/sessions/s1/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: "/workspace/project", message: "hang" }),
  });
  assert.equal(started1.status, 202);

  await new Promise((r) => setTimeout(r, 20));

  const started2 = await fetch(`${base}/api/sessions/s1/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: "/workspace/project", message: "hang2" }),
  });
  assert.equal(started2.status, 409);
  const body = await started2.json() as any;
  assert.equal(body.code, "TURN_ALREADY_ACTIVE");
  assert.ok(body.activeTurnId);

  server.close();
});

test("cancellation followed by new turn allowed", async () => {
  const provider = new FakeProvider([() => ({ hang: true }), () => ({ chunks: [{ type: "text_delta", text: "hello" }] })]);
  const { app } = createTestDeps(provider);

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const started1 = await fetch(`${base}/api/sessions/s1/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: "/workspace/project", message: "hang" }),
  });
  const { turnId: t1 } = await started1.json() as any;
  await new Promise((r) => setTimeout(r, 20));

  await fetch(`${base}/api/sessions/s1/turns/${t1}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "stop" }),
  });

  await new Promise((r) => setTimeout(r, 50));

  const started2 = await fetch(`${base}/api/sessions/s1/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: "/workspace/project", message: "hi" }),
  });
  assert.equal(started2.status, 202);

  server.close();
});

test("explicit session creation and pinning", async () => {
  const provider = new FakeProvider([() => ({ chunks: [{ type: "text_delta", text: "hello" }] })]);
  const { app } = createTestDeps(provider);

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const createRes = await fetch(`${base}/api/sessions/s1`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: "/workspace/project" }),
  });
  assert.equal(createRes.status, 201);

  const createAgain = await fetch(`${base}/api/sessions/s1`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: "/workspace/project" }),
  });
  assert.equal(createAgain.status, 409);

  const turnRes = await fetch(`${base}/api/sessions/s1/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hi" }),
  });
  assert.equal(turnRes.status, 202);

  server.close();
});
