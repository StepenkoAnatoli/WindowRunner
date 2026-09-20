# Installation

Status of every install path this repository advertises, verified against the
current `main` on Linux.

**Verification environment:** Node `v22.22.3`, npm `10.9.8`, git `2.39.5`,
Linux x86_64, 2026-09-20. Every row below was produced by running the command
listed, not inferred from source.

CI enforces the Linux row only. See
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
| `install.sh` | **Experimental** | Reaches `npm run setup`, then offers `npm start` on an interactive terminal (prints the command when piped) |
| `install.ps1` | **Untested** | No Windows runner is available to this repository (gap G-06) |
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

- **HTTP API only.** There is no web UI and no `packages/web` bundle; the
  endpoints are the ones `createApp()` defines: `POST /api/sessions/:id`,
  `POST /api/sessions/:id/turns`, `GET /api/sessions/:id/turns/:turnId/events`
  (SSE), `POST …/cancel`, `POST /api/sessions/:id/approve`, `GET /api/health`,
  `GET /api/metrics`, `GET /api/diagnostics/persistence`, and `GET /healthz`
  (liveness only).
- **One provider: `mock`.** It is offline, makes no model calls, and prefixes
  every reply with `[mock]`. Naming any other provider in
  `WINDOWS_RUNNER_PROVIDER` is a boot error that lists what is available. The
  OpenAI-compatible and Anthropic adapters are not in this checkout.
- **No tools.** `packages/server/src/agent/tools/` holds the executor and the
  contract, not tool implementations, so the loop runs with an empty tool map
  and the agent can only answer in text. The banner says so.
- **No authentication** (P0-01 is open). Therefore the server refuses to bind
  anything but a loopback address unless `WINDOWS_RUNNER_ALLOW_REMOTE=1` is set
  explicitly. Do not set it on a shared network.

### Configuration

All values come from environment variables; a value that is set but not
understood fails the boot with a message naming the variable. Nothing falls
back silently.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address. Non-loopback requires `WINDOWS_RUNNER_ALLOW_REMOTE=1` |
| `PORT` | `7634` | Port; `0` picks an ephemeral port and prints it in the ready line |
| `WINDOWS_RUNNER_ALLOW_REMOTE` | `0` | Acknowledge that a non-loopback bind exposes an unauthenticated API |
| `WINDOWS_RUNNER_PROVIDER` | `mock` | Provider name; only `mock` exists |
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

**G-06 — no Windows or macOS verification.** CI runs `ubuntu-latest` only. There
is no Windows runner, no macOS runner, no Docker daemon and no Electron build in
this repository's CI, so `install.ps1`, the Windows support matrix and the
desktop path are untested rather than passing.

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
Intentional: the API has no authentication yet (P0-01). Bind a loopback address,
or set `WINDOWS_RUNNER_ALLOW_REMOTE=1` if you have decided the network is
trusted — the message spells out what that exposes.

**`npm start` says `provider "…" is not available in this checkout`**
Only the offline `mock` provider exists here. Unset `WINDOWS_RUNNER_PROVIDER` or
set it to `mock`; there is no key or endpoint to configure.

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
