# Installation

Status of every install path this repository advertises, verified against the
current `main`.

**Verification environment:** Node `v22.22.3`, npm `10.9.8`, git `2.39.5`,
Linux x86_64, 2026-09-20. Every row below was produced by running the command
listed, not inferred from source. The `CI` job re-enforces the lifecycle rows
on Linux; the `Platform` matrix re-enforces install/typecheck/build/test/smokes
on `windows-latest` and `macos-latest`. See
[`RELEASE_CHECKLIST.md`](../RELEASE_CHECKLIST.md) → "CI enforcement status" for
which platform checks exist and which do not.

---

## Install-path status

| Path | Status | Evidence |
| --- | --- | --- |
| Clone + `npm ci` | **Verified** (Linux) | Runs the `postinstall` hook; exits 0 on a healthy tree |
| Clone + `npm ci --ignore-scripts` | **Verified** (Linux) | Used by the Dockerfile dependency layer |
| Clone + `npm run typecheck` | **Verified** (Linux) | All three workspaces, `--noEmit` |
| Clone + `npm test` | **Verified** (Linux) | All three workspaces, `node:test` via `tsx` |
| Clone + `npm run build` | **Verified** (Linux) | Emits `packages/*/dist` (JS + `.d.ts`), no test files |
| Clone + `npm run smoke:packed` | **Verified** (Linux) | Tarball contents match the manifest contract |
| Clone + `npm run smoke:packed:start` | **Verified** (Linux) | Unpacks tarball outside source tree and verifies `npm start` |
| Clone + `npm run setup` | **Verified** (Linux) | install + typecheck + build, in that order |
| Clone + `npm start` | **Verified** (Linux) | Boots `packages/server/dist/index.cjs` on `127.0.0.1:7634` (builds first when `dist/` is missing or stale); see "Running the server" |
| Clone + `npm run smoke:start` | **Verified** (Linux) | Boots the built server as a child process, runs a turn over SSE, restarts it, checks a clean SIGTERM exit |
| `npm run dev` | **Server only** | `tsx watch` on the server entry. There is still no web dev server or bundler (gap G-03 web residual) |
| `npx windows-runner` / `npm i -g windows-runner` / `wr` | **CLI entry shipped** | Bin launchers exist; publication to npm registry is open (gap G-05) |
| `install.sh` | **Experimental** | Executed on macOS CI in checkout mode (`--no-start`); fresh-clone and interactive-prompt modes untested |
| `install.ps1` | **Experimental** | Executed on Windows CI in checkout mode (`-NoStart`); fresh-clone and interactive-prompt modes untested |
| `docker compose up --build` | **Verified** (Linux CI) | `Docker` job builds the image, boots the bundle, runs a mock turn over SSE, asserts SIGTERM → 0 |
| `npm run desktop` | **Not available** | `packages/desktop` does not exist; Electron is not a dependency (gap G-04) |

"Verified" means the command succeeded on the environment above. It is not a
claim about Windows, macOS, or any packaged/distributed artifact.

---

## Prerequisites

- **Node >= 20.10** (declared in `package.json` → `engines.node`).
  Note: CI pins **22.23.2** exactly, because Node 20 is past the end of its
  security-fix window (see the comment in `.github/workflows/ci.yml`). New work
  should target Node 22; the `engines` range has not been narrowed because that
  is a support-matrix decision, not a packaging fix.
- **npm** (ships with Node) and **git**.

No global tools are required. `tsx` and `typescript` come from the lockfile; do
not run `npx tsc` in a checkout that has not been installed — npx will resolve
the unrelated deprecated `tsc` package from the registry instead.

---

## The path that works

```bash
git clone https://github.com/StepenkoAnatoli/WindowRunner.git
cd WindowRunner
npm ci              # installs all three workspaces, runs the postinstall check
npm run typecheck   # shared + server + web, --noEmit
npm test            # full suite across all three workspaces
npm run build       # emits packages/*/dist
npm run smoke:packed
npm run smoke:start # boots the built server and runs a turn against it
npm start           # http://127.0.0.1:7634
```

`npm run setup` performs install → typecheck → build in one step and is what
`install.sh` / `install.ps1` call. `npm start` does not need it: its `prestart`
hook (`scripts/ensure-built.mjs`) builds when `packages/*/dist` is missing or
older than `src/`, and is silent otherwise.

### What the build produces

