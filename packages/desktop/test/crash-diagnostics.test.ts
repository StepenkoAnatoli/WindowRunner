/**
 * Crash diagnostics unit tests (B5.5).
 *
 * Covers the pure contract of src/crash-diagnostics.ts against temp
 * directories: record shape, secret scrubbing, detail bounding, file naming,
 * tmp-then-rename writes, crash-log retention, minidump retention (mtime
 * order), and the logs README. The main-process wiring (crashReporter,
 * setPath, handlers) is asserted in main-flow.test.ts via the electron stub,
 * and the real-Electron behavior in test/electron-smoke.ts (CI).
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeTempPath } from "../../../scripts/temp-path.mjs";
import {
  CRASH_LOG_KEEP,
  MAX_DETAILS_LENGTH,
  crashLogFileName,
  describeError,
  ensureLogsReadme,
  formatCrashRecord,
  logsReadmeText,
  pruneCrashDumps,
  pruneCrashLogs,
  scrubText,
  writeCrashLog,
  type CrashRecord,
} from "../src/crash-diagnostics.js";

const tmps: string[] = [];
after(async () => {
  await Promise.all(tmps.map((t) => removeTempPath(t)));
});

async function tmp(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wr-crash-"));
  tmps.push(dir);
  return dir;
}

function sampleRecord(overrides: Partial<CrashRecord> = {}): CrashRecord {
  return {
    kind: "unhandledRejection",
    writtenAt: "2026-09-22T10:11:12.123Z",
    appVersion: "0.1.0",
    platform: "win32",
    electronVersion: "44.4.3",
    nodeVersion: "22.22.3",
    pid: 4242,
    details: "Error: something failed\n    at somewhere",
    ...overrides,
  };
}

describe("crash diagnostics (B5.5)", () => {
  it("formats a bounded, ordered, plain-text record", () => {
    const text = formatCrashRecord(sampleRecord({ extras: { reason: "oom", exitCode: 5 } }));
    const lines = text.split("\n");
    assert.equal(lines[0], "WindowRunner desktop crash record");
    assert.match(text, /kind: unhandledRejection/);
    assert.match(text, /written: 2026-09-22T10:11:12\.123Z/);
    assert.match(text, /appVersion: 0\.1\.0/);
    assert.match(text, /platform: win32/);
    assert.match(text, /electron: 44\.4\.3/);
    assert.match(text, /node: 22\.22\.3/);
    assert.match(text, /pid: 4242/);
    assert.match(text, /reason: oom/);
    assert.match(text, /exitCode: 5/);
    assert.match(text, /details:\nError: something failed/);
    assert.ok(text.endsWith("\n"), "file content ends with a newline");
  });

  it("scrubs secrets from details and extras", () => {
    const token = "deadbeefcafe0123456789abcdef";
    const record = sampleRecord({
      details: `failed while calling ${token} upstream`,
      extras: { header: `Bearer ${token}` },
    });
    const text = formatCrashRecord(record, [token]);
    assert.ok(!text.includes(token), "the token must not appear anywhere in the record");
    assert.match(text, /\[redacted\]/);
    assert.match(text, /Bearer \[redacted\]/);
  });

  it("truncates oversized details instead of writing unbounded memory", () => {
    const huge = "x".repeat(MAX_DETAILS_LENGTH + 5000);
    const text = formatCrashRecord(sampleRecord({ details: huge }));
    assert.ok(text.length < huge.length, "details must be truncated");
    assert.match(text, new RegExp(`…\\(truncated at ${MAX_DETAILS_LENGTH} characters\\)`));
  });

  it("names crash files without characters hostile to Windows paths", () => {
    const name = crashLogFileName({ pid: 99 }, "2026-09-22T10:11:12.123Z");
    assert.equal(name, "crash-20260922T101112123Z-99.log");
    assert.ok(!/[:.]/.test(name.slice(0, -4)), "no colons or dots in the stamp");
  });

  it("writes crash logs tmp-then-rename and prunes retention", async () => {
    const dir = await tmp();
    const logsDir = path.join(dir, "logs");
    // Fill past the keep limit with distinct timestamps.
    for (let i = 0; i < CRASH_LOG_KEEP + 5; i += 1) {
      const writtenAt = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      const file = writeCrashLog(logsDir, sampleRecord({ pid: i, writtenAt, details: `failure #${i}` }));
      assert.ok(file, `write ${i} must succeed`);
      assert.ok(fs.existsSync(file), `file ${i} must exist`);
      assert.ok(!fs.existsSync(`${file}.tmp`), "no tmp file may survive the rename");
    }
    const remaining = fs.readdirSync(logsDir).filter((n) => n.startsWith("crash-") && n.endsWith(".log"));
    assert.equal(remaining.length, CRASH_LOG_KEEP, `retention must keep exactly ${CRASH_LOG_KEEP} crash logs`);
    // The newest survive, the oldest five are gone (pids == seconds 0..24).
    assert.ok(remaining.some((n) => n.endsWith("-24.log")), "newest record (second 24) survives");
    assert.ok(!remaining.some((n) => n.endsWith("-0.log") || n.endsWith("-4.log")), "the five oldest are pruned");

    // Non-crash files in the same dir are never touched.
    fs.writeFileSync(path.join(logsDir, "server.log"), "keep me");
    assert.equal(pruneCrashLogs(logsDir, 3), CRASH_LOG_KEEP - 3, "explicit keep prunes the delta");
    assert.ok(fs.existsSync(path.join(logsDir, "server.log")), "server.log is not crash retention's business");
  });

  it("writeCrashLog never throws (the caller is often dying)", async () => {
    const dir = await tmp();
    // A file where the directory should be: every fs call fails.
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "not a directory");
    const result = writeCrashLog(path.join(blocker, "logs"), sampleRecord());
    assert.equal(result, undefined, "a failing write returns undefined, it does not throw");
  });

  it("prunes minidumps by mtime, keeping the newest", async () => {
    const dir = await tmp();
    const crashes = path.join(dir, "crashes");
    await fsp.mkdir(crashes, { recursive: true });
    const dumpNames = ["a.dmp", "b.dmp", "c.dmp", "unrelated.txt"];
    let mtime = Date.now() - 10_000;
    for (const name of dumpNames) {
      const file = path.join(crashes, name);
      await fsp.writeFile(file, name);
      await fsp.utimes(file, new Date(mtime), new Date(mtime));
      mtime += 1000;
    }
    const removed = pruneCrashDumps(crashes, 2); // 3 dumps, keep 2
    assert.equal(removed, 1, "oldest dump removed");
    assert.ok(fs.existsSync(path.join(crashes, "c.dmp")), "newest dump kept");
    assert.ok(!fs.existsSync(path.join(crashes, "a.dmp")), "oldest dump removed");
    assert.ok(fs.existsSync(path.join(crashes, "unrelated.txt")), "non-dump files untouched");
    assert.equal(pruneCrashDumps(path.join(dir, "does-not-exist")), 0, "missing dir is not an error");
  });

  it("writes the logs README once, never overwriting user edits", async () => {
    const dir = await tmp();
    const logsDir = path.join(dir, "logs");
    ensureLogsReadme(logsDir);
    ensureLogsReadme(logsDir);
    const readme = fs.readFileSync(path.join(logsDir, "README.txt"), "utf8");
    assert.match(readme, /nothing in either directory is ever uploaded/);
    assert.match(readme, /crash-\*\.log/);
    assert.match(readme, /minidumps/i);
    // A user annotation survives the second ensure.
    fs.appendFileSync(path.join(logsDir, "README.txt"), "my note\n");
    ensureLogsReadme(logsDir);
    assert.ok(fs.readFileSync(path.join(logsDir, "README.txt"), "utf8").includes("my note"));
    assert.ok(logsReadmeText().endsWith("\n"));
  });

  it("describeError renders Errors and unknown values readably", () => {
    const err = new Error("boom");
    assert.match(describeError(err), /^Error: boom/);
    assert.match(describeError(err), /at /, "stack included when available");
    assert.equal(describeError("plain string"), "plain string");
    assert.equal(describeError(42), "42");
    assert.equal(describeError(undefined), "undefined");
  });

  it("scrubText leaves text intact when the scrub list is empty or blank", () => {
    assert.equal(scrubText("abc", []), "abc");
    assert.equal(scrubText("abc", ["", " "]), "abc");
  });
});
