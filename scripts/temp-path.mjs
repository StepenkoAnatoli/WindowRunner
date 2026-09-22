/**
 * windows-runner — Windows-safe removal of test temp paths.
 *
 * Test teardown used to call `fs.rm(dir, { recursive: true, force: true })`
 * directly everywhere. Node only retries transient removal failures when
 * `maxRetries` is set, and its default is 0 — so a single `EBUSY: resource
 * busy or locked, rmdir` (Windows briefly holding a handle on a temp tree
 * after a child process exits, or while an indexer/Defender scan runs) is
 * fatal, and `node:test` fails the whole file's hook rather than any
 * assertion.
 *
 * Observed once, on PR #36's first run (2026-09-22): the Windows `Platform`
 * leg failed all of `packages/server/test/builtin-tools.test.ts` as
 * `hookFailed` after 4.5 ms — `EBUSY … rmdir …\Temp\wr-tools-XXXX\project`
 * from its `after` hook — with every real assertion passing (380/386, 5
 * skipped). Diagnosis and decision:
 * `docs/superpowers/plans/2026-09-22-v0.1.0-release-atomic-status.md`
 * follow-up item 9; the fix, its audit and its evidence:
 * `docs/superpowers/plans/2026-09-22-windows-teardown-hardening-atomic-status.md`.
 *
 * `maxRetries`/`retryDelay` apply to exactly the transient codes (EBUSY,
 * EMFILE, ENFILE, ENOTEMPTY, EPERM) and are ignored for real failures, so a
 * deterministic failure still throws — just after up to 10 attempts spaced
 * 100 ms apart (≤ ~1 s of extra delay in the flaky case).
 *
 * This is the only place test code may remove a temp path; the audit in
 * `packages/server/test/teardown-hardening.test.ts` fails if a suite goes back
 * to a bare `fs.rm`/`rmSync` call.
 */

import * as fs from "node:fs/promises";
import { rmSync } from "node:fs";

export const TEMP_PATH_RM_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 100,
};

/**
 * Removes a test temp path — a tree (the common case) or a single file under
 * one — retrying transient Windows failures.
 *
 * `rm` is injectable so the teardown-hardening test can pin the options this
 * helper forwards without racing a real `EBUSY`.
 */
export async function removeTempPath(target, rm = fs.rm) {
  await rm(target, TEMP_PATH_RM_OPTIONS);
}

/** The synchronous twin, for the smoke scripts' `finally` teardown. */
export function removeTempPathSync(target) {
  rmSync(target, TEMP_PATH_RM_OPTIONS);
}
