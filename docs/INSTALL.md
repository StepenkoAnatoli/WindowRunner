# Installation

Status of every install path this repository advertises, verified against the
current `main`. Notable changes between versions are in
[`CHANGELOG.md`](../CHANGELOG.md).

**Verification environment:** Node `v22.22.3`, npm `10.9.8`, git `2.39.5`,
Linux x86_64, 2026-09-20. Every row below was produced by running the command
listed, not inferred from source. The `CI` job re-enforces the lifecycle rows
on Linux; the `Platform` leg re-enforces install/typecheck/build/test/smokes
on `windows-latest`. The product is Windows-only; macOS coverage was
deliberately set aside (see the 2026-09-23 Unreleased changelog entry). See
[`RELEASE_CHECKLIST.md`](../RELEASE_CHECKLIST.md) → "CI enforcement status" for
which platform checks exist and which do not.

**PR checks (all seven required green before merge):** `CI`, `Browser E2E`,
`Docker`, `Platform (windows-latest)`, `Desktop (windows-latest)`,
`Desktop installer (windows-latest)` (which also verifies in-place upgrade and
uninstall data survival), and `Desktop signing (windows-latest)` — named in
`.github/workflows/ci.yml`, whose two B2
inventory steps fail the run if the browser or desktop E2E specs are deleted,
renamed, or stop being discovered. Per-phase B2 evidence (run ids and commit
index) lives in
the B2 plan's atomic checklist (removed from the tree with the other process scaffolding; recoverable from git history).