| Workspace | Output | Contents |
| --- | --- | --- |
| `packages/shared` | `dist/index.js`, `dist/index.d.ts` | Turn-state reducer and shared types |
| `packages/server` | `dist/**/*.js` + `.d.ts`, `dist/index.cjs` | TypeScript compilation, declarations, and self-contained executable bundle (`dist/index.cjs`) inlining shared code and dependencies |
| `packages/web` | `dist/turn-state.js` + `.d.ts` | UI-side turn-state projection |

Each workspace builds from `tsconfig.build.json`, which compiles `src/` only —
so `dist/` never contains tests, and `rootDir` keeps the output flat instead of
nesting `dist/server/src/…` and `dist/shared/src/…` the way the previous
`tsc -p tsconfig.json` build did. In addition, the server workspace build
runs `node scripts/bundle.mjs` using `esbuild` to emit `dist/index.cjs`.

`tsconfig.json` (used by `typecheck` and by `tsx` at test time) still maps
`@windows-runner/shared` to `../shared/src/index.ts`, so **typecheck and test do
not require a prior build**. The build configs instead resolve that specifier to
`../shared/dist/index.d.ts`, which is why `npm run build` builds `shared` first.

---

## Running the server

`npm start` runs `packages/server/dist/index.cjs`, which reads its configuration
from the environment, composes the runtime, recovers persisted state, listens,
and prints a ready line:

```
windows-runner listening on http://127.0.0.1:7634
```

Ctrl+C (SIGINT), SIGTERM or SIGHUP drains the server: it stops accepting
connections, cancels in-flight turns (each records a `turn_cancelled` event),
waits up to `WINDOWS_RUNNER_SHUTDOWN_GRACE_MS` for them and for open connections
to finish, then exits 0. A second signal exits immediately.

### What the server is in this checkout

Be precise about what starts, because the README's product narrative describes
more than this repository contains (that reconciliation is P2-01):

- **HTTP API plus a minimal web UI.** `packages/web` builds to
  `packages/web/dist/app` and the server serves it at `/` when present (static
  files never answer under `/api/`; `/api` keeps requiring the bearer token).
  Open the `ui:` URL from the banner; in memory mode it includes
  `#token=<generated token>`, which the page stores in `sessionStorage` and
  strips from the address bar. In file mode paste the contents of
  `<dataDir>/auth-token` into the token field. The UI covers: session
  create/delete, sending a turn, streamed text, Stop, approval cards, the
  project-trust prompt and error display — nothing more yet. The API
  endpoints are the ones `createApp()` defines: `POST /api/sessions/:id`,
  `POST /api/sessions/:id/turns`, `GET /api/sessions/:id/turns/:turnId/events`
  (SSE), `POST …/cancel`, `POST /api/sessions/:id/approve`, `GET /api/health`,
  `GET /api/metrics`, `GET /api/diagnostics/persistence`, and `GET /healthz`
  (liveness only).
