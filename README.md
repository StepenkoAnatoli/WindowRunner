# Windows Runner

A local-first desktop coding agent you run **with your own API keys**. Point it at a project folder, and it reads the files, understands the build system, and implements changes — auto or manual. The server, tools, and persistence run on your machine with no account or telemetry; requests to configured model, search, and MCP providers cross their respective trust boundaries as described below.

WindowsRunner is a **Windows-first, local-first coding agent**: parallel local sessions, file editing with reviewable diffs, a terminal, skills and MCP tools, all running on your machine with your choice of model.

## ✨ Key features

- **Project context auto-discovery** — Point the agent at a folder and it automatically reads `package.json`, `tsconfig.json`, `Makefile`, `Cargo.toml`, and other build config files to understand how to build, test, and run your project (inspired by Claude Code).
- **Auto-build & Manual-build skills** — Two modes: autonomous implementation (agent does everything end-to-end) or teaching mode (agent coaches you through building it yourself).
- **Premium dark UI** — glassmorphism, subtle gradients, Inter + JetBrains Mono, animated micro-interactions inspired by Linear/Raycast/Vercel.
- **One-command source setup** — `npm run setup` installs, typechecks and builds a checkout, and `npm start` boots the server (building first if needed). The no-build packed path (`npx windows-runner`, `npm i -g windows-runner`) is **not available yet**: see [docs/INSTALL.md](./docs/INSTALL.md) for what is verified and what is blocked.

## 🚀 Installation

Full details, prerequisites, known gaps and troubleshooting:
**[docs/INSTALL.md](./docs/INSTALL.md)**. Notable changes are tracked in
**[CHANGELOG.md](./CHANGELOG.md)**.

Status below is what was actually executed on Linux (Node 22, npm 10) — not what
the packaging intends. CI covers Linux (`CI` job), Docker (`Docker` job) and
Windows/macOS (`Platform` matrix); the installers run in checkout mode only
(fresh-clone and interactive modes untested).

| Path | Status |
| --- | --- |
| Clone + `npm ci` / `npm run setup` / `npm test` / `npm run build` | **Verified** (Linux) |
| `npm start` (HTTP API on `127.0.0.1:7634`, offline mock provider, no tools, no UI) | **Verified** (Linux) |
| `npm run smoke:packed` (tarball contents) | **Verified** (Linux) |
| `npm run smoke:packed:start` (tarball startup in clean directory) | **Verified** (Linux) |
| `npm run smoke:start` (boots the built server, runs a turn, restarts, clean SIGTERM) | **Verified** (Linux) |
| Packed artifact: `npx windows-runner` / `npm i -g windows-runner` / `wr` | **CLI entry shipped** — bin launcher exists; package unpublished (gap G-05) |
| `npm run dev` | **Server only** — `tsx watch` on the server entry; no web dev server or bundler |
| Docker / `docker compose up` | **Verified** (Linux CI) — `Docker` job builds the image and runs a mock turn against the self-contained bundle `dist/index.cjs` |
| `install.sh` | Experimental — executed on macOS CI in checkout mode (`--no-start`); fresh-clone and interactive modes untested |
| `install.ps1` | Experimental — executed on Windows CI in checkout mode (`-NoStart`); fresh-clone and interactive modes untested |
| Electron desktop shell | **Available** — `packages/desktop`; `npm run package:desktop:win` builds the NSIS installer (built, installed, exercised and uninstalled by the `Desktop installer` CI job) |

### Option 1 — Clone and set up (the path that works)

```bash
git clone https://github.com/StepenkoAnatoli/WindowRunner.git
cd WindowRunner
npm ci            # installs all three workspaces, runs the postinstall check
npm run setup     # install -> typecheck -> build, in one step
npm test          # full suite, no API keys required
npm run build     # emit packages/*/dist
npm start         # serve the API on http://127.0.0.1:7634
```

`npm ci` runs a real `postinstall` hook that verifies the workspace tree and
fails with an actionable message if it is broken. Set
`WINDOWS_RUNNER_SKIP_POSTINSTALL=1` to bypass it.

