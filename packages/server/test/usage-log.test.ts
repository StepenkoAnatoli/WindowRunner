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
    // POSIX only: Windows ignores mode bits (ACLs instead of modes).
    if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600, "first write creates the file 0600");

    log.append(rec("t2"));
    await log.flush();
    if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600, "subsequent appends leave the mode untouched");
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
    if (process.platform !== "win32") assert.equal((await fs.stat(path.join(nested, "usage.jsonl"))).mode & 0o777, 0o600);

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

describe("UsageLog bounds (tail read + rotation)", () => {
  const LINE_FLOOR = 4 * 8 * 1024; // the constructor's floor for maxFileBytes

  it("loadInitial() reads a bounded tail of usage.jsonl instead of the whole history", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "usage.jsonl");
    // 400 valid records (~120 bytes each). "FIRST" marks the oldest one: if the
    // whole file were read it would be in the ring, because maxRecords here is
    // far larger than 400 and nothing would be trimmed away.
    const lines = [JSON.stringify(rec("FIRST", 0))];
    for (let i = 2; i <= 400; i++) lines.push(JSON.stringify(rec(`t${i}`, i)));
    await fs.writeFile(file, lines.join("\n") + "\n");

    const log = new UsageLog({ dataDir: dir, maxRecords: 1000, tailBytes: 4096 });
    await log.loadInitial();

    assert.ok(log.length > 0, "the tail window still yields records");
    assert.ok(log.length < 400, `only the tail was loaded (${log.length} of 400 records)`);
    assert.equal(log.recent(1)[0].turnId, "t400", "the newest record survives");
    assert.ok(
      !log.recent(1000).some((r) => r.turnId === "FIRST"),
      "records older than the tail window are not loaded"
    );
    assert.equal(log.bounded, true, "the log reports that older records are missing");
  });

  it("a partial first line inside the tail window is dropped, not parsed as garbage", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "usage.jsonl");
    // ~24 KiB of records, so the 8 KiB window (tailBytes is floored at
    // MAX_LINE_BYTES — a window smaller than one record is meaningless) really
    // does start in the middle of a line.
    const lines: string[] = [];
    for (let i = 1; i <= 200; i++) lines.push(JSON.stringify(rec(`t${i}`, i)));
    await fs.writeFile(file, lines.join("\n") + "\n");

    const log = new UsageLog({ dataDir: dir, maxRecords: 1000, tailBytes: 8 * 1024 });
    await log.loadInitial();
    assert.ok(log.length > 10 && log.length < 200, `tail window holds the newest block only (got ${log.length} of 200)`);
    // Nothing half-parsed crept in: what was loaded is exactly the newest
    // contiguous run of records, in order.
    assert.deepEqual(
      log.recent(log.length).map((r) => r.turnId).reverse(),
      lines.slice(-log.length).map((l) => JSON.parse(l).turnId)
    );
  });

  it("usage.jsonl rotates at maxFileBytes and keeps exactly one older generation", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "usage.jsonl");
    const budget = Math.max(LINE_FLOOR, 32 * 1024);
    const log = new UsageLog({ dataDir: dir, maxFileBytes: budget, maxRecords: 10_000 });
    for (let i = 1; i <= 900; i++) log.append(rec(`t${i}`, i));
    await log.flush();

    const size = (await fs.stat(file)).size;
    assert.ok(size <= budget + 8 * 1024, `usage.jsonl stayed inside its budget (${size} bytes <= ${budget + 8 * 1024})`);
    const rotated = `${file}.1`;
    await fs.stat(rotated); // throws if the generation is missing
    // One generation only: a second rotation replaces it rather than piling up.
    const rotatedSize = (await fs.stat(rotated)).size;
    assert.ok(rotatedSize <= budget + 8 * 1024, "the rotated generation is bounded too");
    assert.equal(log.bounded, true, "rotation means records are no longer available");

    // A restart still sees the newest turns, and knows the history is partial.
    const fresh = new UsageLog({ dataDir: dir, maxFileBytes: budget });
    await fresh.loadInitial();
    assert.equal(fresh.recent(1)[0].turnId, "t900");
    assert.ok(fresh.length < 900, "the rotated records are not reloaded");
    assert.equal(fresh.bounded, true);
  });

  it("bounded is false while the whole history still fits", async () => {
    const dir = await tmpDir();
    const log = new UsageLog({ dataDir: dir, maxRecords: 100 });
    for (let i = 1; i <= 5; i++) log.append(rec(`t${i}`, i));
    await log.flush();
    assert.equal(log.bounded, false);
    const fresh = new UsageLog({ dataDir: dir, maxRecords: 100 });
    await fresh.loadInitial();
    assert.equal(fresh.length, 5, "nothing was dropped");
    assert.equal(fresh.bounded, false);
  });

  it("maxFileBytes is floored so a single record can never rotate on every append", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "usage.jsonl");
    const log = new UsageLog({ dataDir: dir, maxFileBytes: 1 }); // floored to 4 * MAX_LINE_BYTES
    for (let i = 1; i <= 5; i++) log.append(rec(`t${i}`, i));
    await log.flush();
    const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
    assert.equal(lines.length, 5, "no rotation storm from an absurdly small budget");
  });
});
