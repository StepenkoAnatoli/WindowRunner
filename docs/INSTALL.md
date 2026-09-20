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
| Clone + `npm run setup` | **Verified** (Linux) | install + typecheck + build, in that order |
| `npm start` | **Not available** | No server boot entry point (gap G-02) |
| `npm run dev` | **Not available** | No web dev server; no bundler dependency (gap G-03) |
| `npx windows-runner` / `npm i -g windows-runner` / `wr` | **Not available** | Package declares no `bin` and is not published (gaps G-01, G-05) |
| `install.sh` | **Experimental** | Reaches `npm run setup`; its "start the server" offer is disabled (gap G-02) |
| `install.ps1` | **Untested** | No Windows runner is available to this repository (gap G-06) |
| `docker compose up --build` | **Blocked** | Image cannot start a server (gap G-02); build fails loudly by design |
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
```

`npm run setup` performs install → typecheck → build in one step and is what
`install.sh` / `install.ps1` call.

### What the build produces

| Workspace | Output | Contents |
| --- | --- | --- |
| `packages/shared` | `dist/index.js`, `dist/index.d.ts` | Turn-state reducer and shared types |
| `packages/server` | `dist/**/*.js` + `.d.ts` | `createApp()` and the agent, provider, persistence and metrics modules |
| `packages/web` | `dist/turn-state.js` + `.d.ts` | UI-side turn-state projection |

Each workspace builds from `tsconfig.build.json`, which compiles `src/` only —
so `dist/` never contains tests, and `rootDir` keeps the output flat instead of
nesting `dist/server/src/…` and `dist/shared/src/…` the way the previous
`tsc -p tsconfig.json` build did.

`tsconfig.json` (used by `typecheck` and by `tsx` at test time) still maps
`@windows-runner/shared` to `../shared/src/index.ts`, so **typecheck and test do
not require a prior build**. The build configs instead resolve that specifier to
`../shared/dist/index.d.ts`, which is why `npm run build` builds `shared` first.

---

## Known packaging gaps

These are recorded so nobody re-derives them from a failing command. Each one is
a real blocker for the corresponding advertised path, not a stylistic note.

**G-01 — no CLI entry point.** `package.json` previously declared
`bin: { "windows-runner": "./bin/windows-runner.js", "wr": … }`. Neither `bin/`
nor that file exists, so `bin` was removed. Until a launcher is written,
`npx windows-runner`, `npm i -g windows-runner` and `wr` cannot work.

**G-02 — no server boot path.** `packages/server/src/app.ts` exports
`createApp(deps)` and never calls `listen()`; there is no `src/index.ts`, and the
server workspace declares no `start` script. Nothing in this checkout can serve
HTTP, which is why `npm start`, `prestart`, the Dockerfile `CMD` and the
installers' "start the server" step are all unavailable rather than broken.
Wiring a boot path requires product decisions (config, API keys, auth, default
roots) that are out of scope for packaging.

**G-03 — no bundler.** The Dockerfile and README described an esbuild bundle at
`packages/server/dist/index.cjs` and a Vite build for `packages/web/dist`.
Neither `esbuild` nor `vite` is a dependency, and the lockfile contains no React
toolchain. `dist/` is therefore plain `tsc` output, not a bundle.

**G-04 — `dist/` is not self-contained.** The emitted server and web modules
still `import … from "@windows-runner/shared"`. Inside this checkout that
resolves through the `node_modules/@windows-runner/shared` workspace symlink to
`packages/shared/src/index.ts`, which Node executes via type stripping
(Node >= 22.18 strips types by default). That works locally — verified by
loading `packages/server/dist/app.js` and `packages/web/dist/turn-state.js` and
calling into them — but a published tarball has no workspace symlink, so the
packed `dist/` would not run for a consumer. Bundling shared into the output
(G-03) is the fix.

**G-05 — not published.** `npm view windows-runner` returns `E404`. Any README
sentence presenting the npm/npx path as verified describes a state that does not
exist today.

**G-06 — no Windows or macOS verification.** CI runs `ubuntu-latest` only. There
is no Windows runner, no macOS runner, no Docker daemon and no Electron build in
this repository's CI, so `install.ps1`, the Windows support matrix and the
desktop path are untested rather than passing.

---

## Docker

The Dockerfile is retained but **cannot produce a working image** while G-02 and
G-03 stand: its runtime stage has no server entry point to execute. Rather than
build an image that fails at `docker run` time, the builder stage verifies that
the runtime entry it needs exists and fails the build with an explicit message
when it does not.

`docker-compose.yml` inherits the same blocker.

No Docker daemon was available when this was written, so these statements come
from reading the files and from the absent dependencies, not from an executed
`docker build`.

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

**`error TS6059: File '…/packages/shared/src/index.ts' is not under 'rootDir'`**
A build config inherited the `paths` mapping that points at shared *source*.
Build configs must map `@windows-runner/shared` to `../shared/dist/index.d.ts`
and build `packages/shared` first.
