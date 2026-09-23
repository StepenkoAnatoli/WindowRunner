# AGENTS.md

Notes for coding agents working in this repository (this file is also read by
the app itself as project instructions for sessions opened here).

## What this is

A local-first coding agent for **Windows**: Express server + framework-free
web UI + Electron desktop shell (`packages/desktop`). Users bring their own
API keys; nothing phones home. The shipped product targets Windows; the
server itself is plain Node 22 and is developed/tested on Linux CI runners
and Docker as build infrastructure — do not add macOS/Linux user-platform
claims.

## Layout

- `packages/server/src/index.ts` — the executable boot entry (`npm start`,
  `npm run dev`). `config.ts` parses the environment (strict; safe defaults;
  the `ENV` table there is the single source the docs tables must match),
  `boot.ts` composes `createApp()`, recovers persisted state and drains on
  shutdown. Importing `index.ts` starts a server — import `boot.ts` for the
  API.
- `packages/server/src/app.ts` — the Express app **factory**: security
  middleware order, body limits, the validation loop, lifecycle hooks
  (`close`, `abortActiveTurns`). It composes route modules and owns none of
  the request handling itself.
- `packages/server/src/http/` — the HTTP surface, one owner per resource:
  `http/validate.ts` (id/body/cursor guards shared by all routes),
  `http/runtime.ts` (`AppRuntime` — the per-app state every route module
  receives; `activeControllers` lives only here), `http/static-ui.ts`
  (dashboard, `/desktop`, deep-route allowlist, web static, `/healthz`),
  `http/routes/sessions.ts` (create/delete session + project trust),
  `http/routes/turns.ts` (start turn, SSE events, cancel, approve),
  `http/routes/observability.ts` (metrics, health, persistence diagnostics),
  `http/routes/providers.ts` (profile CRUD/test/activate/discovery + usage).
- `packages/server/src/agent/loop.ts` — the agent loop. One turn = up to
  `limits.maxSteps` model calls; tools execute sequentially; approvals block
  on a promise resolved by `POST /api/sessions/:id/approve`.
- `packages/server/src/agent/` — turn manager (`turn-manager.ts` owns `seq`),
  session lifecycle (`session-manager.ts`: root pinning, one-active-turn
  policy), approvals (`approval-registry.ts`), trust (`project-trust.ts`),
  file persistence (`file-turn-log-store.ts`, `file-session-store.ts`),
  metrics (`metrics.ts`).
- `packages/server/src/project-root.ts` — the ONLY filesystem authority:
  logical containment + realpath checks. Every tool path goes through it.
- `packages/server/src/providers/` — `openai-compatible.ts` covers OpenAI,
  OpenRouter, Gemini compatibility endpoints, Ollama and friends;
  `anthropic.ts` is the native Messages API adapter; `mock.ts` is the offline
  default. All implement the same `LLMProvider` interface over normalized
  `LLMChunk`s (`sse.ts` is the shared reader); `retry.ts` wraps any provider
  with retry/backoff before the first chunk; `index.ts` is the registry.
- `packages/shared/src/index.ts` — every type shared between server and UIs.
  Stream events live here; add new ones to the `StreamEvent` union and handle
  them in the web reducer (`packages/web/src/app-state.ts`).
  `packages/shared/src/workspace-catalog.ts` is the single owner of the
  workspace-catalog shape and validation used by BOTH the web UI and the
  desktop main process — never duplicate it locally.
- `packages/server/src/agent/tools/builtin.ts` — the complete built-in tool
  set (`read_file`, `write_file`, `edit_file`, `list_dir`, `run_terminal`),
  each `{ spec, requiresApproval, preview, execute }`. There is no plugin
  discovery: new tools are added to `createBuiltinTools()` and nowhere else.
- `packages/web/src/` — web UI (vanilla TypeScript, no framework). `main.ts`
  wires the DOM and owns side effects; `app-state.ts` owns session/turn state
  as a pure reducer; `providers/`, `settings/`, `usage/` are route-local view
  modules; `workspace-catalog.ts` re-exports the shared catalog core plus the
  browser stores. The desktop shell reuses this UI at `/desktop`.
- `packages/desktop/src/` — Electron main process: spawns the bundled server
  (`server-process.ts`), sandboxed preload bridge (`desktop-bridge.ts`,
  allowlisted methods only), per-user paths (`paths.ts`), crash diagnostics.

## Conventions

- TypeScript, ESM, `strict` on. No build step for the server in dev (`tsx`).
- Keep the server free of UI concerns and the UI free of provider specifics.
- Anything that touches the filesystem must go through `ProjectRoot`
  (`safePath` semantics) — no direct `fs` calls on user-influenced paths.
- Errors returned to the model should be actionable ("old_str was not found,
  read the file again"), not stack traces.
- New `any` is forbidden in the HTTP layer: route handlers take typed
  `Request`/`Response`; reach for a structural type or narrow, not `any`.
- Platform scope is Windows: CI keeps only `windows-latest` platform legs
  (Linux runners host the cheap `CI`/`Docker`/`Browser E2E` test jobs).
  Never reintroduce macOS/Linux installers or CI legs without a decision to
  reopen multi-platform support.

## Checks

```bash
npm test                                        # ALL four workspaces (desktop pretest auto-builds its shell)
npx tsc -p packages/server/tsconfig.json --noEmit
npx tsc -p packages/web/tsconfig.json --noEmit
npm run build                                   # shared + server (bundle) + web
npm run typecheck:desktop                       # desktop workspace (3 tsconfigs)
npm run test:desktop                            # desktop unit + contract tests
npm run smoke:desktop                           # desktop page smoke + Electron smoke
npm run e2e:desktop                             # desktop user journey (real Electron)
npm run smoke:packed                            # tarball contents against manifest
npm run smoke:packed:start                      # unpack tarball and boot npm start outside repo
npm run smoke:start                             # boot the built server, run a turn, restart, SIGTERM
npm start                                       # http://127.0.0.1:7634 (mock provider, offline)
npm run check:release                           # version + changelog consistency gate
npm run eval -- --expect-pass                   # scripted end-to-end tasks against the real server
npm run package:desktop:win                     # NSIS installer (unsigned unless WIN_CSC_* set)
npm run package:desktop:win:release             # installer, forceCodeSigning (fails unsigned)
```

`npm start` rebuilds automatically when `dist/` is missing or older than
`src/` (`scripts/ensure-built.mjs`); `npm run test:desktop` does the same for
the desktop shell (`packages/desktop/scripts/ensure-built.mjs`). Any new
environment variable the server reads must be added to `ENV` in `config.ts`
and to the tables in `docs/INSTALL.md` and `README.md`.

## Testing without API keys

`packages/server/test/` spins up fake OpenAI- and Anthropic-shaped SSE
servers. Follow that pattern rather than adding tests that need real keys.
The `mock` provider is also useful for manual end-to-end checks, and
`npm run eval -- --expect-pass` drives the full server (real HTTP, scripted
provider, tools, approvals) through five tasks with hidden checks.
The skills loader mentioned in older docs does not exist; there is no skills
system in this checkout.
