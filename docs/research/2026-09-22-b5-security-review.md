# B5 Final Security Review — Release Hardening

**Review date:** 2026-09-22
**Reviewer role:** adversarial analyst / fact-checker (same posture as the
2026-09-19 checkout-integrity audit)
**Scope:** everything B5 introduced (versioning gate, changelog, code-signing
pipeline, checksums/trust docs, crash diagnostics, upgrade/uninstall gate,
release workflow, SECURITY.md), plus a re-check that the pre-B5 security gates
still hold at the B5 head.
**Verification environment:** Node `v22.22.3`, npm `10.9.8`, git `2.39.5`,
Linux x86_64 (sandbox; Electron-dependent checks delegated to CI, consistent
with B3/B4). Every check below was actually executed unless marked CI-pending.

---

## 1. Executive summary

**No new secrets, no new telemetry, no new attack surface that is not gated.**
B5's changes are release tooling and local diagnostics; the product's runtime
trust boundaries (API auth, filesystem roots, provider-key redaction, desktop
sandbox) are untouched, and the full server/web/desktop suites pass at the
reviewed head.

Two findings are recorded as **accepted risks with owners** (F-02: minidumps
contain process memory; F-03: no production certificate yet — SmartScreen
warns on official installers). Nothing in B5 increases the severity of either;
both are now documented in `docs/INSTALL.md` and `SECURITY.md` and, in
F-03's case, mechanically one secret away from being fixed.

---

## 2. What B5 added, mapped to the surfaces it touches

| Surface | Change | New risk introduced? |
| --- | --- | --- |
| Version metadata | `scripts/check-release.mjs` (read-only over manifests) | No — pure reads; no network |
| Changelog | `CHANGELOG.md`, `scripts/release-notes.mjs` | No — notes script reads one file, validates the version argument against a strict regex, writes one output file |
| Signing | `electron-builder.yml` `signtoolOptions`, `package:win:release`, CI `Desktop signing` job | Credential handling reviewed in §3 |
| Checksums | `scripts/checksums.mjs`, CI sidecar step | No — reads named files, writes `SHA256SUMS.txt` (fixed name, basenames only) |
| Crash diagnostics | `crash-diagnostics.ts` + `main.ts` handlers | Reviewed in §4 |
| Upgrade/uninstall | CI job restructure + `e2e/upgrade.spec.ts` | No repo-side risk; CI runner hygiene reviewed in §5 |
| Release workflow | `.github/workflows/release.yml` | Reviewed in §5 |
| Security policy | `SECURITY.md`, `npm audit --omit=dev` CI step | No |

## 3. Secret handling (code signing)

- **No certificate material in the repository.** Enforced by test:
  `release-contract.test.ts` fails if `certificateFile` or
  `certificatePassword` ever appear in `electron-builder.yml`. Signing
  activates only through `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` env vars.
- **Secrets are never interpolated into shell scripts.** Verified
  programmatically (YAML-parsed both workflows; `secrets.*` appears only in
  `env:` and `if:` positions). The signing-mode decision passes only a
  `yes`/`no` derived value across the step boundary (`HAS_CERT`), never the
  secret.
- **The CI proof certificate is a 4-hour throwaway.** Generated on the runner,
  exported to a PFX under `RUNNER_TEMP`, the store entry deleted immediately;
  the PFX path (not content) crosses steps. The test-signed installer is
  uploaded failure-only as diagnostics and is named as untrusted in the job
  comments and assertions. Verified: the signing job's upload steps are all
  `if: failure()` (test-pinned).
- **Release builds cannot silently ship unsigned**: the signed path runs with
  `forceCodeSigning` (enforced in electron-builder 26's `winPackager` —
  verified in the installed dependency source); the unsigned path exists only
  because no production certificate exists yet, and it stamps an explicit
  "this build is UNSIGNED" warning into the draft release (test-pinned).
- **Timestamping**: production builds counter-sign via the default RFC 3161
  server; the CI proof disables it (`ELECTRON_BUILDER_OFFLINE=true`) only for
  the throwaway certificate, so the proof has no external service dependency.

## 4. Crash diagnostics (privacy)

- **Nothing is uploaded.** `crashReporter.start({ uploadToServer: false })`
  with no `submitURL`; verified in the electron d.ts contract and pinned by
  the main-flow stub test (`uploadToServer === false`).
- **Crash logs are redacted and bounded.** The server bearer token and any
  env-provided token are scrubbed; details truncated at 8 KiB; unit-tested
  (scrub + truncation cases) and e2e-asserted in CI: the electron smoke fires
  a real main-process unhandled rejection and asserts the log contains the
  marker and not the token.
- **Minidumps stay local and are pruned** (keep 10, mtime order, boot-time).
  The logs README states plainly that minidumps can contain process memory
  and may be deleted at any time. Accepted risk F-02 below.
- **No new IPC channels, no new renderer surface.** Crash handling is
  main-process only; the preload bridge surface is unchanged (pinned by
  `preload.test.ts` / `main-flow.test.ts` channel allowlist, both passing).
