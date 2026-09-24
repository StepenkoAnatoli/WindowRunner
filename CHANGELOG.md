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

- **One-click setup and start for Windows beginners.** `Setup-WindowRunner.cmd`
  and `Start-WindowRunner.cmd` at the repository root turn installation into
  two double-clicks: the first checks that Node >= 22 is installed (opening the
  download page and spelling out Next-Next-Finish when it is missing or too
  old) and then runs `npm run setup`; the second runs `npm start` and points at
  the `ui:` address. They add no new install path — they wrap the commands
  `docs/INSTALL.md` already verifies — and both are contract-pinned in
  `packages/server/test/packaging.test.ts` (plain ASCII, CRLF, no BOM, must
  still call `npm run setup` / `npm start`, must `pause` so a double-clicked
  window cannot vanish). `docs/INSTALL.md` records their status honestly: the
  commands are verified, the wrappers have not yet been double-clicked on a
  Windows desktop.

- **The double-click wrappers are now executed, not just contract-tested.**
  `npm run smoke:launchers` (`scripts/smoke-launchers.mjs`) drives both `.cmd`
  files under `cmd.exe` on Windows: it runs `Setup-WindowRunner.cmd -NoPause`
  (asserting the Node gate reports the installed version and `npm run setup`
  reaches its success banner through the wrapper), then starts
  `Start-WindowRunner.cmd -NoPause`, waits for the banner's ready line, checks
  `/healthz`, and tears the process tree down. A new `-NoPause` switch on both
  wrappers exists solely so a runner can drive them — a double-click is
  unchanged. The script skips with a printed note on non-Windows platforms, and
  the `Platform (windows-latest)` CI leg runs it, so the beginner path can no
  longer regress silently.

- **`install.ps1`'s two untested modes are covered.** The Windows CI leg now
  also executes fresh-clone mode — against a local bare mirror injected through
  `WINDOWS_RUNNER_REPO_URL`, asserting that a full checkout with a built server
  bundle appears in `WINDOWS_RUNNER_HOME` — and the interactive start prompt
  answered with `n` (must exit 0 without starting anything, so a runner cannot
  hang on `Read-Host`). The three modes are named in `docs/INSTALL.md` instead
  of the previous blanket "fresh-clone and interactive-prompt modes untested".

- **The `.cmd` wrappers ship in the npm tarball.** They are part of the
  beginner kit, so they are in `package.json` → `files` and in
  `scripts/smoke-packed.mjs`'s required list; `packages/server/test/packaging.test.ts`
  fails if either the manifest or the packed-artifact contract drops them.

### Changed

- **File persistence now keeps an advisory instance lock.** Booting a server
  in file mode writes `<dataDir>/.instance-lock` with its PID. A second boot
  that finds a *live, foreign* owner warns loudly at startup — multi-process
  writers corrupt the per-turn JSONL logs (there is deliberately no file
  lock) — while a stale lock from a crashed instance is reclaimed without
  blocking recovery, and a clean shutdown releases the lock. Strictly
  advisory: no boot path can wedge on it. Pinned in
  `packages/server/test/boot.test.ts` ("advisory instance lock").
- **`npm test` is self-sufficient from a bare checkout.** A root `pretest`
  first verifies the dev toolchain is actually installed — an interrupted or
  corrupted `npm ci` (which wipes `node_modules` mid-install) now fails in
  under a second with the exact recovery command instead of an opaque
  `tsx: not found` — then runs `scripts/ensure-built.mjs`, so a missing or
  stale `dist/` is rebuilt before the first test file runs (the packaging
  contract requires the built bundle). The CI `Test` step also retries once
  on failure: the suite has one observed one-off cold-start failure that
  never reproduces on warm runs, and the gate still requires a fully green
  second run, so a real regression cannot be hidden.
- **The signing gate now requires both credentials.** It tested
  `WIN_CSC_LINK` alone while the build consumes both it and
  `WIN_CSC_KEY_PASSWORD`, so a half-configured repository took the
  `forceCodeSigning` path and failed the build with an opaque signing error.
  The gate now tests both, and a certificate without its password (or the
  reverse) produces an explicit "signing misconfigured" error naming the
  missing secret.