- **Three providers.** `mock` (default) is offline, makes no model calls, and
  prefixes every reply with `[mock]`. `anthropic` talks to the Anthropic
  Messages API (`WINDOWS_RUNNER_PROVIDER=anthropic`, `WINDOWS_RUNNER_MODEL=claude-…`,
  key from `WINDOWS_RUNNER_MODEL_API_KEY` or `ANTHROPIC_API_KEY`; default base
  URL `https://api.anthropic.com/v1`). `openai-compatible` talks to any
  `/chat/completions` endpoint (OpenAI, OpenRouter, Ollama, LM Studio, vLLM,
  Groq, Gemini's OpenAI endpoint): set `WINDOWS_RUNNER_PROVIDER=openai-compatible`,
  `WINDOWS_RUNNER_MODEL=<model>`, optionally `WINDOWS_RUNNER_MODEL_BASE_URL`
  (default `https://api.openai.com/v1`) and `WINDOWS_RUNNER_MODEL_API_KEY`
  (or `OPENAI_API_KEY`; local servers need none). The key is never printed and
  is redacted from error messages. Naming any other provider is a boot error
  that lists what is available; there is no Anthropic adapter yet.
- **Five built-in tools, all confined to the session root** (`WINDOWS_RUNNER_TOOLS=0`
  disables them): `read_file` and `list_dir` never ask; `write_file`,
  `edit_file` and `run_terminal` ask for approval on every call. Paths are
  relative to the project root and go through the same containment checks as
  session roots (no `..`, no absolute paths, no encoded traversal, no symlinks
  pointing outside — for reads *and* writes). `run_terminal` runs in the real
  project root through the platform shell with the server's own secrets
  stripped from the environment, output bounded to
  `WINDOWS_RUNNER_TERMINAL_OUTPUT_LIMIT` bytes (head + tail), a wall-clock limit
  of `WINDOWS_RUNNER_TERMINAL_TIMEOUT_MS`, and is killed as a **process tree**
  (process group on POSIX, `taskkill /T` on Windows) on Stop or timeout.
  Unknown or malformed tool calls from the model are controlled tool errors
  fed back to the model, never crashes.
- **Bearer-token authentication on every `/api` route** (P0-01). Only
  `/healthz` is public. Requests must send `Authorization: Bearer <token>`;
  the token comes from `WINDOWS_RUNNER_AUTH_TOKEN`, else from
  `<data dir>/auth-token` in file mode (generated on first boot, mode 0600),
  else it is generated for the process and printed once in the banner. The
  server also validates the `Host` header (loopback names, the bind address,
  `WINDOWS_RUNNER_ALLOWED_HOSTS`) and, for browser requests, the `Origin`
  header (loopback origins by default, `WINDOWS_RUNNER_ALLOWED_ORIGINS` to
  replace that; never a wildcard, `Origin: null` is always refused). See
  "Authentication" below.
- **Explicit project trust before project-supplied code runs** (P0-02). A tool
  that declares `trust` (an MCP server command, a project skill) is refused
  with `PROJECT_NOT_TRUSTED` until the project's real root has been trusted for
  that exact configuration via `POST /api/sessions/:id/trust`. No such tool
  ships in this checkout; the gate and its persistence (`trust.json`) do.
- The server still refuses to bind anything but a loopback address unless
  `WINDOWS_RUNNER_ALLOW_REMOTE=1` is set: the token travels over plain HTTP.

### Configuration

All values come from environment variables; a value that is set but not
understood fails the boot with a message naming the variable. Nothing falls
back silently.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address. Non-loopback requires `WINDOWS_RUNNER_ALLOW_REMOTE=1` |
| `PORT` | `7634` | Port; `0` picks an ephemeral port and prints it in the ready line |
| `WINDOWS_RUNNER_ALLOW_REMOTE` | `0` | Acknowledge that a non-loopback bind exposes the token-protected API over plain HTTP |
| `WINDOWS_RUNNER_AUTH` | `token` | `token` (bearer auth on `/api`) or `off` (loopback `HOST` only; refused otherwise) |
| `WINDOWS_RUNNER_AUTH_TOKEN` | generated | Bearer token, ≥16 characters, no whitespace. Unset: `<data dir>/auth-token` in file mode, else per-process |
| `WINDOWS_RUNNER_ALLOWED_HOSTS` | none | Extra `Host` header values (comma-separated, no port) accepted besides loopback names and the bind address |
| `WINDOWS_RUNNER_ALLOWED_ORIGINS` | loopback origins | Comma-separated browser origins (`scheme://host[:port]`) allowed to call the API; replaces the loopback default. No `*`, no `null` |
| `WINDOWS_RUNNER_PROVIDER` | `mock` | `mock` (offline), `openai-compatible` or `anthropic` |
| `WINDOWS_RUNNER_MODEL` | none | Model name; required with `openai-compatible` / `anthropic` (e.g. `gpt-4o-mini`, `llama3.1`, `claude-sonnet-4-5`) |
| `WINDOWS_RUNNER_MODEL_BASE_URL` | `https://api.openai.com/v1` | Base URL; `{base}/chat/completions` is called. `http://127.0.0.1:11434/v1` for Ollama |
| `WINDOWS_RUNNER_MODEL_API_KEY` | `OPENAI_API_KEY`, else none | Bearer key for the model endpoint. Never printed; redacted from errors |
| `WINDOWS_RUNNER_MODEL_MAX_RETRIES` | `2` | Extra attempts on 429/5xx/connection/broken-stream errors, only before any output was streamed. Honours `Retry-After`; otherwise exponential backoff with jitter (≤8 s). `0` disables |
| `WINDOWS_RUNNER_MAX_STEPS` | `10` | Model calls per turn before `MAX_STEPS_EXCEEDED`; lower it to cap spend |
| `WINDOWS_RUNNER_MODEL_CALL_TIMEOUT_MS` | `30000` | Wall-clock limit for one model call |
| `WINDOWS_RUNNER_TOOLS` | `1` | Register the built-in tools (`0` = text-only agent) |
| `WINDOWS_RUNNER_TERMINAL_TIMEOUT_MS` | `60000` | Wall-clock limit for one `run_terminal` command (the 30 s tool timeout in `createApp()` still applies on top) |
| `WINDOWS_RUNNER_TERMINAL_OUTPUT_LIMIT` | `65536` | Bytes of command output kept (first and last half) |
| `WINDOWS_RUNNER_PERSISTENCE_MODE` | `memory` | `memory` (lost on restart) or `file` (JSONL + `meta.json` under the data dir) |
| `WINDOWS_RUNNER_DATA_DIR` | `~/.windows-runner` | Absolute path; created on first file-mode boot. Unused in memory mode |
| `WINDOWS_RUNNER_DURABLE_BEFORE_NOTIFY` | `true` in file mode | Persist each event before it is sent over SSE |
| `WINDOWS_RUNNER_FSYNC` | `false` | fsync every appended event |
| `WINDOWS_RUNNER_ALLOWED_ROOTS` | `WINDOWS_RUNNER_HOME`, else the OS home directory | Comma-separated absolute directories a session's `cwd` must be inside |
| `WINDOWS_RUNNER_HOME` | OS home | Overrides the default allowed root only |
| `WINDOWS_RUNNER_SHUTDOWN_GRACE_MS` | `5000` | How long a drain waits before forcing sockets closed |

Booleans accept `1/true/yes/on` and `0/false/no/off`.

`WINDOWS_RUNNER_DATA_DIR` in file mode is a single-writer directory: run one
server per data dir (see README, "Persistence").

### Authentication

Every `/api` route answers `401 AUTH_REQUIRED` (or `401 AUTH_INVALID`) without
a valid `Authorization: Bearer <token>` header; `/healthz` stays public for
container health checks. The token is resolved at boot, in this order:

1. `WINDOWS_RUNNER_AUTH_TOKEN`, if set (≥16 characters, no whitespace).
2. File persistence mode: `<WINDOWS_RUNNER_DATA_DIR>/auth-token`. Created on
   the first boot with mode 0600 and reused afterwards, so other local tools
   can read it and restarts keep it stable. A corrupt file is a boot error.
3. Memory mode: a fresh random token, printed once in the banner
   (`token: …`). It is not printed in cases 1 and 2.

```sh
# memory mode: copy the token from the banner
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7634/api/health

# file mode
curl -H "Authorization: Bearer $(cat ~/.windows-runner/auth-token)" \
     -H "content-type: application/json" \
     -d '{"cwd":"'"$PWD"'","message":"hello"}' \
     http://127.0.0.1:7634/api/sessions/demo/turns
```

`EventSource` cannot set headers, so a browser client must open the SSE route
with `fetch` and stream the body (the `Last-Event-ID` header is accepted the
same way, or `?afterSeq=` as a query parameter).

Before the token is checked the server validates two more headers, so an
attacker page in your browser cannot reach a loopback server through DNS
rebinding or cross-site requests:

- `Host` must be a loopback name, the bind address, or an entry of
  `WINDOWS_RUNNER_ALLOWED_HOSTS` — otherwise `403 HOST_NOT_ALLOWED`.
- `Origin`, when a browser sends it, must be a loopback origin or an entry of
  `WINDOWS_RUNNER_ALLOWED_ORIGINS` — otherwise `403 ORIGIN_NOT_ALLOWED`.
  `Origin: null` is always refused; there is no wildcard. Allowed origins get
  the matching CORS headers and preflights are answered.

`WINDOWS_RUNNER_AUTH=off` disables the token check (Host/Origin validation
stays). It is accepted only with a loopback `HOST`; combined with any other
bind it is a configuration error that `WINDOWS_RUNNER_ALLOW_REMOTE` cannot
override.

Rejections are counted in `/api/metrics` (`counters.securityRejections`,
by kind `host` / `origin` / `auth`) and surface as a `securityRejection`
alert on `/api/health`. Neither the token nor the presented credential is ever
written to logs, metrics or health output.

### Provider dashboard

When the web package is built (`npm run build`), the same origin serves the
provider dashboard at `/dashboard` (main UI at `/`). It uses the **same bearer
token** as `/api` — the browser shares it with the main UI through
`sessionStorage` — and is behind the same auth middleware; there is no
unauthenticated path.

What it does:

- **Active-provider banner** — the profile the next turn will run on.
- **Provider cards** — every saved profile with a status dot (green = last
  Test passed, red = failed, gray = never tested) and **Use this** (hot-swap:
  the *next* turn runs on the new profile, no restart), **Test** (one minimal
  request with a 5 s timeout), **Edit**, **Delete** (the active profile cannot
  be deleted — switch first).
- **Add-profile form** with presets: OmniRoute (OpenAI-compatible — the base
  URL is per-account, so it is a placeholder you type, never pre-filled),
  OpenAI, Anthropic (official base URL, fixed), Spark (local Ollama,
  `http://127.0.0.1:11434/v1`, no key), and the offline mock.
- **Recent turns** — the last 50 usage records (time, provider, model, tokens,
  status). Cost shows `—` unless a price-table entry exists for the exact
  model id; the bundled table is empty, so no cost is ever fabricated.
- **Quick chat** — one streamed turn to the active provider, reusing the main
  UI's `POST /turns` + SSE event stream.

Storage:

- Profiles live in `<data dir>/provider-profiles.json` (same `<data dir>` as
  sessions — `~/.windows-runner` by default, or `WINDOWS_RUNNER_DATA_DIR`),
  written atomically with **mode 0600**, the same pattern as `auth-token`.
  The file is created on the first boot even in memory mode (sessions stay in
  memory; profiles do not).
- Usage history lives in `<data dir>/usage.jsonl` (mode 0600, one line per
  terminal turn). It contains turn metadata (provider, model, tokens,
  status) — no keys, no message content.
- **The API key is stored in that file in plaintext at rest.** It is never
  logged, echoed in an API response, or included in error/diagnostic output
  (responses show only `****last4`), and the 0600 mode keeps other local users
  out — but there is no OS keychain integration in this checkout. That is the
  documented trade-off; see `RELEASE_CHECKLIST.md` (P2, provider dashboard).
- On first boot (file absent) the environment provider
  (`WINDOWS_RUNNER_PROVIDER`/`WINDOWS_RUNNER_MODEL*`) is registered as the
  `default` profile and made active. On later boots the **persisted** active
  profile wins over the environment, so a dashboard "Use this" survives
  restarts.

### Remote access

The default is loopback only. Setting `HOST` to a non-loopback address requires
`WINDOWS_RUNNER_ALLOW_REMOTE=1` because the bearer token is sent over plain
HTTP: anyone who can observe the traffic can replay it. If you must expose the
server, terminate TLS in a reverse proxy in front of it, forward the original
`Host` (and add that name to `WINDOWS_RUNNER_ALLOWED_HOSTS`), list the web
origin in `WINDOWS_RUNNER_ALLOWED_ORIGINS`, and set an explicit
`WINDOWS_RUNNER_AUTH_TOKEN`. Auth cannot be turned off for a remote bind.

### Project trust

Tools may declare `trust(input)` returning `{ configHash, source }` — the
digest of project-supplied configuration they would execute (an MCP server
command from `.mcp.json`, for example). The loop checks the session's real
(symlink-resolved) root against the trust registry *before* any approval is
requested and refuses with a `tool_completed` result of `PROJECT_NOT_TRUSTED`
until the user has granted trust for that exact hash:

```
GET    /api/sessions/:id/trust            -> { realRoot, canonicalRoot, grant|null }
POST   /api/sessions/:id/trust            { "configHash": "sha256:…", "source": ".mcp.json" }
DELETE /api/sessions/:id/trust            -> 204
```

A grant is keyed by the real root and bound to the hash, so a changed
configuration invalidates it (the refusal names the stale hash). In file mode
grants persist in `<data dir>/trust.json` (0600). Approving a tool call never
grants trust, and a persisted session never implies it.

### Startup smoke test

`npm run smoke:start` (`scripts/smoke-start.mjs`) is the runtime check that
`npm run smoke:packed` deliberately is not. It builds if needed, then spawns the
compiled entry with a clean environment, `PORT=0`, file persistence in a
temporary data directory and a temporary allowed root, and asserts:

1. the ready line appears and `/healthz` and `/api/health` answer;
2. `POST /api/sessions/smoke/turns` runs to `turn_completed` over SSE, the
   `[mock]` reply echoes the message, `seq` is contiguous, and the JSONL and
   `meta.json` exist under the data dir;
3. a session whose `cwd` is outside the allowed root is refused with
   `403 PATH_ESCAPES_ROOT`;
4. SIGTERM exits 0 within the grace period (on Windows, where SIGTERM does not
   exist, only termination is asserted);
5. a second boot on the same data dir reports the recovered session and turn and
   replays it;
6. `HOST=0.0.0.0` without the opt-in exits 1 naming `WINDOWS_RUNNER_ALLOW_REMOTE`.

It never touches `~/.windows-runner`, needs no API key and makes no network
requests. CI runs it after the build. The same contract is exercised in-process
from sources by `packages/server/test/boot.test.ts`, so `npm test` still needs
no prior build.

---

## Known packaging gaps

These are recorded so nobody re-derives them from a failing command. Each one is
a real blocker for the corresponding advertised path, not a stylistic note.

**G-01 — no CLI entry point. Closed 2026-09-20.** `bin/windows-runner.js` added
as executable launcher (`chmod +x`), declared in `package.json` under `bin`
(`windows-runner` and `wr`), and included in `files[]`.

**G-02 — no server boot path. Closed 2026-09-20.** `packages/server/src/index.ts`
is the executable entry (`config.ts` parses the environment, `boot.ts` composes
`createApp()`, recovers persisted state, listens and drains), the server
workspace declares `start`, the root `npm start` runs the compiled entry behind
an ensure-built `prestart`, and `npm run smoke:start` proves the built artifact
boots.

**G-03 — no bundler. Closed 2026-09-20.** Bundling implemented via `esbuild` in
`packages/server/scripts/bundle.mjs`. `npm run build` bundles the server into a
self-contained CommonJS artifact `packages/server/dist/index.cjs`.

**G-04 — `dist/` is not self-contained. Closed 2026-09-20.** The server bundle
inlines `@windows-runner/shared` and runtime dependencies (`express`). It has
zero runtime dependency on `node_modules` or monorepo workspace symlinks,
verified by running the bundle outside the source tree in an isolated directory
and by `npm run smoke:packed:start`.

**G-05 — not published.** `npm view windows-runner` returns `E404`. Any README
sentence presenting the npm/npx path as verified describes a state that does not
exist today.

**G-06 — no Windows or macOS verification. Closed 2026-09-20.** The `Platform`
CI matrix runs the full lifecycle (install, typecheck, build, test, packed and
startup smokes) on `windows-latest` and `macos-latest`, and executes both
installers in checkout mode with `--no-start`/`-NoStart`. There is still no
Electron build in this repository's CI, so the desktop path is untested rather
than passing. Residuals: installer fresh-clone mode and the interactive start
prompt are untested on every OS.

---

## Docker

The Dockerfile produces a working container image using the self-contained server
bundle (`packages/server/dist/index.cjs`, closing G-03 and G-04). The builder
stage runs `npm run build` to emit the bundle, and the runtime stage runs it
directly without requiring `node_modules` or workspace symlinks in the runtime
container.

`docker-compose.yml` describes the configuration the entry point expects:
`HOST=0.0.0.0` with `WINDOWS_RUNNER_ALLOW_REMOTE=1` inside the container's own
network namespace, and `WINDOWS_RUNNER_ALLOWED_ROOTS=/work` for the mounted
workspace.

The API inside the container is token-protected like everywhere else. The
first boot writes the token to the data volume; read it with
`docker compose exec windows-runner cat /home/node/.windows-runner/auth-token`,
or pin one with `WINDOWS_RUNNER_AUTH_TOKEN` in the compose environment.

CI enforces this on every push and pull request: the `Docker` job (which runs
after `CI`) executes `docker compose up --build -d`, waits for `/healthz`,
asserts `/api/health` is 401 without the token and, with the token read from
the volume, reports file persistence and token auth, runs one mock turn over SSE
against a session rooted in the mounted `/work`, then stops the stack and
asserts the container exited 0. Container logs are uploaded on failure.

---

## Troubleshooting

**`npm ci` fails with `Cannot find module '…/scripts/postinstall.mjs'`**
The `postinstall` hook is missing. This is the exact failure that made a plain
`npm ci` impossible before `scripts/postinstall.mjs` was restored. Restore the
file, or install with `npm ci --ignore-scripts` to get a usable tree now.

**`npm ci` fails with `postinstall verification FAILED`**
The hook ran and found a real problem; it prints each one. Usually a workspace
symlink or a tool is missing after a partial install. `rm -rf node_modules &&
npm ci` recovers. Set `WINDOWS_RUNNER_SKIP_POSTINSTALL=1` to bypass the check
when you need an install to succeed for other reasons (the Dockerfile and both
installers do this).

**`npm run build` fails with `Missing script: "build"` in a workspace**
Each workspace in `package.json` → `workspaces` must declare `build`, `test` and
`typecheck`, because the root scripts fan out to all of them.
`packages/server/test/packaging.test.ts` fails when one is missing.

**`npm start` says `configuration error (PORT): 127.0.0.1:7634 is already in use`**
Another process (often a previous server) holds the port. Stop it, or run with
`PORT=<free port> npm start`. `PORT=0` picks an ephemeral port and prints it.

**`npm start` says `refusing to bind 0.0.0.0`**
Intentional: the bearer token travels over plain HTTP. Bind a loopback address,
or set `WINDOWS_RUNNER_ALLOW_REMOTE=1` after putting TLS in front — the message
spells out what that exposes. With `WINDOWS_RUNNER_AUTH=off` a non-loopback
bind is refused unconditionally.

**Every `/api` request returns `401 AUTH_REQUIRED`**
Send `Authorization: Bearer <token>`. The token is `WINDOWS_RUNNER_AUTH_TOKEN`
if you set it, else `<data dir>/auth-token` in file mode, else the `token:`
line the banner printed (memory mode). See "Authentication".

**A request returns `403 HOST_NOT_ALLOWED` or `403 ORIGIN_NOT_ALLOWED`**
The `Host` header is not a loopback name or the bind address (add it to
`WINDOWS_RUNNER_ALLOWED_HOSTS`), or a browser sent an `Origin` outside the
allowed set (add it to `WINDOWS_RUNNER_ALLOWED_ORIGINS`).

**A tool result says `PROJECT_NOT_TRUSTED`**
The tool executes configuration supplied by the project, and this project has
not been trusted for that configuration (or it changed). Inspect and grant with
`GET`/`POST /api/sessions/:id/trust` using the `configHash` from the message.

**`npm start` says `provider "…" is not available in this checkout`**
Three providers exist: `mock` (offline), `openai-compatible` and `anthropic`.
There is no `openai` or `ollama` name — OpenAI, Ollama and friends are
`openai-compatible` with `WINDOWS_RUNNER_MODEL_BASE_URL` pointed at them.

**A turn fails with `MODEL_AUTH`, `MODEL_RATE_LIMITED`, `MODEL_UNAVAILABLE`, `MODEL_BAD_REQUEST`, `MODEL_CONTEXT_EXHAUSTED` or `MODEL_STREAM_BROKEN`**
These are the adapters' mappings of the upstream response (both `openai-compatible` and `anthropic` use the same codes):
401/403, 429, connection failure or 5xx, other 4xx (404 usually means a wrong
model name or base URL), a context-length error, or a stream that ended
before the model finished. Rate-limit, unavailable and broken-stream failures
are marked retryable; send the turn again.

**A session request returns `403 PATH_ESCAPES_ROOT` or `400 PATH_NOT_FOUND`**
The `cwd` must be an existing directory inside one of the allowed roots (your
home directory by default). Add roots with `WINDOWS_RUNNER_ALLOWED_ROOTS`, which
takes comma-separated absolute paths; the banner prints the roots in effect.

**`npm start` rebuilds every time**
`prestart` rebuilds when any `packages/{shared,server}/src/**/*.ts` is newer than
the built entry. Check for a file with a clock-skewed mtime (`touch` it, or run
`npm run build` once), and make sure the build actually succeeded.

**`error TS6059: File '…/packages/shared/src/index.ts' is not under 'rootDir'`**
A build config inherited the `paths` mapping that points at shared *source*.
Build configs must map `@windows-runner/shared` to `../shared/dist/index.d.ts`
and build `packages/shared` first.

**`install.ps1` fails with "cannot be loaded because running scripts is disabled"**
Windows blocks local scripts under the default `Restricted` execution policy.
Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once (current user
only), reopen the terminal and re-run. CI bypasses the policy with
`-ExecutionPolicy Bypass` so the script logic itself is validated; the policy
UX above is intentionally left to the operator.