- **Stability trade-off checked**: `unhandledRejection` keeps the app alive
  (recorded, not fatal) — a deliberate, documented choice; a renderer crash
  reloads once and only a second loss is fatal. Neither path can loop without
  writing a crash record each time, which retention bounds at 20.

## 5. Workflows (CI + release)

- **Minimal permissions.** `release.yml` defaults to `contents: read`; only
  the publishing job escalates to `contents: write`, and to exactly that
  (test-pinned). `ci.yml` stays at `contents: read`.
- **Draft-only releases.** `gh release create --draft`; publishing is a human
  action (test-pinned). The unsigned branch adds a warning banner to the
  body; checksums are embedded in the body as well as attached.
- **Tag binding.** The guard job requires the tag to equal `package.json`
  version and the changelog's newest section (`check:release
  --require-version`), so a release cannot be cut from a mismatched tree
  (test-pinned; local run verified for the matching and mismatching cases).
- **Release artifacts are exercised before shipping**: the CLI tarball passes
  both packed smokes; the installer is silently installed, driven through the
  installed-app e2e journey, and uninstalled — inside the release workflow
  itself, not just on PRs.
- **CI runner hygiene**: the upgrade journey seeds real user data under
  `%APPDATA%\WindowRunner` on a throwable runner and the final step deletes
  it; artifacts from the signing job are failure-only; diagnostics artifacts
  are 7-day retention. The `Desktop signing` job does not use any repository
  secrets at all.
- **`npm audit --omit=dev --audit-level=high`** added to the CI job. Current
  result on this tree: `found 0 vulnerabilities` (verified locally). The
  product has zero runtime npm dependencies; the step exists so that cannot
  regress silently.

## 6. Pre-B5 gates re-checked at the B5 head

| Gate | Evidence at B5 head |
| --- | --- |
| Bearer token on every `/api` route; loopback default; Host/Origin validation | `npm test` (server 385/385) passes, including `security.test.ts`; smoke:start and the packed smokes pass |
| Filesystem confinement (`safePath` / authorized roots) | server suite green; no B5 change touches `access.ts` |
| Provider-key redaction; discovery key boundary | server + web suites green (B4 specs included); no B5 change touches provider code — confirmed by diff (B5 files: scripts/, workflows, desktop shell diagnostics, docs, tests) |
| Desktop sandbox (contextIsolation, allowlisted IPC, navigation lockdown) | desktop suite 67/67; the IPC channel allowlist test still passes; preload surface unchanged |
| Token never in URLs/storage | desktop.spec / electron-smoke assertions unchanged and CI-run; new crash logs add a *negative* token assertion (log must not contain the token) |
| Unattended-upgrade data preservation | newly *proven* (B5.6) rather than assumed |

## 7. Findings

| ID | Finding | Severity | Disposition |
| --- | --- | --- | --- |
| F-01 | The unsigned release path (no `WIN_CSC_LINK` secret) can still produce a publishable draft; a maintainer could publish an unsigned build without reading the warning | Low | Accepted: draft + banner + `SHA256SUMS.txt` embedded in the body; the "Cutting a release" procedure names signing status as a review item. Flipping to hard-fail is one line when the certificate lands. |
| F-02 | Crashpad minidumps may contain secrets present in process memory (e.g. a provider API key held by the bundled server child) | Medium (local-only exposure) | Accepted + documented: dumps never leave the machine, are pruned to 10, and the logs README tells users they are sensitive and deletable. Encrypting dumps is not supported by Crashpad; this is the standard local-first trade-off, now stated honestly. |
| F-03 | No production signing certificate exists; official installers are unsigned and SmartScreen warns | Medium (user-trust, not confidentiality) | Accepted + documented (INSTALL → "Code signing and SmartScreen"); pipeline is CI-proven with a test certificate; production requires only the two repo secrets — no code changes. |
| F-04 | `upgrade.spec.ts` trusts `WR_EXPECTED_APP_VERSION` from CI env; a wrong value would fail the run, not fake a pass | Info | No action: fail-closed by construction. |
| F-05 | The `check-release`/`release-notes`/`checksums` scripts are trusted repo tooling without their own dependency isolation | Info | No action: zero runtime dependencies (node: builtins only), covered by contract tests; they run in the same trust domain as the build. |

## 8. Outstanding items (carried, with owners)

1. **Production OV/EV certificate** (maintainer with the CA account): add
   `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD` secrets; the release workflow then
   signs and the SmartScreen warning story collapses to reputation buildup.
2. **Branch protection** (repo admin): require the nine checks + an approval
   on `main` (bot token cannot; documented since B2 and still true).
3. **Auto-update client** (deferred, deliberate): needs a published update
   feed and stable signatures first; `latest.yml` already ships with releases.

## 9. Verdict

**B5 introduces no unreviewed secret path, no telemetry, and no new
remotely-reachable surface.** The one new file-writing runtime component
(crash logs) is redacted, bounded, local-only, retention-managed, and covered
by unit + e2e tests. Release publication is draft-gated, checksummed,
tag-bound, and signs-or-warns. GO from the security side; the remaining items
are the two accepted risks above and the admin actions that were already
outstanding before B5.
