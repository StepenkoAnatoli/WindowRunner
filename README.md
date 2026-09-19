# Windows Runner

A local-first desktop coding agent you run **with your own API keys**. Point it at a project folder, and it reads the files, understands the build system, and implements changes — auto or manual. The server, tools, and persistence run on your machine with no account or telemetry; requests to configured model, search, and MCP providers cross their respective trust boundaries as described below.

WindowsRunner is a **Windows-first, local-first coding agent**: parallel local sessions, file editing with reviewable diffs, a terminal, skills and MCP tools, all running on your machine with your choice of model.

## ✨ Key features

- **Project context auto-discovery** — Point the agent at a folder and it automatically reads `package.json`, `tsconfig.json`, `Makefile`, `Cargo.toml`, and other build config files to understand how to build, test, and run your project (inspired by Claude Code).
- **Auto-build & Manual-build skills** — Two modes: autonomous implementation (agent does everything end-to-end) or teaching mode (agent coaches you through building it yourself).
- **Premium dark UI** — glassmorphism, subtle gradients, Inter + JetBrains Mono, animated micro-interactions inspired by Linear/Raycast/Vercel.
- **Install without a build step** — the published package ships a prebuilt server bundle and UI (`npx windows-runner`, `npm i -g windows-runner`), and a source checkout builds itself on `npm run setup`. See [docs/INSTALL.md](./docs/INSTALL.md) for which paths are verified.
- **Better DX** — CLI (`wr`), one-time setup for contributors, optional Docker and Electron paths.

## 🚀 Installation

Full details, prerequisites and troubleshooting: **[docs/INSTALL.md](./docs/INSTALL.md)**.
Every advertised path has a recorded smoke-test result; anything without one is
marked experimental rather than promised.

| Path | Status |
| --- | --- |
| Clone + `npm run setup` (Linux) | **Verified** |
| Packed artifact: `npx windows-runner` / `npm i -g windows-runner` / `wr` | **Verified** (Linux, from the packed tarball) |
| Docker / `docker compose up` | Experimental — image never built in the verification environment |
| `install.sh` / `install.ps1` | Experimental — the Unix clone path is exercised on Linux; Windows is untested |
| Electron desktop shell | Experimental — requires a graphical session |

### Option 1 — Clone and set up (recommended)

```bash
git clone https://github.com/StepenkoAnatoli/WindowsRunner.git
cd WindowsRunner
npm run setup   # checks Node >=20.10, installs, builds, prints next steps
npm start       # → http://127.0.0.1:7634
```

`npm start` **auto-builds if `dist` is missing**, so `npm install && npm start` also works.

### Option 2 — Packed artifact (no build step)

```bash
npx windows-runner          # run without installing
# or
npm install -g windows-runner
wr                          # alias for the same CLI
wr --help                   # never installs, builds or starts anything
```

The published tarball ships the prebuilt server bundle and UI, with no runtime
dependencies and no sources, so first run is a start — not a 30-second build.
Verify it yourself with `npm run smoke:packed` from a checkout.

### Option 3 — Curl installer (Unix, experimental)

```bash
curl -fsSL https://raw.githubusercontent.com/StepenkoAnatoli/WindowsRunner/main/install.sh | bash
# options: --no-start; WINDOWS_RUNNER_HOME / WINDOWS_RUNNER_REPO_URL override the target and source
```

### Option 4 — PowerShell (Windows, experimental)

```powershell
irm https://raw.githubusercontent.com/StepenkoAnatoli/WindowsRunner/main/install.ps1 | iex
# or: .\install.ps1 -NoStart
```

### Option 5 — Docker (experimental)

```bash
docker compose up --build   # → http://localhost:7634 (loopback only)
```

### Option 6 — Desktop app (Electron, optional ~120 MB, experimental)

```bash
npm run desktop   # installs Electron on first run, then launches native window
```

---

After launch:

1. Click **Settings** and paste an API key for at least one provider (or point it at Ollama).
2. Click **New session**, pick your project folder, and ask for something.

For development with hot reload:

```bash
npm run dev   # server on :7634 + Vite UI on :5173
```

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

Configuration, complete session transcripts, session memory, and crash reports are stored locally. Configured model and search providers receive the data needed for their requests; approved MCP servers and `web_fetch` calls cross their disclosed boundaries. See the [authoritative data-flow map](./docs/THREAT_MODEL.md#5-secrets-and-data-egress) for the exact flows.

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
provide. See `docs/THREAT_MODEL.md`.

## How it fits together

```
packages/
  shared/    types shared by server + UI (stream events, sessions, provider config)
  server/    Express API, agent loop, tools, provider adapters
  web/       React + Vite UI (served by the server in production)
  desktop/   Electron shell (optional, installed separately)
bin/
  windows-runner.js  one-click CLI launcher (npx / global)
scripts/
  setup.mjs        one-click setup
  postinstall.mjs  auto-build on npm install
  ensure-built.mjs auto-build on npm start
  desktop.mjs      Electron launcher
install.sh / install.ps1  curl installers
```

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `7634` | Server port |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` to expose on LAN) |
| `WINDOWS_RUNNER_DATA_DIR` | `~/.windows-runner` | Where config and sessions are stored |
| `WINDOWS_RUNNER_MAX_STEPS` | `120` | Tool-calling steps per turn (also `limits.maxSteps`) |
| `WINDOWS_RUNNER_MAX_TOKENS` | model default | Max output tokens per model call (also `limits.maxOutputTokens`) |
| `MOCK_ALLOW_WRITE` | `0` | Set to `1` to let the mock provider also demo a file write |
| `WINDOWS_RUNNER_HOME` | OS home | Overrides the default authorized project root (used by tests/containers) |
| `WINDOWS_RUNNER_ALTERNATE_HOME` | — | An extra read-only root the folder picker may browse |
| `LOG_LEVEL` | `info` | Structured log level: `debug`, `info`, `warn`, `error` |

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
included. Third-party components (Node.js, React, Vite, Express, Tailwind CSS,
highlight.js, `diff`, `picomatch`, …) are used under their own licenses — see
[NOTICE](./NOTICE).

## License

Apache-2.0. See [LICENSE](./LICENSE).