**Historical note — one permanently red run on `main`:** the post-merge run
**35618145045** failed at `Desktop (windows-latest)` → "Electron smoke (real
unpacked Electron)" (a transient runner failure that also skipped the
installer job), and GitHub **refused the rerun** ("its workflow file may be
broken"). The plan-only rerun 35621840761 and every run since are green. Do
not read that single red run as a broken `main`.

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
| Clone + `npm run smoke:launchers` | **Windows only** (skips on Linux/macOS with a printed note) | Runs `Setup-WindowRunner.cmd -NoPause` and `Start-WindowRunner.cmd -NoPause` under `cmd.exe`, asserts the setup banner, the ready line, and `/healthz`; CI runs it in the `Platform (windows-latest)` leg |
| `npm run dev` | **Server only** | `tsx watch` on the server entry. There is still no web dev server or bundler (gap G-03 web residual) |
| `npx windows-runner` / `npm i -g windows-runner` / `wr` | **CLI entry shipped, not yet published** | Bin launchers exist and `.github/workflows/npm-publish.yml` can publish them; nothing is on the registry yet, so `npx windows-runner` still 404s (gap G-05) |
| `install.ps1` | **Experimental, all three modes executed on Windows CI** | Checkout mode (`install.ps1 -NoStart`), fresh-clone mode (a local bare mirror via `WINDOWS_RUNNER_REPO_URL`, asserted to produce a built checkout in `WINDOWS_RUNNER_HOME`), and the start prompt answered `n` (must exit 0 without starting anything). All three green on run 35951799435 (2026-09-24). The `irm … \| iex` invocation still has no coverage, and these rows describe script logic, not the `-ExecutionPolicy` UX |
| `Setup-WindowRunner.cmd` (double-click) | **Executed by CI** (`Platform (windows-latest)` → `npm run smoke:launchers`) | Thin wrapper: refuses a folder that is not a checkout, Node >= 22 check, then `npm run setup` — the verified rows above. `npm run smoke:launchers` runs the wrapper itself under `cmd.exe` with `-NoPause` and asserts the success banner; `packages/server/test/packaging.test.ts` pins ASCII/CRLF/no BOM, the commands it calls, the checkout guard and the batch control flow (every `goto`/`call` resolves to a label, no dead label, one `cd /d "%~dp0"`, an explicit exit code per path). Green on run 35951799435 (2026-09-24) |
| `Start-WindowRunner.cmd` (double-click) | **Executed by CI** (`Platform (windows-latest)` → `npm run smoke:launchers`) | Thin wrapper around `npm start` (verified row above): the smoke test boots it, waits for the ready line, checks `/healthz`, then tears the process tree down. Same encoding/command contract test; it adds no second start path at runtime. Green on run 35951799435 (2026-09-24) |
| `docker compose up --build` | **Verified** (Linux CI) | `Docker` job builds the image, boots the bundle, runs a mock turn over SSE, asserts SIGTERM → 0 |
| `npm run desktop` | **Superseded** | Replaced by the `packages/desktop` workspace — see the desktop rows below (gap G-04 closed; G-07 for the installer) |
| `npm run build:desktop` | **Verified** (Linux + `Desktop` CI jobs) | Compiles the Electron shell and stages the packaged payload under `packages/desktop/dist/` |
| `npm run smoke:electron` (desktop) | **Verified** (`Desktop` CI job, windows-latest) | Real unpacked Electron via Playwright `_electron`: `/desktop` same-origin, in-memory token, clean shutdown |
| `npm run e2e` (web) | **Verified** (`Browser E2E` CI job) | Playwright/Chromium against fixture servers: auth flow, workspace, the B2 provider/usage/settings routes, `/dashboard` compatibility, and B2 accessibility semantics (`packages/web/e2e/`) |
| `npm run e2e:desktop` | **Verified** (`Desktop` + `Desktop installer` CI jobs) | Two journeys against the real Electron shell — core (boot → auto-auth → mock turn → clean shutdown) and B2 providers/settings (create/mask/test/activate providers, settings sections, `/dashboard` token flow, no token or key leakage); the installer job repeats both against the installed app |
| `npm run package:desktop:win` | **Verified** (`Desktop installer` CI job, windows-latest) | Builds `WindowRunner-Setup-<version>.exe`; the job installs silently, runs the journey against the installed app, then uninstalls |

"Verified" means the command succeeded on the environment above. It is not a
claim about any packaged/distributed artifact beyond what the named CI job
exercises. Windows end-user paths are verified by the Windows CI legs; macOS
and Linux are not supported end-user platforms.

---

## Prerequisites

- **Node >= 22.0.0** (declared in `package.json` → `engines.node`).
  Note: CI pins **22.23.2** exactly, because Node 20 is past the end of its
  security-fix window (see the comment in `.github/workflows/ci.yml`). New work
  targets Node 22; the `engines` range is set to `>=22.0.0`.
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
npm run smoke:launchers # Windows only: drives the double-click setup/start wrappers
npm start           # http://127.0.0.1:7634
```

`npm run setup` performs install → typecheck → build in one step and is what
`install.ps1` calls. `npm start` does not need it: its `prestart`
hook (`scripts/ensure-built.mjs`) builds when `packages/*/dist` is missing or
older than `src/`, and is silent otherwise.

### Windows quick start (no command line)

For a downloaded ZIP, two double-clicks are enough. Neither file adds a new
install path: they check that Node is present and then run the same commands as
the block above.

1. `Setup-WindowRunner.cmd` — verifies Node >= 22 (offering the download page and
   plain instructions if it is missing) and runs `npm run setup`.
2. `Start-WindowRunner.cmd` — runs `npm start` and tells you to Ctrl-click the
   `ui:` address it prints.

Both refuse a folder that is not a WindowRunner checkout before they run
anything: they check for `packages\server\package.json`, which exists in an
extracted ZIP and a clone but not in an npm-installed copy (that ships compiled
output only). The three wrong-folder cases a beginner actually hits — the file
opened from inside the ZIP preview window, a stray folder, a global
`node_modules` install — therefore get the script's own plain-language
instructions instead of an npm error they cannot act on.

Both are pinned by `packages/server/test/packaging.test.ts` (plain ASCII, CRLF,
no BOM — a BOM makes `cmd.exe` try to execute the first line — the commands they
must still call, the checkout guard, and the batch control flow: every
`goto`/`call` resolves to a label, no label is left with no jump to it,
exactly one `cd /d "%~dp0"`, and each path ends with an explicit exit code),
shipped in the npm tarball's `files`
list, and **executed** on every `Platform (windows-latest)` CI run by
`npm run smoke:launchers`: the wrapper runs the full setup under `cmd.exe`
(`-NoPause`), then starts the app through the second wrapper, waits for the
ready line and probes `/healthz` before tearing the process tree down. The
`-NoPause` switch exists only so a runner can drive the wrappers; a double-click
behaves exactly as described above.

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

Be precise about what starts; the README is written to match this list:

- **HTTP API plus a web UI.** `packages/web` builds to `packages/web/dist/app`
  and the server serves it at `/` when present (static files never answer under
  `/api/`; `/api` keeps requiring the bearer token). Open the `ui:` URL from the
  banner; in memory mode it includes `#token=<generated token>`, which the page
  stores in `sessionStorage` and strips from the address bar. In file mode paste
  the contents of `<dataDir>/auth-token` into the sign-in field. The UI covers:
  the three-panel workspace (project/session sidebar, conversation with
  streamed text, Stop, approval cards with diffs and commands, project-trust
  prompt, `/`-palette for project skills), provider management
  (`/providers`: add, test, discover models, activate, delete), usage history
  (`/usage`), settings (`/settings/security|storage|about`), and the legacy
  `/dashboard` compatibility page. `/desktop` is the Electron shell.
  The API endpoints are the ones `createApp()` defines:
  `POST /api/sessions/:id`, `DELETE /api/sessions/:id`,
  `GET|POST|DELETE /api/sessions/:id/trust`, `GET /api/sessions/:id/skills`,
  `POST /api/sessions/:id/turns`,
  `GET /api/sessions/:id/turns/:turnId/events` (SSE), `POST …/cancel`,
  `POST /api/sessions/:id/approve`, `GET|POST /api/providers`,
  `DELETE /api/providers/:id`, `POST /api/providers/:id/activate`,
  `POST /api/providers/:id/test`, `POST /api/providers/discover-models`,
  `GET /api/usage`, `GET /api/health`, `GET /api/metrics`,
  `GET /api/diagnostics/persistence`, and `GET /healthz` (liveness only).
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
  that lists what is available. `mock`, `openai-compatible` and `anthropic` are
  the complete registry; there is no plugin provider discovery.
- **Six built-in tools, all confined to the session root** (`WINDOWS_RUNNER_TOOLS=0`
  disables them): `read_file`, `list_dir` and `read_skill` never ask;
  `write_file`, `edit_file` and `run_terminal` ask for approval on every call.
  `read_skill` reads a project-local instruction file under
  `.windowrunner/skills/` (ADR 003) — it is instructions only, executes nothing,
  and cannot widen an approval. Paths are
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

### Provider management (main UI routes + `/dashboard` compatibility)

When the web package is built (`npm run build`), the same origin serves the
main UI at `/` with a small client-side route host — **Workspace** (the
three-column B1 workspace), **Providers**, **Usage**, and **Settings**
(`/providers`, `/usage`, `/settings/security|storage|about`). In-app moves use
`history.pushState` + `popstate` (no framework). A refresh or a pasted link
of those five paths is served the same `index.html` shell — an allowlist in
`packages/server/src/app.ts`, not a catch-all. Unknown paths, missing assets,
and `POST` to those paths stay 404. `/api/*` still requires the bearer token.
`/dashboard` stays a **compatibility entry point** that renders the same
provider components (plus the quick chat) at its old URL for existing
bookmarks; it never redirects and stays independently loadable. A hard load
of `/dashboard` in the desktop window still shows that page's own token form.

Both use the **same bearer token** as `/api` — in a browser the token arrives
via the `#token=…` fragment (stripped from the address bar immediately) or the
token form, and is kept in `sessionStorage` only (a refresh of a deep route
reuses it; it is never put back in the URL); in the **desktop app** the token
is injected into the window's memory by the shell. A refresh of an allowlisted
deep route republishes that bootstrap before the app reads it, so the token
stays in memory and is still never written to the URL, web storage, or disk.
There is no unauthenticated path to `/api`. Loading the HTML shell itself does
not require the token (same as `/`).

Provider management (identical in the main UI's Providers page and on
`/dashboard`):

- **Active-provider banner** — the profile the next turn will run on.
- **Provider cards** — every saved profile with a status dot (green = last
  Test passed, red = failed, gray = never tested), the masked key
  (`****last4` only), and **Use this** (hot-swap: the *next* turn runs on the
  new profile, no restart), **Test** (one minimal request with a 5 s timeout;
  never activates), **Edit**, **Delete** (explicit confirmation; the active
  profile cannot be deleted — the server refuses, so switch first).
- **Add/edit form** — pick the kind (`mock` / `openai-compatible` /
  `anthropic`; the kind and id are immutable on edit), label, model, and base
  URL for OpenAI-compatible endpoints. The API key field is a password input
  that is sent once to the server and never shown again: edits leave it blank
  ("Leave blank to keep the existing key") and the UI never sends the mask or
  an unchanged key back. The form lives in tab/desktop-window memory only —
  it is never persisted to `localStorage`, the workspace catalog, or the URL.
- **Fetch models (model discovery, B4)** — with the kind, base URL, and API
  key typed, **Fetch models** makes ONE authenticated request to this server,
  which probes the provider once (`GET {baseUrl}/models` for
  `openai-compatible`, including local loopback endpoints like Ollama;
  `mock` answers `["mock"]` offline; `anthropic` reports "model discovery
  unavailable for this provider" instead of pretending to a live listing).
  The ids come back deduplicated and sorted into a "Select a model…"
  dropdown; picking one copies it into the model field. One shot per click:
  no polling, no auto-selection, and discovery never saves or activates the
  profile. The upstream probe times out after ~5 seconds (the error is shown
  and the form stays usable); redirects are refused, oversized responses are
  cut off, and results clear when the kind, base URL, or key changes. Manual
  model entry is always available — an empty result says "No models were
  returned. Enter the model id manually." The typed key rides only in the
  discovery request body to this server and the single upstream
  `Authorization` header: it is never stored by the browser, the workspace
  catalog, the URL, logs, or the discovery response, and the browser never
  sends any request to the provider itself.
- **Usage** (main UI route; the same table on `/dashboard`) — the last 50
  usage records (time, provider, model, tokens, status). Cost shows `—`
  unless a price-table entry exists for the exact model id; the bundled table
  is empty, so no cost is ever fabricated. When the server reports bounded
  history, the page says the oldest records rotated out instead of implying
  the table is complete.
- **Quick chat** (dashboard only) — one streamed turn to the active provider,
  reusing the main UI's `POST /turns` + SSE event stream.
- **Settings** (main UI only) — read-only Security/Storage/About information
  from `GET /api/health` (no settings mutate server configuration in this
  release), plus **Settings → Storage → "Forget remembered projects &
  sessions"**, which resets *only* the local workspace catalog (see below).

Storage:

- Profiles live in `<data dir>/provider-profiles.json` (same `<data dir>` as
  sessions — `~/.windows-runner` by default, or `WINDOWS_RUNNER_DATA_DIR`),
  written atomically with **mode 0600**, the same pattern as `auth-token`.
  The file is created on the first boot even in memory mode (sessions stay in
  memory; profiles do not).
- Usage history lives in `<data dir>/usage.jsonl` (mode 0600, one line per
  terminal turn). It contains turn metadata (provider, model, tokens,
  status) — no keys, no message content. It is **bounded**, so it cannot grow
  without limit on a machine that runs for months: once the file would exceed
  8 MiB it is rotated to `usage.jsonl.1` (one older generation is kept, so
  disk use stays around 16 MiB), and a restart only reads the newest tail of
  the file to rebuild the dashboard's table. The dashboard says so when the
  table is partial rather than implying it is the whole history. Copy the file
  away if you want to keep the records; nothing archives them for you.
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

The workspace catalog (separate from provider data):

- The main UI's sidebar remembers the `{ project root, sessionId }` pairs you
  opened, **on this device only**: in a browser under one `localStorage` key
  (`windows-runner.workspace-catalog.v1`), in the desktop app via the shell's
  fixed IPC bridge in the per-user application-data directory. The catalog is
  navigation metadata only — it never contains tokens, provider keys,
  transcripts, tool input/output, or file contents. A refresh keeps that
  catalog (you can reattach a remembered session). It does **not** restore the
  live transcript — B1 never persisted one.
- **Reset navigation metadata** (Settings → Storage) clears exactly that
  catalog. It does NOT delete server sessions, provider profiles, or provider
  keys — the sidebar simply starts empty and re-attaching a server session
  recreates it under the same id. There is no arbitrary filesystem deletion:
  the desktop path uses the same fixed preload method the app already uses
  for catalog persistence.

### Sandboxed authoring environments (browser/Electron downloads)

Two downloads are network-blocked in some sandboxes (CI is unaffected — it
performs both downloads):

- **Electron's binary** (`node_modules/electron/dist/`): `npm run
  smoke:electron` and `npm run e2e:desktop` cannot run without it. Enable it
  with `node node_modules/electron/install.js` where GitHub release downloads
  are allowed; otherwise the `Desktop` / `Desktop installer` CI jobs are the
  required evidence — report the local gap explicitly instead of claiming the
  suites passed.
- **Playwright's managed Chromium** (`npx playwright install chromium`): the
  web e2e accepts any Chromium through the local-debug override —
  `E2E_CHROMIUM_EXECUTABLE=/path/to/chromium E2E_CHROMIUM_LD_LIBRARY_PATH=/path/to/libs npm run e2e`
  (see `packages/web/playwright.config.ts`). One self-contained binary source
  is the desktop dev-dependency `@sparticuz/chromium`: its `executablePath()`
  extracts a Chromium to `/tmp/chromium`, with its shared libraries in the
  extracted `al2023` directory — point `E2E_CHROMIUM_LD_LIBRARY_PATH` there.

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

**G-05 — not published; the publish path now exists.** `npm view
windows-runner` still returns `E404` — nothing has been published. What
changed is that the missing machinery is no longer missing:
`.github/workflows/npm-publish.yml` is a manually dispatched workflow that
proves the tarball exactly as `release.yml` does (tag-bound consistency gate,
unit suite, both packed smokes, `npm pack`) and then publishes it. It defaults
to `dry_run: true`, computes the dist-tag instead of letting npm infer it (a
prerelease goes to `next`, never `latest`), and checks the credential with
`npm whoami` before publishing — because `npm publish --dry-run` exits 0 even
with no token, so a dry run proves the tarball and nothing about auth.

It is kept out of `release.yml` on purpose: that workflow is draft-only
("publishing is a human action"), and npm has no draft — a published version
can never be re-published, so publication is a separate, explicitly
dispatched act. **Publication still requires a maintainer** to add the
`NPM_TOKEN` repository secret (an npm *automation* token, so it works without
2FA interaction) and run the workflow with `dry_run` set to `false`. Until
that first run, `npx windows-runner` keeps returning E404 and no README
sentence may present the npm/npx path as verified.

**G-06 — no Windows or macOS verification. Closed 2026-09-20; rescoped 2026-09-23.**
The `Platform` CI leg runs the full lifecycle (install, typecheck, build, test,
packed and startup smokes) on `windows-latest` and executes `install.ps1` in
checkout mode with `-NoStart`; the macOS leg and `install.sh` were removed with
the Windows-only product scope. The `Desktop` and `Desktop installer` CI jobs
additionally build, launch, drive and uninstall the real Electron app and the
NSIS installer on `windows-latest` (the "no desktop CI" note above predates
them). Residuals: installer fresh-clone mode and the interactive start prompt
are untested on Windows.

---

**G-07 — no packaged Windows desktop app. Closed 2026-09-21 (PR A).**
`packages/desktop` (Electron shell) plus `electron-builder` NSIS packaging:
`npm run package:desktop:win` builds `WindowRunner-Setup-<version>.exe`. The
`Desktop installer (windows-latest)` CI job builds the installer, installs it
silently, drives the installed app through a mock session, and uninstalls it.
See "Windows desktop app" below.

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

## Windows desktop app

The Electron shell in `packages/desktop` boots the bundled server as a child
process (loopback, OS-assigned port, in-memory bearer token) and loads the web
UI at `/desktop` from the server's own origin. Installed users need no Node.js:
the server runs on Electron's own runtime (`ELECTRON_RUN_AS_NODE`).

### Build and run from a checkout

```bash
npm run build          # server + web bundles (prerequisite)
npm run build:desktop  # desktop shell + staged payload
npm run smoke:desktop  # page smoke (Linux) + Electron smoke
npm run e2e:desktop    # the user journey against the unpacked app
```

### Build the installer (Windows)

```bash
npm run package:desktop:win
# → packages/desktop/release/WindowRunner-Setup-<version>.exe
```

### Install / uninstall

- Run `WindowRunner-Setup-<version>.exe`. Per-user install (no admin/UAC),
  Start Menu entry; default location `%LOCALAPPDATA%\Programs\WindowRunner`.
- **Silent install** (automation): `WindowRunner-Setup-<version>.exe /S`.
- **Silent uninstall**:
  `%LOCALAPPDATA%\Programs\WindowRunner\Uninstall WindowRunner.exe /S`.
- **Upgrade**: run the new version's installer — it installs straight over
  the previous version (same location, no uninstall first). Sessions, the
  workspace catalog, provider profiles and logs are untouched.
- **User data** (sessions, provider profiles, logs) lives in
  `%APPDATA%\WindowRunner` and is intentionally kept across uninstall.

CI enforces the whole story on every push: the `Desktop installer
(windows-latest)` job builds the NSIS installer, installs silently, drives the
installed app through boot → auto-auth → mock turn → clean shutdown, verifies
an in-place upgrade to a newer build keeps your data (B5.6), then uninstalls
and asserts removal while user data survives. The installer exe and a
`SHA256SUMS.txt` sidecar are uploaded as a workflow artifact
(`windowrunner-installer`; electron-builder update metadata joins it when
present — it is emitted only once a publish provider is configured).

### Code signing and SmartScreen

**Current status: the signing pipeline is proven, but official installers are
not yet signed — SmartScreen will warn until a production certificate is
provided.**

- The build signs automatically when `WIN_CSC_LINK` (a `.pfx`/`.p12` file
  path, an https URL, or base64 content) and `WIN_CSC_KEY_PASSWORD` are set;
  without them it builds unsigned (documented in
  `packages/desktop/electron-builder.yml`). SHA-256 only.
- The `Desktop signing (windows-latest)` CI job proves the full pipeline on
  every push: it signs a build with a self-signed test certificate and asserts
  the app executable, the installer **and the uninstaller** carry an
  Authenticode signature. This proves cert injection → signtool → signed
  artifacts; it does **not** create trust — a self-signed chain is untrusted on
  every machine by design. It also runs offline
  (`ELECTRON_BUILDER_OFFLINE=true`), so the RFC 3161 timestamping that a real
  release uses is *not* covered by this proof — see the release step below.
- Release builds use `npm run package:desktop:win:release`, which sets
  `forceCodeSigning`: a release build that cannot sign **fails** instead of
  shipping silently unsigned. The signing gate requires **both**
  `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`; setting only one produces an
  explicit "signing misconfigured" error naming the missing secret rather than
  an opaque build failure.
- Because `forceCodeSigning` only proves that *a* signature was applied, the
  release workflow then inspects the artifacts themselves before the installer
  is run or shipped: the app exe, the installer and the uninstaller must all be
  signed, by the **same** subject, must carry an RFC 3161 timestamp (an
  untimestamped signature stops verifying when the certificate expires), and
  must not be signed by the CI test certificate.
- To ship signed installers, a maintainer adds the repository secrets
  `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD` (OV or EV code-signing certificate).
  Nothing else changes — the release workflow picks them up automatically.
  Optionally add `WIN_CSC_EXPECTED_SUBJECT` with the certificate's exact
  subject (for example `CN=Your Name, O=Your Name, C=IL`) to pin the signer:
  the release then fails if the artifact is signed by anything else. The pin is
  skipped when the secret is absent, and after a certificate renewal it must be
  updated or the release will fail with a message saying so.
  With an OV certificate, SmartScreen reputation builds over downloads of the
  signed artifacts; an EV certificate earns immediate reputation. Until then,
  Windows SmartScreen shows "Windows protected your PC" on first run — click
  **More info → Run anyway** if you trust the source, or build from source.

### Verifying a download

Official artifacts come from exactly two places: **GitHub Releases of this
repository** and the **npm registry tarball** (`windows-runner`). Anything
else (mirrors, "free download" sites) is not ours. Every release and every
CI `windowrunner-installer` artifact carries a `SHA256SUMS.txt` sidecar:

```powershell
# Windows PowerShell
Get-FileHash .\WindowRunner-Setup-<version>.exe -Algorithm SHA256
# or: certutil -hashfile .\WindowRunner-Setup-<version>.exe SHA256
```

```bash
# Git Bash (Windows) / other POSIX shells
sha256sum -c SHA256SUMS.txt   # from the directory holding the artifacts
```

Compare against the value published with the release. A checksum verifies
integrity (your download matches what we built), not publisher identity —
publisher identity is what the code signature above provides once a
certificate is in place.

### Crash reports and logs

The desktop shell keeps its diagnostics in the per-user data directory
(`%APPDATA%\WindowRunner` on Windows):

- `logs/server.log` — the bundled server's combined output with the auth
  token redacted.
- `logs/crash-*.log` — small, redacted, bounded records the shell writes when
  something fails: an uncaught exception, an unhandled promise rejection, the
  window renderer dying, or the backend exiting unexpectedly. A fatal error
  dialog names the file it wrote. An unhandled rejection is recorded but does
  **not** kill the app; a renderer crash reloads the window once and fails
  loudly only if it keeps crashing.
- `logs/README.txt` — the note above, shipped next to the files.
- `crashes/*.dmp` — Crashpad minidumps (native memory snapshots) written when
  a process dies hard. **These can contain process memory** — treat them as
  sensitive.

Nothing here is ever uploaded — crash reporting is strictly local (no
`submitURL`, `uploadToServer: false`). Crash logs are scrubbed of the bearer
token and truncated; old crash logs (beyond 20) and minidumps (beyond 10) are
pruned on every boot. You can delete any of these files at any time.

**Known gaps:** no production code-signing certificate yet (see above), the
package is not published to npm yet (gap G-05 — add the `NPM_TOKEN` repository
secret and run the `npm publish` workflow with `dry_run` set to `false`), and
the app uses the default Electron icon. Branding is a separate milestone.

### UI limitations (B3)

- Deep-route refresh works only for `/providers`, `/usage`,
  `/settings/security`, `/settings/storage`, and `/settings/about`. Anything
  else (including `/settings` with no section) is a 404, not the app shell.
- Refresh does not restore the live conversation. The sidebar catalog survives;
  reattach the session to continue.
- Model discovery is one-shot and kind-limited: `openai-compatible` (and the
  offline `mock`) offer a Fetch models dropdown; `anthropic` reports that
  discovery is unavailable, so you type the model id there. Discovery never
  runs on its own and never selects a model for you.
- Keyboard: arrow keys move focus in the top nav, the settings section nav,
  and the inspector tabs. Enter or Space activates. Escape cancels the
  provider form (and dismisses the platform `confirm()` used for delete,
  unsaved-form navigation, and catalog reset). Notices are not dialogs and do
  not trap focus.
- The desktop shell and the browser load the same `app.css`. At 800px and
  below, the project sidebar and inspector overlay the conversation and can
  be collapsed; provider cards are one column.

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
