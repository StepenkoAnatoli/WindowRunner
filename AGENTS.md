# AGENTS.md

Notes for coding agents working in this repository (this file is also read by
the app itself as project instructions for sessions opened here).

## What this is

A local-first coding agent: Express server + React UI + optional Electron
shell. Users bring their own API keys; nothing phones home.

## Layout

- `packages/server/src/index.ts` — the executable boot entry (`npm start`,
  `npm run dev`). `config.ts` parses the environment (strict; safe defaults),
  `boot.ts` composes `createApp()`, recovers persisted state and drains on
  shutdown. Importing `index.ts` starts a server — import `boot.ts` for the API.
- `packages/server/src/providers/index.ts` — provider registry. Only `mock`
  (`providers/mock.ts`, offline) exists in this checkout; the adapters listed
  below are not present yet.
- `packages/shared/src/index.ts` — every type shared between server and UI.
  Stream events live here; add new ones to the `StreamEvent` union and handle
  them in `packages/web/src/App.tsx` (`applyEvent`).
- `packages/server/src/agent/loop.ts` — the agent loop. One turn = up to
  `MAX_STEPS` model calls; tools execute sequentially; approvals block on a
  promise resolved by `POST /api/sessions/:id/approve`.
- `packages/server/src/agent/project-context.ts` — project context auto-discovery.
  Scans for config files (package.json, Makefile, etc.) and builds a structured
  context injected into the system prompt. Inspired by Claude Code.
- `packages/server/src/agent/tools/` — one file per tool family, each tool is
  `{ spec, requiresApproval, preview, execute }`. New tools only need to be
  added to `ALL_TOOLS` in `index.ts`.
- `packages/server/src/providers/` — `openai-compatible.ts` covers OpenAI,
  OpenRouter, Gemini, Ollama and friends; `anthropic.ts` is native. Both
  implement the same `LLMProvider` interface over normalized `LLMChunk`s.
- `packages/server/src/routes.ts` — REST + SSE surface.
- `packages/server/src/skills.ts` — SKILL.md discovery, parsing, `includes:` resolution.
- `.windows-runner/skills/` — skills shipped with this repo (project skills).
- `packages/web/src/` — React UI. `App.tsx` owns all state; components are
  presentational.

## Conventions

- TypeScript, ESM, `strict` on. No build step for the server in dev (`tsx`).
- Keep the server free of UI concerns and the UI free of provider specifics.
- Anything that touches the filesystem must go through `safePath()`.
- Skills are never injected into the system prompt: they ride in the user turn
  inside `<skill name="…">` tags, so the system prompt stays cache-stable.
- Errors returned to the model should be actionable ("old_str was not found,
  read the file again"), not stack traces.

## Checks

```bash
npm test                                        # tests, no keys needed
npx tsc -p packages/server/tsconfig.json --noEmit
npx tsc -p packages/web/tsconfig.json --noEmit
npm run build                                   # shared + server (bundle) + web
npm run smoke:packed                            # tarball contents against manifest
npm run smoke:packed:start                      # unpack tarball and boot npm start outside repo
npm run smoke:start                             # boot the built server, run a turn, restart, SIGTERM
npm start                                       # http://127.0.0.1:7634 (mock provider, no tools)
```

`npm start` rebuilds automatically when `dist/` is missing or older than `src/`
(`scripts/ensure-built.mjs`). Any new environment variable the server reads
must be added to `ENV` in `config.ts` and to the tables in `docs/INSTALL.md`
and `README.md`.

## Testing without API keys

`packages/server/test/` spins up fake OpenAI- and Anthropic-shaped SSE
servers. Follow that pattern rather than adding tests that need real keys.
The `mock` provider is also useful for manual end-to-end checks.
The skills loader caches per cwd for 5s — use `loadSkills(cwd, { force: true })`
or a fresh temp directory in tests.
