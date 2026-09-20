# Evaluation harness

`npm run eval` runs representative coding tasks through the **real** server:
auth on, the `openai-compatible` or `anthropic` adapter, the built-in tool set, approvals
answered by a policy, one allowed root per task. Each task's hidden `check.js`
then verifies the working copy. A JSON report is written to `eval/results/`.

## Tasks (`eval/tasks/<id>/`)

| id | category | what the model must do | hidden check |
| --- | --- | --- | --- |
| `bug-fix` | bug fix | `sum([])` returns `undefined`; make it `0` | unit assertions |
| `feature` | feature work | add and export `slugify` | assertions incl. existing export intact |
| `refactor` | refactor | extract `readEnv` used by three getters | source assertions (`process.env` read once) + behaviour |
| `build-failure` | build failure | run `npm run build`, read the syntax error, fix it | build passes, `package.json` unchanged |
| `multi-file` | multi-file change | rename `fetchUser` → `loadUser` across three files | no stale name, call sites work |

Each task dir has `project/` (the fixture copied to a temp dir), `task.json`
(prompt), `check.js` (never inside the project root, so the model cannot read
or edit it) and `solution.mjs` (the scripted solution, see below).

## Modes

- **Scripted (default, CI):** `npm run eval`. An in-process fake OpenAI endpoint
  plays each task's `solution.mjs` — the tool calls a competent model would
  make. Zero spend, no network, deterministic. It proves the adapter, loop,
  tools, approvals and checks work end to end; it does **not** measure any
  model. CI runs it with `--expect-pass`.
- **Real model (manual, costs money):**
  ```sh
  WINDOWS_RUNNER_MODEL_API_KEY=… npm run eval -- \
    --provider openai-compatible --model gpt-4o-mini --base-url https://api.openai.com/v1
  # local, no key:
  npm run eval -- --provider openai-compatible --model llama3.1 --base-url http://127.0.0.1:11434/v1
  # Anthropic (native adapter):
  ANTHROPIC_API_KEY=… npm run eval -- --provider anthropic --model claude-sonnet-4-5
  ```
  Real runs are deliberately not part of CI. Commit the report under
  `eval/results/<provider>-<model>-<date>.json` so releases can be compared.

Options: `--task <id>` (one task), `--approve approve|deny` (approval policy;
`deny` shows the agent handles refusal), `--keep` (leave temp dirs), `--out`.

## What is recorded

Per task: pass/fail, turn status and failure code, model calls (`steps`), tool
calls and tool failures, approvals asked/denied (user interventions), token
usage as reported by the provider, elapsed time, the check output. Per run:
provider, model, base URL, approval policy, turn limits, Node version,
platform, completion rate, total interventions, total tokens.

Cost is not computed: prices differ per provider and change; multiply tokens
by your provider's rate.

## Limits

Five small Node.js tasks with no external dependencies. They are a smoke-level
benchmark for "can this agent actually edit a project safely", not a coding
leaderboard. Larger, dependency-heavy tasks belong in a separate suite with
its own time budget.
