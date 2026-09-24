# WindowRunner — Complete Project Prompt

> **For AI assistants and maintainers:** copy/paste this entire document into a new chat to give the agent full context on WindowRunner's current state, architecture, and how to run it. It is self-contained and up to date as of 2026-09-23.

---

## 1. Project Name + Purpose

**WindowRunner** — a local-first coding agent for **Windows**. You point it at a project folder; it reads, edits, and runs code under your approval, streaming answers live. It runs entirely on your machine with your own API keys — nothing leaves except the model requests you send. Windows-first by design: per-user NSIS installer, per-user data under `%APPDATA%`, CI proving the installer on `windows-latest`.

---

## 2. Tech Stack

| Layer | Detail |
|-------|--------|
| **Language** | TypeScript (strict, ESM) |
| **Runtime** | Node.js >=22.0.0 (CI pins 22.23.2) |
| **Server** | Express 4 — the *only* runtime npm dependency (+ `@windows-runner/shared`) |
| **Bundling** | `esbuild` emits self-contained `packages/server/dist/index.cjs` (no `node_modules` needed at runtime) and `packages/web/dist/app` |
| **Shared core** | `@windows-runner/shared` — owns `StreamEvent` union, `reduceTurnState`, `workspace-catalog` validation — single owner for server + UIs |
| **Web UI** | Vanilla TypeScript, no framework. Pure reducer (`app-state.ts`) + pure view modules, `dom.ts` primitives, `esbuild` build |
| **Desktop** | Electron 44 + electron-builder (NSIS, per-user, no UAC). Spawns bundled server as child on random loopback port with in-memory token |
| **Providers** | `mock` (offline, default), `openai-compatible` (OpenAI, Ollama, LM Studio, OpenRouter, Groq, Gemini compat endpoint), native `anthropic` + `retry.ts` (maxRetries=2, backoff, honors Retry-After) |
| **Persistence** | `memory` (default, `InMemoryTurnLogStore`) or `file` (`FileTurnLogStore` JSONL per turn + `FileSessionStore` meta.json, atomic writes, fsync optional, quarantine, RESTART recovery) |
| **Tests** | `node:test` via `tsx`, Playwright (Chromium for web, `_electron` for desktop), scripted eval harness (`eval/run.mts` with 6 tasks) |
| **Infra** | Docker multi-stage (server bundle verification), GitHub Actions 7-job gate |

**Key principle:** Server is free of UI concerns, UI is free of provider specifics. Everything touching the filesystem goes through `ProjectRoot` (logical containment + realpath).

---

## 3. Exact Current Folder Structure

