# B5 atomic checklist — phase status

Durable progress record for B5 (release hardening). Chat history is not
durable — this file is. Updated at every B5 stop point.

Branch: `arena/01a0c893-windowrunner`
Base: `main` @ `75380d6b106fbb007797dfbc339f828dc11fd339` (merge of PR #31, B4)
Plan: `docs/superpowers/plans/2026-09-22-b5-release-hardening.md`

## Status

B5.0–B5.4 implemented and locally green (versioning gate, changelog, code
signing, checksums/trust docs). Remaining: B5.5 crash diagnostics, B5.6
upgrade/uninstall CI, B5.7 release workflow, B5.8 security review, B5.9 docs
+ gate. CI not yet run (no push yet).

## Commits

```text
0a3bb8a — docs(plan): define B5 release hardening
52a8d1c — docs(release): add the changelog
3d923ae — feat(release): enforce version and changelog consistency
8ebff26 — feat(desktop): wire env-driven code signing with a fail-loud release build
8a5d400 — feat(release): publish SHA-256 checksums and document installer trust
```

## Files changed

`scripts/check-release.mjs` + `check-release.d.mts` (new, version + changelog
gate), `scripts/checksums.mjs` + `checksums.d.mts` (new, SHA-256 sidecar),
`CHANGELOG.md` (new), `packages/desktop/test/release-contract.test.ts` (new),
`packages/desktop/test/packaging.test.ts` (signing pins), root + desktop
`package.json` (`check:release`, `package:desktop:win:release`, exact
electron-builder pin), `packages/desktop/electron-builder.yml`
(`win.signtoolOptions.signingHashAlgorithms: [sha256]` + credential contract
comments), `.github/workflows/ci.yml` (release-gate step, new `Desktop signing`
job, installer checksums step, nine-check header), `README.md`,
`docs/INSTALL.md` (changelog link, checks list, signing/SmartScreen,
verifying-a-download).

## Behavior now verified

- **Versioning (B5.1):** `npm run check:release` passes on this tree
  (0.1.0 across root + all four workspaces); `--require-version vX` binds a
  tag to the tree (mismatch → exit 1, verified); a workspace version drift is
  reported (unit-tested against a temp tree); CI runs the gate in the `CI` job
  (pinned by contract test).
- **Changelog (B5.2):** `CHANGELOG.md` in Keep a Changelog format; the gate
  validates heading shape (`## [x.y.z] - YYYY-MM-DD` / `## [Unreleased]`),
  ISO dates (rejects 2026-02-30), canonical sections only, no duplicates,
  newest-first ordering, `[Unreleased]` first and dateless, and newest
  version == package.json version — each rejection covered by a unit test.
- **Code signing (B5.3):** env-driven as documented in
  `electron-builder.yml` (signing activates only with
  `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`; otherwise unsigned + green);
  `package:win:release` sets `forceCodeSigning` (electron-builder 26.15.3
  enforces it in `winPackager` — verified in the installed source); SHA-256
  only; CI `Desktop signing (windows-latest)` job generates a self-signed
  CodeSigningCert, exports a PFX (the exact secret shape production uses),
  builds with `ELECTRON_BUILDER_OFFLINE=true` (no timestamp dependency for a
  throwaway cert), and asserts `Get-AuthenticodeSignature` on both the app
  exe and the installer: not `NotSigned` and signed by the expected subject.
  Test-signed installers are uploaded failure-only, never as artifacts.
  electron-builder pinned exactly (26.15.3), asserted by packaging tests.
- **Checksums/trust (B5.4):** `scripts/checksums.mjs` verified locally
  (sidecar verified by `sha256sum -c` end to end; duplicate basenames
  refused); the `Desktop installer` job writes `SHA256SUMS.txt` for
  `*-Setup-*.exe` + `latest.yml` and ships it in the `windowrunner-installer`
  artifact; INSTALL documents SmartScreen ("More info → Run again" flow, OV
  reputation vs EV instant trust), how signing turns on (repo secrets, zero
  code changes), and download verification (`Get-FileHash`, `certutil`,
  `sha256sum -c`) plus the official sources (GitHub Releases, npm tarball).

## Tests

| Check | Result |
| --- | --- |
| `npm run check:release` | pass |
| `npm run typecheck` / `typecheck:desktop` | pass |
| `npm run test:desktop` | pass — 46/46 (30 baseline + 16 release-contract) |
| `npm test` (shared/server/web) | pass at baseline (9/385/233), re-run pending after B5.5 |
| ci.yml / electron-builder.yml YAML validity | pass (js-yaml parse + key assertions) |
| New CI jobs (`Desktop signing`, checksums step) | written; first CI run pending (see CI status) |

## Acceptance criteria

- B5.0 plan committed first: pass.
- B5.1 version single-source + CI gate + tests: pass.
- B5.2 changelog + validation + doc links: pass.
- B5.3 signing config + fail-loud release script + CI proof job + tests: pass
  locally; CI proof pending first run.
- B5.4 checksums + trust docs + tests: pass locally; CI sidecar pending first
  run.

## Security checks

- No certificate material or passwords in the repo; signing is env-only
  (asserted: `certificateFile`/`certificatePassword` must not appear in the
  builder config).
- The CI test certificate is a 4-hour throwaway; private key never leaves the
  runner (store entry deleted after export); its artifacts are
  failure-only uploads.
- Checksum sidecar uses basenames only (no path leakage), sorted,
  `sha256sum -c` compatible.

## Deviations

- The brief lists areas, not an order; implementation runs in dependency
  order (versioning/changelog → signing → checksums → …) because the signing,
  upgrade and release phases consume the version contract.
- electron-builder `^26.15.3` → exact `26.15.3` pin (release reproducibility;
  lockfile already pinned it — manifest now states it).

## Known gaps

- No production certificate exists; official installers remain unsigned
  (SmartScreen warns) until `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` secrets are
  added — documented in INSTALL.
- The signing CI job proves "signed", not "trusted" (self-signed chain); it
  cannot prove anything about a real CA chain.

## CI status

Not run yet for this branch (work in progress; push + PR after B5.9).

## Verdict

Pending — GO or STOP after B5.5–B5.9 and the CI gate.
