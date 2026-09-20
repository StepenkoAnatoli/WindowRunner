/**
 * Usage log (src/usage-log.ts): the usage.jsonl file is created with mode
 * 0600 on the first write (appendFile's mode applies at creation; later
 * appends leave it untouched), the in-memory ring is newest-first and capped,
 * loadInitial() reseeds the ring across restarts, a broken file degrades to
 * the ring only, and costs are never invented.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MODEL_PRICE_TABLE, UsageLog, estimateCostUsd } from "../src/usage-log.js";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "wr-usage-"));
}

const rec = (turnId: string, at = Number(turnId.slice(1)), over: Record<string, unknown> = {}) => ({
  at,
  providerId: "default",
  model: "mock",
  turnId,
  status: "completed" as const,
  ...over,
});

describe("UsageLog", () => {
  it("creates usage.jsonl with mode 0600 on the first write; appends do not change the mode", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "usage.jsonl");
    const log = new UsageLog({ dataDir: dir });
    log.append(rec("t1"));
    await log.flush();
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600, "first write creates the file 0600");

    log.append(rec("t2"));
    await log.flush();
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600, "subsequent appends leave the mode untouched");
    const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[1]).turnId, "t2");
  });

  it("the in-memory ring is newest-first and capped at maxRecords", async () => {
    const log = new UsageLog({ dataDir: await tmpDir(), maxRecords: 3 });
    for (let i = 1; i <= 5; i++) log.append(rec(`t${i}`, i));
    await log.flush();
    assert.deepEqual(log.recent(10).map((r) => r.turnId), ["t5", "t4", "t3"]);
    assert.equal(log.recent(2).length, 2);
  });

  it("loadInitial() reseeds the ring from the file across a restart; malformed lines are skipped", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "usage.jsonl");
    const log = new UsageLog({ dataDir: dir, maxRecords: 3 });
    for (let i = 1; i <= 5; i++) log.append(rec(`t${i}`, i));
    await log.flush();
    await fs.appendFile(file, "{not json\n");
    await fs.appendFile(file, JSON.stringify(rec("t6", 6)) + "\n");

    const fresh = new UsageLog({ dataDir: dir, maxRecords: 3 });
    await fresh.loadInitial();
    assert.deepEqual(fresh.recent(10).map((r) => r.turnId), ["t6", "t5", "t4"]);
  });

  it("append tolerates a missing data dir (created lazily) and a broken file (ring only)", async () => {
    const dir = await tmpDir();
    const nested = path.join(dir, "nested", "data");
    const log = new UsageLog({ dataDir: nested });
    log.append(rec("t1"));
    await log.flush();
    assert.equal(log.length, 1);
    assert.equal((await fs.stat(path.join(nested, "usage.jsonl"))).mode & 0o777, 0o600);

    const roDir = await tmpDir();
    await fs.chmod(roDir, 0o555);
    const roLog = new UsageLog({ dataDir: roDir });
    roLog.append(rec("t1"));
    await roLog.flush();
    assert.equal(roLog.length, 1, "the ring keeps working even when the file write fails");
    await fs.chmod(roDir, 0o755); // so the OS temp dir can be cleaned up
  });

  it("estimateCostUsd is undefined unless a price entry matches the exact model id", () => {
    const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };
    assert.equal(estimateCostUsd("gpt-4o-mini", usage), undefined, "unknown model: never invent a price");
    assert.equal(estimateCostUsd("gpt-4o-mini", undefined), undefined, "no usage: no price");
    assert.deepEqual(MODEL_PRICE_TABLE, {}, "the bundled table is intentionally empty");
  });
});