```
WindowRunner/                           # repo root — branch arena/01a0cf17-windowrunner
├─ .github/workflows/
│  ├─ ci.yml                            # 7 required checks: CI, Browser E2E, Docker, Platform/win, Desktop/win, Desktop installer, Desktop signing
│  ├─ npm-publish.yml                   # manual dry-run publish, computes dist-tag, checks NPM_TOKEN
│  └─ release.yml                       # tag vX.Y.Z → draft GitHub Release with checksums
├─ bin/windows-runner.js                # CLI launcher (bin: windows-runner, wr) → requires dist/index.cjs
├─ packages/
│  ├─ shared/
│  │  ├─ src/index.ts                   # StreamEvent union, TurnState, reduceTurnState, workspace-catalog re-export
│  │  ├─ src/workspace-catalog.ts       # single-owner catalog shape + validation
│  │  └─ test/turn-reducer.test.ts
│  ├─ server/
│  │  ├─ src/
│  │  │  ├─ index.ts                    # boot entry (npm start): config → runtime → listen → drain, banner
│  │  │  ├─ config.ts                   # ENV table — single source, strict parsing, safe defaults
│  │  │  ├─ boot.ts                     # createRuntime(): TurnManager, ApprovalRegistry, SessionManager, providers, createApp(), recovery, resolveAuthToken
│  │  │  ├─ app.ts                      # Express factory: security order, body limits, validation loop, lifecycle hooks
│  │  │  ├─ security.ts                 # createSecurityPolicy(): Host → Origin → bearer token, constant-time
│  │  │  ├─ project-root.ts             # ONLY filesystem authority: safePath containment + realpath
│  │  │  ├─ provider-*.ts, usage-log.ts, deadline.ts, process-tree.ts
│  │  │  ├─ agent/
│  │  │  │  ├─ loop.ts                  # turn loop: up to maxSteps model calls, sequential tools, approval promises
│  │  │  │  ├─ turn-manager.ts          # owns seq, persistence, SSE subscription, cancel
│  │  │  │  ├─ session-manager.ts       # root pinning, one-active-turn, lifecycle
│  │  │  │  ├─ approval-registry.ts     # pending approvals, independent of SSE
│  │  │  │  ├─ project-trust.ts         # grants keyed by realRoot+configHash, persisted to trust.json
│  │  │  │  ├─ skills.ts                # ADR 003: discover/parse/validate .windowrunner/skills/*/SKILL.md
│  │  │  │  ├─ file-turn-log-store.ts   # JSONL per turn, O_APPEND, quarantine >50%, RESTART recovery
│  │  │  │  ├─ file-session-store.ts    # meta.json versioned, atomic rename, boot re-validation
│  │  │  │  └─ tools/builtin.ts         # 6 tools: read_file, write_file, edit_file, list_dir, run_terminal, read_skill
│  │  │  ├─ http/
│  │  │  │  ├─ runtime.ts               # AppRuntime shared by routes (activeControllers lives here)
│  │  │  │  ├─ validate.ts              # id/body/cursor guards
│  │  │  │  ├─ static-ui.ts             # web static at /, /desktop, deep-route allowlist, /healthz
│  │  │  │  └─ routes/ {sessions, turns, providers, observability, skills}.ts
│  │  │  └─ providers/
│  │  │     ├─ openai-compatible.ts, anthropic.ts, mock.ts, retry.ts, sse.ts, model-call.ts
│  │  └─ scripts/bundle.mjs             # esbuild → dist/index.cjs
│  ├─ web/
│  │  ├─ src/
│  │  │  ├─ main.ts                     # ONLY module owning side effects: auth, catalog, sessions, turns, providers, routing
│  │  │  ├─ app-state.ts                # pure UI reducer over AppState (extends shared turn reducer)
│  │  │  ├─ api.ts                      # ApiClient: bearer on every request, fetch-streamed SSE with Last-Event-ID
│  │  │  ├─ app-shell.ts, workspace.ts, project-sidebar.ts, inspector.ts, tool-timeline.ts
│  │  │  ├─ approval-view.ts, skills-palette.ts, dom.ts, keyboard-nav.ts, ui-route.ts
│  │  │  ├─ providers/ {provider-form, provider-cards, provider-page}.ts
│  │  │  ├─ settings/ {security-page, storage-page, settings-shell, about-page}.ts
│  │  │  └─ usage/usage-page.ts, workspace-catalog.ts
│  │  ├─ public/{app.css, index.html, dashboard.css, dashboard.html}
│  │  ├─ e2e/{ui, workspace, dashboard, providers-workspace, accessibility, deep-routes, responsive, model-discovery}.spec.ts
│  │  └─ scripts/bundle.mjs             # esbuild → dist/app + dist/dashboard
│  └─ desktop/
│     ├─ src/
│     │  ├─ main.ts                     # Electron main: spawns server-process, window, IPC
│     │  ├─ server-process.ts           # boots bundled server on ephemeral port, in-memory token, process-tree kill
│     │  ├─ preload.ts                  # sandboxed bridge, allowlisted methods only
│     │  ├─ desktop-bridge.ts, paths.ts, workspace-catalog.ts, crash-diagnostics.ts
│     │  ├─ renderer.html / renderer.ts # /desktop renderer
│     ├─ scripts/{build.mjs, copy-assets.mjs}
│     ├─ electron-builder.yml            # NSIS per-user, SHA256, signing honored when WIN_CSC_* set
│     └─ test/{main-flow, packaging, server-process, preload, paths, workspace-catalog, release-contract}.test.ts
├─ scripts/
│  ├─ setup.mjs                          # install → typecheck → build
│  ├─ postinstall.mjs                    # verifies 4 workspaces on npm ci
│  ├─ ensure-built.mjs                   # prestart: builds when dist missing/stale (--desktop for desktop)
│  ├─ smoke-*.mjs, check-release.mjs, checksums.mjs
├─ eval/
│  ├─ README.md, run.mts, validate-provider.mts
│  ├─ tasks/{bug-fix, build-failure, feature, multi-file, refactor, skills}/ {project/, task.json, check.js, solution.mjs}
│  └─ results/scripted-2026-09-20.json   # historical sample (tracked via git add -f)
├─ docs/
│  ├─ INSTALL.md                         # full status matrix, prerequisites, running server, config table, troubleshooting
│  ├─ THREAT_MODEL.md                    # trust boundaries
│  ├─ adr/001..003                       # turn reducer seq, approval identity, skills-instructions-only
│  └─ research/2026-09-22-b5-security-review.md   # cited by SECURITY.md; the only file left in research/
├─ Setup-WindowRunner.cmd                # double-click one-time setup (ASCII, CRLF, no BOM)
├─ Start-WindowRunner.cmd                # double-click start (ASCII, CRLF, no BOM)
├─ install.ps1                           # Windows PowerShell installer (BOM + CRLF, checkout + fresh-clone modes)
├─ Dockerfile / docker-compose.yml       # server-bundle verification (CI/dev, not user platform)
├─ package.json                          # root workspaces, scripts (build, test, start, eval), bin, files, engines
├─ package-lock.json
├─ tsconfig.json
├─ LICENSE (Apache-2.0), NOTICE, SECURITY.md, CHANGELOG.md, AGENTS.md, CONTEXT.md
└─ README.md                             # (this ship-ready rewrite) — professional GitHub front page
```

