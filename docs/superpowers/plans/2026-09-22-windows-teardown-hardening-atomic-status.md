# Windows teardown hardening — atomic status

Durable record of the stage that closed the Windows teardown flake — the known
gap recorded in
`docs/superpowers/plans/2026-09-22-v0.1.0-release-atomic-status.md` (follow-up
item 9, "Windows teardown flake (diagnosed 2026-09-22, not yet hardened)").
Chat history is not durable — this file is.

Branch: `arena/01a0cac5-windowrunner`
Session base: `main` @ `dc604c9` (merge of PR #36)
This session's first PR: #37 (the PR #36 merge record) → `main` @ `cf40253`
Plan: `docs/superpowers/plans/2026-09-22-windows-teardown-hardening.md`

## Status

**Implemented, full local gate green, PR open.** The fix, the audit that keeps
it fixed, and the stage's paperwork are done and locally verified; the nine CI
checks on the head commit are the remaining merge gate, and the post-merge
`main` run is verified by the next session — per repo precedent a status PR
cannot contain its own final-head run.

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

## Commits

```text
37cb67f — docs(status): record the PR #36 merge and post-merge runs   (PR #37 → cf40253)
58c62e2 — docs(plan): define the Windows teardown hardening
394c6b9 — fix(test): retry transient Windows failures when removing test temp paths
<this>  — docs(status): record the Windows teardown hardening
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
| `npm test` — after | pass, **633/633** (shared 9/9, server 391/391 incl. the 6 new guard tests, web 233/233) |
| `npm test` — baseline (clean tree) | pass, all suites (the guard test did not exist yet) |
| `npm run test:desktop` | pass — 69/69 (baseline: 69/69) |
| `npm run smoke:packed` | pass — 148 entries, unchanged |
| `npm run smoke:packed:start` | pass (boots the packed tarball) |
| `npm run smoke:start` | pass (turn, restart, SIGTERM, token, origins) |
| `npm run eval -- --expect-pass` | pass — 5/5 |
| `npm audit --omit=dev --audit-level=high` | pass (0 vulnerabilities) |
| `packages/server/test/teardown-hardening.test.ts` | pass — 6/6 (run solo during development too) |
| Guard vs. an injected regression | pass — restoring `fs.rm(dir, { recursive: true, force: true })` in `boot.test.ts` fails the audit with `packages/server/test/boot.test.ts — .rm(…` (5 pass, 1 fail); the injection was reverted and the tree is clean |
| Windows legs / Electron / browser | executed by CI only (sandbox limitation, as in B3/B4/B5) |

## Acceptance criteria (from the plan)

- Guard test passes, audit included: **pass** (6/6 locally).
- No bare `fs.rm`/`rmSync` call left in any workspace `test/` tree or in the
  two smoke scripts: **pass** (`grep` returns nothing; the guard fails if it
  ever does again).
- Full local gate green in the corrected order: **pass** (baseline and
  after-fix, 12/12 steps each).
- All nine CI checks green on the PR head: **pending** — the head is
  `<head>`; the run is recorded below and in the PR body.
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

- **The retry path itself has no deterministic Windows test.** Node performs
  the retries, so what the guard can prove is that the helper forwards
  `maxRetries`/`retryDelay` (injected `rm`) and that nothing bypasses it. The
  end-to-end proof is the Windows legs staying green on a tree whose removals
  all go through the helper.
- **Residual flake risk is real but bounded.** A temp tree genuinely held
  (for example by a child process that never exits) still fails the hook after
  the retries — correct behavior, since that is a leak rather than a race.
  This stage does not add child-process fencing to every suite; the retries
  cover the observed class.
- Standing items from the v0.1.0 record, unchanged: F-03 (production signing
  certificate) open, owner action; auto-update gated on the certificate plus a
  real feed; P1-01/P1-02/P1-03 residual, P1-04, G-05, installer fresh-clone and
  interactive modes; branch protection deferred to project end by owner
  decision.
- No release is re-cut for this stage: it is test-only, and `v0.1.0` remains
  the published artifact.

## CI status

| Run | Commit | Result | What |
| --- | --- | --- | --- |
| 35780220041 | `37cb67f` (PR #37) | 9/9 GREEN | PR #36 merge record — merge gate satisfied, merged as `cf40253` |
| 35781014810 | `cf40253` | pending | post-merge main, PR #37 — verified by the next session |
| (this PR) | `<head>` | pending | nine checks on the head commit |

## Verdict

**GO — the Windows teardown flake is fixed and guarded locally; the nine CI
checks are the merge gate.** The stage closed the recorded known gap with a
single shared helper, converted every removal that runs on Windows, and pinned
the pattern so a new suite cannot reintroduce it. Nothing in this stage is a
STOP; the remaining inputs are the same owner actions and candidate stages the
v0.1.0 record lists.
