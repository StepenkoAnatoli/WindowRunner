# WindowRunner

> A local-first coding agent for **Windows** — your AI assistant runs on your machine, uses your own API keys, and helps you read, edit, and run code with your approval at every step.

[![Node >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-Windows-blue)](#how-to-install-windows--absolute-beginners)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-informational)](#project-structure)

---

## Features

- **Works offline out of the box** — built-in `mock` provider lets you try the whole app with no API key and no internet
- **Bring your own key** — one place for OpenAI-compatible (OpenAI, Ollama, LM Studio, OpenRouter, Gemini), native **Anthropic**, or offline mock. Switch providers between turns with one click
- **Stays inside your project** — every file the agent touches is locked to the folder you chose. `..`, absolute paths, and sneaky symlinks are blocked for reading *and* writing
- **You approve the risky stuff** — file writes, edits, and terminal commands always pause for **Approve / Deny**. A “no” is sent back to the model; nothing runs without you
- **Project Trust is separate** — a project's own config (like `.mcp.json` or a skill) only runs after you explicitly trust that folder. Approval ≠ trust
- **Project Skills (instructions only)** — drop markdown files under `.windowrunner/skills/<name>/SKILL.md` and the agent can read them with `read_skill`. Skills never execute code and can never skip approval
- **Resumable live streaming** — answers stream over SSE with monotonic `seq` and `Last-Event-ID` resume, so a dropped connection never loses text
- **Durable & private** — sessions and logs stay on your disk (`~/.windows-runner` or `%APPDATA%\WindowRunner` in the desktop app). Only model requests leave your machine, and only when you send a message
- **Clean three-panel UI** — Projects on the left, chat in the middle, tools & approvals on the right. Works on desktop and in the browser with no framework overhead
- **Windows-native shell** — Electron app boots its own server on a random loopback port, holds the token in memory, and shuts down the whole process tree cleanly. Per-user NSIS installer, no admin / UAC needed

## Screenshots

> Screenshots are placeholders — replace with actual captures when publishing. Suggested framing:

| Screenshot | What to show |
|---|---|
| **Workspace** | Three-column layout: project sidebar (Projects / Sessions), center conversation with a turn and approval card, right inspector with tool timeline |
| **Providers** | Provider dashboard: active-provider banner, provider cards with green/gray dots, masked `****last4`, **Use this / Test / Edit / Delete** buttons |
| **Approval** | Detail of an approval card: `write_file` diff preview with **Approve** (blue) and **Deny** (red) |

`Screenshots live in /docs or at the top of README as images: ![Workspace](docs/screenshots/workspace.png)`

---

## How to Install (Windows – Absolute Beginners)

You need **no prior experience** with the command line. Pick **one** option below. The zip method is the simplest if you already downloaded this project.

### What you need first (one time)

1. **Install Node.js**
   - Open your browser and go to **https://nodejs.org**
   - Click the green **LTS** button (it says **22.x LTS**)
   - Run the downloaded installer: click **Next → Next → Next → Finish** (all defaults are fine)
   - To check it worked: press **Windows key**, type **PowerShell**, open **Windows PowerShell**, type `node -v` and press **Enter**. You should see `v22.x.x`.

2. **Install Git (only if you don't have it)**
   - Go to **https://git-scm.com/download/win**
   - Run the installer with defaults
   - Check in the same PowerShell: `git --version`

> You only do steps 1–2 once. You can skip them next time.

### Option A — From the ZIP you downloaded (recommended)

This is the file you get when you click **Download ZIP** on GitHub or receive `WindowRunner-clean.zip`.

1. **Extract the ZIP**
   - Right-click `WindowRunner-clean.zip` → **Extract All…** → **Extract**
   - Open the new folder `WindowRunner` (you should see `package.json` and `install.ps1` inside)

2. **Open PowerShell inside that folder**
   - Click inside the address bar at the top, type `powershell`, press **Enter**
   - A blue window opens already in the right place

3. **Install the app (first time only, about 30 seconds)**
   ```powershell
   npm ci
   ```
   - This downloads everything the app needs. Wait until it says `windows-runner: install verified`.

4. **Start the app**
   ```powershell
   npm start
   ```
   - You will see:
     ```
     windows-runner listening on http://127.0.0.1:7634
       ui:          http://127.0.0.1:7634/#token=...
     ```
   - Hold **Ctrl** and click the `ui:` link, or copy it into your browser
   - The page opens already signed in (the `#token=...` part is removed automatically)

5. **Stop the app**
   - Go back to PowerShell and press **Ctrl + C**

> **Tip:** You can also double-click `install.ps1` or run `powershell -ExecutionPolicy Bypass -File .\install.ps1` — it does `npm ci` → build → typecheck and then offers to start the server.

### Option B — One-line installer (if you have internet)

If you prefer to clone fresh instead of using a ZIP:

1. Open **PowerShell**
2. Paste this and press **Enter**:
   ```powershell
   irm https://raw.githubusercontent.com/StepenkoAnatoli/WindowRunner/main/install.ps1 | iex
   ```
   - It clones the project to `~/windows-runner`, installs, and asks if you want to start. Choose **Y**.
   - If Windows says *“running scripts is disabled”*, run once: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, reopen PowerShell, and try again.

### Option C — Desktop app installer (when a Release is published)

When you see a **Release** on GitHub:

1. Download `WindowRunner-Setup-<version>.exe` and `SHA256SUMS.txt`
2. (Optional) verify the download: in PowerShell `Get-FileHash .\WindowRunner-Setup-*.exe -Algorithm SHA256` and compare with `SHA256SUMS.txt`
3. Double-click the `.exe` → **No admin needed**
4. Find **WindowRunner** in your Start Menu. User data (sessions, profiles) lives in `%APPDATA%\WindowRunner` and survives updates & uninstall.

> Today the installer is built & tested in CI on `windows-latest` but official signed installers await a production certificate (SmartScreen will warn until then — click **More info → Run anyway** if you trust the source). Until the Releases page has an `.exe`, use **Option A**.

**Having trouble?** See [`docs/INSTALL.md`](./docs/INSTALL.md#troubleshooting) for copy-paste fixes for the most common errors, or open an Issue on GitHub.

---

## How to Run

After the first `npm ci`, you only need one command each time:

```powershell
npm start
# → http://127.0.0.1:7634  (mock provider, offline — no API key needed)
```

What happens:
- If the project was never built, it builds automatically before starting (you don't need `npm run build` yourself)
- The browser UI is served at `/` — open the `ui:` URL from the banner; in memory mode it already contains your token
- Every `/api` request needs a bearer token: the banner prints it once in memory mode, or read `~/.windows-runner/auth-token` in file-persistence mode
- Press **Ctrl + C** to stop gracefully (in-flight turns are cancelled cleanly)

**Other useful commands:**

| What you want | Command |
|---|---|
| Auto-restart on file changes (developers) | `npm run dev` |
| Use a real model (OpenAI, Ollama, …) | `set WINDOWS_RUNNER_PROVIDER=openai-compatible` + `set WINDOWS_RUNNER_MODEL=gpt-4o-mini` + `set WINDOWS_RUNNER_MODEL_API_KEY=sk-...` then `npm start` |
| Use Anthropic | `set WINDOWS_RUNNER_PROVIDER=anthropic` + `set WINDOWS_RUNNER_MODEL=claude-sonnet-4-5` + `set ANTHROPIC_API_KEY=...` |
| Start with file persistence | `set WINDOWS_RUNNER_PERSISTENCE_MODE=file` then `npm start` |
| Check if everything is healthy | Open `http://127.0.0.1:7634/healthz` or `http://127.0.0.1:7634/api/health` (with token) |

Full list of environment variables: [`docs/INSTALL.md` → Configuration](./docs/INSTALL.md#configuration) and `packages/server/src/config.ts` (the single source of truth).

---

## How to Use

You can learn the whole app in under a minute:

1. **Pick a folder** — left sidebar → **Choose folder…** (desktop) or type a path like `C:\Users\you\my-project` → **Open project**. The agent will only touch files inside this folder.

2. **Start a conversation** — click **New session** under your project. Type a message at the bottom (e.g. *“Fix the bug in src/app.js”*) and press **Send**.

3. **Watch it work** — the answer streams in real time. Tool calls (reading, writing) appear in the center and in the right **Inspector**.

4. **Approve when asked** — risky actions show a yellow card:
   - **Diff** preview for file writes/edits, **Command** preview for terminal
   - Click **Approve** to let it run, **Deny** to stop that step (the “no” is sent back to the model)
   - If you see *“Project not trusted”* on top, click **Trust this project** only if you trust that folder's config

5. **Manage providers** — top bar → **Providers**: add a new key, **Test** it, **Fetch models** to pick a model, **Use this** to switch for the next turn. No restart needed.

6. **Check history** — top bar → **Usage** shows the last 50 turns (tokens, model, status). **Settings** shows security & storage info and lets you **Forget remembered projects** (clears the sidebar only, not server data).

> **First time?** Leave the provider on **Mock** (offline). It prefixes replies with `[mock]` so you can learn the flow before spending any money.

---

## Tech Stack

| Layer | Choice |
|---|---|
| **Language** | TypeScript (strict), ESM |
| **Runtime** | Node.js >=22 |
| **Server** | Express 4 (only runtime dependency) + self-contained `esbuild` bundle `dist/index.cjs` |
| **Shared core** | `@windows-runner/shared` — turn-state reducer, `StreamEvent` contract, workspace-catalog validation (single owner for server + UIs) |
| **Web UI** | Vanilla TypeScript, no framework — pure reducer (`app-state.ts`) + view modules, `esbuild` → `dist/app` |
| **Desktop** | Electron 44 + electron-builder (NSIS per-user installer) |
| **Providers** | `openai-compatible` (OpenAI, Ollama, vLLM, Groq, Gemini compat) + native `anthropic` + offline `mock` with retry/backoff |
| **Persistence** | In-memory (default) or file (`JSONL` per turn + `meta.json`, atomic writes, quarantine, `RESTART` recovery) |
| **Tests** | `node:test` + `tsx`, Playwright (Chromium + Electron), scripted eval harness |

---

## Project Structure

```
WindowRunner/
├─ bin/
│  └─ windows-runner.js        # CLI launcher (windows-runner / wr) → runs dist/index.cjs
├─ packages/
│  ├─ shared/                  # shared types: StreamEvent union, turn reducer, workspace catalog
│  │  └─ src/index.ts
│  ├─ server/                  # Express app + agent loop + providers
│  │  └─ src/
│  │     ├─ index.ts           # boot entry (npm start)
│  │     ├─ config.ts          # strict env parsing — single source for docs
│  │     ├─ boot.ts            # composes runtime, recovers persisted state
│  │     ├─ app.ts             # Express factory (security, validation, routes)
│  │     ├─ agent/             # loop, turn-manager, session, approvals, trust, persistence
│  │     ├─ providers/         # openai-compatible, anthropic, mock, retry, sse
│  │     ├─ http/              # routes: sessions, turns, providers, observability, skills
│  │     └─ project-root.ts    # ONLY filesystem authority (containment + realpath)
│  ├─ web/                     # vanilla TS UI — app shell + workspace + providers/usage/settings
│  │  └─ src/main.ts           # DOM coordinator (own side effects), reducer owns state
│  └─ desktop/                 # Electron shell — main, preload bridge, server-process, paths
├─ scripts/                    # setup, ensure-built, postinstall, smoke checks
├─ eval/                       # 6 scripted coding tasks + validate-provider probe
├─ docs/
│  ├─ INSTALL.md               # full install-path status & troubleshooting
│  ├─ THREAT_MODEL.md          # trust boundaries
│  └─ adr/                     # 001 seq, 002 approval identity, 003 skills
├─ install.ps1                 # Windows clone-and-setup installer
├─ Dockerfile / docker-compose.yml  # server-bundle verification (dev/CI only)
└─ package.json                # root workspaces + scripts (build, test, start, eval)
```

Generated folders (`packages/*/dist/`, `node_modules/`) are gitignored and rebuilt with `npm run build` / `npm ci`.

---

## Running Tests

No API keys needed — fake OpenAI/Anthropic servers + offline mock provider cover everything.

```powershell
# Full suite — shared + server + web + desktop (desktop auto-builds if needed)
npm test

# Individual workspaces
npm run typecheck              # typecheck all workspaces (no emit)
npm run build                  # emits packages/*/dist + bundled server

# Smoke & contract checks (what CI runs)
npm run smoke:packed            # tarball matches manifest?
npm run smoke:packed:start      # unpack tarball outside repo and boot npm start?
npm run smoke:start             # boot built server → run a mock turn over SSE → restart → SIGTERM
npm run check:release           # version single-source + changelog format
npm run eval -- --expect-pass   # 6 scripted end-to-end tasks with hidden checks (writes eval/results/*.json)

# Desktop & browser E2E (needs build + Playwright/Electron binaries)
npm run test:desktop            # desktop unit & contract tests
npm run smoke:desktop           # page + Electron smoke (Linux + windows-latest CI)
npm run e2e                     # web Playwright suite (Chromium)
npm run e2e:desktop             # real Electron journey (core + providers/settings)
```

`npm start` also has a `prestart` hook that builds automatically when `dist/` is missing or older than `src/`, so you can run tests or start without building first.

---

## Known Limitations / TODOs

Honest and short — these are tracked in [`RELEASE_CHECKLIST.md`](./RELEASE_CHECKLIST.md):

- **npm package not yet published** — `npx windows-runner` still 404s. The publish workflow exists (`.github/workflows/npm-publish.yml`, dry-run by default); until a maintainer adds `NPM_TOKEN` and dispatches it, use the ZIP + `npm ci` path.
- **No OS keychain for API keys** — provider keys are stored in `<data dir>/provider-profiles.json` with mode `0600` and masked as `****last4` in the UI, but at rest they are plaintext. No telemetry or phone-home.
- **Single writer per data dir** — file persistence (`WINDOWS_RUNNER_DATA_DIR`) is safe for one server process. Running two servers on the same dir is unsupported (no file lock; `O_APPEND` alone is not enough).
- **Desktop installer unsigned until a cert is provided** — SmartScreen will warn. Build from source or verify `SHA256SUMS.txt`. Signing pipeline is proven in CI (`Desktop signing` job).
- **No sandbox** — an approved terminal command runs as *you* with your full privileges, network and credentials. Only approve commands you would type yourself; treat untrusted repos like their own scripts (use a VM if needed).
- **macOS / Linux not supported as user platforms** — Windows is the shipped product. Linux runners & Docker are dev/CI infrastructure only.
- **Limited UI persistence** — a refresh keeps the project sidebar but does not restore the live transcript. Re-attach the session to continue.

---

## Contributing

We welcome contributions! Keep it small and Windows-first:

1. Fork the repo and create a feature branch
2. Run `npm ci && npm test` — all four workspaces must pass
3. Keep filesystem access behind `ProjectRoot` (`safePath`) — no raw `fs` on user paths
4. Keep the server free of UI concerns and the UI free of provider specifics
5. Windows is the product platform — don't add macOS/Linux installers or CI legs without a decision
6. Open a pull request — all **seven CI checks must be green** before merge (`CI`, `Browser E2E`, `Docker`, `Platform`, `Desktop`, `Desktop installer`, `Desktop signing`)

Please report security issues privately per [`SECURITY.md`](./SECURITY.md).

---

## License

**Apache-2.0** — see [`LICENSE`](./LICENSE). Third-party components are listed in [`NOTICE`](./NOTICE).

---

*Made for Windows. Local-first. Your keys, your machine, your code.*