Ignored at runtime (not in zip, not in Git): `node_modules/`, `packages/*/dist/`, `eval/results/scripted-*.json` (ephemeral), `eval-scripted.json`, `test-results/`, `playwright-report/`, `*.tsbuildinfo`, `.windows-runner/crash-reports/`.

---

## 4. How to Install on Windows (Absolute Beginners)

**Prerequisite (once):** Install **Node.js LTS 22.x** from https://nodejs.org (Next → Next → Finish) and optionally **Git** from https://git-scm.com/download/win. Verify in PowerShell: `node -v` → `v22.x.x`, `git --version`.

### Option A — From the ZIP (recommended, easiest offline, no typing)

1. Right-click `WindowRunner-clean.zip` → **Extract All…** → **Extract**. Open the `WindowRunner` folder (you should see `package.json` and the two `.cmd` files).
2. Double-click **`Setup-WindowRunner.cmd`** (once, ~1 min). It checks Node ≥ 22 — opening https://nodejs.org/en/download and printing plain instructions when it is missing or too old — then runs `npm run setup`. It ends with "Setup finished — WindowRunner is ready to use." and pauses so the window cannot vanish.
3. Double-click **`Start-WindowRunner.cmd`** (every time). It runs `npm start` and tells the user to Ctrl-click the printed `ui:` address.

Both wrappers are pinned by `packages/server/test/packaging.test.ts` (plain ASCII, CRLF, no BOM, must still call `npm run setup` / `npm start`, must `pause` unless `-NoPause`), shipped in the npm tarball, and **executed on every Windows CI run** by `npm run smoke:launchers` (the wrapper runs the full setup; the second wrapper starts the app and is probed on `/healthz` before its process tree is torn down). A human double-click on a desktop has still not been observed — `docs/INSTALL.md` is the authority on exactly which modes are covered.

Command-line equivalent (same commands, typed):

```powershell
npm ci      # or: npm run setup  (install + typecheck + build)
npm start
```

`install.ps1` alternative: `powershell -ExecutionPolicy Bypass -File .\install.ps1` does install+build+offer start.

### Option B — One-line fresh clone (with internet)

```powershell
irm https://raw.githubusercontent.com/StepenkoAnatoli/WindowRunner/main/install.ps1 | iex
```
Clones to `~/windows-runner`, installs, offers to start. If blocked: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, reopen PowerShell.

### Option C — Desktop installer (when Release published)

Download `WindowRunner-Setup-<version>.exe` (and `SHA256SUMS.txt` to verify: `Get-FileHash .\WindowRunner-Setup-*.exe -Algorithm SHA256`), double-click → per-user install (no admin), Start Menu entry, data in `%APPDATA%\WindowRunner`. Until a signed Release exists, use Option A.

**Always verify** downloads only from this repo's Releases or the npm tarball. Troubleshooting copy-pastes: `docs/INSTALL.md` bottom.

---

## 5. How to Run the Project

```powershell
npm start          # http://127.0.0.1:7634  (mock offline, builds automatically if needed)
npm run dev        # tsx watch on server entry (developers)
```

- `npm start` runs `packages/server/dist/index.cjs` (prestart `scripts/ensure-built.mjs` builds when `dist/` missing/stale) and serves the web UI at `/` from `packages/web/dist/app` when present.
- Banner prints `windows-runner listening on http://127.0.0.1:7634` and `ui:` URL with `#token=…` (memory mode). File mode token is at `<dataDir>/auth-token` (default `~/.windows-runner` or `%APPDATA%\WindowRunner`).
- All `/api` routes require `Authorization: Bearer <token>` (constant-time), plus Host/Origin validation (loopback only unless allowlists set). `/healthz` is public liveness.
- `Ctrl+C` drains: stop accepting → `abortActiveTurns` → wait `WINDOWS_RUNNER_SHUTDOWN_GRACE_MS` (5000 ms) → force close.
- **Real models:**
  - OpenAI-compatible: `WINDOWS_RUNNER_PROVIDER=openai-compatible` `WINDOWS_RUNNER_MODEL=gpt-4o-mini` `WINDOWS_RUNNER_MODEL_BASE_URL=https://api.openai.com/v1` (or `http://127.0.0.1:11434/v1` for Ollama) `WINDOWS_RUNNER_MODEL_API_KEY=sk-...`
  - Anthropic: `WINDOWS_RUNNER_PROVIDER=anthropic` `WINDOWS_RUNNER_MODEL=claude-sonnet-4-5` `ANTHROPIC_API_KEY=...`
  - Mock: default, no key, replies prefixed `[mock]`
- File persistence: `WINDOWS_RUNNER_PERSISTENCE_MODE=file` (uses `WINDOWS_RUNNER_DATA_DIR`, default `~/.windows-runner`).

Full ENV table: `packages/server/src/config.ts` (single source) and `docs/INSTALL.md#configuration`.

---

## 6. How to Run Tests / Break-Test Suite

