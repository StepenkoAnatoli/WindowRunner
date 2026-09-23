# Windows Runner

A local-first coding agent for **Windows**, run **with your own API keys**. Point it at a project folder, and it reads files, edits them under your approval, and runs terminal commands — streamed to you live, resumable across restarts, with nothing leaving your machine except the model requests you configure.

Windows-first is taken literally: the supported end-user platform is **Windows** (per-user NSIS installer, per-user data under `%APPDATA%`), the CI merge gate proves the installer and the desktop app on `windows-latest`, and the macOS/Linux user paths were deliberately removed rather than left half-claimed. The server is plain Node, so development and test automation also run on Linux runners and in Docker — that is development infrastructure, not a supported platform.

## ✨ What actually ships (all verified in CI)

- **Agent loop over SSE** — sessions pinned to a project root, one active turn at a time, streamed events with monotonic `seq`, `Last-Event-ID` resume with no gaps or duplicates, explicit terminal events (`turn_completed` / `turn_cancelled` / `turn_failed`), hot provider swap between turns.
- **Five root-confined tools** — `read_file`, `write_file`, `edit_file`, `list_dir`, `run_terminal`. Every path goes through logical-containment **and** realpath checks (`..`, absolute paths, encoded traversal and symlink escapes are rejected for reads and writes alike); `run_terminal` runs with a bounded output buffer, a wall-clock limit, secrets stripped from its environment, and is killed as a whole process tree on Stop or timeout.
- **Approvals + project trust** — `write_file`, `edit_file` and `run_terminal` always ask; approval lifetimes are independent of any SSE connection. Trust grants are a separate, explicit act keyed by the project's real root and a config hash, persisted per machine.
- **Bring-your-own-key providers** — `openai-compatible` (OpenAI, OpenRouter, Ollama, LM Studio, Gemini's compatibility endpoint, …), native `anthropic`, and an offline `mock` default. Provider profiles with masked keys, one-shot **model discovery**, one-click connection test, usage history, retry with backoff.
- **Durable file persistence** — per-session metadata + per-turn JSONL logs, atomic writes, optional fsync, durable-before-notify, crash recovery (truncated tails), quarantine of malformed logs, restart recovery that appends exactly one `RESTART` event.
- **Hardened HTTP surface** — loopback-only bind by default, Host/Origin validation, bearer token on every `/api` route (constant-time compare), strict input validation with stable error codes, keys redacted from every error and log surface.
- **Windows desktop app** — Electron shell that boots the bundled server as a child process on an OS-assigned loopback port with an in-memory token, sandboxed preload bridge, navigation lockdown, clean process-tree shutdown, per-user NSIS install that keeps your data across upgrades and uninstall.

No skills system, no MCP, no project-context auto-discovery, no web search: those are **not implemented**, and this README does not advertise them. The tool list above is the complete list.

## 🚀 Installation

Status below is what was actually executed — not what the packaging intends. Full details, prerequisites, known gaps and troubleshooting: **[docs/INSTALL.md](./docs/INSTALL.md)**. Notable changes are tracked in **[CHANGELOG.md](./CHANGELOG.md)**.

| Path | Status |
| --- | --- |
| Windows desktop app (NSIS installer) | **Built, installed, exercised, upgraded and uninstalled by CI on `windows-latest`** (unsigned — see code signing below) |
| Clone + `npm ci` / `npm run setup` / `npm test` / `npm start` | **Verified** (Linux dev runners and `windows-latest` CI) |
| `npm start` (HTTP API on `127.0.0.1:7634`, offline mock provider) | **Verified** |
| Packed tarball (`npm pack` → clean dir → `npm start`) | **Verified** (`smoke:packed`, `smoke:packed:start`); registry publication is open (gap G-05) |
| Docker (server-bundle verification in CI) | **Verified** — development/CI infrastructure, not a supported user platform |
| macOS / Linux as end-user platforms | **Set aside** — no installers, no CI legs, no claims |

### Option 1 — Windows desktop app

From a checkout:

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
sessions, provider profiles, logs — lives in `%APPDATA%\WindowRunner`,
survives uninstall, and is preserved across in-place upgrades. Automation:
silent install/uninstall with `/S`. The `Desktop installer (windows-latest)`
CI job builds the installer, installs it silently, drives the installed app
through a mock session, verifies an in-place upgrade keeps user data, and
uninstalls it on every push. Every installer artifact ships with a
`SHA256SUMS.txt` sidecar; the `Desktop signing (windows-latest)` job proves
the Authenticode signing pipeline on every push (official installers stay
unsigned — and SmartScreen warns — until a production certificate is wired in
as a repo secret). See
[docs/INSTALL.md](./docs/INSTALL.md#windows-desktop-app) → "Code signing and
SmartScreen" and "Verifying a download".

### Option 2 — Clone and set up (development)

```bash
git clone https://github.com/StepenkoAnatoli/WindowRunner.git
cd WindowRunner
npm ci            # installs all four workspaces, runs the postinstall check
npm run setup     # install -> typecheck -> build, in one step
npm test          # full suite (shared, server, web, desktop), no API keys required
npm start         # serve the API + UI on http://127.0.0.1:7634
```

`npm start` runs `packages/server/dist/index.cjs` (its `prestart` hook builds
when `dist/` is missing or stale). What starts is the HTTP API plus the
**web UI** served at `/` (`packages/web`): the offline `mock` provider is the
default (set `WINDOWS_RUNNER_PROVIDER=openai-compatible` or `anthropic` for a real model),
five root-confined tools are registered, every `/api` route
requires a bearer token (printed once in memory mode — the banner's `ui:` line
carries it as a `#token=` fragment the page consumes and removes — and stored
at `~/.windows-runner/auth-token` in file mode), and the server binds loopback
only. The UI talks to the API with `fetch` only (bearer on every request,
streamed SSE with `Last-Event-ID` resume). Configuration, endpoints and limits are in
[docs/INSTALL.md → "Running the server"](./docs/INSTALL.md#running-the-server).
`npm run smoke:start` boots the built server and runs a turn against it.

### Option 3 — Packed artifact

`bin/windows-runner.js` is the CLI launcher (declared as `windows-runner` and
`wr` in `package.json`). `npm run smoke:packed:start` proves that packing the
tarball, unpacking it in a clean temporary directory outside the repository,
and executing `npm start` boots and answers health queries without workspace
symlinks. Until the package is published to the registry (`npm view windows-runner`
returns `E404`, gap G-05), local tarball installation works.

### Option 4 — Docker (development/CI verification of the server bundle)

```bash
docker compose up --build
```

Builds the multi-stage container image using the self-contained server bundle
(`packages/server/dist/index.cjs`). The image runs the standalone bundle
directly without requiring `node_modules` or workspace symlinks in the runtime
container. CI verifies this on every push and pull request (the `Docker` job)
as a portable way to exercise the server artifact — it is not a supported
end-user platform for the product.

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

## Providers

| Provider | Status in this checkout |
| --- | --- |
| **Mock** | ✅ Default. Offline rehearsal of the whole loop — no key, no network |
| **OpenAI-compatible** | ✅ `WINDOWS_RUNNER_PROVIDER=openai-compatible`. Covers OpenAI, OpenRouter, Groq, Together, vLLM, llama.cpp, LiteLLM, LM Studio, Google Gemini's OpenAI endpoint |
| **Ollama** | ✅ via OpenAI-compatible: `WINDOWS_RUNNER_MODEL_BASE_URL=http://127.0.0.1:11434/v1`, no key |
| **Anthropic (native)** | ✅ `WINDOWS_RUNNER_PROVIDER=anthropic`, `WINDOWS_RUNNER_MODEL=claude-…`, key from `WINDOWS_RUNNER_MODEL_API_KEY` or `ANTHROPIC_API_KEY` |

## What the agent can do

Tools shipped in this checkout (`packages/server/src/agent/tools/builtin.ts`).
Every path is relative to the session's project root and cannot leave it —
not via `..`, absolute paths, encoded traversal or symlinks, for reads or writes.

| Tool | Approval |
| --- | --- |
| `read_file` (with optional line range), `list_dir` | never |
| `write_file`, `edit_file` (exact-match replace, must be unique) | **always asks first** |
| `run_terminal` | **always asks first** — runs in the project root, server secrets stripped from its environment, bounded output, killed as a whole process tree on Stop/timeout |

Set `WINDOWS_RUNNER_TOOLS=0` for a text-only agent. There are no other tools
in this checkout — no `grep`, no `apply_patch`, no `git_*`, no `web_*`, no
skills, no `mcp_*`. The project-trust gate that will guard project-supplied
tools (MCP servers, hooks) already exists; the tools themselves do not.

### Privacy and data flow

Local-first describes where WindowsRunner runs and stores its state; it does not mean every value remains on the machine.

Configuration, complete session transcripts, and session state are stored
locally. Configured model providers receive the data needed for their
requests — that is the only data that leaves the machine, and only when you
send a turn. There is no telemetry, no account, and no phone-home. A fuller
description of the trust boundaries lives in
[docs/THREAT_MODEL.md](./docs/THREAT_MODEL.md).

Safety rails:

- The agent's own file tools are confined to the session's project directory
- Terminal commands need approval, are killed with their whole process tree at the timeout (60s default) or when you press Stop, no pty
- Authorization roots default to your home directory (configurable via `WINDOWS_RUNNER_ALLOWED_ROOTS`); a request naming a `cwd` outside them is rejected

**This is not a sandbox.** An approved shell command runs as *you*, with your
full privileges: it can read and write anywhere you can, reach the network and
use your credentials. The project-directory restriction applies only to the
built-in file tools, and it does not make command execution safe. Only approve
commands you would type yourself, and run WindowsRunner on an untrusted
repository the way you would run that repository's own scripts — in a VM if
that matters to you. OS-level isolation is a separate project, not something
the current controls provide.

## How it fits together

```
packages/
  shared/    turn-state reducer + StreamEvent contract + workspace-catalog
             validation — the single owner of everything server and UIs share
  server/    src/index.ts   boot entry point (`npm start`): config -> runtime -> listen -> drain
             src/config.ts  environment parsing, strict, safe defaults
             src/boot.ts    composes createApp(), recovers persisted state, graceful shutdown
             src/app.ts     Express app factory: composition, security boundary, validation loop
             src/http/      route modules (sessions, turns, observability, providers), static UIs,
                            shared request validation — one owner per resource
             src/providers/ LLMProvider contract, the offline mock, the openai-compatible and
                            anthropic adapters, retry wrapper
             src/agent/     turn manager/loop, session lifecycle, approvals, trust, persistence stores
  web/       framework-free UI: app shell, workspace, provider dashboard, usage, settings
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
install.ps1         Windows clone-and-setup installer (offers `npm start` at the end)
Dockerfile / docker-compose.yml   server-bundle verification (CI)
docs/INSTALL.md     install-path status, how to run the server, packaging gaps (G-01..G-06)
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
- Diagnostics: `BootDiagnostics` observable via `/api/health` and `/api/diagnostics/persistence`.

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

## Environment variables

Read by the server entry point (`npm start`) — this table matches `ENV` in
`packages/server/src/config.ts`; set-but-invalid values fail the boot with a
message naming the variable. The full semantics table is in
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

## Tests

```bash
npm test
```

Runs the full suite across all four workspaces — shared, server, web, and
desktop (the desktop `pretest` hook builds the shell if `dist/` is missing or
stale). No API keys required. `npm run eval -- --expect-pass` additionally
drives the real server through five scripted end-to-end tasks with hidden
checks.

## Provenance

WindowsRunner is an independent project. The agent loop, tools, provider adapters
and user interface are written for this repository; no third-party agent code is
included. Third-party components are used under their own licenses — see
[NOTICE](./NOTICE).

`express` is the only runtime dependency (plus the workspace `@windows-runner/shared`),
with `typescript`, `tsx` and `@types/*` for development. There is no React,
Vite, Tailwind CSS, highlight.js, `diff` or `picomatch` in `package-lock.json`.
Verify with `npm ls --all --depth=0`.

## Security

Found a security problem? Do not open a public issue — see
[SECURITY.md](./SECURITY.md) for the private reporting path and the trust
model. The implemented security boundary is described in
[docs/THREAT_MODEL.md](./docs/THREAT_MODEL.md). Download verification and
code-signing status are in
[docs/INSTALL.md](./docs/INSTALL.md#windows-desktop-app) → "Code signing and
SmartScreen" / "Verifying a download". The B5 security review lives at
[docs/research/2026-09-22-b5-security-review.md](./docs/research/2026-09-22-b5-security-review.md).

## License

Apache-2.0. See [LICENSE](./LICENSE).
