# Changelog

All notable changes to WindowRunner are documented in this file.

The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/)
and the project adheres to [Semantic Versioning](https://semver.org/).
`npm run check:release` enforces this file's contract: the newest version
section must match the root `package.json` version, and only the canonical
section names below are allowed.

## [Unreleased]

### Added

- Nothing yet. Work toward the first tagged release accumulates here.

## [0.1.0] - 2026-09-22

First packaged state of the project (pending the first tagged release — the
0.1.0 artifacts cut from this tree are the first installable ones).

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
- Root-confined tools — read, edit, list, terminal, git status — all going
  through `safePath()` authorization against allowed project roots.
- SKILL.md skill discovery with `includes:` resolution; skills ride in the
  user turn, never the system prompt.
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
- Native installers `install.sh` / `install.ps1` (checkout mode, verified in
  CI), Docker image + compose stack, and a CLI launcher (`windows-runner`,
  `wr`) shipped in the packed tarball.
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