```powershell
npm test                              # ALL 4 workspaces: shared, server, web, desktop (desktop pretest auto-builds)
npm run typecheck                     # tsc --noEmit for shared+server+web
npm run build                         # shared + server (incl. bundle) + web
npm run check:release                 # version single-source + changelog format (B5 gate)
npm run smoke:packed                  # tarball content matches files manifest
npm run smoke:packed:start            # unpack tarball outside repo, boot npm start, hit /healthz & /api/health, check web UI served
npm run smoke:launchers               # Windows only: drives Setup-/Start-WindowRunner.cmd under cmd.exe (skips elsewhere)
npm run smoke:start                   # boot built server on PORT=0 file mode, mock turn over SSE (contiguous seq, JSONL+meta persisted), PATH_ESCAPES_ROOT, token enforcement, SIGTERM, reboot recovery, HOST refusal
npm run eval -- --expect-pass         # 6 scripted tasks (bug-fix, build-failure, feature, multi-file, refactor, skills) via fake OpenAI endpoint — 0 spend, deterministic
npm run eval -- --expect-pass --task skills   # single task
npm run validate:provider             # ordered probe of a real endpoint before eval (text → cancel → failures → tools), 4 stages, stops on first failure
```

Web/Desktop E2E (need Chromium/Electron binaries; CI proves on `windows-latest`):

```powershell
npm run test:desktop                  # desktop unit + contract tests
npm run smoke:desktop                 # page smoke + Electron smoke (Playwright _electron)
npm run e2e                           # web Playwright Chromium suite (ui, workspace, dashboard, providers-workspace, accessibility, deep-routes, responsive, model-discovery)
npm run e2e:desktop                   # real Electron journey: core + B2 providers/settings, plus installer variant in CI
npm run package:desktop:win           # NSIS installer → packages/desktop/release/WindowRunner-Setup-<version>.exe
```

No API keys required for `npm test` or eval scripted — fakes in `packages/server/test/fakes/` cover OpenAI + Anthropic SSE.

---

## 7. Every Important File and Its Purpose

