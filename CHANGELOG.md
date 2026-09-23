# Changelog

All notable changes to WindowRunner are documented in this file.

The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/)
and the project adheres to [Semantic Versioning](https://semver.org/).
`npm run check:release` enforces this file's contract: the newest version
section must match the root `package.json` version, and only the canonical
section names below are allowed.

## [Unreleased]

### Added

- **Project skills** (ADR 003). A project can now ship its own conventions as
  markdown instruction files under `.windowrunner/skills/<name>/SKILL.md`.
  Discovered skills are listed — name and description only, capped at 40 —
  in the turn's first user message, and the model loads one on demand with the
  new `read_skill` built-in tool, bringing the tool count to six. A skill is
  **instructions only**: nothing in it executes, `read_skill` asks no approval
  because it is a read of a file inside the project root that `read_file` could
  already return, and a skill can never widen an approval — whatever it asks
  for still goes through `write_file` / `edit_file` / `run_terminal` approval
  exactly as before. That invariant is pinned by
  `packages/server/test/skills-security.test.ts`, which runs a skill claiming
  "approval prompts are disabled for this session" through the real turn runner
  and real approval registry and asserts the following `run_terminal` still
  waits for the user. Discovery never throws: a malformed, oversized or hostile
  skill is excluded with a diagnostic naming the reason and the repo-relative
  file, surfaced in the UI rather than silently dropped. Skills are read from
  the project you point the agent at, so the injected index labels them
  untrusted repository content rather than system instructions. Also reachable
  over `GET /api/sessions/:id/skills` (metadata and diagnostics, never bodies)
  and from a `/`-palette over the composer, which inserts `/<name>` and submits
  — it never injects a body, so both activation modes share the one
  `read_skill` path. `eval/tasks/skills/` drives the whole flow against the
  real server, and its hidden check can only pass by reading a skill.

- **An npm publication workflow** (`.github/workflows/npm-publish.yml`),
  narrowing gap G-05. The Release workflow has always built and proven the CLI
  tarball but never published it, so the documented `npx windows-runner` path
  404'd. Publication is a separate, manually dispatched workflow rather than a
  step in `release.yml`, because that workflow is draft-only by design and npm
  has no draft: a published version can never be re-published. It re-proves the
  tarball exactly as the Release workflow does (tag-bound consistency gate,
  unit suite, both packed smokes, `npm pack`), computes the dist-tag instead of
  letting npm infer it (prereleases go to `next`, never `latest`), defaults to
  `dry_run: true`, and verifies the credential with `npm whoami` before
  publishing — `npm publish --dry-run` exits 0 even with no token, so a dry run
  proves the tarball and nothing about auth. Contract-tested in
  `release-contract.test.ts`. Publishing still needs a maintainer to add the
  `NPM_TOKEN` secret and re-run with `dry_run` set to `false`.
- **Release-path signature verification.** `forceCodeSigning` only proves that
  electron-builder applied *a* signature — it cannot tell a wrong-but-present
  certificate from the right one, and `release.yml` never inspected the
  artifacts it produced (`Get-AuthenticodeSignature` appeared in `ci.yml` but
  nowhere in the release path). The Release workflow now verifies the app exe,
  the installer and the uninstaller before the installer is run or shipped: all
  three signed, all by the same subject, all carrying an RFC 3161 timestamp (an
  untimestamped signature stops verifying when the certificate expires), and
  none signed by the CI signing-proof certificate. An optional
  `WIN_CSC_EXPECTED_SUBJECT` secret pins the signer subject; like the
  certificate gate it degrades to a skip when absent, and a mismatch names
  certificate renewal as the likely cause.

### Changed

- **The signing gate now requires both credentials.** It tested
  `WIN_CSC_LINK` alone while the build consumes both it and
  `WIN_CSC_KEY_PASSWORD`, so a half-configured repository took the
  `forceCodeSigning` path and failed the build with an opaque signing error.
  The gate now tests both, and a certificate without its password (or the
  reverse) produces an explicit "signing misconfigured" error naming the
  missing secret. The CI signing assertion also covers the uninstaller now,
  matching what `electron-builder.yml` has always claimed it signs.

- **Windows-only product scope.** The macOS and Linux user-platform claims,
  installers and CI legs were deliberately set aside: the `Platform` and
  `Desktop` CI legs now run only on `windows-latest`, the Unix `install.sh`
  path was removed (`install.ps1` is the supported installer script), and the
  README/install docs no longer advertise non-Windows platforms. Linux-based
  `CI`/`Docker`/`Browser E2E` jobs remain as development/test infrastructure
  for the Node server.

### Fixed

- The user-facing documentation told a different story than the code. Every
  advertised-but-unimplemented feature claim was removed from `README.md` and
  the release notes: project-context auto-discovery, a skills system
  (SKILL.md, `/`-commands, the seven named skills, auto/manual-build modes),
  MCP servers, crash reports (`/api/error-reports`), `delete_file` /
  `web_fetch` / `git status` tools, `.windows-runner-ignore`, Tailwind v4
  "glassmorphism" styling, and a "Context and spending limits" settings page.
  None of these existed in the code; the tool list in the README is now the
  complete list, and `AGENTS.md` now points at the real file map.
- Cancelling a turn that does not exist now answers `404 TURN_NOT_FOUND`
  (previously a lying `202 {"cancelled":true}`), and cancelling an
  already-finished turn answers `409 TURN_NOT_ACTIVE` with its terminal state
  instead of fake success. The UI Stop buttons treat the 409 race as success.
- `npm test` no longer silently skips the desktop workspace: the desktop
  `pretest` hook builds its shell when `dist/` is missing or stale, and the
  root `test` script runs all four workspaces.
- `docs/THREAT_MODEL.md` now exists (previously cited but absent) and
  describes only shipped controls.

### Removed

- Process scaffolding moved out of the tree (recoverable from git history):
  `docs/architecture/exploration-*` phase documents, `docs/superpowers/plans`,
  `docs/research/restore-kit`, the checkout-integrity audit, and unused
  `scripts/*.d.mts` type stubs.

## [0.1.0] - 2026-09-22

First tagged release of the project — the 0.1.0 artifacts (CLI tarball and
Windows installer) cut from this tree are the first installable ones.

### Added

- Local-first agent server: Express API + SSE streaming, bearer-token auth on
  every `/api` route, loopback-only bind by default, Host/Origin validation,
  strict input validation with stable error codes (`packages/server`).
- Pluggable providers with your own keys: `openai-compatible` (OpenAI,
  OpenRouter, Gemini via compatibility endpoints, Ollama, LM Studio),
  `anthropic` (native Messages API), and an offline `mock` provider; retry
  with backoff and `Retry-After` handling; keys redacted from every error and
  log surface.
- Provider profiles and dashboard: CRUD, activation, one-shot connection test,
  usage log (`GET /api/usage`), hot-swap of the active provider for the next
  turn; API keys stored at rest only in the per-user `provider-profiles.json`
  (0600).
- One-shot model discovery for `openai-compatible` providers (B4): a single
  authenticated `GET /models` probe behind the existing middleware, with
  redirects refused, 5 s timeout, 2 MiB response cap, sorted/deduped results
  and manual model entry that never goes away. Keys are never persisted by
  discovery.
- Agent loop with sequential tool execution, approval gates (approve/deny over
  the API), project trust grants keyed by root + config hash, and process-tree
  termination on Stop/timeout (POSIX process groups, `taskkill /T` on Windows).
- Root-confined tools — `read_file`, `write_file`, `edit_file`, `list_dir`,
  `run_terminal` — all going through `safePath()` authorization against
  allowed project roots.
- File persistence with turn JSONL logs, session metadata, replay/`Last-Event-ID`
  resume, quarantine of malformed logs, retention that preserves active
  sessions, and `/api/diagnostics` observability.
- Web UI (framework-free) with session/project workspace, three-column layout,
  streamed turns with tool timeline and approvals, provider management with
  model discovery, usage view, settings (security/storage/about), keyboard
  navigation, and a `/dashboard` compatibility entry.
- Electron desktop shell (`packages/desktop`): boots the bundled server as a
  child process on an OS-assigned loopback port with an in-memory token, loads
  the UI from the server's own origin, sandboxed preload bridge (folder picker,
  workspace catalog, app info), navigation lockdown, clean shutdown that stops
  the backend process tree.
