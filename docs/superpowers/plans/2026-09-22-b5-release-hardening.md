# B5 plan — Release hardening

Date: 2026-09-22
Branch: `arena/01a0c893-windowrunner`
Base: `main` @ `75380d6b106fbb007797dfbc339f828dc11fd339` (merge of PR #31, B4)
Brief: Stage 4 — B5 release hardening. After B4: code signing; installer
trust/SmartScreen work; crash diagnostics; upgrade/uninstall verification;
release artifacts; versioning; changelog; final security review. **This stays
separate from model discovery** — no provider/discovery code is touched.

The brief lists areas, not an order. Implementation runs in dependency order:
versioning and changelog first (the signing proof, upgrade verification and
release workflow all consume the version contract), then signing/trust, crash
diagnostics, upgrade/uninstall, release artifacts, and the security review last
so it can review everything B5 shipped.

## B5.0 baseline (recorded before implementation)

| Item | Value |
| --- | --- |
| Current base | `main` @ `75380d6`, B4 (PR #31) merged; working tree clean, local gates green (shared 9, server 385, web 233, desktop 30/30 after build; one non-reproducing server-test flake on the first baseline run) |
| Version state | Root `package.json` `0.1.0`; all four workspaces (`shared`, `server`, `web`, `desktop`) also `0.1.0` — by convention only, nothing checks it. Web bundle injects `__APP_VERSION__` from the root manifest; `app.getVersion()` in the packaged desktop app reads the packaged metadata (workspace `package.json` version via electron-builder). |
| Changelog | None. No `CHANGELOG.md`; release history exists only as merged PR descriptions and plan/status files. |
| Signing | None. `electron-builder.yml` ends with "No icon and no code signing yet… signing and branding are separate milestones". electron-builder 26.15.3 is installed and pins are known: signing is env-driven (`WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`, falls back to `CSC_LINK`/`CSC_KEY_PASSWORD`); `win.signtoolOptions` (v26 key) selects hashes/timestamp (`rfc3161TimeStampServer` default `http://timestamp.digicert.com`; `signingHashAlgorithms` default `["sha1","sha256"]`); `forceCodeSigning` (enforced in `winPackager.js`) fails a build that would ship unsigned; the NSIS target signs installer + uninstaller via `packager.signIf`; `ELECTRON_BUILDER_OFFLINE=true` skips timestamping. No certificate exists today and none can be bought from a sandbox. |
| Installer trust | `docs/INSTALL.md` documents "installer is not code-signed (SmartScreen warns on first run: More info → Run anyway)". No checksums are published for the per-PR installer artifact. No statement of official download sources. |
| Crash diagnostics | `main.ts` has `uncaughtException` → error box + exit 1, and the backend exit → error box pointing at `logs/server.log`. No `crashReporter`, no crash log files, no renderer-crash handling (`render-process-gone`/`child-process-gone` unhandled), no `unhandledRejection` handler, no retention for anything in `logs/`. `paths.ts` defines `logsDir` only. |
| Upgrade/uninstall | CI `desktop-installer` job: build → silent install → e2e against installed app (temp data dir) → silent uninstall → exe gone. In-place upgrade (new version over old, user data preserved) is **never tested**. Uninstall-keeps-data (`deleteAppDataOnUninstall: false`) is documented but **never asserted**. |
| Release artifacts | No release workflow. Per-PR the installer exe is uploaded as artifact `windowrunner-installer` (14 days). No tag-driven release, no npm tarball artifact, no checksums, no notes. GitHub private vulnerability reporting is enabled on the repo. |
| CI | Eight checks (CI, Browser E2E, Docker, Platform windows/macos, Desktop ubuntu/windows, Desktop installer). Branch protection is NOT configured (bot token gets 403; documented in RELEASE_CHECKLIST.md) — adding a job cannot break a protection rule, and docs list the check names for the eventual admin action. |

## Non-goals (B5)

No real certificate purchase or CA identity validation (sandboxed agent; the
pipeline is proven with a CI-generated self-signed test certificate and the
production certificate becomes a drop-in secret); no custom signing service or
Azure Trusted Signing migration; no macOS/Linux desktop targets (NSIS/Windows
only, as scoped in A2); no auto-update client (electron-updater) — no update
feed exists until the first tagged release, and Windows auto-updates are
refused for apps whose signatures change, so it lands with the production
certificate; no app icon/branding (separate milestone, named in
electron-builder.yml); no changes to model discovery or any provider code; no
npm publishing (G-05 stays open); no branch-protection changes (admin action).

## Phase B5.1 — Versioning: one source of truth, checked

The root `package.json` `version` is the only place a human edits a version.
Everything else is asserted against it:

- New `scripts/check-release.mjs` (root, no deps): (1) root version is valid
  semver; (2) every workspace `package.json` version equals the root version;
  (3) with `--require-version vX.Y.Z`, that value must equal the root version
  too (used by the release workflow to bind a tag to the tree).
- Root script `check:release`; a `CI` job step runs it on every push/PR; the
  `Desktop (…)` jobs keep building as today (no runtime coupling).
- `packages/desktop/test/release-contract.test.ts` (new, same style as
  `packaging.test.ts`): pins that `ci.yml` runs `check:release`, that the
  electron-builder `artifactName` keeps deriving from `${version}` (already in
  packaging.test.ts — cross-referenced, not duplicated), and unit-tests the
  script's exported helpers.

Acceptance: a version drift in any workspace fails CI; `npm run check:release`
passes on this tree.

## Phase B5.2 — Changelog

- `CHANGELOG.md`, Keep a Changelog 1.1.0 format, semver: an `## [Unreleased]`
  section plus `## [0.1.0] - 2026-09-22` describing the shipped product (the
  first tagged release cuts from this state; the date is corrected at tag time
  if it drifts). Only the canonical sections (`Added`, `Changed`,
  `Deprecated`, `Removed`, `Fixed`, `Security`).
- `check-release.mjs` grows changelog validation: file exists; `Unreleased`
  first when present; every version section is `## [x.y.z] - YYYY-MM-DD` or
  `## [Unreleased]`; the newest version section equals the root version; only
  canonical `###` sections.
- README + docs/INSTALL.md link the changelog.

Acceptance: `check:release` fails on a missing/mismatched changelog section;
the contract test covers the parser against `CHANGELOG.md`.

## Phase B5.3 — Code signing: pipeline proven, production cert drop-in

Config (repo): `electron-builder.yml` gains `win.signtoolOptions.signingHashAlgorithms: [sha256]`
(drops the legacy SHA-1 dual signature) with comments documenting the whole
contract: signing activates when `WIN_CSC_LINK` (+ `WIN_CSC_KEY_PASSWORD`) is
set; builds without credentials stay unsigned and green; the RFC 3161
timestamp server defaults to `http://timestamp.digicert.com`. New desktop
script `package:win:release` = `electron-builder --win nsis --config
electron-builder.yml -c.forceCodeSigning=true` — a release build that cannot
sign FAILS instead of shipping silently unsigned. electron-builder is pinned
exactly (lockfile discipline; same policy as the exact electron pin).

Proof (CI): new job `Desktop signing (windows-latest)` (needs `desktop`):

1. Generate a self-signed CodeSigningCert on the runner
   (`New-SelfSignedCertificate -Type CodeSigningCert`), export PFX, base64 →
   `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` — the same secret shape a real
   certificate will use.
2. `ELECTRON_BUILDER_OFFLINE=true` (the test certificate needs no timestamp),
   build with `-c.forceCodeSigning=true`.
3. Assert `Get-AuthenticodeSignature` on the installer and the unpacked app
   exe: `Status -ne 'NotSigned'` (a self-signed chain is not `Valid` — the
   assertion is "signed by the pipeline", which is what this job proves).
4. Upload the test-signed installer only on failure, as diagnostics.

The unsigned default path stays exactly as today (the existing installer job
keeps proving it). Docs: how a real OV/EV certificate is wired
(repo secrets `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`), and what changes the day
it lands.

Acceptance: the signing job proves cert injection → signtool → signed
installer + signed app exe on every PR; `package:win:release` fails loudly
without credentials; contract tests pin the config keys and the CI job.

## Phase B5.4 — Installer trust / SmartScreen

- `scripts/checksums.mjs`: write `SHA256SUMS.txt` (`<sha256>  <filename>`)
  for named files, created by the `Desktop installer` job for the per-PR
  installer artifact.
- Docs (README + docs/INSTALL.md): the trust story, stated honestly —
  unsigned installers trip SmartScreen ("Windows protected your PC" →
  "More info → Run anyway"); what code signing changes (publisher identity,
  SmartScreen reputation: OV builds it over downloads, EV earns it
  immediately); how to verify a downloaded artifact against `SHA256SUMS.txt`
  (`Get-FileHash`/`certutil -hashfile … SHA256`, `sha256sum -c`); and the
  official download sources (GitHub Releases of this repository; the npm
  tarball) — anything else is not ours.
- `latest.yml` (electron-builder update metadata) stays in the release dir and
  is shipped with releases for the future auto-updater; nothing consumes it
  yet (documented).

Acceptance: every PR's installer artifact carries a checksums sidecar; the
verification commands are documented; contract tests pin the checksums step.

## Phase B5.5 — Crash diagnostics (local-first, nothing uploaded)

New `packages/desktop/src/crash-diagnostics.ts` (pure, injectable fs — unit
testable without Electron):

- `formatCrashRecord` → bounded text record (kind, ISO timestamp, app version,
  platform, electron/node versions, pid, redacted details; details capped).
- `writeCrashLog(logsDir, record)` → `logs/crash-<stamp>-<pid>.log`, written
  tmp-then-rename; prunes oldest crash logs beyond a keep limit.
- `pruneCrashDumps(crashesDir, keep)` → minidump retention by mtime.
- `LOGS_README` → `logs/README.txt` explaining every file and the privacy
  statement (local only; never uploaded; safe to delete).

`main.ts` wiring:

- `app.setPath("crashDumps", <appData>/crashes)` early +
  `crashReporter.start({ uploadToServer: false, compress: true })` — Crashpad
  minidumps written locally, never uploaded (no `submitURL`).
- `fatal()` now writes a crash record first (with the server token in the
  scrub list) and the dialog names the file it wrote.
- `unhandledRejection` → crash record, app keeps running (a dying renderer
  feature must not take the shell down; documented).
- `render-process-gone` → crash record + one `reload()`; a second renderer
  loss → fatal.
- `child-process-gone` (GPU etc.) → crash record only.
- Boot: write `logs/README.txt`, prune old crash logs and dumps.

Tests: `crash-diagnostics.test.ts` (format/redaction/bounds/retention/prune,
temp dirs); `main-flow.test.ts` + electron stub extended (`setPath`,
`crashReporter`, event registrations) asserting the wiring; `electron-smoke.ts`
(CI, real Electron) fires a synthetic main-process unhandled rejection and
asserts the crash log appears, is redacted, and the app stays alive; a clean
run leaves no crash logs.

Docs: `docs/INSTALL.md` troubleshooting gains "Crash reports and logs" (what is
where, what minidumps may contain, how to wipe).

## Phase B5.6 — Upgrade/uninstall verification

New `packages/desktop/e2e/upgrade.spec.ts` — runs only when the installer CI
job asks (`WR_UPGRADE_PHASE=old|new`), against the installed app, with the
data dir pinned to the real per-user location the installer uses
(`%APPDATA%\WindowRunner` via `WINDOWS_RUNNER_DESKTOP_DATA_DIR`):

- Phase `old` (`WR_EXPECTED_APP_VERSION` = current): create a marker project +
  session, complete a mock turn, persist the session id into the marker dir,
  quit clean.
- Phase `new` (after the new installer is run over the old install): assert
  `getAppInfo().version` = the new version, the marker project is still in the
  workspace catalog, the phase-A session is still listed and its completed
  turn still renders, and a fresh turn completes.

The `Desktop installer` job becomes: build installer vCur (`0.1.0`-style, root
version) → silent install → assert canonical path → full e2e suite against the
installed app (unchanged, temp data dirs) → upgrade phase `old` → build
installer vNext (patch-bumped via `-c.extraMetadata.version`, separate output
dir `release-next`) → silent install over the old one → assert installed exe
`ProductVersion` = vNext → upgrade phase `new` → silent uninstall → assert exe
gone **and** `%APPDATA%\WindowRunner\workspace-catalog.json` still present
(`deleteAppDataOnUninstall: false` finally asserted) → cleanup.

Acceptance: in-place upgrade with data preservation and data-surviving
uninstall are proven on every PR; contract tests pin the job steps and the
spec inventory.

## Phase B5.7 — Release artifacts

New `.github/workflows/release.yml`, triggered by `v*.*.*` tag pushes:

- Guard job: `check:release --require-version <tag>` binds the tag to the
  tree (version + changelog section must match).
- CLI job (ubuntu): build, `smoke:packed`, `smoke:packed:start`, `npm pack` →
  tarball artifact.
- Windows job: build, `package:win:release` **with** the repo secrets
  `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`; when the secrets are absent the build
  is unsigned and the release is created as a DRAFT carrying an explicit
  "unsigned" warning (the first release ships before a certificate exists;
  a human publishes deliberately). Silent-install → desktop e2e against the
  installed app → silent uninstall, same assertions as the installer job.
- `scripts/release-notes.mjs <version>` extracts the CHANGELOG section as the
  release body (fails if missing); `scripts/checksums.mjs` produces
  `SHA256SUMS.txt` (installer, tarball, `latest.yml`, blockmap when present).
- Draft GitHub Release with all artifacts; workflow `permissions:
  contents: write` only on the publishing job.

Contract tests pin: trigger shape, permissions, forceCodeSigning usage, the
unsigned-draft branch, checksums + notes steps, draft-not-publish.

## Phase B5.8 — Final security review

- `SECURITY.md`: supported versions, reporting via the repo's enabled private
  vulnerability reporting, scope, trust model summary.
- `docs/research/2026-09-22-b5-security-review.md`: review of every B5
  surface — secret handling (`WIN_CSC_KEY_PASSWORD` never echoed; crash-log
  redaction; workflow permissions), artifact integrity (checksums, draft
  releases, test-signed artifacts never presented as trusted), crash-dump
  privacy (local-only, retention), release-workflow attack surface — plus a
  re-check that the pre-B5 gates still hold, and the outstanding items with
  owners.
- CI: `npm audit --omit=dev --audit-level=high` step in the `CI` job (the
  shipped artifact has no runtime npm dependencies today; the step exists so
  that can never regress silently).
- RELEASE_CHECKLIST.md updated: P1-06/release-gate rows, the CI-enforcement
  tables, SmartScreen/signing status, changelog/versioning rows.

## Phase B5.9 — Docs, gate, status

README + docs/INSTALL.md brought current (checks list, signing status,
checksums, crash logs, upgrade/uninstall behavior, changelog link);
`AGENTS.md` checks list gains `npm run check:release`; the B5 atomic status
file records the phase reports; the gate is the full local suite + all CI
checks green on the head commit. Verdict GO or STOP in
`docs/superpowers/plans/2026-09-22-b5-atomic-status.md`.

## Gate

Local: `npm run check:release`, `npm test`, `npm run typecheck`,
`npm run typecheck:desktop`, `npm run build`, `npm run build:desktop`,
`npm run test:desktop`, `npm run smoke:packed`, `npm run smoke:packed:start`,
`npm run smoke:start`, `npm run eval -- --expect-pass`,
`npm run smoke:page --workspace packages/desktop` (Electron-dependent checks
run in CI — the sandbox cannot download the Electron binary, same as B3/B4).
CI: all checks green on the head commit, including the two new jobs
(`Desktop signing`, and the extended `Desktop installer` upgrade/uninstall
gate).