| File | Purpose |
|------|---------|
| `package.json` (root) | Workspaces (shared/server/web/desktop), `bin` (windows-runner, wr), `files` manifest for `npm pack`, `engines.node >=22`, scripts (build, test, typecheck, start, dev, setup, smoke:*, eval, e2e) |
| `bin/windows-runner.js` | Executable CLI launcher — `createRequire` then `require(dist/index.cjs)` |
| `packages/shared/src/index.ts` | Single owner of `StreamEvent` union, `TurnState`, `reduceTurnState`, `createInitialTurnState` — used by server + UIs |
| `packages/shared/src/workspace-catalog.ts` | Catalog shape/validation (ProjectCatalogEntry, SessionCatalogEntry) shared by web + desktop (never duplicated) |
| `packages/server/src/index.ts` | Boot entry: `loadServerConfig` → `startServer` → banner + `ui:` URL + signal drain. Importing starts server. |
| `packages/server/src/config.ts` | `ENV` table, strict parsing, defaults: loopback 7634, mock, memory, allowedRoots=home, 5 s grace |
| `packages/server/src/boot.ts` | `createRuntime()`, `resolveAuthToken`, restart recovery (`TurnManager.boot` + `FileSessionStore.boot`), BootDiagnostics, graceful shutdown |
| `packages/server/src/app.ts` | Express factory: security → body limits → validation loop → routes → lifecycle (`close`, `abortActiveTurns`). No request handling itself |
| `packages/server/src/security.ts` | `createSecurityPolicy()` middleware: Host (loopback+bind+allowedHosts) → Origin (loopback or allowedOrigins, never `null`/`*`) → bearer token constant-time |
| `packages/server/src/project-root.ts` | ONLY filesystem authority: logical containment + realpath checks for every tool path and session cwd. `safePath` semantics |
| `packages/server/src/agent/loop.ts` | Turn loop: up to `maxSteps` model calls, tools sequential, approvals via promise, trust checked *before* approval, retry, SSE seq |
| `packages/server/src/agent/turn-manager.ts` | Owns `seq` monotonic per turn, persistence append, `subscribe` with atomic replay+live, cancel, durableBeforeNotify |
| `packages/server/src/agent/session-manager.ts` | Pins ProjectRoot per session, one-active-turn policy (409 TURN_ALREADY_ACTIVE), re-validation on boot |
| `packages/server/src/agent/approval-registry.ts` | UUID `requestId` minted locally, promise blocked until `POST .../approve` (approve/deny) |
| `packages/server/src/agent/project-trust.ts` | TrustRegistry keyed by realRoot+configHash (sha256), persisted to `trust.json` 0600, exposed via `/api/sessions/:id/trust` |
| `packages/server/src/agent/skills.ts` | Discover/parse `.windowrunner/skills/*/SKILL.md` (frontmatter + markdown), capped 40, never throws, diagnostics on exclusion, trust=untrusted repo content |
| `packages/server/src/agent/tools/builtin.ts` | The **complete 6-tool set**: `read_file`, `write_file`, `edit_file`, `list_dir`, `run_terminal`, `read_skill` — each `{spec, requiresApproval, preview, execute}` |
| `packages/server/src/agent/tools/executor.ts` | Sequential execution, preview, error mapping to recoverable results |
| `packages/server/src/agent/file-turn-log-store.ts` | File adapter: JSONL per turn, per-turn promise queue, O_APPEND, crash-truncate, quarantine >50% invalid, RESTART idempotent |
| `packages/server/src/agent/file-session-store.ts` | `meta.json` versioned, atomic temp+rename, activeTurnId cleared on boot, re-validates root vs current allowedRoots |
| `packages/server/src/http/runtime.ts` | `AppRuntime` per-app state shared by route modules (activeControllers only here) |
| `packages/server/src/http/validate.ts` | Shared id/body/cursor guards (SESSION_ID_INVALID, BODY_TOO_LARGE, CURSOR_INVALID) |
| `packages/server/src/http/static-ui.ts` | Serves web app at `/`, deep-route allowlist for SPA, `/desktop` for Electron, `/healthz` liveness |
| `packages/server/src/http/routes/{sessions, turns, providers, observability, skills}.ts` | One owner per resource; skills route returns name+description (40 cap) + diagnostics, never bodies |
| `packages/server/src/providers/{openai-compatible, anthropic, mock, retry, sse}.ts` | `LLMProvider` contract over `LLMChunk`, shared SSE reader, explicit error codes (MODEL_AUTH, RATE_LIMITED, etc.), mock offline |
| `packages/web/src/main.ts` | ONLY DOM side-effect owner: auth, catalog, desktop picker, session/turn/SSE/cancel/approve/trust, route, provider/usage loaders, render coalesce via rAF |
| `packages/web/src/app-state.ts` | Pure UI reducer (`reduceApp`) over `AppState`: auth, session, turns, busy, workspace catalog, route, providers, usage |
| `packages/web/src/api.ts` | `ApiClient`: bearer on every fetch, SSE streaming via fetch (not EventSource), `Last-Event-ID` resume with bounded backoff |
| `packages/web/src/app-shell.ts` | Three-column grid shell (sidebar-collapsed/inspector-collapsed), sticky panels, overlays ≤800px |
| `packages/web/src/project-sidebar.ts` | Catalog sidebar: Projects (sorted), Sessions per project, Choose folder / open path, new/delete session, blocked while active turn |
| `packages/web/src/workspace.ts` | Center workspace: composer (Message textarea, Send/Stop), trust prompt, turn cards, `/`-skills palette |
| `packages/web/src/approval-view.ts` | Shared approval rendering with identical preview for center (`approval`) and inspector (`inspector-approval`) via namespace |
| `packages/web/src/providers/*` | Provider page, form (password key never prefilled, aria-invalid), cards, discovery (one-shot Fetch models), compatibility |
| `packages/web/src/settings/*` | Read-only Security/Storage/About from `/api/health`; Storage → Forget catalog only |
| `packages/desktop/src/main.ts` | Electron main: single instance, window, server spawn, deep link handling, crash diagnostics |
| `packages/desktop/src/server-process.ts` | Spawns `dist/index.cjs` via `ELECTRON_RUN_AS_NODE` on 127.0.0.1:0, in-memory token, waits for ready line, clean tree kill |
| `packages/desktop/src/preload.ts` | Sandboxed bridge: allowlisted `window.desktop` methods (pick folder, catalog IPC, etc.) |
| `packages/desktop/src/paths.ts` | Per-user paths: `%APPDATA%\WindowRunner` for data, logs, catalog |
| `packages/web/public/app.css` | Full B1+B2 styles: CSS vars, light/dark, grid, cards, diff, provider/usage/settings, responsive 1100/900/800/700 |
| `install.ps1` | Windows installer PowerShell script (BOM + CRLF): Node/git checks, checkout vs fresh-clone, `npm run setup`, offers `npm start` |
| `Setup-WindowRunner.cmd` | Beginner path, step 1: Node ≥ 22 check (opens the download page and explains Next-Next-Finish when missing/old) → `npm run setup` → "ready" message + `pause`. Plain ASCII, CRLF, no BOM (a BOM makes cmd.exe execute it as a command); `-NoPause` for automation; contract-pinned in `packages/server/test/packaging.test.ts`, executed for real by `npm run smoke:launchers` on Windows CI, and shipped in the npm tarball |
| `Start-WindowRunner.cmd` | Beginner path, step 2: verifies the folder and `node_modules`, then `npm start` with a plain-language "Ctrl-click the `ui:` address" instruction and `pause`. Same encoding contract, same `-NoPause` switch, same CI execution and tarball membership |
| `scripts/*.mjs` | `setup.mjs`, `postinstall.mjs`, `ensure-built.mjs`, `smoke-start.mjs`, `smoke-packed.mjs`, `smoke-packed-start.mjs`, `smoke-launchers.mjs`, `check-release.mjs`, `checksums.mjs`, `release-notes.mjs`, `temp-path.mjs` — build/lifecycle/verification |
| `scripts/smoke-launchers.mjs` | Windows-only proof that the beginner path works: runs `Setup-WindowRunner.cmd -NoPause` (asserts the Node check and the setup banner through the wrapper) and `Start-WindowRunner.cmd -NoPause` (ready line + `/healthz` 200 + process-tree teardown). Skips with a note on other platforms; the `Platform (windows-latest)` CI leg runs it. `packages/server/test/packaging.test.ts` fails if CI stops running it on Windows |
| `docs/INSTALL.md` | Install-path status matrix (verified rows), prerequisites, The path that works, build outputs, Running the server, config table, auth, provider management, troubleshooting |
| `eval/run.mts` | Eval harness: boots real server per task, fake provider runs `solution.mjs`, checks hidden `check.js`, writes JSON report |
| `eval/validate-provider.mts` | Single-endpoint validation probe (text→cancel→failures→tools) before spending on full eval |
| `docs/adr/003` | Skills-are-instructions-only invariant: markdown only, `read_skill` no approval, can never widen approval (pinned by `skills-security.test.ts`) |

