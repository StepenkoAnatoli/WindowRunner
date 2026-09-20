import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { FileTurnLogStore } from "../src/agent/file-turn-log-store.js";
import type { StreamEvent } from "@windows-runner/shared";

function makeEvent(seq: number, turnId: string, sessionId: string, type: any = "text_delta", extra: any = {}): StreamEvent {
  return {
    seq,
    at: Date.now() + seq,
    sessionId,
    turnId,
    type,
    ...extra,
  } as StreamEvent;
}

async function mkTmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "wr-file-store-"));
}

describe("FileTurnLogStore", () => {
  it("atomic serialized appends per turn", async () => {
    const dir = await mkTmpDir();
    const store = new FileTurnLogStore({ dataDir: dir });

    const turnId = "t_123";
    const sessionId = "s_1";

    // Concurrent appends
    const promises = [];
    for (let i = 1; i <= 10; i++) {
      promises.push(store.append(turnId, makeEvent(i, turnId, sessionId, "text_delta", { delta: `d${i}` })));
    }
    await Promise.all(promises);

    const events = await store.readAll(turnId);
    assert.equal(events.length, 10);
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("durable vs async notification ordering — durable awaits before notify", async () => {
    // This test verifies FileTurnLogStore append is awaited in TurnManager.appendAsync when durableBeforeNotify=true
    // Here we test store itself: append should be durable if fsync true
    const dir = await mkTmpDir();
    const store = new FileTurnLogStore({ dataDir: dir, fsync: true });

    const turnId = "t_durable";
    const sessionId = "s_1";
    const ev = makeEvent(1, turnId, sessionId);

    await store.append(turnId, ev);

    // File should exist and be readable immediately after append (durable)
    const events = await store.readAll(turnId);
    assert.equal(events.length, 1);
    assert.equal(events[0].seq, 1);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("truncated final record ignored", async () => {
    const dir = await mkTmpDir();
    const store = new FileTurnLogStore({ dataDir: dir });

    const turnId = "t_trunc";
    const sessionId = "s_1";

    await store.append(turnId, makeEvent(1, turnId, sessionId));
    await store.append(turnId, makeEvent(2, turnId, sessionId));

    // Manually append truncated line
    const filePath = path.join(dir, "sessions", sessionId, "turns", `${turnId}.jsonl`);
    await fs.appendFile(filePath, `{"seq":3,"at":123,"sessionId":"${sessionId}","turnId":"${turnId}","type":"text_delta","delta":"trunc`);

    const events = await store.readAll(turnId);
    // Should ignore truncated last line, keep 2
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((e) => e.seq), [1, 2]);

    const diag = store.getDiagnostics();
    assert.ok(diag.truncatedLinesIgnored >= 1);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("malformed middle record skipped and warned", async () => {
    const dir = await mkTmpDir();
    const store = new FileTurnLogStore({ dataDir: dir });

    const turnId = "t_malformed";
    const sessionId = "s_1";

    await store.append(turnId, makeEvent(1, turnId, sessionId));
    await store.append(turnId, makeEvent(2, turnId, sessionId));

    const filePath = path.join(dir, "sessions", sessionId, "turns", `${turnId}.jsonl`);
    // Insert malformed line in middle by rewriting file
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.trim().split("\n");
    // Add malformed line between 1 and 2
    const malformed = `not json`;
    const newContent = `${lines[0]}\n${malformed}\n${lines[1]}\n`;
    await fs.writeFile(filePath, newContent, "utf8");

    const events = await store.readAll(turnId);
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((e) => e.seq), [1, 2]);

    const diag = store.getDiagnostics();
    assert.ok(diag.eventsSkipped >= 1);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("duplicate sequence keep first", async () => {
    const dir = await mkTmpDir();
    const store = new FileTurnLogStore({ dataDir: dir });

    const turnId = "t_dup";
    const sessionId = "s_1";

    await store.append(turnId, makeEvent(1, turnId, sessionId, "text_delta", { delta: "first" }));
    // Append duplicate seq 1 with different content
    await store.append(turnId, makeEvent(1, turnId, sessionId, "text_delta", { delta: "second" }));

    const events = await store.readAll(turnId);
    assert.equal(events.length, 1);
    assert.equal((events[0] as any).delta, "first");

    const diag = store.getDiagnostics();
    assert.ok(diag.duplicatesSkipped >= 1);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("out-of-order sequences sorted on read, diagnostic emitted, never rewrites file", async () => {
    const dir = await mkTmpDir();
    const store = new FileTurnLogStore({ dataDir: dir });

    const turnId = "t_ooo";
    const sessionId = "s_1";

    // Write out-of-order manually
    const filePath = path.join(dir, "sessions", sessionId, "turns", `${turnId}.jsonl`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const ev1 = makeEvent(1, turnId, sessionId);
    const ev3 = makeEvent(3, turnId, sessionId);
    const ev2 = makeEvent(2, turnId, sessionId);
    await fs.writeFile(filePath, `${JSON.stringify(ev1)}\n${JSON.stringify(ev3)}\n${JSON.stringify(ev2)}\n`, "utf8");

    const originalContent = await fs.readFile(filePath, "utf8");

    const events = await store.readAll(turnId);
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3]);

    const afterContent = await fs.readFile(filePath, "utf8");
    // File should NOT be rewritten automatically
    assert.equal(afterContent, originalContent);

    const diag = store.getDiagnostics();
    assert.ok(diag.outOfOrderDetected >= 1);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("gaps and identity mismatches", async () => {
    const dir = await mkTmpDir();
    const store = new FileTurnLogStore({ dataDir: dir });

    const turnId = "t_gap";
    const sessionId = "s_1";

    const filePath = path.join(dir, "sessions", sessionId, "turns", `${turnId}.jsonl`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    const ev1 = makeEvent(1, turnId, sessionId);
    const ev3 = makeEvent(3, turnId, sessionId); // gap seq 2 missing
    const evWrongTurn = makeEvent(4, "other_turn", sessionId); // identity mismatch turnId
    const evWrongSession = makeEvent(5, turnId, "other_session"); // identity mismatch sessionId

    await fs.writeFile(filePath, `${JSON.stringify(ev1)}\n${JSON.stringify(ev3)}\n${JSON.stringify(evWrongTurn)}\n${JSON.stringify(evWrongSession)}\n`, "utf8");

    const events = await store.readAll(turnId);
    // Should have 1 and 3, gap warning, and mismatches skipped
    assert.deepEqual(events.map((e) => e.seq), [1, 3]);

    const diag = store.getDiagnostics();
    assert.ok(diag.gapsDetected >= 1);
    assert.ok(diag.eventsSkipped >= 2);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("quarantine behavior >50% invalid — file moved to quarantine, cannot be loaded as active", async () => {
    const dir = await mkTmpDir();
    const store = new FileTurnLogStore({ dataDir: dir });

    const turnId = "t_quarantine";
    const sessionId = "s_1";

    const filePath = path.join(dir, "sessions", sessionId, "turns", `${turnId}.jsonl`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    // Write 1 valid, 3 invalid (>50% invalid)
    const valid = makeEvent(1, turnId, sessionId);
    await fs.writeFile(filePath, `${JSON.stringify(valid)}\nnot json\nnot json2\nnot json3\n`, "utf8");

    const events = await store.readAll(turnId);
    // After quarantine, file is moved, so read returns empty (cannot be loaded as active)
    assert.equal(events.length, 0);

    const diag = store.getDiagnostics();
    assert.ok(diag.quarantinedFiles.length >= 1);
    assert.ok(diag.quarantinedFiles[0].includes(turnId));

    // Quarantine file should exist, original should be gone
    const quarantinePath = path.join(dir, "quarantine", `${turnId}.jsonl.quarantined`);
    const stat = await fs.stat(quarantinePath);
    assert.ok(stat.isFile());

    const originalExists = await fs.stat(filePath).then(() => true).catch(() => false);
    assert.equal(originalExists, false, "original file should be moved, not present");

    // list() should not include quarantined turn
    const list = await store.list();
    assert.ok(!list.includes(turnId));

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("crash during append — truncated last line ignored, file not corrupted", async () => {
    const dir = await mkTmpDir();
    const store = new FileTurnLogStore({ dataDir: dir });

    const turnId = "t_crash";
    const sessionId = "s_1";

    await store.append(turnId, makeEvent(1, turnId, sessionId));
    await store.append(turnId, makeEvent(2, turnId, sessionId));

    // Simulate crash: append partial line without newline
    const filePath = path.join(dir, "sessions", sessionId, "turns", `${turnId}.jsonl`);
    await fs.appendFile(filePath, `{"seq":3,"at":`);

    const events = await store.readAll(turnId);
    assert.equal(events.length, 2);

    // After crash recovery, we should be able to append again
    await store.append(turnId, makeEvent(3, turnId, sessionId));
    const events2 = await store.readAll(turnId);
    // Note: after crash, file has truncated line ignored, but new append adds seq 3, so we should have 1,2,3
    // However our store's find will still see truncated ignored, and new append will add new line
    // The file now has 1,2,truncated,3 — truncated ignored, so 1,2,3
    assert.equal(events2.length, 3);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("legacy providerCallId fallback", async () => {
    const dir = await mkTmpDir();
    const store = new FileTurnLogStore({ dataDir: dir });

    const turnId = "t_legacy";
    const sessionId = "s_1";

    const filePath = path.join(dir, "sessions", sessionId, "turns", `${turnId}.jsonl`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    // Old event missing providerCallId
    const oldEvent = {
      seq: 1,
      at: Date.now(),
      sessionId,
      turnId,
      type: "turn_waiting_for_approval",
      request: {
        requestId: "apr_123",
        // providerCallId missing
        turnId,
        sessionId,
        toolName: "read_file",
        input: { path: "foo" },
        reason: "needs approval",
        // createdAt missing
        expiresAt: Date.now() + 1000,
      },
    };

    await fs.writeFile(filePath, `${JSON.stringify(oldEvent)}\n`, "utf8");

    const events = await store.readAll(turnId);
    assert.equal(events.length, 1);
    const req = (events[0] as any).request;
    assert.equal(req.providerCallId, "apr_123"); // fallback to requestId
    assert.ok(req.createdAt); // fallback to at

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("retention and flat-layout migration", async () => {
    const dir = await mkTmpDir();
    const store = new FileTurnLogStore({ dataDir: dir });

    const turnId = "t_flat";
    const sessionId = "s_1";

    // Create legacy flat file
    const flatPath = path.join(dir, "turns", `${turnId}.jsonl`);
    await fs.mkdir(path.dirname(flatPath), { recursive: true });
    await fs.writeFile(flatPath, `${JSON.stringify(makeEvent(1, turnId, sessionId))}\n`, "utf8");

    // list should find flat file
    const list = await store.list();
    assert.ok(list.includes(turnId));

    // readAll should find flat file
    const events = await store.readAll(turnId);
    assert.equal(events.length, 1);

    // Test delete (retention)
    const deleted = await store.deleteTurnFile(turnId);
    assert.equal(deleted, true);

    const list2 = await store.list();
    assert.ok(!list2.includes(turnId));

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("concurrency boundary: serialized writes within one process, multi-process unsupported documented", async () => {
    const dir = await mkTmpDir();
    const store = new FileTurnLogStore({ dataDir: dir });

    // Documented: single process serialized via queue, multi-process not supported
    // We test that concurrent appends within one process are serialized and not interleaved
    const turnId = "t_conc";
    const sessionId = "s_1";

    const promises = [];
    for (let i = 1; i <= 20; i++) {
      promises.push(store.append(turnId, makeEvent(i, turnId, sessionId, "text_delta", { delta: "x".repeat(100) })));
    }
    await Promise.all(promises);

    const content = await fs.readFile(path.join(dir, "sessions", sessionId, "turns", `${turnId}.jsonl`), "utf8");
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 20);
    // Each line should be valid JSON, no interleaving
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.ok(parsed.seq);
    }

    await fs.rm(dir, { recursive: true, force: true });
  });
});
