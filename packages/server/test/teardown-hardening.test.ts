/**
 * Windows teardown hardening (2026-09-22) — pins the fix for the CI flake
 * recorded in that day's atomic-status plans (removed from the tree with the
 * other process scaffolding, recoverable from git history; follow-up item 9)
 * and implemented in `scripts/temp-path.mjs`.
 *
 * The incident: on PR #36's first run the `Platform (windows-latest)` leg
 * failed the whole of `packages/server/test/builtin-tools.test.ts` as
 * `hookFailed` after 4.5 ms — `EBUSY: resource busy or locked, rmdir
 * …\Temp\wr-tools-XXXX\project` raised by its `after` hook — while every real
 * assertion passed (380/386, 5 skipped). The class: teardown removed temp
 * paths with `fs.rm(dir, { recursive: true, force: true })` and Node's default
 * `maxRetries: 0`, so one transient Windows handle (a child process still
 * exiting, an indexer/Defender scan) is fatal — and `node:test` reports it as
 * a file-level hook failure, not a test failure, so a green suite goes red.
 *
 * Two halves of the contract, both pinned here:
 *   1. the shared helper retries — it forwards `maxRetries`/`retryDelay` and
 *      otherwise behaves like `fs.rm` (removes the path, tolerates a missing
 *      one, synchronous twin for the smoke scripts);
 *   2. nothing bypasses it — a static audit over every suite that runs on
 *      Windows (each workspace's `test/` tree), plus the two smoke scripts
 *      that remove their own temp trees.
 *
 * Reviewed and deliberately outside the audit, because they cannot fail a test
 * hook: the Playwright specs and the web e2e server helpers already
 * `.catch(() => {})` their removals (they leak a temp dir at worst), `eval/`
 * runs only in the Linux `CI` job, and `packages/desktop/scripts/copy-assets.mjs`
 * removes repo-internal build output rather than an OS temp path.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TEMP_PATH_RM_OPTIONS,
  removeTempPath,
  removeTempPathSync,
  type TempPathRm,
  type TempPathRmOptions,
} from "../../../scripts/temp-path.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

/**
 * Repo-relative POSIX path. `path.relative` yields backslashes on Windows
 * runners, so comparing its output against the POSIX-style expectations below
 * must not depend on the separator — the first version of this guard did, and
 * the Windows leg of PR #38's first run failed on exactly that (the audit
 * expected `packages/server/test/builtin-tools.test.ts` and got
 * `packages\server\test\builtin-tools.test.ts`).
 */
function toPosix(file: string): string {
  return file.split(/[\\/]/).join("/");
}

const relPath = (file: string): string => toPosix(path.relative(repoRoot, file));

/** This file: it holds the forbidden pattern as data, so it audits nothing. */
const SELF = path.basename(fileURLToPath(import.meta.url));

const SMOKE_SCRIPTS = ["scripts/smoke-start.mjs", "scripts/smoke-packed-start.mjs"];

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

/** `packages/<ws>/test/**`, i.e. every suite that runs on the Windows legs. */
const testTrees = fs
  .readdirSync(path.join(repoRoot, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(repoRoot, "packages", entry.name, "test")))
  .map((entry) => path.join(repoRoot, "packages", entry.name, "test"));

const audited = [
  ...testTrees.flatMap(walk).filter((file) => path.basename(file) !== SELF),
  ...SMOKE_SCRIPTS.map((rel) => path.join(repoRoot, rel)),
];