---

## 8. Currently Implemented Features

- Agent loop over SSE: sessions pinned to project root, one active turn, streamed events with monotonic `seq`, Last-Event-ID resume, explicit terminals (`turn_completed`/`turn_cancelled`/`turn_failed`), host provider swap between turns
- Six root-confined tools with previews: `read_file` (line range), `write_file`, `edit_file` (exact unique match), `list_dir`, `run_terminal` (bounded, secret-stripped env, process-tree kill), `read_skill`
- Approval registry: every `write_file`/`edit_file`/`run_terminal` mints a UUID requestId and blocks until `POST .../approve` → `approved`/`denied`; independent of SSE connection
- Project trust: grants keyed by realRoot+configHash, persisted, stale-hash refusal, `GET/POST/DELETE /api/sessions/:id/trust`
- Bring-your-own-key providers: `mock` offline, `openai-compatible`, native `anthropic`, profiles masked (`****last4`), model discovery one-shot, test, activate, usage history bounded (8 MiB + rotation)
- File persistence: per-turn JSONL + meta.json, atomic writes, fsync optional, durableBeforeNotify, crashRecovery (truncate tail), quarantine >50%, restart RESTART at maxSeq+1 idempotent, single-writer per dataDir documented
- Security: loopback-only bind default, Host+Origin validation, bearer token constant-time, 401/403 with stable codes, keys redacted everywhere, metrics/Health alerts
- Project skills: discovery of `.windowrunner/skills/<name>/SKILL.md`, index injected into first user message (labelled untrusted), on-demand `read_skill`, diagnostics, palette via `/` (caps 40)
- Web UI: framework-free three-column workspace, top route host (Workspace | Providers | Usage | Settings), inspector, keyboard arrow focus, responsive ≤800 overlays, deep-route allowlist, fetch-stream SSE
- Desktop shell: Electron boots bundled server on ephemeral loopback with in-memory token, sandboxed preload, clean shutdown, per-user NSIS install that preserves `%APPDATA%\WindowRunner` across upgrade/uninstall, `SHA256SUMS.txt`, signing pipeline proven in CI
- CI: 7 required jobs on ubuntu + windows-latest (CI, Browser E2E, Docker, Platform, Desktop, Desktop installer+upgrade, Desktop signing) + release draft with checksum/changelog, npm-publish dry-run workflow

Not implemented (explicitly): MCP, project-context auto-discovery, web search — no `grep`, `apply_patch`, `git_*`, `web_*`, `mcp_*` tools. The trust gate exists; project-supplied runtimes do not.

---

## 9. UI/UX Decisions and Why They Are Beginner-Friendly