`npm start` runs `packages/server/dist/index.cjs` (its `prestart` hook builds
when `dist/` is missing or stale). What starts is the HTTP API plus a **minimal
web UI** served at `/` (`packages/web`): the offline `mock` provider is the
default (set `WINDOWS_RUNNER_PROVIDER=openai-compatible` or `anthropic` for a real model),
five root-confined tools are registered, every `/api` route
requires a bearer token (printed once in memory mode — the banner's `ui:` line
carries it as a `#token=` fragment the page consumes and removes — and stored
at `~/.windows-runner/auth-token` in file mode), and the server binds loopback
only. The UI talks to the API with `fetch` only (bearer on every request,
streamed SSE with `Last-Event-ID` resume); it is not exposed via any endpoint. Configuration, endpoints and limits are in
[docs/INSTALL.md → "Running the server"](./docs/INSTALL.md#running-the-server).
`npm run smoke:start` boots the built server and runs a turn against it.

### Option 2 — Packed artifact

`bin/windows-runner.js` is the CLI launcher (declared as `windows-runner` and
`wr` in `package.json`). `npm run smoke:packed:start` proves that packing the
tarball, unpacking it in a clean temporary directory outside the repository,
and executing `npm start` boots and answers health queries without workspace
symlinks. Until the package is published to the registry (`npm view windows-runner`
returns `E404`, gap G-05), local tarball installation works.

### Option 3 — Curl installer (Unix, experimental)

```bash
curl -fsSL https://raw.githubusercontent.com/StepenkoAnatoli/WindowRunner/main/install.sh | bash
# options: --no-start; WINDOWS_RUNNER_HOME / WINDOWS_RUNNER_REPO_URL override the target and source
```

Clones a checkout and runs `npm run setup`. On an interactive terminal it then
offers to run `npm start`; when piped as above it prints the command instead
and never blocks. `--no-start` skips the offer.

### Option 4 — PowerShell (Windows, experimental)

```powershell
irm https://raw.githubusercontent.com/StepenkoAnatoli/WindowRunner/main/install.ps1 | iex
# or: .\install.ps1 -NoStart
```

CI executes this script on `windows-latest` in checkout mode with `-NoStart`
(gap G-06 lifecycle coverage); the fresh-clone and interactive-prompt modes
have no recorded result. If Windows refuses to run the script, see
[docs/INSTALL.md → "Troubleshooting"](./docs/INSTALL.md#troubleshooting)
(execution policy).

### Option 5 — Docker

```bash
docker compose up --build
```

Builds the multi-stage container image using the self-contained server bundle
(`packages/server/dist/index.cjs`, closing gaps G-03 and G-04). The image runs
the standalone bundle directly without requiring `node_modules` or workspace
symlinks in the runtime container. CI verifies this on every push and pull
request (the `Docker` job). See [docs/INSTALL.md](./docs/INSTALL.md#docker).

### Option 6 — Windows desktop app (Electron)

The desktop shell (`packages/desktop`) boots the bundled server as a child
process (loopback, OS-assigned port, in-memory bearer token) and loads the web
UI at `/desktop` from the server's own origin. A refresh of `/providers`,
`/usage`, or a settings section republishes that in-memory token; it is never
written to the URL or web storage (the browser keeps its token in
`sessionStorage` instead). No Node.js install is required at
runtime: the server runs on Electron's own Node runtime. From a checkout:

```bash
npm run build            # server + web bundles
npm run build:desktop    # desktop shell + packaged payload
npm run e2e:desktop      # user journey against the unpacked app
```

Package the installer on Windows:

```bash
npm run package:desktop:win    # → packages/desktop/release/WindowRunner-Setup-<version>.exe
```

Run `WindowRunner-Setup-<version>.exe` for a per-user install (no admin/UAC;
Start Menu entry under `%LOCALAPPDATA%\Programs\WindowRunner`). User data —
sessions, provider profiles, logs — lives in `%APPDATA%\WindowRunner` and
survives uninstall. Automation: silent install/uninstall with `/S`. The
`Desktop installer (windows-latest)` CI job builds the installer, installs it
silently, drives the installed app through a mock session, and uninstalls it on
every push. See [docs/INSTALL.md](./docs/INSTALL.md#windows-desktop-app).

---

The default provider is the offline **mock** (no key, no network): the whole
loop — sessions, turns, SSE streaming, approvals — runs end to end without an
API key, in `npm start` and in the desktop app alike. Real model calls need a
provider profile (see the provider dashboard in
[docs/INSTALL.md](./docs/INSTALL.md#provider-dashboard)); real-model runs are
manual and never part of CI ([`eval/README.md`](./eval/README.md)). Locally
generated reports land in `eval/results/scripted-*.json`, which is
**intentionally gitignored** (the tracked `scripted-2026-09-20.json` is a
historical sample kept for reference). For
development, `npm run dev` restarts the server on source changes (`tsx watch`).

> Scope note: this section covers install, build and packaging claims only. The
> product-feature claims elsewhere in this README are tracked separately as
> P2-01 in [RELEASE_CHECKLIST.md](./RELEASE_CHECKLIST.md) and were not
> re-verified here.


## 📂 Project Context Auto-Discovery

When you point the agent at a folder, it automatically discovers and reads key project files to understand the build system, dependencies, and project structure. This is inspired by how Claude Code works — the agent reads your project's configuration files before making any changes.

### Files automatically discovered

| File | What it tells the agent |
| --- | --- |
| `package.json` | Build scripts, dependencies, project name |
| `tsconfig.json` | TypeScript configuration |
| `Makefile` | Build targets and commands |
| `Cargo.toml` | Rust project configuration |
| `go.mod` | Go module and dependencies |
| `pyproject.toml` / `setup.py` | Python project configuration |
| `Dockerfile` | Container build instructions |
| `.env.example` | Required environment variables |
| `README.md` | Project documentation |
| `AGENTS.md` / `CLAUDE.md` / `.windows-runner/instructions.md` | Agent-specific instructions |

The agent reads these files at session start and includes a summary in its system prompt, so it already knows how to build, test, and lint your project before you ask.

### How it works

1. **Session creation** — when you pick a project folder, the agent scans for recognized config files
2. **Context injection** — key build commands and project structure are included in the system prompt
3. **On-demand refresh** — the `read_project_context` tool lets the agent re-scan if files change mid-session
4. **Build skills use it** — both `auto-build` and `manual-build` skills reference the discovered context

## 🎨 Design system

This project features:

- **Tokens** — deep navy `#070a11`, panel `#0f131e`, border `#1e2636`, accent gradient `#8b9eff → #a48fff`.
- **Glass & blur** — headers and composer use `backdrop-filter: blur(20px)` with subtle radial glows.
- **Typography** — Inter for UI, JetBrains Mono for code, optical sizing and tighter tracking.
- **Motion** — `fadeIn`, `slideIn`, shimmer, pulse dots, hover lift on primary buttons.

All styles live in `packages/web/src/styles.css` (Tailwind v4 + custom utilities).

## Providers

| Provider | Status in this checkout |
| --- | --- |
| **Mock** | ✅ Default. Offline rehearsal of the whole loop — no key, no network |
| **OpenAI-compatible** | ✅ `WINDOWS_RUNNER_PROVIDER=openai-compatible`. Covers OpenAI, OpenRouter, Groq, Together, vLLM, llama.cpp, LiteLLM, LM Studio, Google Gemini's OpenAI endpoint |
| **Ollama** | ✅ via OpenAI-compatible: `WINDOWS_RUNNER_MODEL_BASE_URL=http://127.0.0.1:11434/v1`, no key |
| **Anthropic (native)** | ✅ `WINDOWS_RUNNER_PROVIDER=anthropic`, `WINDOWS_RUNNER_MODEL=claude-…`, key from `WINDOWS_RUNNER_MODEL_API_KEY` or `ANTHROPIC_API_KEY` |

Configure with `WINDOWS_RUNNER_MODEL` (required), `WINDOWS_RUNNER_MODEL_BASE_URL`
(default `https://api.openai.com/v1`) and `WINDOWS_RUNNER_MODEL_API_KEY` (or
`OPENAI_API_KEY`). The key is never printed and is redacted from error
messages. Instead of editing env vars for every switch, manage providers in
the UI (same bearer token as the API):

- **In the main UI** the top navigation is **Workspace | Providers | Usage |
  Settings** (routes `/providers`, `/usage`,
  `/settings/security|storage|about`). In-app moves do not reload the page;
  a refresh or a pasted link of those routes is served the same app shell
  (unknown paths stay 404). The attached session's catalog survives a refresh;
  the live transcript does not — reattach the session. The Providers page has the
  profile cards, the add/edit form, **Use this** (hot-swap: the *next* turn
  runs on the new profile, no restart), **Test**, and **Delete**; Usage lists
  the recent turns; Settings shows read-only security/storage/about
  information and can reset the locally remembered projects & sessions.
  Arrow keys move focus in the top nav, settings sections, and inspector tabs;
  Enter or Space activates.
- **Fetch models (model discovery, B4).** In the add/edit form, after typing
  the kind, base URL, and API key, **Fetch models** asks *this server* to
  probe the provider's model listing once and offers the result in a
  "Select a model…" dropdown; choosing one copies the id into the model field.
  The facts that matter:
  - **One-shot only.** Exactly one request per click — no polling, no
    auto-selection, no capability/pricing/context-window lookup, and discovery
    never saves or activates a profile.
  - **Supported kinds.** `openai-compatible` probes `GET {baseUrl}/models`
    (OpenAI, OpenRouter, Ollama, LM Studio, gateways — including local
    loopback endpoints). `mock` answers `["mock"]` offline. `anthropic` has no
    live listing yet: the form says "model discovery unavailable for this
    provider" up front and never pretends a static list is live data.
  - **Manual entry always remains.** Discovery is optional; the model text
    field is never replaced unless you pick from the dropdown, an empty
    result says "No models were returned. Enter the model id manually.", and
    a failed fetch leaves the form fully usable. Results clear when the kind,
    base URL, or key changes, so stale ids are never offered.
  - **Timeout.** The upstream probe gets ~5 seconds; timeouts and provider
    errors surface as secret-free messages in the form. Redirects from the
    provider are refused, not followed, and huge responses are cut off.
  - **API-key handling.** The raw key exists only in the open form (tab or
    desktop-window memory), travels once in the authenticated discovery
    request to this server (which uses it for the single upstream probe's
    `Authorization` header), and is never persisted: not in browser storage,
    the workspace catalog, the URL, logs, errors, or the discovery response.
    The browser never talks to the provider directly — all provider requests
    are made by the server.
- **`/dashboard` stays a compatibility entry point** that renders the same
  provider components (plus the quick chat) for older bookmarks — the URL is
  unchanged, no redirect.
- **Keys are masked everywhere in the UI.** The server returns only
  `****last4`; an edit form leaves the key blank ("keep the existing key") and
  sends a key only when you type a replacement. The browser never persists
  provider data: the form lives in tab memory only — never `localStorage`,
  never the workspace catalog, never the URL.
- On first boot the env provider becomes the `default` profile; after that the
  persisted choice wins. Keys managed through the UI are stored server-side in
  `<data dir>/provider-profiles.json` (mode 0600, **plaintext at rest** —
  no keychain integration yet; the key is never returned by any API, log line,
  or error).

## Skills

Skills are reusable instruction sets that stay **out of context until they are used**. A session starts bare — no skill is loaded — because which one applies depends on the task. Two ways to bring one in:

- **The model loads it.** The `skill` tool's description carries an index of names and one-line descriptions (~30 tokens each). When a task matches, the model calls `skill({name})` and the body comes back.
- **You load it.** Type `/` in the composer to pick one (that turn only), or pin one to the whole session with **+ skill** in the header.

A skill is a directory with a `SKILL.md`:

```
.windows-runner/skills/research-core/SKILL.md   # this project
~/.windows-runner/skills/research-core/SKILL.md # every project
```

### Skills shipped here

| Skill | What it does |
| --- | --- |
| `research-core` | Verification before decisions |
| `manual-build` | Teaching mode — you write the code, agent coaches |
| `auto-build` | Autonomous mode — agent does everything end to end |
| `brainstorm` | Product/architecture brainstorm |
| `subproject-discovery` | Reconstructs a project, selects three subprojects |
| `finisher` | End-of-session maintainer |
| `error-handler` | Crash recorder, auto-fixer and GitHub reporter — replaces break.test as living skill, records failures to `.windows-runner/crash-reports/` and `~/.windows-runner/crash-reports/` |

## MCP (Model Context Protocol)

Connect to external tool servers for additional capabilities. MCP lets the agent use tools from third-party servers — databases, APIs, filesystem access, and more.

### Configuration

Create `.windows-runner/mcp.json` in your project root:

```json
{
  "mcpServers": [
    {
      "id": "filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "env": {}
    },
    {
      "id": "fetch",
      "transport": "stdio",
      "command": "uvx",
      "args": ["mcp-server-fetch"]
    }
  ]
}
```

See `.windows-runner/mcp.example.json` for a complete example.

### How it works

1. **Session start** — the agent reads `mcp.json` and spawns configured servers
2. **Tool discovery** — each server advertises its available tools
3. **Qualified names** — MCP tools are prefixed: `mcp_<serverId>__<toolName>`
4. **Approval** — MCP tools require approval by default (external code execution)
5. **Cleanup** — servers are shut down when the run ends

### Popular MCP servers

- `@modelcontextprotocol/server-filesystem` — file operations in a sandboxed directory
- `mcp-server-fetch` — HTTP requests
- `@modelcontextprotocol/server-postgres` — PostgreSQL queries
- `@modelcontextprotocol/server-github` — GitHub API

## What the agent can do

Tools shipped in this checkout (`packages/server/src/agent/tools/builtin.ts`).
Every path is relative to the session's project root and cannot leave it —
not via `..`, absolute paths, encoded traversal or symlinks, for reads or writes.

| Tool | Approval |
| --- | --- |
| `read_file` (with optional line range), `list_dir` | never |
| `write_file`, `edit_file` (exact-match replace, must be unique) | **always asks first** |
| `run_terminal` | **always asks first** — runs in the project root, server secrets stripped from its environment, bounded output, killed as a whole process tree on Stop/timeout |

Set `WINDOWS_RUNNER_TOOLS=0` for a text-only agent. Tools described elsewhere in
this README (`grep`, `apply_patch`, `git_*`, `web_*`, skills, `mcp_*`) are not
implemented yet; the project-trust gate that will guard `mcp_*` already is.

### Error handling (new)

The `error-handler` skill is the evolution of `break.test.ts`. Failures are auto-recorded to two separate folders:

- **Global:** `~/.windows-runner/crash-reports/` — survives project deletion, zip and upload to GitHub
- **Project:** `<project>/.windows-runner/crash-reports/` — easy to find, gitignored

Each crash creates `.json` (bounded diagnostic context) + `.md` (GitHub-ready issue template). The skill can auto-fix then update the report with `fixed: true` and `fixDescription`, so users can upload both the break and the fix.

- UI: **Crash reports** button in sidebar footer opens a viewer with copy/download + upload instructions
- API: `/api/error-reports` lists, `/api/error-reports/:id` shows markdown, `/api/error-reports/:id/fix` marks as fixed
- Server: `uncaughtException`, `unhandledRejection`, provider errors and tool errors are auto-recorded without needing the skill

### Privacy and data flow

Local-first describes where WindowsRunner runs and stores its state; it does not mean every value remains on the machine.

Configuration, complete session transcripts, session memory, and crash reports are stored locally. Configured model and search providers receive the data needed for their requests; approved MCP servers and `web_fetch` calls cross their disclosed boundaries. There is no data-flow map in this repository: `docs/THREAT_MODEL.md` is cited by
`RELEASE_CHECKLIST.md` but does not exist, so the paragraph above is the only
recorded description of these flows.

Crash-report JSON and Markdown are redacted before they are written. The same redaction is applied again when a stored report is opened for preview, which also protects legacy reports. It removes configured provider/search credential values (including `env:NAME` values), secret-named nested fields, authorization credentials, and common token formats. Redaction is best-effort, not a guarantee: review the preview before sharing it.

Complete local session transcripts are intentionally not redacted because they provide conversation continuity and model context. WindowsRunner currently has no session-export feature; P1-01 does not add one.

Safety rails:

- The agent's own file tools are confined to the session's project directory
- File, session, skills and project-context API operations are restricted to
  **authorized project roots** — your home directory (and, on Windows, its
  drive) by default, plus any folders you add via `allowedProjectRoots` in
  Settings. A request that names a `cwd` outside those roots is rejected.
- `delete_file` refuses `.git` and project root
- Terminal commands need approval, are killed with their whole process tree at the timeout (120s default) or when you press Stop, no pty
- A short deny-list rejects obvious accidents (`sudo`, `rm -rf /`, `mkfs`, …)
- `web_fetch` refuses private/loopback addresses, validates redirects
- `.windows-runner-ignore` file in your project root tells the agent which files/directories to skip (same syntax as `.gitignore`)

**This is not a sandbox.** An approved shell command runs as *you*, with your
full privileges: it can read and write anywhere you can, reach the network and
use your credentials. The project-directory restriction applies only to the
built-in file tools, and the deny-list only catches a few well-known mistakes;
it does not make command execution safe. Only approve commands you would type
yourself, and run WindowsRunner on an untrusted repository the way you would run
that repository's own scripts — in a VM or container if that matters to you.
OS-level isolation is a separate project, not something the current controls
provide. (`docs/THREAT_MODEL.md` is referenced by the release checklist but is
not present in this checkout.)

## How it fits together

```
packages/
  shared/    turn-state reducer + types shared by server and UI
  server/    src/index.ts   boot entry point (`npm start`): config -> runtime -> listen -> drain
             src/config.ts  environment parsing, strict, safe defaults
             src/boot.ts    composes createApp(), recovers persisted state, graceful shutdown
             src/app.ts     Express app factory (REST + SSE), agent loop, executor, persistence, metrics
             src/providers/ LLMProvider contract, the offline mock, the openai-compatible and anthropic adapters, retry wrapper
  web/       UI-side turn-state projection (no bundler, no React in this checkout)
desktop/   Electron desktop shell: main process, preload bridge, /desktop renderer, NSIS packaging
scripts/
  setup.mjs         install -> typecheck -> build
  postinstall.mjs   verifies the workspace tree on npm ci / npm install
  ensure-built.mjs  `prestart`: builds when dist/ is missing or older than src/
  smoke-packed.mjs        validates the packed tarball against the manifest
  smoke-packed-start.mjs  unpacks the tarball outside source tree and verifies `npm start`
  smoke-start.mjs         boots the built server, runs a turn over SSE, restarts it, checks SIGTERM
bin/
  windows-runner.js       executable CLI launcher (`windows-runner`, `wr`)
docs/INSTALL.md     install-path status, how to run the server, packaging gaps (G-01..G-06)
install.sh / install.ps1   clone-and-setup installers (offer `npm start` at the end)
Dockerfile / docker-compose.yml   container deployment with self-contained bundle

packages/desktop/ itself is present (Electron shell + electron-builder NSIS
packaging, PR A). Still not present: scripts/desktop.mjs (the old
`npm run desktop` shim). Use the desktop scripts instead (root aliases:
build:desktop, smoke:desktop, e2e:desktop, package:desktop:win). Packaging
gaps are recorded in docs/INSTALL.md.
```

## Persistence

WindowsRunner supports two persistence modes with strong safety guarantees:

- **Memory (default)**: `InMemoryTurnLogStore` — deterministic test double, no durability, restart loses all, UI treats as failed.
- **File (production)**: `FileTurnLogStore` + `FileSessionStore` — JSONL per turn under `WINDOWS_RUNNER_DATA_DIR/sessions/<sessionId>/turns/<turnId>.jsonl` (primary) with `turns/<turnId>.jsonl` legacy flat fallback, plus `sessions/<sessionId>/meta.json` versioned metadata.

**File layout:**
```
WINDOWS_RUNNER_DATA_DIR/
  sessions/<sessionId>/meta.json  {version:1, sessionId, canonicalRoot, realRoot, createdAt, lastActivityAt, activeTurnId|null, allowedRootsSnapshot?}
  sessions/<sessionId>/turns/<turnId>.jsonl  JSONL per turn
  turns/<turnId>.jsonl  legacy flat fallback
  quarantine/<turnId>.jsonl.quarantined  >50% invalid lines moved here, cannot be loaded as active
```

**Durability:**
- Per-turn serialized queue `Map<turnId, Promise>` ensures serialized writes within one process.
- O_APPEND atomic <4KB, optional fsync (`WINDOWS_RUNNER_FSYNC=true` does open+write+fsync+close).
- `durableBeforeNotify` (default true for file mode): `appendAsync` awaits persistence before SSE — never emits before durable. Async mode (false) notifies before persist, faster but possible loss, RESTART appended on recovery.
- Crash recovery truncates incomplete last line before next append.
- Recovery: truncated final ignored, malformed middle skip+warn, duplicate seq keep first, out-of-order sorted on read with diagnostic (never rewrites file automatically except RESTART and truncated cleanup), gaps warn, identity mismatches reject/quarantine.
- Boot: re-validates every session root via `ProjectRoot.create(canonicalRoot, currentAllowedRoots)` with current config, never trusts persisted `canonicalRoot`, `realRoot`, `allowedRootsSnapshot` for authorization. Clears stale `activeTurnId`, persists updated meta. Appends exactly one `RESTART` at `maxSeq+1` for non-terminal turns, persisted and boot-idempotent across process restarts (file still 3 lines after second boot, not 4).
- Retention: `evictOldest` only evicts terminal turns, preserves active. `deleteTurnFile` for eviction.
- Diagnostics: `BootDiagnostics` {turnsLoaded, turnsWithRestart, eventsSkipped, truncatedLinesIgnored, gapsDetected, outOfOrderDetected, duplicatesSkipped, quarantinedFiles, warnings, persistenceFailures} observable via `/api/health` and `/api/diagnostics/persistence`.

**Single-process writer limitation (prominent):**
```
SERIALIZED WRITES WITHIN ONE PROCESS ONLY. Multi-process writers UNSUPPORTED — O_APPEND alone does NOT provide session-level correctness, no file lock. Run single server instance per dataDir.
```
Documented in `FileTurnLogStore` header, `CONTEXT.md`, `/api/health`, and deployment docs. For production, run single instance per dataDir or use external lock (future).

**Configuration defaults (safe):**
- `WINDOWS_RUNNER_DATA_DIR`: `~/.windows-runner` if not set; must be absolute. Only used and created in file mode.
- `WINDOWS_RUNNER_PERSISTENCE_MODE`: `memory` default (safe for dev), `file` for prod.
- `WINDOWS_RUNNER_DURABLE_BEFORE_NOTIFY`: true default for file mode (correctness), false for memory (performance).
- `WINDOWS_RUNNER_FSYNC`: false default (performance), true for durability.
- `WINDOWS_RUNNER_ALLOWED_ROOTS`: comma-separated absolute project roots. The server defaults to the home directory (`WINDOWS_RUNNER_HOME` overrides it); an empty list — "allow any" — is a test-only affordance of `ProjectRoot` that the boot path never uses.
- `FileTurnLogStore`: fsync false default, maxLineBytes 1MB.
- `TurnManager`: durableBeforeNotify false default for backward compat; the boot path sets it true in file mode.

See `docs/architecture/exploration-7-persistence/config-defaults.md` for complete defaults.

## Environment variables

Read by the server entry point (`npm start`). Set-but-invalid values fail the
boot with a message naming the variable; the full table with semantics is in
[docs/INSTALL.md → "Configuration"](./docs/INSTALL.md#configuration).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `7634` | Server port (`0` = ephemeral, printed in the ready line) |
| `HOST` | `127.0.0.1` | Bind address. Non-loopback is refused unless `WINDOWS_RUNNER_ALLOW_REMOTE=1` |
| `WINDOWS_RUNNER_ALLOW_REMOTE` | `0` | Explicit acknowledgement that the token-protected API is exposed beyond loopback over plain HTTP |
| `WINDOWS_RUNNER_AUTH` | `token` | `token` = bearer auth on every `/api` route; `off` only with a loopback `HOST` |
| `WINDOWS_RUNNER_AUTH_TOKEN` | generated | The bearer token (≥16 chars). Unset: `<data dir>/auth-token` in file mode, else per-process and printed once |
| `WINDOWS_RUNNER_ALLOWED_HOSTS` | none | Extra `Host` header values accepted besides loopback and the bind address |
| `WINDOWS_RUNNER_ALLOWED_ORIGINS` | loopback origins | Explicit browser origins allowed to call the API (no wildcard) |
| `WINDOWS_RUNNER_PROVIDER` | `mock` | `mock` (offline), `openai-compatible` or `anthropic` |
| `WINDOWS_RUNNER_MODEL` / `_MODEL_BASE_URL` / `_MODEL_API_KEY` | — | Model name (required for network providers), endpoint base URL (default per provider), key (never printed; falls back to `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) |
| `WINDOWS_RUNNER_MODEL_MAX_RETRIES` | `2` | Retries for transient model errors (429/5xx/network) before any output streamed; `0` disables |
| `WINDOWS_RUNNER_MAX_STEPS` | `10` | Model calls per turn before `MAX_STEPS_EXCEEDED`; lower it to cap spend |
| `WINDOWS_RUNNER_MODEL_CALL_TIMEOUT_MS` | `30000` | Wall-clock limit for one model call |
| `WINDOWS_RUNNER_TOOLS` | `1` | `0` disables the built-in tools |
| `WINDOWS_RUNNER_TERMINAL_TIMEOUT_MS` / `_TERMINAL_OUTPUT_LIMIT` | `60000` / `65536` | `run_terminal` wall-clock limit and output cap |
| `WINDOWS_RUNNER_PERSISTENCE_MODE` | `memory` | `memory` or `file` |
| `WINDOWS_RUNNER_DATA_DIR` | `~/.windows-runner` | Where sessions and turn logs are stored in file mode |
| `WINDOWS_RUNNER_DURABLE_BEFORE_NOTIFY` | `true` (file mode) | Persist before notifying SSE listeners |
| `WINDOWS_RUNNER_FSYNC` | `false` | fsync each appended event |
| `WINDOWS_RUNNER_ALLOWED_ROOTS` | home directory | Comma-separated absolute roots a session `cwd` must be inside |
| `WINDOWS_RUNNER_HOME` | OS home | Overrides the default authorized project root (used by tests/containers) |
| `WINDOWS_RUNNER_SHUTDOWN_GRACE_MS` | `5000` | Drain timeout on SIGINT/SIGTERM/SIGHUP |

Documented for the full product but **not read by anything in this checkout**
(tracked with the other product-narrative claims under P2-01):
`WINDOWS_RUNNER_MAX_STEPS`, `WINDOWS_RUNNER_MAX_TOKENS`, `MOCK_ALLOW_WRITE`,
`WINDOWS_RUNNER_ALTERNATE_HOME`, `LOG_LEVEL`. Turn limits are currently fixed in
`createApp()` (10 steps, 30 s model/tool timeouts, 5 min approval timeout).

## Context and spending limits

Every request is budgeted against the model's context window — the **whole**
request: system prompt, tool schemas, conversation history and the reserved
reply. When history no longer fits, the agent drops the oldest *complete*
exchanges (a tool call never loses its results), keeps the most recent work, and
carries the user's earlier requirements forward in a bounded summary. The
transcript shows a note when that happens.

Settings → **Context & spending limits** (or `config.json` → `limits`):

| Setting | Meaning |
| --- | --- |
| `contextWindow` | Override the model's window when the built-in table is wrong |
| `maxOutputTokens` | Reply ceiling per model call |
| `maxSteps` | Model steps per turn |
| `maxRunTokens` | Stop the run after this many tokens (0 = unlimited) |
| `maxRunCostUsd` | Stop the run after this estimated cost (0 = unlimited) |
| `priceOverrides` | Per-million-token prices for models the table does not know |

Cost is an **estimate** from published per-million-token prices, shown with an
`est.` label; models without a published price report "unknown cost" instead of a
number, and a cost limit is not enforced for them (the run says so rather than
pretending the model is free). Estimates are a budget guard, not a bill.

## Tests

```bash
npm test
```

No API keys required.

## Provenance

WindowsRunner is an independent project. The agent loop, tools, provider adapters
and user interface are written for this repository; no third-party agent code is
included. Third-party components are used under their own licenses — see
[NOTICE](./NOTICE).

The dependency set in this checkout is much smaller than the list above used to
claim: `express` is the only runtime dependency, with `typescript`, `tsx` and
`@types/*` for development. There is no React, Vite, Tailwind CSS, highlight.js,
`diff` or `picomatch` in `package-lock.json`. Verify with
`npm ls --all --depth=0`.

## License

Apache-2.0. See [LICENSE](./LICENSE).