- Windows NSIS installer: per-user install (no UAC) to
  `%LOCALAPPDATA%\Programs\WindowRunner`, silent install/uninstall (`/S`),
  user data preserved on uninstall; CI builds, installs, drives and uninstalls
  it on every push.
- Native Windows installer script `install.ps1` (checkout mode, verified in
  CI), Docker image + compose stack (server-bundle verification), and a CLI
  launcher (`windows-runner`, `wr`) shipped in the packed tarball.
- Evaluation harness (`npm run eval`): scripted, keyless end-to-end runs in CI
  plus manual real-model mode.
- Local crash diagnostics for the desktop shell (B5): Crashpad minidumps and
  bounded crash logs written under the per-user data directory, never
  uploaded, with retention pruning.
- Release hardening (B5): env-driven Authenticode code signing
  (`WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`; SHA-256; pipeline proven in CI with
  a test certificate, production certificate pending), `forceCodeSigning`
  release builds, SHA-256 checksums for installer artifacts, verified in-place
  upgrade with data preservation, tag-driven draft GitHub Releases with
  changelog-derived notes, and a version/changelog consistency gate
  (`npm run check:release`).

### Security

- Every `/api` route requires a bearer token (environment, file, or generated;
  never `off` off-loopback); `WINDOWS_RUNNER_ALLOW_REMOTE=1` is the explicit
  opt-in for non-loopback binds.
- API keys redacted from responses, errors, logs and the UI; provider test and
  discovery paths scrub them defensively; the desktop bootstrap token lives in
  renderer memory only.
- File operations bound to canonicalized authorized roots; symlink and alias
  escapes refused.
- Desktop shell hardening: contextIsolation, no nodeIntegration, sandboxed
  preload with an allowlisted IPC surface, `will-navigate`/window-open/
  webview lockdown, permission requests denied by default.