- **Plain language everywhere:** Buttons say **Send, Stop, Approve, Deny, Trust this project, Use this, Choose folder…** — never “dispatch”, “invoke”, or “execute”. Inline `hint` text explains each card.
- **Obvious primary actions:** `Send` is `primary` (blue), `Stop`/`Deny` is `danger` (red), secondary actions muted. Approval cards are `role=alertdialog` with stable `data-testid` so E2E (and a new user) can find them instantly.
- **Windows-first wording (2026-09-23 finisher pass):** every example path is a Windows path (`C:\Users\me\my-project`), the sidebar adds the reassurance "the agent can only read and change files inside the folder you choose", the empty conversation says "Pick a project on the left, then click New session", and the browser token screen is titled **Sign in** with instructions to Ctrl-click the `ui:` address the server printed (the `token:` line is the fallback), instead of the old "API token"/"Bearer token" jargon.
- **Three-column that collapses gracefully:** Desktop ≥1100: 280 | 1fr | 360; ≤1100: 220 | 1fr | 300; ≤800: single column with sidebar/inspector as fixed overlays (z-index, shadow) with collapse toggles always on top. A novice at narrow width still sees the chat centered (max 880 px) while the rails overlay, never causing horizontal scroll.
- **Notices never trap focus:** Success/error/info banners are static (`position: static`) — they don't cover the composer or trap the tab order. A failed turn notes the code (MODEL_AUTH, PATH_ESCAPES_ROOT) with a one-sentence human hint.
- **Two views, one preview:** Center approval and inspector approval share `renderApprovalPreview` — the diff/command/json preview is byte-identical in both places, so a user moving eyes left↔right sees the same thing.
- **One active stream rule:** Switching projects/sessions while a turn runs is blocked with a red hint `Finish or stop the active turn before switching` — no silent cancel, no race.
- **Auth is invisible after first load:** Banner's `ui:` token fragment is consumed into `sessionStorage` and stripped from URL; desktop injects token into window memory. No token field to hunt for.
- **Skills are discoverable not magical:** `Project skills` collapsed `<details>` lists skills + diagnostics verbatim; `/` palette on the composer inserts `/<name>` and submits — same `read_skill` path, no hidden injection.
- **Provider form safety:** Key input is `type=password`, never prefilled with mask, aria-invalid linked to field errors, Cancel/Escape goes through discard-confirm when dirty. **Fetch models** is one-shot with explicit idle/loading/ready/error states; anthropic says “discovery unavailable” rather than fake empty.
- **Sticky but bounded context:** Sidebar + inspector sticky with `max-height: calc(100vh-24px)` and scroll, so long histories don't push the page down and focus/scroll survive re-renders (rAF coalesced).
- **Tooltips where novices hesitate:** `Trust this project` card explains “Approving a single call never grants this. Trusting lets this project's config execute until revoked.” Provider kind hints spell out which URLs need which provider (Ollama local URL shown explicitly).

---

## 10. Known Limitations / Intentional TODOs

- **npm not yet published (G-05):** `npx windows-runner` 404s. Workflow exists (`.github/workflows/npm-publish.yml`), dry-run by default; needs maintainer to set `NPM_TOKEN` and dispatch with `dry_run: false`. Until then use ZIP + `npm ci`.
- **No OS keychain:** Keys in `<data dir>/provider-profiles.json` mode 0600, plaintext at rest (masked in UI/logs). Tradeoff documented in `RELEASE_CHECKLIST.md`.
- **Single writer per dataDir:** `FileTurnLogStore` serialized queue within one process; multi-process unsupported (no file lock, O_APPEND insufficient for cross-process session correctness).
- **Installer unsigned until cert provided:** Build signs when `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD` set; CI `Desktop signing` proves pipeline with self-signed cert (offline, unstamped). SmartScreen warns until OV/EV cert added (optional `WIN_CSC_EXPECTED_SUBJECT` pin).
- **Not a sandbox:** Approved `run_terminal` runs as *you* with full privileges. Only approve what you would type; use a VM for untrusted repos.
- **macOS/Linux not user platforms:** Windows-only product; Linux runners/Docker are dev/CI infra, no end-user installers/CI legs.
- **Transcript not persisted across refresh:** Sidebar catalog survives refresh; live transcript does not — reattach session to continue. Deep refresh only for `/providers`, `/usage`, `/settings/{security,storage,about}`.
- **Model costs not computed:** Usage logs tokens only; multiply by provider's price (dashboard `—` unless price table entry). Bundled price table empty by design.
- **Beginner wrappers are CI-executed, not yet human-tested:** `Setup-WindowRunner.cmd` / `Start-WindowRunner.cmd` are run for real by `npm run smoke:launchers` on the `Platform (windows-latest)` leg (setup banner through the wrapper, ready line, `/healthz` 200, process-tree teardown; green on run 35951799435, 2026-09-24) and contract-tested for encoding (ASCII/CRLF/no BOM), `-NoPause`, and the commands they call. What has never happened is a human double-clicking them in Explorer on a desktop, and `install.ps1` fresh-clone/prompt modes are CI-executed while `irm | iex` still has no coverage (docs/INSTALL.md is the authority).
- **E2E binaries need an unrestricted network:** Playwrights CDN and Electrons GitHub release assets are blocked in some sandboxes. The browser suite still runs there via the documented override `E2E_CHROMIUM_EXECUTABLE=<chromium> E2E_CHROMIUM_LD_LIBRARY_PATH=<libdir> npm run e2e` (a self-contained source is the `@sparticuz/chromium` npm package: extract `al2023.tar.br` for the shared libraries; this is how the 42-spec suite was verified on a CDN-less machine). The Electron journeys (`smoke:desktop`, `e2e:desktop`) have no substitute on such a machine and stay CI evidence.
- **Branding:** Default Electron icon; per-user data survives uninstall by design (intentional, not TODO).

---

## 11. Coding Conventions and Key Architectural Decisions

