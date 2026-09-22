# Windows teardown hardening — plan

Picked from the 2026-09-22 handoff plan ("Next steps after v0.1.0"), Step 4
candidate list, first item: *"NEW — Windows teardown hardening (small,
self-contained): add `maxRetries`/`retryDelay` to teardown `fs.rm` removals in
process-spawning test suites (start with
`packages/server/test/builtin-tools.test.ts:46`; audit for the same pattern) …
close the recorded known gap when it lands."*

Branch: `arena/01a0cac5-windowrunner`
Session base: `main` @ `dc604c9` (merge of PR #36)
First PR of the session: #37, the docs-only PR #36 merge record.
This file is committed **before** the implementation, per repo convention.

## The recorded gap this closes

`docs/superpowers/plans/2026-09-22-v0.1.0-release-atomic-status.md`, follow-up
item 9 and the "Windows teardown flake (diagnosed 2026-09-22, not yet
hardened)" known gap:

> test `after` hooks remove temp trees with `fs.rm(..., { recursive: true,
> force: true })` and no `maxRetries`/`retryDelay`; on the Windows runner a
> transient `EBUSY` on `rmdir` fails the whole file as `hookFailed` (observed
> once on PR #36's first run — `builtin-tools.test.ts`; every real assertion
> passed and the same suite was green on main hours earlier).

The observed failure: run
[35768354030](https://github.com/StepenkoAnatoli/WindowRunner/actions/runs/35768354030),
head `f8c1487`, `Platform (windows-latest)`: the whole of
`packages/server/test/builtin-tools.test.ts` marked `failureType:
'hookFailed'` at line 46 — the `after` hook's
`fs.rm(base, { recursive: true, force: true })` raised `EBUSY: resource busy
or locked, rmdir 'C:\Users\runneradmin\AppData\Local\Temp\wr-tools-6bDYgu\project'`
after 4.5 ms — with 380/386 assertions passing (5 skipped) and the same suite
green on `main` hours earlier and on the macOS/Ubuntu legs of the same run.
Node's `rm` only retries transient failures when `maxRetries` is set; its
default is `0`, so one transient Windows handle (a child process still
exiting, an indexer or Defender scan) turns a green suite red — and costs a
full CI cycle to re-run.

## What lands

1. **`scripts/temp-path.mjs`** (+ `scripts/temp-path.d.mts`, the repo's
   `.mjs` + `.d.mts` pattern): the single place test code removes a temp path.
   `removeTempPath(target, rm = fs.rm)` /
   `removeTempPathSync(target)` forward
   `{ recursive: true, force: true, maxRetries: 10, retryDelay: 100 }` —
   the retry options apply to exactly the transient codes (EBUSY, EMFILE,
   ENFILE, ENOTEMPTY, EPERM) and are ignored for real failures, so a
   deterministic failure still throws, after ≤ ~1 s of retries. The `rm`
   parameter is injectable so the guard test can pin the forwarded options.
   Rationale and the incident record live in the module's doc comment.
2. **Every Windows-suite removal goes through it**: 14 server test files
   (`builtin-tools`, `boot`, `file-*` ×3, `metrics-alerts`, `packaging`,
   `production-readiness-audit`, `project-root`, `provider-discovery`,
   `providers-routes`, `security`, `session-manager`, `web-ui` — 57 call
   sites) and 8 desktop test/smoke files (`crash-diagnostics`,
   `electron-smoke`, `main-flow`, `page-smoke`, `paths`,
   `release-contract`, `server-process`, `workspace-catalog` — 11 call
   sites), plus the two smoke scripts that tear down their own temp trees
   (`scripts/smoke-start.mjs`, `scripts/smoke-packed-start.mjs`). Unused
   `node:fs`/`node:fs/promises` imports dropped where the conversion made them
   dead.
3. **`packages/server/test/teardown-hardening.test.ts`**: the guard. Behavioral
   half — the helper removes a tree, tolerates a missing one, works
   synchronously, and forwards the retry options. Static half — an audit of
   every workspace `test/` tree plus the two smoke scripts: any bare
   `fs.rm`/`rmSync` call fails the guard, and the audit asserts its own scope
   (≥ 25 files, the five files/scripts that matter named) so it cannot pass on
   an empty walk.

## Deliberately not changed (reviewed)

| Surface | Why it stays |
| --- | --- |
| `packages/desktop/e2e/*.spec.ts`, `packages/web/e2e/*-server.ts` | Every removal is already `.catch(() => {})`: a failure leaks a temp dir, it cannot fail a hook. The desktop specs do run on Windows; the exemption is the swallow, not the platform. |
| `eval/run.mts`, `eval/validate-provider.mts` | The eval harness runs only in the Linux `CI` job (and locally); Windows `Platform` legs never execute it. |
| `packages/desktop/scripts/copy-assets.mjs` | A build script removing repo-internal staging dirs, not an OS temp tree; its failure is deterministic and loud, not a handle race. |
| `packages/web/test`, `packages/shared/test` | No removals at all (verified by the audit's walk). |

## Acceptance criteria

- `packages/server/test/teardown-hardening.test.ts` passes, including the
  audit over all audited files.
- No bare `fs.rm`/`rmSync` call remains in any workspace `test/` tree or in
  the two smoke scripts.
- The full local gate is green in the corrected order (check:release →
  typecheck → typecheck:desktop → build → build:desktop → test → test:desktop
  → smoke:packed → smoke:packed:start → smoke:start → eval --expect-pass;
  `npm audit --omit=dev --audit-level=high` alongside).
- All nine CI checks green on the PR head; the Windows legs (`Platform
  (windows-latest)`, `Desktop (windows-latest)`) are the point of the stage.
- The v0.1.0 status file's known gap is marked closed with the evidence, and
  the stage's atomic status file records status, commits, files, tests,
  acceptance, security, deviations, known gaps and CI status.

## Risks and mitigations

- **Retry masks a real failure?** No: the retry set is the transient OS codes
  only; a permission error or a genuine bug still throws, just after the
  retries. Bounded: 10 attempts × 100 ms.
- **The audit is textual.** It flags `.rm(`/`.rmSync(` anywhere in an audited
  file, comments included. That is deliberate: the helper is the escape hatch,
  and the alternative (parsing) would be more code than the fix.
- **Cross-package import path.** The helper lives at the repo root
  (`scripts/`), imported as `../../../scripts/temp-path.mjs` from package test
  trees — the same pattern `packages/desktop/test/release-contract.test.ts`
  already uses for `scripts/check-release.mjs`. Verified by both typechecks.
- **No production code touched.** Nothing in `packages/*/src` changes; the
  shipped bundle is unaffected, so no release artifacts are re-cut.

## Verification plan

1. Baseline: full local gate on a clean tree at `dc604c9` (recorded in the
   status file).
2. After the change: full local gate again, with the log kept for the record.
3. CI: nine checks on the PR head; the Windows legs exercise the converted
   suites and the smoke scripts end to end.
