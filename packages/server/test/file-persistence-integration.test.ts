import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { FileTurnLogStore } from "../src/agent/file-turn-log-store.js";
import { FileSessionStore } from "../src/agent/file-session-store.js";
import { TurnManager } from "../src/agent/turn-manager.js";
import { createInitialTurnState, reduceTurnState } from "@windows-runner/shared";

async function mkTmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "wr-integration-"));
}

describe("File persistence integration — restart recovery", () => {
  it("restart appends exactly one RESTART at maxSeq+1 and clears activeTurnId", async () => {
    const dir = await mkTmpDir();
    const turnStore = new FileTurnLogStore({ dataDir: dir });
    const sessionStore = new FileSessionStore({ dataDir: dir });

    const sessionId = "sess_integ";
    const turnId = "t_integ";

    // A session root that exists on every OS (/tmp does not exist on Windows).
    const sysTmp = os.tmpdir();

    // Create session meta with activeTurnId
    await sessionStore.save({
      version: 1,
      sessionId,
      canonicalRoot: sysTmp,
      realRoot: sysTmp,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      activeTurnId: turnId,
    });

    // Create turn with 2 events, non-terminal — use appendAsync to ensure durable before boot
    const manager = new TurnManager({ store: turnStore, now: () => Date.now(), durableBeforeNotify: true });
    manager.ensureLog(sessionId, turnId);
    await manager.appendAsync(sessionId, turnId, { type: "turn_started", limits: { maxSteps: 10, modelCallTimeoutMs: 1000, toolTimeoutMs: 1000, approvalTimeoutMs: 1000 }, message: "hi" } as any);
    await manager.appendAsync(sessionId, turnId, { type: "text_delta", delta: "hello" } as any);

    // Simulate restart: new manager boot
    const manager2 = new TurnManager({ store: turnStore, now: () => Date.now() });
    const bootResult = await manager2.boot();

    assert.equal(bootResult.turnsLoaded, 1);
    assert.equal(bootResult.turnsWithRestart, 1);

    const log = manager2.getLog(turnId);
    assert.ok(log);
    assert.equal(log!.state.isTerminal, true);
    assert.equal(log!.state.seq, 3); // 2 original + 1 RESTART
    assert.equal(log!.events.length, 3);
    assert.equal(log!.events[2].type, "turn_failed");
    assert.equal((log!.events[2] as any).code, "RESTART");

    // Session boot should clear activeTurnId
    const sessDiag = await sessionStore.boot([sysTmp], () => Date.now());
    assert.equal(sessDiag.sessionsWithClearedActiveTurn, 1);

    const meta = await sessionStore.load(sessionId);
    assert.equal(meta!.activeTurnId, null);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("idempotency of restart recovery — second boot does not append second RESTART", async () => {
    const dir = await mkTmpDir();
    const turnStore = new FileTurnLogStore({ dataDir: dir });

    const sessionId = "sess_idem";
    const turnId = "t_idem";

    const manager = new TurnManager({ store: turnStore, now: () => Date.now(), durableBeforeNotify: true });
    manager.ensureLog(sessionId, turnId);
    await manager.appendAsync(sessionId, turnId, { type: "turn_started", limits: { maxSteps: 10, modelCallTimeoutMs: 1000, toolTimeoutMs: 1000, approvalTimeoutMs: 1000 }, message: "hi" } as any);

    // First boot
    const manager2 = new TurnManager({ store: turnStore, now: () => Date.now() });
    await manager2.boot();
    const log1 = manager2.getLog(turnId);
    assert.equal(log1!.events.length, 2); // started + RESTART
    assert.equal(log1!.events[1].type, "turn_failed");

    // Second boot — should not append another RESTART because already terminal
    const manager3 = new TurnManager({ store: turnStore, now: () => Date.now() });
    await manager3.boot();
    const log2 = manager3.getLog(turnId);
    assert.equal(log2!.events.length, 2); // still 2, not 3

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("flat-layout fallback migration without changing source files", async () => {
    const dir = await mkTmpDir();
    const turnStore = new FileTurnLogStore({ dataDir: dir });

    const sessionId = "sess_flat";
    const turnId = "t_flat";

    // Create legacy flat file
    const flatPath = path.join(dir, "turns", `${turnId}.jsonl`);
    await fs.mkdir(path.dirname(flatPath), { recursive: true });
    const ev = {
      seq: 1,
      at: Date.now(),
      sessionId,
      turnId,
      type: "turn_started",
      limits: { maxSteps: 10, modelCallTimeoutMs: 1000, toolTimeoutMs: 1000, approvalTimeoutMs: 1000 },
      message: "hi",
      root: "/tmp",
      realRoot: "/tmp",
    };
    await fs.writeFile(flatPath, `${JSON.stringify(ev)}\n`, "utf8");

    const originalContent = await fs.readFile(flatPath, "utf8");

    // Boot should find flat file
    const manager = new TurnManager({ store: turnStore, now: () => Date.now() });
    const bootResult = await manager.boot();
    assert.equal(bootResult.turnsLoaded, 1);

    // Original file should NOT be rewritten for sorting, but RESTART append is expected (exactly one)
    const afterContent = await fs.readFile(flatPath, "utf8");
    assert.ok(afterContent.startsWith(originalContent), "file should preserve original content at start");
    // Should have original + RESTART
    const linesAfter = afterContent.trim().split("\n");
    assert.equal(linesAfter.length, 2); // original 1 + RESTART 1
    const restart = JSON.parse(linesAfter[1]);
    assert.equal(restart.code, "RESTART");

    await fs.rm(dir, { recursive: true, force: true });
  });
});
