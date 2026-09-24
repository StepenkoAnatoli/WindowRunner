# WindowRunner

> A local-first coding agent for **Windows** — it runs on your own PC, uses your own API key, and asks your permission before it changes any file or runs any command.

[![Node >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-Windows-blue)](#how-to-install-windows--absolute-beginners)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-informational)](./CHANGELOG.md)

New here? You can be up and running in about five minutes, without ever typing a command — see [How to Install](#how-to-install-windows--absolute-beginners).

---

## Features

- **Works offline, right away** — the built-in *mock* helper answers every message so you can click around and learn the app before you spend a penny.
- **Bring your own key** — OpenAI, Anthropic, Ollama, LM Studio, OpenRouter and any other OpenAI-style service. Add a key, press **Test**, pick a model, done. Change it any time; no restart.
- **Only touches the folder you choose** — every read and every write is locked to the project folder you opened. `..`, absolute paths and sneaky shortcuts are refused.
- **Nothing runs without your click** — writing a file, editing a file and running a terminal command always stop and ask **Approve** or **Deny**. Your "no" goes back to the model as a "no".
- **Trust is a separate decision** — a project's own settings only ever run after you explicitly trust that folder. Approving one action is *not* the same as trusting a project.
- **Project skills, instructions only** — drop markdown files in `.windowrunner/skills/<name>/SKILL.md` and the agent can read them. A skill can never run code and can never skip an approval.
- **Answers stream as they are written** — and if your connection blips, the app resumes where it left off instead of losing the text.
- **Your work stays on your disk** — sessions, history and settings live in your own user folder. The only thing that leaves your PC is the request you send to your chosen model provider.
- **Clear three-panel window** — projects on the left, conversation in the middle, tools and approvals on the right.
- **A real Windows app, if you want one** — the optional desktop build installs per-user with no administrator prompt and keeps its data in `%APPDATA%\WindowRunner`.

---

## Screenshots

> Placeholder — real captures should be added before the first public release. Take them in this order with the window at ~1400 px wide:

| Add this file | What to capture |
|---|---|
| `docs/screenshots/workspace.png` | The three panels: **Projects** sidebar with a project and one session, a conversation with streamed text and an approval card, right-hand inspector showing the tool list |
| `docs/screenshots/approval.png` | One approval card close up: the file-change preview with **Approve** and **Deny** buttons |
| `docs/screenshots/providers.png` | The **Providers** page: the active-provider banner, provider cards with a masked key (`****last4`) and the **Use this / Test / Edit / Delete** buttons |

Once the files exist, replace this table with `![WindowRunner](docs/screenshots/workspace.png)` at the top of this file.

---

## How to Install (Windows – Absolute Beginners)

You do **not** need to know anything about the command line. If you can install a normal Windows program and double-click a file, you can do this.

### Before you start (once, about 2 minutes)

**Install Node.js.** WindowRunner is built on it, and it installs like any other Windows program.

1. Open your browser and go to **https://nodejs.org**
2. Click the big button that says **LTS** (it will say something like *22.x LTS*).
3. Open the downloaded file and click **Next → Next → Finish**. All the standard options are fine.
4. That's it. You never have to open Node.js itself.

> Already have Node.js? Make sure it is **version 22 or newer**. The install screen below tells you if it needs updating.

### Step 1 — Get the WindowRunner folder

- If you downloaded a ZIP (from GitHub: **Code → Download ZIP**, or the `WindowRunner-clean.zip` you were given): right-click it → **Extract All…** → **Extract**.
- If you cloned the project with Git: you already have the folder.

You should end up with a folder that contains `package.json`, `Setup-WindowRunner.cmd` and `Start-WindowRunner.cmd`. Open that folder.

### Step 2 — Double-click `Setup-WindowRunner.cmd` (once, about a minute)

A black window opens and does the work for you. It checks that Node.js is installed and then downloads and prepares everything WindowRunner needs.

- If Node.js is missing or too old, the window tells you exactly what to do and opens the download page for you.
- When it finishes you will see **“Setup finished — WindowRunner is ready to use.”**
- You only ever do this once.

> Seeing *“Windows protected your PC”*? That is the standard warning for downloaded scripts. Choose **More info → Run anyway** to continue.

### Step 3 — Double-click `Start-WindowRunner.cmd`

This starts WindowRunner. When you see a line that begins with `ui:`, hold the **Ctrl** key and click that address — the app opens in your browser already signed in.

Leave the black window open while you use WindowRunner, and close it (or press **Ctrl + C**) when you are done.

**That's the whole installation.** Steps 2 and 3 are the only ones you repeat, and step 2 only if you want to update.

### Other ways to install

<details>
<summary><strong>I'd rather type the commands myself</strong></summary>

Open PowerShell in the WindowRunner folder (click the address bar, type `powershell`, press **Enter**), then:

```powershell
npm ci          # one time: downloads everything
npm start       # every time: starts the app
```

`npm ci` prints `windows-runner: install verified` when it worked. `npm start` prints the ready line and the `ui:` address described above.
</details>

<details>
<summary><strong>One-line installer (downloads the project for you)</strong></summary>

In PowerShell:

```powershell
irm https://raw.githubusercontent.com/StepenkoAnatoli/WindowRunner/main/install.ps1 | iex
```

It downloads the project to `%USERPROFILE%\windows-runner`, installs it and offers to start it. If Windows blocks the script, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once and try again.

`install.ps1` is the older, experimental path — the double-click files above are the recommended way, and [`docs/INSTALL.md`](./docs/INSTALL.md) records the verification status of every install path.
</details>

<details>
<summary><strong>Desktop app (installer, when a Release is published)</strong></summary>

1. Open the project's **Releases** page and download `WindowRunner-Setup-<version>.exe` plus `SHA256SUMS.txt`.
2. Optional but recommended: in PowerShell run `Get-FileHash .\WindowRunner-Setup-*.exe -Algorithm SHA256` and compare the result with `SHA256SUMS.txt`.
3. Double-click the `.exe` — it installs for your user account only, **no administrator permission needed**, into `%LOCALAPPDATA%\Programs\WindowRunner`.
4. Launch **WindowRunner** from the Start Menu. Your sessions and keys live in `%APPDATA%\WindowRunner` and survive updates and uninstalls.

> Releases are not published yet, and installers are unsigned until a production certificate is added, so Windows SmartScreen will warn about an unknown publisher. Until then use the double-click files above.
</details>

### If something goes wrong

| What you see | What to do |
|---|---|
| `'npm' is not recognized` | Node.js is not installed (or the window was open before you installed it). Close the window, install Node.js from **https://nodejs.org**, then double-click `Setup-WindowRunner.cmd` again. |
| `WindowRunner is not set up yet` | You skipped Step 2. Double-click `Setup-WindowRunner.cmd` first. |
| Setup stops with red text | Check your internet connection and that antivirus is not blocking the folder, then run the setup again. Full list: [`docs/INSTALL.md`](./docs/INSTALL.md). |
| The browser shows a blank page | Make sure the black window is still open, then copy the `ui:` address (with everything after the `#`) into the browser's address bar. |

---

## How to Run

| I want to… | Do this |
|---|---|
| Start the app | Double-click **`Start-WindowRunner.cmd`** |
| Stop the app | Close the black window, or press **Ctrl + C** in it |
| Start from a terminal instead | `npm start` in the project folder |
| Update to a newer version | Replace the folder with the new ZIP, then double-click `Setup-WindowRunner.cmd` again |

`npm start` opens a server on your own computer at `http://127.0.0.1:7634` and serves the app to your browser. Nothing is exposed to the internet.

**Other useful commands**

| What you want | Command |
|---|---|
| Auto-restart while editing code (developers) | `npm run dev` |
| Use a real model without the Providers page | `set WINDOWS_RUNNER_PROVIDER=openai-compatible` then `set WINDOWS_RUNNER_MODEL=gpt-4o-mini` then `set WINDOWS_RUNNER_MODEL_API_KEY=sk-...` then `npm start` |
| Use Anthropic | `set WINDOWS_RUNNER_PROVIDER=anthropic` then `set WINDOWS_RUNNER_MODEL=claude-sonnet-4-5` then `set ANTHROPIC_API_KEY=...` |
| Keep history between restarts | `set WINDOWS_RUNNER_PERSISTENCE_MODE=file` then `npm start` |
| Check that it is alive | Open `http://127.0.0.1:7634/healthz` |

---

## How to Use

You can learn the whole app in a minute:

1. **Open a project** — left panel → **Choose folder…** (desktop app) or paste a path such as `C:\Users\me\my-project` → **Open project**. Only files inside that folder can be touched.
2. **Start a session** — click **New session**, type your request at the bottom (for example *“Explain what src/app.js does”*), press **Send**.
3. **Watch it work** — the reply streams in. Every tool the agent uses shows up in the conversation and in the right-hand **Inspector**.
4. **Answer the yellow card** — before a file is written or a command is run you get a preview and two buttons: **Approve** or **Deny**. Denying is safe: the agent is told “no” and carries on.
5. **Add your own key** — top bar → **Providers** → add a provider, press **Test**, then **Use this**. Leave it on the offline *mock* provider while you practise.
6. **Look back** — top bar → **Usage** lists your recent turns; **Settings** shows security, storage and version details and lets you forget remembered projects.

> First time? Stay on the **mock** provider. It replies instantly, offline, and prefixes answers with `[mock]`, so you can learn the flow without spending anything.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Language | TypeScript (strict, ESM) |
| Runtime | Node.js >= 22 |
| Server | Express 4 — deliberately the only runtime dependency — bundled by esbuild into a self-contained `packages/server/dist/index.cjs` |
| Shared core | `@windows-runner/shared` — turn-state reducer, stream-event contract and workspace-catalog validation; the single owner used by both the server and the UIs |
| Web UI | Vanilla TypeScript, no framework: a pure reducer plus pure view modules, bundled with esbuild |
| Desktop | Electron + electron-builder (per-user NSIS installer, no admin prompt) |
| Model providers | `openai-compatible` (OpenAI, Ollama, LM Studio, OpenRouter, Groq, Gemini's compatible endpoint), native `anthropic`, offline `mock`, all behind one interface with retry/backoff |
| Storage | In memory (default) or on disk (JSONL per turn + `meta.json`, atomic writes, corruption quarantine, restart recovery) |
| Tests | `node:test` via `tsx`, Playwright (Chromium and Electron), and a scripted end-to-end eval harness |

---

## Project Structure

```
WindowRunner/
├─ Setup-WindowRunner.cmd       # one-time setup by double-click
├─ Start-WindowRunner.cmd       # start the app by double-click
├─ install.ps1                  # older PowerShell installer (experimental)
├─ package.json                 # scripts: build, test, start, eval, desktop, release
├─ bin/windows-runner.js        # `windows-runner` / `wr` CLI launcher
├─ packages/
│  ├─ shared/                   # types shared by server and UIs (stream events, reducer)
│  ├─ server/                   # Express app, agent loop, providers, persistence
│  │  └─ src/
│  │     ├─ index.ts            # boot entry behind `npm start`
│  │     ├─ config.ts           # every environment setting, parsed strictly
│  │     ├─ app.ts              # HTTP app factory (security, validation, routes)
│  │     ├─ agent/              # turn loop, sessions, approvals, trust, skills
│  │     ├─ providers/          # openai-compatible, anthropic, mock, retry
│  │     ├─ http/routes/        # sessions, turns, providers, skills, observability
│  │     └─ project-root.ts     # the only place filesystem access is authorised
│  ├─ web/                      # browser UI (vanilla TS) + `/dashboard` page
│  └─ desktop/                  # Electron shell for the Windows app
├─ scripts/                     # setup, build guard, smokes, release gates
├─ eval/                        # six scripted coding tasks with hidden checks
├─ docs/
│  ├─ INSTALL.md                # every install path and its verification status
│  ├─ THREAT_MODEL.md           # trust boundaries
│  ├─ adr/                      # decisions: sequencing, approvals, skills
│  └─ research/                 # security review
└─ CONTEXT.md, AGENTS.md        # domain glossary and notes for contributors/agents
```

Generated folders (`node_modules/`, `packages/*/dist/`) are not in Git; `Setup-WindowRunner.cmd` recreates them.

---

## Running Tests

No API keys and no network needed — the suite uses fake OpenAI/Anthropic servers and the offline mock provider.

```powershell
npm test              # all four workspaces (shared, server, web, desktop)
npm run typecheck     # type-check every workspace
npm run build         # produce packages/*/dist

npm run smoke:start   # boot the built server, run a turn, restart, shut down cleanly
npm run smoke:packed  # the published file list matches the package manifest
npm run smoke:packed:start   # unpack that artifact elsewhere and boot it
npm run smoke:launchers      # Windows only: run the two double-click files for real
npm run check:release        # version and changelog consistency gate
npm run eval -- --expect-pass   # six scripted end-to-end tasks against the real server

npm run e2e           # browser UI journeys (Playwright; needs `npm run e2e:install` once)
npm run test:desktop  # desktop unit and contract tests
npm run smoke:desktop # desktop page and Electron smoke tests
npm run e2e:desktop   # full desktop journey in a real Electron window
```

---

## Configuration (advanced)

Everything is optional when the app is started by double-click. Every setting is an environment variable; a value that is set but not understood stops the start with a message naming it — nothing is guessed.

<details>
<summary><strong>All settings and their defaults</strong></summary>

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address. A non-loopback address also needs `WINDOWS_RUNNER_ALLOW_REMOTE=1` |
| `PORT` | `7634` | Port; `0` picks a free one and prints it |
| `WINDOWS_RUNNER_ALLOW_REMOTE` | `0` | Acknowledge that a non-loopback bind exposes the token-protected API over plain HTTP |
| `WINDOWS_RUNNER_AUTH` | `token` | `token` (every `/api` call needs the bearer token) or `off` (loopback only) |
| `WINDOWS_RUNNER_AUTH_TOKEN` | generated | Bearer token, at least 16 characters. Unset: `<data dir>/auth-token` in file mode, else generated per run |
| `WINDOWS_RUNNER_ALLOWED_HOSTS` | none | Extra `Host` header values accepted besides the loopback names and the bind address |
| `WINDOWS_RUNNER_ALLOWED_ORIGINS` | loopback origins | Browser origins allowed to call the API; replaces the loopback default. No wildcards |
| `WINDOWS_RUNNER_PROVIDER` | `mock` | `mock` (offline), `openai-compatible` or `anthropic` |
| `WINDOWS_RUNNER_MODEL` | none | Model name; required with `openai-compatible` / `anthropic` |
| `WINDOWS_RUNNER_MODEL_BASE_URL` | `https://api.openai.com/v1` | Model endpoint base URL (use `http://127.0.0.1:11434/v1` for Ollama) |
| `WINDOWS_RUNNER_MODEL_API_KEY` | `OPENAI_API_KEY`, else none | Model key. Never printed; redacted from errors |
| `WINDOWS_RUNNER_MODEL_MAX_RETRIES` | `2` | Extra attempts on 429/5xx/connection errors, before any output was streamed |
| `WINDOWS_RUNNER_MAX_STEPS` | `10` | Model calls per turn; lower it to cap spend |
| `WINDOWS_RUNNER_MODEL_CALL_TIMEOUT_MS` | `30000` | Wall-clock limit for one model call |
| `WINDOWS_RUNNER_TOOLS` | `1` | Register the built-in tools (`0` = answers only) |
| `WINDOWS_RUNNER_TERMINAL_TIMEOUT_MS` | `60000` | Wall-clock limit for one terminal command |
| `WINDOWS_RUNNER_TERMINAL_OUTPUT_LIMIT` | `65536` | Bytes of command output kept (first and last half) |
| `WINDOWS_RUNNER_PERSISTENCE_MODE` | `memory` | `memory` (lost on restart) or `file` (kept under the data dir) |
| `WINDOWS_RUNNER_DATA_DIR` | `~/.windows-runner` | Where file mode stores sessions; created on first use |
| `WINDOWS_RUNNER_DURABLE_BEFORE_NOTIFY` | `true` in file mode | Save each event before streaming it |
| `WINDOWS_RUNNER_FSYNC` | `false` | Flush every appended event to disk |
| `WINDOWS_RUNNER_ALLOWED_ROOTS` | `WINDOWS_RUNNER_HOME`, else your home folder | Folders a session may be opened in |
| `WINDOWS_RUNNER_HOME` | OS home | Overrides the default allowed root only |
| `WINDOWS_RUNNER_SHUTDOWN_GRACE_MS` | `5000` | How long shutdown waits before forcing sockets closed |

Booleans accept `1/true/yes/on` and `0/false/no/off`. The same table, with the parsing rules, is in [`docs/INSTALL.md`](./docs/INSTALL.md#configuration).
</details>

---

## Known Limitations / TODOs

Kept short and honest; the tracked list is [`RELEASE_CHECKLIST.md`](./RELEASE_CHECKLIST.md).

- **Nothing is published to npm yet** — `npx windows-runner` still 404s. Use the ZIP and the double-click setup.
- **No signed installers yet** — the desktop build works and is tested in CI, but official releases wait for a code-signing certificate, so SmartScreen warns.
- **API keys are stored as plain text on your own disk** (permission-restricted, masked in the UI) — there is no OS keychain integration yet, and no telemetry at all.
- **One server per data folder** — file persistence is safe for a single running app, not for two at once.
- **No sandbox** — an approved terminal command runs with your normal user rights. Approve only what you would type yourself.
- **Windows only** — macOS and Linux are not supported as user platforms (Linux is used for CI).
- **A browser refresh keeps your project list but not the live transcript** — re-open the session to continue.

---

## Contributing

Contributions are welcome — small, focused and Windows-first.

1. Fork the repository and create a branch.
2. Run `npm ci` once, then `npm test`. All four workspaces must pass.
3. Keep filesystem work behind `ProjectRoot` (`packages/server/src/project-root.ts`) — no direct `fs` on paths a user influences.
4. Keep the server free of UI concerns and the UI free of provider specifics.
5. Follow the conventions in [`AGENTS.md`](./AGENTS.md); the terminology glossary is [`CONTEXT.md`](./CONTEXT.md).
6. Open a pull request. CI runs seven checks (unit tests, browser E2E, Docker, Windows platform, desktop, desktop installer, desktop signing) and all must be green.

Please report security issues privately — see [`SECURITY.md`](./SECURITY.md) and [`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md).

---

## License

**Apache-2.0** — see [`LICENSE`](./LICENSE). Third-party components are listed in [`NOTICE`](./NOTICE).

---

*Made for Windows. Local-first: your keys, your machine, your code.*
