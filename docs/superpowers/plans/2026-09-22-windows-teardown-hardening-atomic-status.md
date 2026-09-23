# Windows teardown hardening — atomic status

Durable record of the stage that closed the Windows teardown flake — the known
gap recorded in
`docs/superpowers/plans/2026-09-22-v0.1.0-release-atomic-status.md` (follow-up
item 9, "Windows teardown flake (diagnosed 2026-09-22, not yet hardened)").
Chat history is not durable — this file is.

Branch: `arena/01a0cac5-windowrunner`
Session base: `main` @ `dc604c9` (merge of PR #36)
This session's first PR: #37 (the PR #36 merge record) → `main` @ `cf40253`
This session's stage PR: #38 (the hardening) → `main` @ `95a50dd`
Plan: `docs/superpowers/plans/2026-09-22-windows-teardown-hardening.md`

> **CLOSING NOTE — 2026-09-22: PR #38 is merged and both of its runs are
> green.** The final head `6a724f5` ("fix(test): normalize repo-relative
> paths in the teardown audit") ran all nine checks green — run
> [35782302977](https://github.com/StepenkoAnatoli/WindowRunner/actions/runs/35782302977),
> 20:45:02Z → 20:52:19Z — `Platform (windows-latest)` included, the leg that
> failed round 1. PR #38 merged into `main` as
> `95a50dd61336d2b848e335ac4825623ea4609410` at 2026-09-22T20:52:41Z, and the
> post-merge `main` run
> [35783116241](https://github.com/StepenkoAnatoli/WindowRunner/actions/runs/35783116241),
> 20:52:44Z → 20:59:39Z, is 9/9 green on the merge commit. Recorded by the
> next session (branch `arena/01a0ccba-windowrunner`) — per repo precedent a
> status PR cannot contain its own final-head run, so this amendment is the
> durable home for both. Both runs are rows in "CI status"; the evidence is
> "What happened" item 9. `v0.1.0` is untouched: still Latest, four assets,
> published 18:30:22Z, tag still `e06c191`.

## Status

**Merged and verified — the recorded known gap is closed on `main`.** The fix,
the audit that keeps it fixed and the stage's paperwork are done and locally
verified; CI round 1 came back 8/9 — `Platform (windows-latest)` failed the
*new guard itself* (a POSIX-only path comparison, invisible on Linux) — and the
fix plus a regression pin went in. Round 2 on the final head `6a724f5` was
**9/9** (run 35782302977), PR #38 merged as `95a50dd`, and the post-merge
`main` run 35783116241 is **9/9** on that merge commit. The authoring session
could not record those two runs itself — a status PR cannot contain its own
final-head run — so the closing note and item 9 below are that record, added
by the next session.

## What happened, in order

1. **Handoff state verified (handoff Step 1).** `main` was still `dc604c9`
   (merge of PR #36, 2026-09-22T18:58:16Z) with the post-merge run
   [35770712580](https://github.com/StepenkoAnatoli/WindowRunner/actions/runs/35770712580)
   9/9 green; PR #36's own final-head run 35769688533 was 9/9. The `v0.1.0`
   release page still rendered its changelog notes, the UNSIGNED banner and
   the checksums byte-identical to the `SHA256SUMS.txt` sidecar
   (`d7192d5e…`/`2283c121…`/`a19262cc…`), four named assets unchanged, still
   Latest, tag still `e06c191`.
2. **PR #37 — the PR #36 merge record (handoff Step 2).** Docs-only
   amendment of the v0.1.0 status file (closing note, Status, CI table rows,
   follow-up item 10, verdict addendum) recording the merge commit, both
   green runs and the re-verified release state. Run
   [35780220041](https://github.com/StepenkoAnatoli/WindowRunner/actions/runs/35780220041)
   — **9/9 green** on head `37cb67f` (`Platform (windows-latest)` 3m30s,
   `Desktop installer` 3m46s, `Desktop signing` 2m0s, `Platform (macos-latest)`
   3m27s, `Desktop (ubuntu-latest)` 1m29s, `Desktop (windows-latest)` 1m13s,
   `Browser E2E` 1m12s, `CI` 1m35s, `Docker` 26s); merged as
   `cf40253a866128c34b04a73cd05f3479bf4a4dc2` at 2026-09-22T20:32:58Z — the
   merge gate was satisfied on the head commit.
3. **Baseline recorded before any change.** `npm ci` (with
   `ELECTRON_SKIP_BINARY_DOWNLOAD=1`, 380 packages, 0 vulnerabilities,
   `postinstall` verified 4 workspaces) then the full local gate on a clean
   tree at `dc604c9`, in the corrected order: check:release, typecheck,
   typecheck:desktop, build, build:desktop, test, test:desktop,
   smoke:packed, smoke:packed:start, smoke:start, eval --expect-pass, audit —
   12/12 steps green (`test:desktop` 69/69, smokes passed, eval 5/5, audit 0
   vulnerabilities).
4. **The fix (handoff Step 4, first candidate).** `scripts/temp-path.mjs`
   (+ `scripts/temp-path.d.mts`) is now the only place test code removes a
   temp path: `removeTempPath` / `removeTempPathSync` forward
   `{ recursive: true, force: true, maxRetries: 10, retryDelay: 100 }`.
   Node applies those retries to exactly the transient codes (EBUSY, EMFILE,
   ENFILE, ENOTEMPTY, EPERM) and ignores them otherwise, so a deterministic
   failure still throws — after ≤ ~1 s of retries — while the observed flake
   (one transient `EBUSY` on a temp tree whose last handle Windows has not
   released yet) is absorbed.
5. **Every Windows-suite removal converted** (the handoff's "audit for the
   same pattern"): 14 server test files / 57 call sites, 8 desktop test and
   smoke files / 11 call sites, and the two smoke scripts that tear down their
   own temp trees (`scripts/smoke-start.mjs`, `scripts/smoke-packed-start.mjs`)
   — 70 call sites in total. Dead `node:fs`/`node:fs/promises` imports were
   dropped where the conversion removed their last use.
6. **The audit that keeps it fixed.**
   `packages/server/test/teardown-hardening.test.ts` (6 tests) pins both
   halves: the behavioral one (the helper removes a tree, tolerates a missing
   path, works synchronously, and forwards the retry options — verified with
   an injected `rm`, so it does not race a real `EBUSY`) and the static one
   (any `fs.rm`/`rmSync` call in a workspace `test/` tree or in the two smoke
   scripts fails the guard, and the guard asserts its own scope — ≥ 25 audited
   files plus the five files/scripts that matter — so an empty walk cannot
   pass).
7. **After-fix local gate green**, same 12 steps, log retained
   (`/home/user/wr-gate-after.log` in the authoring sandbox; the counts are in
   "Tests" below). The packed tarball is unchanged by this stage: 148 entries,
   2,862,509 bytes unpacked — identical to the baseline run.
8. **CI round 1 (head `4cb00c4`) — 8/9, and the one red leg was the new guard
   itself.** Run
   [35781156495](https://github.com/StepenkoAnatoli/WindowRunner/actions/runs/35781156495):
   eight legs green (`CI` 1m37s, `Browser E2E` 1m13s, `Docker` 29s, `Platform
   (macos-latest)` 2m11s, `Desktop (ubuntu-latest)` 1m26s, `Desktop
   (windows-latest)` 1m11s, `Desktop installer` 4m43s, `Desktop signing`
   1m48s), `Platform (windows-latest)` failed its `Test` step in 1m48s.
   Diagnosis path (per the repo's sandbox technique): the job's step list via
   `actions/jobs/{id}` — only `Test` failed, every smoke/installer step
   skipped behind it — then the check-run annotations, which named exactly one
   failing test: `not ok 99 - teardown hardening: the audit` →
   `not ok 1 - audits the suites that run on Windows, smoke scripts
   included`. (The diagnostics artifact could not be downloaded — the
   blob host is network-blocked in the authoring sandbox, as recorded in the
   v0.1.0 file's Deviations — so the annotations carried the evidence.)
   **Root cause: the audit compared `path.relative()` output, which uses
   backslashes on Windows (`packages\server\test\builtin-tools.test.ts`),
   against POSIX-style expectations. Every converted suite passed on Windows;
   the guard was the only casualty — a defect in the new test, not in the
   fix.** Resolution: a `toPosix()` normalization applied to every comparison
   in the guard, plus an explicit regression pin that feeds it a backslashed
   path, because the mismatch is invisible on Linux and macOS. Re-verified
   locally (guard 7/7, typechecks, suites). The fix commit creates the final
   head, which re-runs the full matrix fresh — the merge gate.
9. **Round 2 green, PR #38 merged, post-merge `main` green (recorded by the
   next session, 2026-09-22).** The final head `6a724f5` ran the full matrix
   fresh: run
   [35782302977](https://github.com/StepenkoAnatoli/WindowRunner/actions/runs/35782302977)
   (`pull_request`), 20:45:02Z → 20:52:19Z, **9/9 green** — `CI`, `Browser
   E2E`, `Docker`, `Platform (windows-latest)`, `Platform (macos-latest)`,
   `Desktop (ubuntu-latest)`, `Desktop (windows-latest)`, `Desktop installer
   (windows-latest)`, `Desktop signing (windows-latest)`. `Platform
   (windows-latest)` — the round-1 casualty — passed, so the converted suites,
   the guard and the two smoke scripts all run green on Windows; the merge gate
   was satisfied on the head commit. PR #38 merged as
   `95a50dd61336d2b848e335ac4825623ea4609410` at 2026-09-22T20:52:41Z, and the
   post-merge `main` run
   [35783116241](https://github.com/StepenkoAnatoli/WindowRunner/actions/runs/35783116241)
   (`push`), 20:52:44Z → 20:59:39Z, is **9/9 green on the merge commit** —
   the same nine legs. **How this was verified (two independent sources):**
   the run/job API — nine jobs, nine `success` conclusions on each run — and
   the public check-runs API on each commit (`6a724f5` and `95a50dd`):
   `total_count: 9`, all nine `status: completed` / `conclusion: success`. The
   local clone corroborates the merge: `95a50dd`'s parents are `cf40253` and
   `6a724f5`. Handoff state re-checked at the same time: `main` is at
   `95a50dd`, and the `v0.1.0` release is unchanged — still Latest, not a
   draft, four assets, published 2026-09-22T18:30:22Z, tag `v0.1.0` still
   pointing at `e06c191`. **What this amendment does not re-derive:** the
   per-leg seconds quoted in PR #38's body (`Platform (windows-latest)` 3m12s,
   `Desktop installer` 4m4s, and so on) — this sandbox's API returns empty
   step timestamps and zero billable durations, so the amendment re-verified
   the run windows (`run_duration_ms` 437000 and 415000, matching the
   wall-clock spans above) and the conclusions, not the per-leg seconds.
   **Docs touched by this amendment:** this file, plus the v0.1.0 record's
   CLOSED entry and its verdict addendum, which now name the merge and both
   runs — so the two records cannot drift apart on whether the gap is closed.

## Commits

```text
37cb67f — docs(status): record the PR #36 merge and post-merge runs   (PR #37 → cf40253)
58c62e2 — docs(plan): define the Windows teardown hardening
394c6b9 — fix(test): retry transient Windows failures when removing test temp paths
4cb00c4 — docs(status): record the Windows teardown hardening
6a724f5 — fix(test): normalize repo-relative paths in the teardown audit   ← final head, 9/9
          └─ PR #38 merged as 95a50dd (parents cf40253 + 6a724f5) at 2026-09-22T20:52:41Z
<this>  — docs(status): record the PR #38 merge and post-merge runs   ← this amendment
```

## Files changed

New:

- `scripts/temp-path.mjs` — the retrying removal helper (incident record and
  rationale in the module doc comment).
- `scripts/temp-path.d.mts` — its types (the repo's `.mjs` + `.d.mts` pattern
  for scripts consumed by TypeScript tests; `rm` is injectable for the guard).
- `packages/server/test/teardown-hardening.test.ts` — the guard (behavioral
  pins + the static audit).
- `docs/superpowers/plans/2026-09-22-windows-teardown-hardening.md` — the plan.
- `docs/superpowers/plans/2026-09-22-windows-teardown-hardening-atomic-status.md`
  — this file.

Converted (one import added, removals routed through the helper):

- server: `boot`, `builtin-tools`, `file-persistence-integration`,
  `file-session-store`, `file-turn-log-store`, `metrics-alerts`, `packaging`,
  `production-readiness-audit`, `project-root`, `provider-discovery`,
  `providers-routes`, `security`, `session-manager`, `web-ui` (`test/`).
- desktop: `crash-diagnostics`, `electron-smoke`, `main-flow`, `page-smoke`,
  `paths`, `release-contract`, `server-process`, `workspace-catalog` (`test/`).
- `scripts/smoke-start.mjs`, `scripts/smoke-packed-start.mjs`.

Also updated: `docs/superpowers/plans/2026-09-22-v0.1.0-release-atomic-status.md`
— the "Windows teardown flake" known gap is marked closed with a pointer here
(the follow-up item 9 text is left as written, as history).

Deliberately unchanged (reviewed, recorded in the plan's table): the
Playwright specs and web e2e server helpers (their removals already
`.catch(() => {})`, so a failure leaks a temp dir but cannot fail a hook),
`eval/` (Linux-only `CI` job), and `packages/desktop/scripts/copy-assets.mjs`
(build script removing repo-internal staging dirs).

## Tests

| Check | Result |
| --- | --- |
| `npm run check:release` | pass (version 0.1.0) |
| `npm run typecheck` (shared, server, web) | pass |
| `npm run typecheck:desktop` | pass (3 tsconfigs) |
| `npm run build` / `npm run build:desktop` | pass |
| `npm test` — after | pass, **634/634** (shared 9/9, server 392/392 incl. the 7 guard tests — the 6 initial ones plus the path-normalization pin added after CI round 1 — web 233/233) |
| `npm test` — baseline (clean tree) | pass, all suites (the guard test did not exist yet) |
| `npm run test:desktop` | pass — 69/69 (baseline: 69/69) |
| `npm run smoke:packed` | pass — 148 entries, unchanged |
| `npm run smoke:packed:start` | pass (boots the packed tarball) |
| `npm run smoke:start` | pass (turn, restart, SIGTERM, token, origins) |
| `npm run eval -- --expect-pass` | pass — 5/5 |
| `npm audit --omit=dev --audit-level=high` | pass (0 vulnerabilities) |
| `packages/server/test/teardown-hardening.test.ts` | pass — 7/7 (run solo during development too) |
| Guard vs. an injected regression | pass — restoring `fs.rm(dir, { recursive: true, force: true })` in `boot.test.ts` fails the audit with `packages/server/test/boot.test.ts — .rm(…` (5 pass, 1 fail); the injection was reverted and the tree is clean |
| Guard vs. the round-1 Windows defect | pass — the `toPosix` pin feeds the normalizer a backslashed path (`packages\server\...`), the exact shape `path.relative` returns on Windows; it fails against the pre-fix comparison on any platform |
| CI round 1 (Windows leg) | **fail, diagnosed** — the guard, not the fix (see item 8); eight legs green, including every converted suite on Windows |
| CI round 2 (final head `6a724f5`) | **pass — 9/9** (run 35782302977, 20:45:02Z → 20:52:19Z): `Platform (windows-latest)` green with the guard, the converted suites and both smoke scripts on that leg; the post-merge `main` run 35783116241 is 9/9 on `95a50dd` (item 9) |
| Windows legs / Electron / browser | executed by CI only (sandbox limitation, as in B3/B4/B5) |

## Acceptance criteria (from the plan)

- Guard test passes, audit included: **pass** (7/7 locally; round 1 proved the
  audit runs on Windows too — it failed there for a path-separator bug in the
  guard itself, now fixed and pinned).
- No bare `fs.rm`/`rmSync` call left in any workspace `test/` tree or in the
  two smoke scripts: **pass** (`grep` returns nothing; the guard fails if it
  ever does again).
- Full local gate green in the corrected order: **pass** (baseline and
  after-fix, 12/12 steps each).
- All nine CI checks green on the PR head: **pass** — round 1 (`4cb00c4`) was
  8/9 with the guard's Windows defect; the final head `6a724f5` ran **9/9**
  (run 35782302977), PR #38 merged as `95a50dd`, and the post-merge `main` run
  35783116241 is **9/9** on the merge commit. Verified in item 9; both are rows
  in "CI status".
- v0.1.0 status file's known gap closed with the evidence + this record:
  **pass**.

## Security checks

- No secrets, no credential handling, no workflow permission changes; no
  production code touched (`packages/*/src` untouched), so no shipped artifact
  changes — the packed tarball is entry- and byte-identical to the baseline
  (148 entries, 2,862,509 bytes) and `v0.1.0` stays exactly as published.
- The new helper is dev/test tooling and is **not** published: the root
  `files[]` allowlist ships only `scripts/postinstall.mjs` and
  `scripts/ensure-built.mjs`, which `smoke:packed` re-verified.
- The audit reads files only; it adds no network, filesystem-write or process
  surface to the suites.
- Signing, release workflow and branch-protection status are untouched by this
  stage (F-03 remains the only open Medium; branch protection stays deferred
  to project end by owner decision).

## Deviations

- **Scope of the fix.** The handoff suggested starting at
  `builtin-tools.test.ts:46` and auditing "process-spawning test suites"; the
  audit found the same pattern in every workspace `test/` tree and in the two
  smoke scripts, so the stage converts all of them through one helper rather
  than patching the one suite. The guard makes the pattern a contract instead
  of a convention.
- **The helper lives at the repo root** (`scripts/temp-path.mjs`) instead of
  inside one package: the server suite, the desktop suite and the smoke
  scripts all need it, and the `.mjs` + `.d.mts` pattern for scripts imported
  by TypeScript tests already exists (`release-contract.test.ts` imports three
  of them). Both package typechecks confirm the imports resolve.
- **The audit is textual and absolute** — any `fs.rm`/`rmSync` call in an
  audited file fails it, comments included. Deliberate: it also catches
  single-file removals (the same Windows handle race applies), and the escape
  hatch is simply to use the helper. The exemptions are named in the guard's
  doc comment, not silent.
- **No CHANGELOG entry.** This is test/dev infrastructure; the repo's
  changelog tracks user-facing changes (B5's CI fixes are absent from it too),
  and `check:release` does not ask for one.
- **Order of the handoff's steps.** Step 2 (PR #37, docs-only) landed before
  Step 4's stage, because the merge-gate rule makes a status PR the last thing
  a session can merge and because that record was the previous session's
  unfinished bookkeeping.
- **A first baseline attempt failed** — it is not in this record's tables
  because nothing was wrong with the tree: it caught the authoring probe left
  in `packages/server/test/` (`__probe_import.ts`, TS2305) used to verify the
  `.mjs` + `.d.mts` import pattern under the server tsconfig before building
  the real helper. The probe was deleted and the baseline was re-run clean.
  The probe's answer: the pattern resolves in `moduleResolution: bundler` too.

## Known gaps

- **A CI round was needed to catch a defect in the guard.** The
  path-separator bug (item 8) cannot fail locally — it only shows on Windows —
  so this stage's CI evidence is two rounds rather than one, and the fix
  carries a regression pin instead of relying on a lucky re-run. Worth
  remembering: a Linux-green guard that reads paths is not yet a Windows-green
  guard.
- **The retry path itself has no deterministic Windows test.** Node performs
  the retries, so what the guard can prove is that the helper forwards
  `maxRetries`/`retryDelay` (injected `rm`) and that nothing bypasses it. The
  end-to-end proof is the Windows legs staying green on a tree whose removals
  all go through the helper — now on record for two runs (35782302977 on the
  final head, 35783116241 on the merge commit), each with `Platform
  (windows-latest)` and `Desktop (windows-latest)` green.
- **Residual flake risk is real but bounded.** A temp tree genuinely held
  (for example by a child process that never exits) still fails the hook after
  the retries — correct behavior, since that is a leak rather than a race.
  This stage does not add child-process fencing to every suite; the retries
  cover the observed class.
- **The remaining queue** — unchanged from the v0.1.0 record, whose "Windows
  teardown flake" gap now reads **CLOSED**: auto-update (gated on the
  production certificate *and* a real published feed), P1-01/P1-02/P1-03
  residual, P1-04, G-05 (npm publication), and the installer fresh-clone and
  interactive modes. F-03 (the certificate) and branch protection stay exactly
  as the v0.1.0 record has them — an owner action, and deliberately deferred to
  project end by owner decision — so neither is something this queue can pick
  up as a stage on its own.
- No release is re-cut for this stage: it is test-only, and `v0.1.0` remains
  the published artifact — re-verified at the amendment: still Latest, not a
  draft, four assets, published 2026-09-22T18:30:22Z, tag `v0.1.0` still at
  `e06c191`.

## CI status

| Run | Commit | Result | What |
| --- | --- | --- | --- |
| 35780220041 | `37cb67f` (PR #37) | 9/9 GREEN | PR #36 merge record — merge gate satisfied, merged as `cf40253` |
| 35781014810 | `cf40253` | **9/9 GREEN** | post-merge main, PR #37 (20:33:01Z → 20:39:45Z) — the PR #36 bookkeeping is closed out |
| 35781156495 | `4cb00c4` (PR #38, round 1) | 8/9 + diagnosed | `Platform (windows-latest)` failed the new guard's path comparison (item 8); both Windows legs of the *converted* suites were otherwise green; fix + pin added |
| 35782302977 | `6a724f5` (PR #38, round 2 — **final head**) | **9/9 GREEN** | the merge gate, satisfied: 20:45:02Z → 20:52:19Z, nine jobs `success`, `Platform (windows-latest)` green (the round-1 leg); check-runs API on the commit `total_count: 9`, all `success` — merged as `95a50dd` (item 9) |
| 35783116241 | `95a50dd` | **9/9 GREEN** | post-merge main, PR #38 (20:52:44Z → 20:59:39Z) — the same nine legs green on the merge commit; the stage's bookkeeping is closed out (item 9) |

## Verdict

**GO — the Windows teardown flake is fixed, guarded, merged and verified.** CI
round 1's red leg was the guard itself (diagnosed, fixed, pinned); the final
head `6a724f5` then ran **9/9** (run 35782302977), PR #38 merged as `95a50dd`,
and the post-merge `main` run 35783116241 is **9/9** on the merge commit — the
merge gate was satisfied on the head commit and the fix is on `main`. The stage
closed the recorded known gap with a single shared helper, converted every
removal that runs on Windows, and pinned the pattern so a new suite cannot
reintroduce it. Nothing in this stage is a STOP; the remaining inputs are the
same owner actions and candidate stages the v0.1.0 record lists — auto-update
(gated on the certificate plus a real feed), P1-01/P1-02/P1-03 residual,
P1-04, G-05, and the installer fresh-clone and interactive modes.