- **Windows-only product scope.** The macOS and Linux user-platform claims,
  installers and CI legs were deliberately set aside: the `Platform` and
  `Desktop` CI legs now run only on `windows-latest`, the Unix `install.sh`
  path was removed (`install.ps1` is the supported installer script), and the
  README/install docs no longer advertise non-Windows platforms. Linux-based
  `CI`/`Docker`/`Browser E2E` jobs remain as development/test infrastructure
  for the Node server.

- **Beginner-facing wording in the UI.** The browser sign-in screen no longer
  opens with "API token" / "Bearer token": it is titled **Sign in** and says to
  Ctrl-click the `ui:` address the server printed, with the `token:` line as the
  fallback. Both project-path fields now show a Windows example
  (`C:\Users\me\my-project`) in a Windows-only product, the sidebar states that
  the agent can only read and change files inside the folder you choose, and
  the empty conversation says "Pick a project on the left, then click New
  session" instead of "Create or open a session to start."

- **README rewritten as the public front page** with the same structure the
  project ships: features, screenshots to capture, a numbered Windows install
  for people who have never used a command line (double-click path first, typed
  commands and the desktop installer after), run/use guides, tech stack, a
  trimmed project tree, the full test command list, an advanced-settings
  `<details>` table that mirrors `config.ts` → `ENV`, limitations, contributing
  and license. `docs/INSTALL.md` gained a "Windows quick start (no command
  line)" section plus status rows for the two launchers.

### Fixed

- **A turn whose events could not be persisted became a zombie.** When
  durable persistence failed (e.g. disk full), the terminal event — the turn's
  last word — was dropped along with everything else, leaving the turn
  non-terminal in memory forever: it counted against every `/api/health`
  check, could never be evicted, and every shutdown drain ran out its full
  grace period on it. Terminal events (`turn_completed` / `turn_cancelled` /
  `turn_failed`) are now applied in-memory when durability is unavailable —
  the store has already recorded the persistence failure, so nothing is lost
  silently — while non-terminal events keep the strict "throw, never emit
  before durable" contract. A `turn_started` that cannot be recorded at all
  now fails the turn with `PERSISTENCE_FAILED` instead of propagating out of
  the runner. Verified live: on a full disk the turn converges to
  `turn_failed PERSISTENCE_FAILED`, the session accepts a new turn once space
  is freed, and shutdown is clean. Pinned in
  `packages/server/test/production-readiness-audit.test.ts`
  ("terminal events converge in-memory").
- **A brand-new turn with no recorded events was reported as stuck for about
  56 years.** `createInitialTurnState` sets `updatedAt: 0`, and the
  stuck-turn check aged the turn from that epoch (`0` is not nullish, so `??`
  never fell back). Any turn whose first event failed to persist was
  instantly flagged as a `stuckTurn` alert with an absurd duration, keeping
  `/api/health` degraded. Age now falls back to the log's in-memory creation
  time. Pinned in `packages/server/test/metrics-alerts.test.ts`.
- **`/api/health` and `/api/diagnostics/persistence` always reported
  `turnsLoaded: 0` and `turnsWithRestart: 0`.** `FileTurnLogStore
  .getDiagnostics()` returns a fresh copy on every call, and boot mutated
  that throwaway copy, so the recovered/RESTART counts reached only the boot
  log and `diagnostics.boot` — the live endpoints silently reported the
  store's zero defaults. The manager now keeps the corrected figures and the
  endpoints use them. Pinned in `packages/server/test/boot.test.ts`
  (file-mode recovery tests now assert the live counters).
- **The boot banner (and, for bracketed input, the ready/UI URLs) mangled
  IPv6 hosts.** `HOST=::1` printed `bind: ::1:7634`, ambiguous between host
  and port, and `HOST=[::1]` — accepted by the loopback check — would have
  produced `http://[[::1]]:7634`. The banner now brackets IPv6 hosts and
  `formatUrl` tolerates already-bracketed input. Pinned in
  `packages/server/test/config.test.ts` and `packages/server/test/boot.test.ts`.
