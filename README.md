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
**[docs/INSTALL.md](./docs/INSTALL.md)**.

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
| Electron desktop shell | **Not available** — `packages/desktop` does not exist |

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
when `dist/` is missing or stale). What starts is the **HTTP API alone**: the
offline `mock` provider is the only provider in this checkout, no tools are
registered, there is no web UI, and the server binds loopback only because the
API has no authentication yet. Configuration, endpoints and limits are in
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

### Option 6 — Desktop app (Electron, not available)

`npm run desktop` was removed: `packages/desktop` does not exist and Electron is
not a dependency (gap G-04 covers the packaging side; the desktop shell itself is
simply absent from this checkout).

---

The "paste an API key, click **New session**, ask for something" flow described
elsewhere in this README requires a UI and a real provider. Neither exists in
this checkout: `npm start` serves the API with the offline mock provider, and
there is nothing to paste a key into. For development, `npm run dev` restarts
the server on source changes (`tsx watch`); there is still no web dev server and
no web bundler (gap G-03 web residual).

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

| Provider | Notes |
| --- | --- |
| **Anthropic** | Native Messages API, prompt caching enabled |
| **OpenAI** | Chat Completions API |
| **OpenRouter** | One key, hundreds of models |
| **Google Gemini** | Via Google's OpenAI-compatible endpoint |
| **Ollama** | `http://localhost:11434/v1`, no key needed |
| **OpenAI-compatible** | Groq, Together, vLLM, llama.cpp, LiteLLM, anything `/v1/chat/completions`-shaped |
| **Mock** | Offline rehearsal of the whole loop — no key, no network |

Keys live in `~/.windows-runner/config.json` with mode `0600`. You can also put `env:ANTHROPIC_API_KEY` in the key field to read from your shell instead of storing anything. Existing `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY` and `GEMINI_API_KEY` environment variables are detected on first run.

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

| Tool | Approval |
| --- | --- |
| `read_file`, `list_files`, `grep` | never |
| `read_project_context` | never — scans project config files |
| `write_file`, `str_replace` | auto-approved by default (toggle in Settings) |
| `apply_patch` | auto-approved by default — multi-file edits |
| `delete_file` | **always asks first** |
| `git_status`, `git_diff`, `git_log` | never |
| `run_terminal` | **always asks first** |
| `web_fetch`, `web_search` | asks (auto-approved by the research skill) |
| `session_memory` | never — saves/reads session notes |
| `record_error`, `list_error_reports` | never — crash recorder for error-handler skill, writes to `.windows-runner/crash-reports/` |
| `skill` | never |
| `mcp_*` | **always asks first** (external tool servers) |

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
             src/providers/ LLMProvider contract + the offline mock (the only provider here)
  web/       UI-side turn-state projection (no bundler, no React in this checkout)
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

Not present, though earlier revisions of this README listed them:
packages/desktop/ (no Electron shell) and scripts/desktop.mjs. Each absence is
recorded in docs/INSTALL.md.
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
| `WINDOWS_RUNNER_ALLOW_REMOTE` | `0` | Explicit acknowledgement that the unauthenticated API is exposed beyond loopback |
| `WINDOWS_RUNNER_PROVIDER` | `mock` | Provider name; only `mock` exists in this checkout |
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
