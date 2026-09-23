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
| `skills` | project skills | read the `release-code` skill and implement `bumpVersion` to its rules | assertions on the suffix and error rules, which exist only inside `SKILL.md` |

`skills` is the only task that exercises the skills system end to end. Its fixture
ships two skills: `release-code` (valid) and `deploy-runbook` (frontmatter never
closed). The valid one is the only entry in the auto-injected index, and the exact
behaviour `check.js` asserts — the pre-release suffix rule and the
`invalid version: <input>` error contract — appears nowhere but in that skill's
body, so a run that never calls `read_skill` cannot pass. The broken skill is
excluded from the index yet still readable by name, which is what the scripted
solution tries first; it is the task's single expected `toolFailures`.

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

Six small Node.js tasks with no external dependencies. They are a smoke-level
benchmark for "can this agent actually edit a project safely", not a coding
leaderboard. Larger, dependency-heavy tasks belong in a separate suite with
its own time budget.

## Validating a real endpoint before spending on the eval

`npm run validate:provider` (`eval/validate-provider.mts`) is the narrow,
ordered check to run once against a new endpoint/account — e.g. an
OpenAI-compatible router — **before** the task suite. It reads the same
`WINDOWS_RUNNER_PROVIDER/MODEL/MODEL_BASE_URL/MODEL_API_KEY` variables as
`npm start`, boots the real server per stage with a throwaway project as the
only root, and stops at the first failure:

1. `text` — one short streamed request → `text_delta`s + usage.
2. `cancel` — a long answer is stopped after the first delta → `turn_cancelled`;
   the time from Stop to the terminal event is reported.
3. `failures` — invalid key → `MODEL_AUTH`; unknown model → `MODEL_BAD_REQUEST`
   or `MODEL_UNAVAILABLE`; verifies the key never appears in messages.
4. `tools` — read-only tool calls arrive assembled; traversal is refused with
   `PATH_ESCAPES_ROOT`; `write_file` asks approval (denied → not written);
   `run_terminal` asks approval and sees no `*_API_KEY`/`*_TOKEN` env vars.

Every turn runs with `maxSteps=3`, a 60 s call timeout and the built-in
retries; stage 4 sends four turns. `--stage N` stops after stage N. The report
`eval/results/validate-<provider>-<model>-<date>.json` records provider, model,
base URL, timestamps, per-stage results, observed events and token usage; the
script refuses to write it if the key appears anywhere in it. Only after this
passes run one task (`npm run eval -- --provider … --task bug-fix`) and then the
full suite.

Cost: pass `--price-in <usd per 1M input tokens> --price-out <usd per 1M output
tokens>` (the model's list price; not known to the tool) to both commands and
the reports gain `estimatedCostUsd` per task and in total. Token counts come
from the provider's usage fields and are summed across the steps of a turn.

Spend controls for real runs: `WINDOWS_RUNNER_MAX_STEPS` (default 10) caps model
calls per turn, `WINDOWS_RUNNER_MODEL_CALL_TIMEOUT_MS` (default 30000) caps one
call, `WINDOWS_RUNNER_MODEL_MAX_RETRIES` (default 2) caps retries.