describe("teardown hardening: the shared helper", () => {
  it("removes a temp tree, and tolerates one that is already gone (force)", async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), "wr-teardown-"));
    await fsp.mkdir(path.join(base, "project", "src"), { recursive: true });
    await fsp.writeFile(path.join(base, "project", "src", "index.ts"), "line\n");

    await removeTempPath(base);
    await assert.rejects(fsp.stat(base), /ENOENT/);
    await removeTempPath(base); // force: true — a missing path is not an error
  });

  it("removes a path synchronously too (the smoke scripts' path)", async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), "wr-teardown-sync-"));
    await fsp.writeFile(path.join(base, "f.txt"), "x");

    removeTempPathSync(base);
    assert.equal(fs.existsSync(base), false);
    removeTempPathSync(base); // force: true, again
  });

  it("forwards the retry options to fs.rm — the point of the fix", async () => {
    const calls: { target: string; options: TempPathRmOptions }[] = [];
    const fake: TempPathRm = async (target, options) => {
      calls.push({ target, options });
    };

    await removeTempPath("/tmp/wr-not-a-real-temp-path", fake);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.target, "/tmp/wr-not-a-real-temp-path");
    assert.deepEqual({ ...calls[0]!.options }, { ...TEMP_PATH_RM_OPTIONS });
    // The posture the diagnosis requires: Node's default is maxRetries: 0, so
    // without these a single transient EBUSY/EPERM/ENOTEMPTY is fatal.
    assert.equal(calls[0]!.options.recursive, true);
    assert.equal(calls[0]!.options.force, true);
    assert.ok(calls[0]!.options.maxRetries >= 5, "maxRetries must be well above Node's default of 0");
    assert.ok(calls[0]!.options.retryDelay >= 50, "retryDelay must give the OS time to release the handle");
  });
});

describe("teardown hardening: the audit", () => {
  it("normalizes repo-relative paths, so the audit reads the same on Windows", () => {
    // The Windows leg of PR #38's first run failed here: `path.relative` gave
    // backslashes and the POSIX expectations below did not match. Pin the
    // normalization on every platform, since the mismatch is invisible on
    // Linux and macOS.
    assert.equal(toPosix("packages\\server\\test\\builtin-tools.test.ts"), "packages/server/test/builtin-tools.test.ts");
    assert.equal(toPosix("packages/server/test/builtin-tools.test.ts"), "packages/server/test/builtin-tools.test.ts");
    assert.equal(relPath(path.join(repoRoot, "scripts", "smoke-start.mjs")), "scripts/smoke-start.mjs");
  });

  it("audits the suites that run on Windows, smoke scripts included", () => {
    assert.ok(audited.length >= 25, `the audit found only ${audited.length} files — is the walk broken?`);
    for (const expected of [
      "packages/server/test/builtin-tools.test.ts", // the file that flaked
      "packages/server/test/production-readiness-audit.test.ts",
      "packages/desktop/test/server-process.test.ts",
      "scripts/smoke-start.mjs",
      "scripts/smoke-packed-start.mjs",
    ]) {
      assert.ok(audited.some((file) => relPath(file) === expected), `${expected} must be audited`);
    }
    assert.ok(
      !audited.some((file) => path.basename(file) === SELF),
      "the guard must not audit itself: it holds the forbidden pattern as data"
    );
  });

  it("no audited file removes a temp path with a bare fs.rm/rmSync", () => {
    const forbidden = /\.rm(?:Sync)?\(/;
    const violations: string[] = [];
    for (const file of audited) {
      const text = fs.readFileSync(file, "utf8").replace(/\s+/g, " ");
      const match = forbidden.exec(text);
      if (match) violations.push(`${relPath(file)} — ${match[0]}…`);
    }
    assert.deepEqual(
      violations,
      [],
      `temp-path removals in the Windows suites must go through scripts/temp-path.mjs ` +
        `(maxRetries/retryDelay; its header comment records why):\n` +
        violations.join("\n")
    );
  });

  it("the smoke scripts import and use the helper", () => {
    for (const rel of SMOKE_SCRIPTS) {
      const text = fs.readFileSync(path.join(repoRoot, rel), "utf8");
      assert.match(
        text,
        /import \{ removeTempPathSync \} from "\.\/temp-path\.mjs";/,
        `${rel} must import the temp-path helper`
      );
      assert.match(text, /removeTempPathSync\(tmp\)/, `${rel} must remove its temp tree with the helper`);
    }
  });
});
