# B5 atomic checklist — phase status

Durable progress record for B5 (release hardening). Chat history is not
durable — this file is. Updated at every B5 stop point.

Branch: `arena/01a0c893-windowrunner`
Base: `main` @ `75380d6b106fbb007797dfbc339f828dc11fd339` (merge of PR #31, B4)
Plan: `docs/superpowers/plans/2026-09-22-b5-release-hardening.md`

## Status

B5.0–B5.9 implemented; full local gate green. Pushed and opened as a PR; the
nine CI checks (eight existing + the new `Desktop signing`) are the remaining
gate before merge. The verdict below flips to GO once they are green on the
head commit.

## Commits

```text
0a3bb8a — docs(plan): define B5 release hardening
52a8d1c — docs(release): add the changelog
3d923ae — feat(release): enforce version and changelog consistency
8ebff26 — feat(desktop): wire env-driven code signing with a fail-loud release build
8a5d400 — feat(release): publish SHA-256 checksums and document installer trust
6887fcc — docs(status): record B5.1-B5.4
280c26b — feat(desktop): add local crash diagnostics with retention
b8851f0 — ci(desktop): verify in-place upgrade and data-surviving uninstall
2f67d5c — feat(release): tag-driven draft releases with checksums and changelog notes
34fb94d — docs(security): add the reporting policy and the B5 security review
(this commit) — docs + gate: B5.9 final docs, AGENTS/README, this status
```

## Files changed

- New: `scripts/check-release.mjs` (+ `.d.mts`), `scripts/checksums.mjs`
  (+ `.d.mts`), `scripts/release-notes.mjs` (+ `.d.mts`), `CHANGELOG.md`,
  `SECURITY.md`, `.github/workflows/release.yml`,
  `packages/desktop/src/crash-diagnostics.ts`,
  `packages/desktop/test/crash-diagnostics.test.ts`,
  `packages/desktop/test/release-contract.test.ts`,
  `packages/desktop/e2e/upgrade.spec.ts`,
  `docs/research/2026-09-22-b5-security-review.md`.
- Changed: `.github/workflows/ci.yml` (release gate + audit step, checksums
  step, nine-check header, `Desktop signing` job, installer-job
  install→upgrade→uninstall restructure, inventory + diagnostics),
  `packages/desktop/electron-builder.yml` (signtoolOptions + credential
  contract), `packages/desktop/src/main.ts` (crash wiring),
  `packages/desktop/src/paths.ts` (`crashesDir`), root + desktop
  `package.json` (scripts, exact electron-builder pin), desktop test files
  (stub, main-flow, packaging, electron-smoke), `AGENTS.md`, `README.md`,
  `docs/INSTALL.md`, `RELEASE_CHECKLIST.md`.

## Behavior now verified

- **Versioning (B5.1):** root `package.json` is the single version source;
  `npm run check:release` asserts valid semver + all four workspaces match
  (0.1.0 today); `--require-version vX.Y.Z` binds a release tag to the tree
  (both match and mismatch executed locally). CI runs the gate (pinned by
  contract test).
- **Changelog (B5.2):** Keep a Changelog format; the gate validates heading
  shape, real ISO dates (rejects 2026-02-30), canonical sections only, no
  duplicates, newest-first order, `[Unreleased]` first/dateless, and newest
  section == shipped version — each rejection covered by a unit test.
- **Code signing (B5.3):** env-driven (`WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`,
  PFX path/URL/base64; absent → unsigned build stays green); SHA-256 only;
  `package:desktop:win:release` adds `forceCodeSigning` (enforced by
  electron-builder 26 `winPackager` — verified in the installed dependency
  source); electron-builder pinned exactly (26.15.3). The CI
  `Desktop signing (windows-latest)` job proves the pipeline every PR:
  self-signed CodeSigningCert → PFX (the exact production secret shape) →
  `Get-AuthenticodeSignature` asserts the app exe and installer are signed by
  the expected subject (not `NotSigned`); test-signed artifacts are
  failure-only uploads (test-pinned). Timestamp-free proof
  (`ELECTRON_BUILDER_OFFLINE=true`) so no external service is in the gate.
- **Installer trust (B5.4):** `scripts/checksums.mjs` produces a
  `sha256sum -c`-compatible `SHA256SUMS.txt` (verified end to end locally with
  `sha256sum -c`; duplicate basenames refused); the installer CI job ships it
  with the `windowrunner-installer` artifact. docs/INSTALL.md documents the
  honest SmartScreen status ("More info → Run anyway"), how signing turns on
  (two repo secrets, zero code changes), OV-reputation vs EV-instant-trust,
  `Get-FileHash`/`certutil`/`sha256sum -c` verification, and the official
  download sources (GitHub Releases, npm tarball).
- **Crash diagnostics (B5.5):** Crashpad minidumps local-only
  (`uploadToServer: false`, no submitURL, dumps in `<userData>/crashes`);
  redacted bounded `logs/crash-*.log` records (token scrubbed, 8 KiB details
  cap, tmp-then-rename); retention 20 logs / 10 dumps pruned at boot;
  `logs/README.txt` privacy note; `unhandledRejection` recorded but
  non-fatal; `render-process-gone` reloads once then fatal; fatal dialogs
  name the crash file. Unit tests (10), electron-stub main-flow wiring
  assertions, and a CI electron-smoke proof that a synthetic main-process
  unhandled rejection produces a redacted crash log while the app stays
  alive.
- **Upgrade/uninstall (B5.6):** installer CI job now: build vCur → silent
  install → full installed-app e2e → upgrade phase A seeds a real project +
  session + completed turn at the REAL `%APPDATA%\WindowRunner` → build a
  patch-bumped installer (`-c.extraMetadata.version`, separate output dir) →
  silent install over the old one → exe `ProductVersion` asserted → upgrade
  phase B proves catalog/session/turn survived and a fresh turn completes →
  silent uninstall asserts the exe is gone AND the catalog file survives
  (`deleteAppDataOnUninstall: false` finally verified). The upgrade spec
  self-skips outside this job; pinned in the desktop contract inventory.
- **Release artifacts (B5.7):** tag-driven `release.yml`: guard (tag↔tree↔
  changelog binding + unit tests) → CLI tarball (packed smokes) → installer
  (production-secret signing with forceCodeSigning, or explicitly-unsigned
  with a warning banner; install → e2e → uninstall inside the workflow) →
  DRAFT GitHub Release with installer, tarball, `latest.yml`, blockmap,
  `SHA256SUMS.txt` and changelog-derived notes (`scripts/release-notes.mjs`).
  Minimal permissions (`contents: write` only on the publishing job);
  secrets never interpolated into shell code (programmatically verified).
  Release-cutting procedure documented in RELEASE_CHECKLIST.md.
- **Security review (B5.8):** `SECURITY.md` (private-vulnerability-reporting
  path — verified enabled on the repo; trust model; out-of-scope) and the
  adversarial review `docs/research/2026-09-22-b5-security-review.md` with
  executed checks, findings F-01..F-05 (none above Medium, all dispositioned)
  and owned outstanding items. CI gains `npm audit --omit=dev
  --audit-level=high` (0 vulnerabilities today; zero runtime npm deps — now
  enforced, not assumed).

## Tests

| Check | Result |
| --- | --- |
| `npm run check:release` | pass |
| `npm run typecheck` (shared + server + web) | pass |
| `npm run typecheck:desktop` (3 tsconfigs) | pass |
| `npm test` | pass — 627/627 (shared 9, server 385, web 233) |
| `npm run test:desktop` | pass — 67/67 (30 baseline + 37 new B5 contract/unit) |
| `npm run build` + `npm run build:desktop` | pass |
| `npm run smoke:packed` | pass |
| `npm run smoke:packed:start` | pass |
| `npm run smoke:start` | pass |
| `npm run eval -- --expect-pass` | pass (5/5) |
| `npm run smoke:page --workspace packages/desktop` | pass (3/3) |
| `npm audit --omit=dev --audit-level=high` | pass (0 vulnerabilities; zero runtime deps) |
| Playwright discovery of `upgrade.spec.ts` (both phases) | pass (`--list`: 2 tests per phase) |
| ci.yml + release.yml YAML validity + job structure | pass (parsed programmatically) |
| `npm run smoke:desktop` (Electron leg) / `e2e:desktop` | not runnable in this sandbox (Electron binary download blocked, same as B3/B4) — **executed by CI** (`Desktop` matrix, `Desktop installer`, `Desktop signing`) |
| `npm run e2e` (browser) | not runnable in this sandbox (playwright CDN blocked, same as B3/B4) — **executed by CI** (`Browser E2E`) |

## Acceptance criteria

- B5.0 plan committed before implementation: pass (`0a3bb8a`).
- Versioning single-source + gate + tests: pass.
- Changelog + validation + links: pass.
- Signing pipeline proven in CI, fail-loud release builds, no repo cert
  material: pass locally; first CI run of the new job pending below.
- Checksums + trust docs: pass locally; CI sidecar pending first run.
- Crash diagnostics local-only, redacted, retained, tested at unit + smoke
  level: pass locally; the real-Electron smoke proof runs in CI.
- Upgrade/uninstall verification in CI: spec + job written and
  collection-verified; first CI execution pending below.
- Release workflow with notes + checksums + draft release: contract-tested;
  first tag execution intentionally deferred until merge (no release is cut
  from a feature branch).
- Final security review + SECURITY.md + audit gate: pass.
- Non-goal respected — **no provider/model-discovery code touched** (B5 diff
  spans scripts/, workflows, desktop shell diagnostics, docs, tests only).

## Security checks

- No certificate material or passwords in the repository (test-enforced).
- Secrets only in `env:`/`if:` workflow positions — never inside `run:`
  scripts (programmatically verified over both workflows).
- Workflow permissions minimal: `contents: read` default; `contents: write`
  only on the release-publishing job; releases are drafts.
- Crash logs scrub the bearer token (unit + CI smoke asserted); minidumps
  never uploaded; retention bounded.
- `npm audit --omit=dev` green and now enforced in CI.
- Pre-B5 gates re-verified at the B5 head (full suites green; boundaries
  untouched — see review §6).

## Deviations

- Implementation order follows dependencies (versioning/changelog first),
  not the brief's listing order; the brief's "Final recommended sequence"
  heading arrived empty.
- The unsigned release path exists (draft + warning banner) because no
  production certificate can be bought from this sandbox; the signed path is
  what CI proves and what the secrets enable without code changes. This is
  recorded as finding F-01/F-03 in the security review.
- electron-builder `^26.15.3` → exact `26.15.3` (lockfile already pinned it;
  the manifest now states it, and packaging tests enforce it).
- The changelog's `0.1.0` section carries a date before the tag exists; the
  check-release contract allows correcting the date at tag time (documented
  in the plan).
- Sandbox limits (Electron binary + playwright CDN blocked) — same
  substitution strategy as B3/B4: unit + contract + page-smoke locally,
  everything Electron/browser/Windows in CI.

## Known gaps

- **No production signing certificate** (maintainer action: add
  `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD`; SmartScreen warns until then) —
  documented in INSTALL, SECURITY, CHANGELOG, and the release draft banner.
- Auto-update client deliberately absent (needs a published feed + stable
  signatures; `latest.yml` already ships with releases).
- Branch protection still not configurable by this token (admin action,
  now listing nine checks).
- Installer fresh-clone/interactive modes remain untested (pre-existing
  row, unchanged).
- Upgrade journey covers per-user NSIS upgrades (the only supported mode);
  no test of a *downgrade*.

## CI status

PR: https://github.com/StepenkoAnatoli/WindowRunner/pull/32
(push succeeded after the sandbox GitHub credential was reconnected; the
session token had expired mid-session before the first push — recorded above).

Evidence run: the run for the PR head commit is
[35721962380](https://github.com/StepenkoAnatoli/WindowRunner/actions/runs/35721962380)
(nine checks: `CI`, `Browser E2E`, `Docker`, `Platform (windows-latest)`,
`Platform (macos-latest)`, `Desktop (ubuntu-latest)`, `Desktop (windows-latest)`,
`Desktop installer (windows-latest)` with the new upgrade/uninstall gate,
`Desktop signing (windows-latest)` — new). Status: in progress at the time of
this commit; per-check results are appended below when the run completes.

## Verdict

**Pending CI:** every local gate is green (see Tests) and the PR is open.
The B5 gate requires all nine checks green on the head commit; this file
records GO the moment that run lands — same pattern as the B3/B4 status
files (the evidence commit's run is the merge basis).