- **The CI signing gate asserted a signature on an artifact that is never
  signed, and failed.** An uninstaller check was added to the `Desktop signing`
  job on the reasoning that `electron-builder.yml` says signing covers the
  "app exe, uninstaller, NSIS installer" and that a shipped uninstaller outside
  the gate was a gap. The premise was wrong. electron-builder signs *an*
  uninstaller — into the output directory as `<installer-base>__uninstaller.exe`
  — and then **deletes it**
  (`app-builder-lib/out/targets/nsis/NsisTarget.js`: `signIf(uninstallerPath)`
  followed by `unlink(UNINSTALLER_OUT_FILE)`). What remains in `win-unpacked` is
  the NSIS template embedded in the installer, which nothing signs, so the
  assertion could only ever fail. Reverted to the app exe and the installer in
  both `ci.yml` and `release.yml` (the release gate carried the same claim and
  would have failed every release), the misleading `electron-builder.yml`
  comment corrected, and `release-contract.test.ts` now asserts the gate does
  *not* look up that file so this cannot come back. Whether the uninstaller a
  user actually runs — extracted at install time from the signed installer —
  carries a signature is not observable from the build output and is recorded
  as an open item in `RELEASE_CHECKLIST.md` rather than guessed at.
- **A `SKILL.md` saved with a UTF-8 BOM was rejected.** The byte-order mark
  sits before the opening `---` line, so the frontmatter check failed and the
  skill was excluded with `missing frontmatter` — a diagnostic naming the wrong
  problem, for a file that was valid. Not exotic on the supported platform:
  this repository pins a BOM in `install.ps1` for the same reason, because
  Windows editors add one. `parseSkillFile` now strips a leading BOM before
  parsing. Found by review, with a regression test in
  `packages/server/test/skills.test.ts`.
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
- **Three documents described a product that no longer exists.** `SECURITY.md`
  still located the filesystem boundary in `packages/server/src/access.ts` and
  its `safePath()` helper, both removed with the `ProjectRoot` rewrite — it now
  names `packages/server/src/project-root.ts` and the containment-then-realpath
  check. `install.ps1` and `scripts/setup.mjs` told the user a fresh checkout
  runs with "no tools" while the boot path registers all six built-in tools;
  both now describe the read tools and the approval-gated write/terminal tools.
  `docs/INSTALL.md` claimed "there is no Anthropic adapter yet" one paragraph
  after documenting the adapter, and listed a UI/endpoint surface that stopped
  at sessions and turns — it now lists the shipped routes, pages and the
  `/desktop` shell. `RELEASE_CHECKLIST.md` also presented the removed
  checkout-integrity audit as "present"; the source-of-truth list now says
  absent and names the B5 review that actually exists.
- A `packages/server/test/boot.test.ts` test was titled "uses no tools in this
  checkout" while its fixture disables tools explicitly; it is now titled for
  what it asserts (the configured tool set is exposed, empty when disabled).
- **The install-directory assertion in `packages/desktop/test/packaging.test.ts`
  could pass for the wrong reason.** It compared each document against a
  needle built with `String.raw` and two escaped backslashes, which does not
  match the single-backslash form the markdown actually contains — so the
  check ran against a literal that only the escaping convention could produce.
  It is now a regex accepting one or two backslashes *and* requiring
  `%LOCALAPPDATA%` in the same document, and it was verified to reject both a
  missing path and a renamed directory.
- **`install.ps1` had mixed line endings** (124 CRLF with 24 bare LF lines from
  an earlier partial edit) even though `.gitattributes` documents it as a CRLF
  file. It is uniformly CRLF again, with its required UTF-8 BOM intact.
- `npm test` no longer silently skips the desktop workspace: the desktop
  `pretest` hook builds its shell when `dist/` is missing or stale, and the
  root `test` script runs all four workspaces.
- `docs/THREAT_MODEL.md` now exists (previously cited but absent) and
  describes only shipped controls.

### Removed

- Process scaffolding moved out of the tree (recoverable from git history):
  `docs/architecture/exploration-*` phase documents, `docs/superpowers/plans`,
  `docs/research/restore-kit`, the checkout-integrity audit, and unused
  `scripts/*.d.mts` type stubs. The 2026-09-23 skills implementation plan
  (`docs/plans/`) followed it out: it is marked complete and its decisions live
  in `docs/adr/003-skills-are-instructions-only-project-markdown.md`, so the
  remaining citations to the removed `docs/superpowers/plans` tree in
  `scripts/temp-path.mjs` and `packages/server/test/teardown-hardening.test.ts`
  now describe the plans instead of linking to files that no longer exist.

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