- TypeScript **strict**, ESM, no build needed for typecheck/test (`tsx` + `paths` to `src`); `tsconfig.build.json` compiles `src/` only and resolves `@windows-runner/shared` to `dist/index.d.ts` (hence `shared` builds first). Never commit `dist/` or `node_modules/`.
- **Add StreamEvent = update one `StreamEvent` union + handle in `packages/web/src/app-state.ts` reducer + write a test.** Keep shared reducer pure, UI reducer wraps it.
- Anything touching filesystem **must** go through `ProjectRoot.safePath(path)` — no direct `fs` on user-influenced paths. Logical containment + realpath double-check, tested against traversal + symlink escapes.
- New `any` forbidden in `src/http/` — route handlers typed `Request`/`Response`. Errors returned to model must be actionable (“old_str was not found…”) not stack traces.
- `ProjectRoot` empty allowedRoots is test-only; boot never uses it (defaults to home). `TurnManager` owns `seq`; `ApprovalRegistry` mints requestId locally (not from provider). Switching providers hot: next turn uses new provider, no restart.
- Keep server **free of UI concerns** and UI **free of provider specifics**. `main.ts` is the only side-effect owner; all rendering pure. `workspace-catalog` single-owned in `shared`.
- **Skills invariant:** A `SKILL.md` edit that changes `skills-security.test.ts` outcome is a security bug, not a test to relax. Skill is markdown instructions inside project root that `read_file` could already read; `read_skill` needs no approval but cannot widen approval — enforced in `skills-security.test.ts` with real runner + registry.
- **Validation order:** Host → Origin → token. Metrics count `securityRejections` by kind; health exposes `bootDiagnostics` (mode/tokenSource only). Keys redacted from all surfaces.
- **Drain order:** stop validation timer → `server.close()` + `closeIdleConnections()` → `abortActiveTurns` → wait grace → `closeAllConnections()`. Idempotent.
- **Three enum boundaries:** `TurnState`/`TurnStatus` terminal = completed|cancelled|failed; `WorkspaceCatalog` is device-local navigation metadata (no token/transcript); deep-route allowlist is explicit not catch-all (unknown 404).

---

## 12. Exact Commands Required

```powershell
# First-time setup (or reinstall)
npm ci                         # installs all 4 workspaces, runs postinstall verification

# Development lifecycle (what CI enforces)
npm run typecheck              # tsc --noEmit across shared+server+web
npm run build                  # shared → server (bundle → dist/index.cjs) → web (dist/app)
npm test                       # node:test via tsx across all workspaces

# Ship verification (what to run before releasing)
npm run smoke:packed            # tarball manifest contract (172 entries — includes the two .cmd launchers)
npm run smoke:packed:start      # unpack outside repo → npm start → /healthz & /api/health & web at /
npm run smoke:start             # mock turn SSE contiguous seq, persistence, Host/Origin/token enforcement, SIGTERM, recovery
npm run check:release           # version single-source + changelog format
npm run eval -- --expect-pass   # 6 scripted tasks via fake OpenAI, — 0 keys, writes eval/results/scripted-*.json (gitignored)
npm audit --omit=dev --audit-level=high   # no high vulns in runtime deps (express only)

# Desktop (on Windows for packaging)
npm run build:desktop           # tsc + build.mjs + copy-assets → desktop/dist
npm run smoke:desktop           # page + Electron smoke
npm run e2e:desktop             # Playwright Electron journey (core + providers/settings)
npm run package:desktop:win     # NSIS installer → WindowRunner-Setup-<version>.exe + SHA256SUMS.txt
npm run package:desktop:win:release  # same but forceCodeSigning (fails if unsigned)

# Running
npm start                       # http://127.0.0.1:7634 (prestart builds if stale)
npm run dev                     # tsx watch server only
docker compose up --build       # server-bundle verification (CI job), not user platform

# PowerShell installer
.\install.ps1                  # from checkout (or irm https://raw.githubusercontent.com/StepenkoAnatoli/WindowRunner/main/install.ps1 | iex)
.\install.ps1 -NoStart         # clone+setup without offering to start (CI mode)

# Beginner double-click path (Explorer; not runnable from a POSIX shell)
Setup-WindowRunner.cmd         # one time: Node check + npm run setup
Start-WindowRunner.cmd         # every time: npm start
```

Environment variables you may set: see `packages/server/src/config.ts` `ENV` — `HOST`, `PORT`, `WINDOWS_RUNNER_ALLOW_REMOTE`, `WINDOWS_RUNNER_AUTH`/`_TOKEN`, `WINDOWS_RUNNER_ALLOWED_HOSTS`/`_ORIGINS`, `WINDOWS_RUNNER_PROVIDER`/`_MODEL`/`_BASE_URL`/`_API_KEY`/`_MAX_RETRIES`/`_MAX_STEPS`/`_CALL_TIMEOUT_MS`, `WINDOWS_RUNNER_TOOLS`, `WINDOWS_RUNNER_TERMINAL_*`, `WINDOWS_RUNNER_PERSISTENCE_MODE`/`_DATA_DIR`/`_DURABLE_BEFORE_NOTIFY`/`_FSYNC`, `WINDOWS_RUNNER_ALLOWED_ROOTS`/`HOME`, `WINDOWS_RUNNER_SHUTDOWN_GRACE_MS`.

---

*End of prompt. This file lives at `PROJECT_PROMPT.md` and is bundled in the clean zip. Keep `README.md` as the human-facing front page and this prompt as the machine-facing blueprint.*
