# Release Readiness Checklist

This checklist tracks the work required to move the project from a promising
local coding agent to a release-ready, defensible product.

Created: 2026-09-17. This is a planning document: it records what must be true
for release, not implementation. Status snapshots below reflect the repository
state at the time of writing and must be re-verified when each issue is picked
up. The governing detail lives in the source-of-truth documents listed at the
bottom.

Issue mapping: P0-01/P0-02 ↔ hardening plan Phase 1A/1B; P0-03/P0-04 ↔ Phase 1A
residuals; P1-01/P1-02/P1-03 ↔ Phase 4; P1-04 ↔ Phase 3A; P1-05 ↔ Phase 3B;
P1-06/P1-07 ↔ Phase 5; P2-01/P2-02 ↔ Phases 6/5.

## CI enforcement status

What CI actually enforces, versus what this checklist used to assume. Written
2026-09-20, when `.github/workflows/ci.yml` landed and the packaging contract was
repaired. This section is the authority for any "CI green" claim below; the older
status rows were written against a repository state that had no CI at all.

### Enforced today

Four jobs. Triggers: `push` to `main` and every `pull_request`. Concurrency
cancels superseded runs on the same ref; each job has a 20-minute timeout; a
diagnostics artifact is uploaded on failure. `CI` (`ubuntu-latest`) and
`Platform` (`windows-latest` + `macos-latest` matrix, after `CI`) pin Node
exactly to `22.23.2`; the `Docker` job (also after `CI`) builds
`node:22-alpine` images and needs no runner Node at all; `Browser E2E`
(`ubuntu-latest`, after `CI`) installs Chromium via Playwright and drives the
web UI against the real server with a scripted offline provider.

| Check | Command |
| --- | --- |
| Clean install **with lifecycle scripts enabled** | `npm ci` |
| Typecheck — shared, server, web | `npm run typecheck` |
| Build — emits `packages/*/dist` | `npm run build` |
| Full test suite | `npm test` |
| Packed-artifact contents | `npm run smoke:packed` |
| Packed-tarball startup — unpacks tarball and runs `npm start` in clean dir | `npm run smoke:packed:start` |
| Startup smoke — boots the built server, runs a turn over SSE, restarts, clean SIGTERM | `npm run smoke:start` |
| Evaluation harness, scripted mode — real server + `openai-compatible` adapter + built-in tools + approvals against a fake endpoint; five tasks with hidden checks; no keys | `npm run eval -- --expect-pass` |
| Browser E2E — Playwright/Chromium against the web UI, scripted provider, fixed token, no keys (`Browser E2E` job) | `npm run e2e` (after `npm run e2e:install`) |
| Docker image + compose — builds the image, boots the bundle, runs a mock turn over SSE, clean SIGTERM exit | `docker compose up --build -d` (plus health/turn/exit assertions inline in `ci.yml`) |
| Windows/macOS lifecycle — install, typecheck, build, test, packed + startup smokes, native installer in checkout mode | `Platform` matrix (`windows-latest`, `macos-latest`): same commands as `CI`, plus `install.sh --no-start` / `install.ps1 -NoStart` |

`npm ci` runs without `--ignore-scripts` because `scripts/postinstall.mjs` now
exists and verifies the workspace tree. Skipping lifecycle scripts was a
bootstrap workaround for a missing hook, and it hid exactly the class of defect
this checklist tracks.

### Not implemented — nothing gates on these

| Previously claimed | Reality |
| --- | --- |
| Installer fresh-clone + interactive modes | Both installers run in CI only in checkout mode with `--no-start`/`-NoStart`. Cloning from a URL and the interactive start prompt are untested on every OS. |
| `npm run smoke:docker` script | No such script exists; the Docker coverage lives inline in the `Docker` CI job (`docker compose up --build`, health/turn/clean-exit assertions) instead of a repo script. |
| Packed CLI smoke (`npx windows-runner`, `wr`) | `bin/windows-runner.js` exists and is packaged; `smoke:packed:start` tests tarball startup; npm registry publication is open (gap G-05). |
| Electron desktop build | `packages/desktop` does not exist (gap G-04's neighbour). |
| Real-model evaluation runs (P2-02) | Deliberately manual: they cost money and are not reproducible. `eval/README.md`. |
| Matrix of supported Node versions | One exact version. `engines.node` still advertises `>=20.10`, and Node 20 is past its security-fix window — narrowing `engines` is an open support-matrix decision, not a packaging fix. |

### Merge gating is NOT configured

Branch protection on `main` is not set. The automation token used to open and
merge these PRs is refused read *and* write access to the protection rules
(HTTP 403), so it could not enable them and could not verify whether they exist.
Until a repository admin requires the `CI`, `Docker`, `Platform (windows-latest)`,
and `Platform (macos-latest)` status checks and at least one approval on `main`,
a green `CI` run is **informational**: it does not block a merge, and "failed CI
gates block release" (P1-06) is not true.

**Outstanding admin action:** on `main`, require the four status checks `CI`,
`Docker`, `Platform (windows-latest)`, and `Platform (macos-latest)`, plus >= 1
approving review. All four are required so no merge can skip a platform leg or
the Docker job. This is the only item in this section that cannot be done from
a pull request.

---

## Status snapshot (as of 2026-09-17, HEAD `b9ae7ac`)

> `b9ae7ac` is not an object in this repository, so every row below describes a
> state that cannot be reproduced from this checkout. Treat these rows as
> historical intent, not as verified status; "CI enforcement status" above is
> current.

| Issue | Snapshot |
| --- | --- |
| P0-01 | **Landed in this checkout (2026-09-20)** — `packages/server/src/security.ts` middleware in front of every `/api` route: bearer token (env → `<dataDir>/auth-token` → generated), Host validation, explicit Origin allowlist (loopback default, no wildcard, `null` refused), CORS only for allowed origins, `/healthz` public. Boot refuses `WINDOWS_RUNNER_AUTH=off` off loopback unconditionally. Covered by `test/security.test.ts`, `test/boot.test.ts`, `scripts/smoke-start.mjs`, the Docker CI job. Residual: TLS is the operator's job (documented under "Remote access"); a browser/Electron client does not exist yet to exercise the credential flow end to end. The earlier "Batch 2" claim referred to files not present in this repository. |
| P0-02 | **Trust boundary landed in this checkout (2026-09-20)** — `packages/server/src/agent/project-trust.ts`: grants keyed by real root + `configHash`, invalidated on change, persisted to `<dataDir>/trust.json`, checked by `TurnRunner` before any approval for tools declaring `trust`, exposed at `/api/sessions/:id/trust`. Residual: no MCP runtime or spawning tool exists in this checkout, so env allowlisting, `try/finally` client cleanup and a consent UI showing the source configuration remain to be built *on* this gate when those land. |
| P0-03 | Landed — `packages/server/src/access.ts` binds every `cwd`-accepting endpoint (fs, sessions, skills, git, project-context, folder picker) to authorized roots (`allowedProjectRoots` + home by default), canonicalized so symlink/alias escapes are refused. (2026-09-17) |
| P0-04 | **Landed for every route that exists (2026-09-20)** — ids, bodies (object, ≤1 MB), `cwd`, `message`, approval/cancel payloads, `Last-Event-ID`/`afterSeq` and trust payloads are validated with stable `400`/`413` codes before any state is touched (`app.ts`, `test/security.test.ts` "input validation"). No config-mutation or `/fs/*` endpoint exists in this checkout; when they land they must use the same helpers. |
| P1-01 | Open (Phase 4). Related: F16 — the test suite still writes into the real `~/.windows-runner`. |
| P1-02 | Open (Phase 4). |
| P1-03 | Open (Phase 4). |
| P1-04 | Largely complete in Batch 5 — verify-and-guard. Known risk: the price table is a snapshot and will drift. |
| P1-05 | **Largely landed 2026-09-20 (Phase 3).** `src/process-tree.ts` (process group on POSIX, `taskkill /T` on Windows) and `run_terminal` in `src/agent/tools/builtin.ts`; tree kill on timeout and Stop is tested with a grandchild pid on POSIX (`builtin-tools.test.ts`); Windows leg runs the same suite minus the pid checks. Malformed/unknown tool calls are controlled errors. Open: usage accounting across retries (no automatic retry exists), Electron quit on Windows (no Electron). |
| P1-06 | **Partly true as of 2026-09-20.** Linux CI now runs clean install (with lifecycle scripts), typecheck, build, test, a packed-contents smoke test, a startup smoke test that boots the built server, and a Docker job that builds the image via compose and runs a mock turn against it; a Windows/macOS platform matrix repeats the lifecycle plus the native installers; all enforced on `push`/`pull_request`. **Packed-CLI jobs do not exist, and no job gates merges** — branch protection is unconfigured. See "CI enforcement status". |
| P1-07 | **Partial as of 2026-09-20.** Browser E2E (Phase 2) as before. Phase 3 added the fake-provider failure suite: `test/openai-compatible.test.ts` against an OpenAI-shaped fake covers auth, 429 (+ Retry-After), 5xx, retry/backoff (`test/retry.test.ts`), context exhaustion, dropped/garbage streams, malformed tool arguments, cancellation mid-stream. Not covered: settings, edit/diff review, reload-resume; no job gates merges. |
| P2-01 | Partial — `docs/INSTALL.md` carries a verified/experimental status table; Phase 6 positioning work not started. |
| P2-02 | **Partial as of 2026-09-20 (Phase 3).** `eval/` harness with five task categories and hidden checks; scripted mode runs in CI, real-model runs are manual and reported as JSON under `eval/results/`. Metrics recorded: completion, steps, tool calls/failures, approvals (interventions), tokens, elapsed. Not recorded: cost, regressions across releases (no real-model baseline committed yet). |

## P0 — Must fix before recommending installation

### [x] P0-01: Secure local API access and require explicit network opt-in
Title: Secure local API boundary and explicit network exposure

Files to inspect:
- `packages/server/src/security.ts` (policy + middleware)
- `packages/server/src/config.ts` (`WINDOWS_RUNNER_AUTH`, `_AUTH_TOKEN`, `_ALLOWED_HOSTS`, `_ALLOWED_ORIGINS`)
- `packages/server/src/boot.ts` (`resolveAuthToken`, `BindRefusedError`)
- `packages/server/src/app.ts` (middleware mounted before body parsing and every `/api` route)
- `packages/server/test/security.test.ts`, `packages/server/test/boot.test.ts`
- `scripts/smoke-start.mjs`, `scripts/smoke-packed-start.mjs`, `.github/workflows/ci.yml` (Docker job), `docker-compose.yml`
- `docs/INSTALL.md` → "Authentication", "Remote access"

Acceptance criteria:
- [x] All sensitive endpoints require authentication before file, config, session, approval, diagnostic, or stream access succeeds. *(Every `/api` route; only `/healthz` is public. Verified per route in `security.test.ts`.)*
- [x] CORS is replaced with explicit allowed origins; wildcard origins are not used. *(`WINDOWS_RUNNER_ALLOWED_ORIGINS` parse refuses `*`/`null`; CORS headers echo only an allowed origin.)*
- [x] Origin/Host validation rejects untrusted origins and DNS rebinding attempts. *(`403 HOST_NOT_ALLOWED` / `403 ORIGIN_NOT_ALLOWED`, also on `/healthz`.)*
- [x] Missing or null Origin headers are handled safely and do not grant access. *(Absent Origin = no CORS grant, token still required; `Origin: null` always refused.)*
- [x] Default bind remains loopback-only; remote access is explicit and documented. *(`WINDOWS_RUNNER_ALLOW_REMOTE=1` still required; `WINDOWS_RUNNER_AUTH=off` cannot be combined with a non-loopback bind.)*
- [ ] Browser and Electron flows still work with valid credentials. *(Browser: yes — Playwright E2E sends the bearer on every request incl. SSE reconnects. Electron: no client exists.)*
- [x] Unauthorized requests cannot read files, change settings, start turns, or approve actions. *(Verified: provider never invoked, no active turn after a 401.)*
- [x] Regression tests cover auth failure, host rejection, and valid client access.

---

### [~] P0-02: Require explicit project trust before launching MCP commands
*(2026-09-20: the trust boundary — identity, `configHash` invalidation, persistence, loop gate, HTTP API, regression tests — is in place: `packages/server/src/agent/project-trust.ts`, `ToolDefinition.trust`, `test/security.test.ts` "project trust". The MCP runtime this issue was written against does not exist in this checkout; the remaining boxes describe what it must satisfy when it is built on the gate.)*
Title: Require explicit project trust and consent before MCP subprocess launch

Files to inspect:
- `packages/server/src/agent/loop.ts`
- `packages/server/src/mcp/manager.ts`
- `packages/server/src/mcp/client.ts`
- `packages/server/src/skills.ts`
- `packages/server/test/mcp-trust-baseline.test.ts`
- `docs/THREAT_MODEL.md`

Acceptance criteria:
- [x] MCP subprocesses do not start until the user explicitly approves the command. *(Any tool declaring `trust` is refused with `PROJECT_NOT_TRUSTED` before `tool_started`; no MCP tool ships yet.)*
- [ ] Approval UI shows command, arguments, environment-variable names, and source configuration before launch. *(Server exposes `source` + `configHash`; UI pending P1-07.)*
- [x] Approval is tied to canonical project identity and configuration contents. *(Keyed by real root, bound to `configHash`.)*
- [x] If approved MCP config changes, prior approval is invalidated. *(Stale grant named in the refusal; tested.)*
- [x] No subprocess starts when consent is denied or absent. *(Trust is checked before the approval request is minted; tested.)*
- [ ] Environment allowlisting prevents accidental secret leakage to child processes.
- [ ] Dummy secrets do not appear in child environment unless explicitly granted.
- [ ] Skill metadata cannot bypass user-required approvals.
- [ ] Error and cancellation paths clean up MCP clients using structured `try/finally`.
- [x] Regression tests cover untrusted project launch blocking and config invalidation.

---

### [x] P0-03: Bind file-system operations to authorized project/session roots
Title: Bind file-system operations to authorized project/session roots

Files to inspect:
- `packages/server/src/routes.ts`
- `packages/server/src/index.ts`
- `packages/server/src/agent/tools/`
- `packages/server/test/`

Acceptance criteria:
- [x] Filesystem access is restricted to authorized project/session roots, not arbitrary directories.
- [x] Folder-picker authorization is a separate and explicit capability.
- [x] Requests outside the authorized project root fail safely.
- [x] Traversal attempts like `../` escapes are rejected.
- [x] Authorization is enforced consistently for file reads, writes, and project-context access.
- [x] Tests cover valid project access and blocked traversal outside the root.

---

### [x] P0-04: Validate API inputs before applying config or approval updates
Title: Validate request bodies and query parameters at the API boundary

Files to inspect:
- `packages/server/src/app.ts` (`requireSessionId`, `requireTurnId`, `bodyObject`, `isPathString`, JSON error handler)
- `packages/server/test/security.test.ts` ("input validation (P0-04)")

Acceptance criteria:
- [x] Configuration update endpoints validate type, format, and allowed ranges before mutation. *(No config-mutation endpoint exists in this checkout; configuration is environment-only and strictly parsed in `config.ts`.)*
- [x] Approval update endpoints reject malformed or unexpected payloads. *(`400 APPROVAL_INVALID`; trust payloads `400 CONFIG_HASH_INVALID` / `SOURCE_INVALID`.)*
- [x] Query parameters are validated before any state-changing action. *(`afterSeq` / `Last-Event-ID` → `400 CURSOR_INVALID`; path ids → `400 SESSION_ID_INVALID` / `TURN_ID_INVALID`.)*
- [x] Invalid or null request values fail with a controlled error, not partial mutation. *(Non-object/invalid JSON → `400 BODY_INVALID`; >1 MB → `413 BODY_TOO_LARGE`; all checks run before any store or provider call.)*
- [x] Regression tests cover malformed config payloads and approval payloads.

---

## P1 — Required before dependable-agent claims

### [ ] P1-01: Document data flow and redact secrets before persistence/export
Title: Document data flow and redact secrets before persistence/export

Files to inspect:
- `README.md`
- `docs/THREAT_MODEL.md`
- `packages/server/src/error-reporter.ts`
- `packages/server/src/config.ts`
- `packages/server/src/sessions.ts`
- `packages/server/src/routes.ts`
- `packages/web/src/components/CrashReportsPanel.tsx`

Acceptance criteria:
- [ ] Data-flow documentation clearly explains what stays local, what is sent to model/search/MCP providers, and what is persisted.
- [ ] Known credential values and common secret patterns are redacted before crash reports, session exports, or diagnostics are stored.
- [ ] Tool inputs/outputs and conversation snippets are minimized to the lowest necessary level.
- [ ] Export/share flows include a preview/review step before public sharing.
- [ ] README and docs explain the privacy risk and local-first model clearly.
- [ ] Canary secrets never appear in persisted/exported diagnostics.

---

### [ ] P1-02: Preserve user work during agent edits, checkpoints, and recovery
Title: Preserve user work during agent edits, checkpoints, and recovery

Files to inspect:
- `packages/server/src/sessions.ts`
- `packages/server/src/config.ts`
- `packages/server/src/agent/tools/`
- `packages/server/test/`

Acceptance criteria:
- [ ] Agent edits are reversible and can be restored without destroying unrelated user changes.
- [ ] The app does not use blanket `git reset` / `git clean` behavior when recovering from failed agent changes.
- [ ] Session checkpoints preserve user dirty work and agent changes safely.
- [ ] Recovery logic handles crash/restart without silently discarding recoverable state.
- [ ] Concurrent sessions targeting the same working directory warn, serialize, or isolate safely.
- [ ] Regression tests cover recovery after partial writes and recovery after restart.

---

### [ ] P1-03: Add retention, deletion, and user review for crash reports and sessions
Title: Add retention, deletion, and user review for persisted diagnostics

Files to inspect:
- `packages/server/src/error-reporter.ts`
- `packages/server/src/routes.ts`
- `packages/server/src/sessions.ts`
- `packages/web/src/components/CrashReportsPanel.tsx`
- `packages/web/src/App.tsx`

Acceptance criteria:
- [ ] Users can inspect stored crash reports and sessions in the UI or API.
- [ ] Users can delete reports and session artifacts.
- [ ] Retention/deletion policy is documented.
- [ ] Global copies and project-local copies are both covered by the policy.
- [ ] Exported reports include clear warnings that redaction is not perfect.
- [ ] Regression tests cover creation, review, and deletion flows.

---

### [ ] P1-04: Enforce context and spending budgets for long-running agent runs
Title: Enforce context and spending budgets for long-running agent runs

Files to inspect:
- `packages/server/src/agent/loop.ts`
- `packages/server/src/agent/context-budget.ts`
- `packages/server/test/context-budget.test.ts`

Acceptance criteria:
- [ ] The full request is budgeted, including system prompt, tool schemas, messages, tool results, images, and reserved output capacity.
- [ ] Context compaction preserves critical user requirements and recent operational state.
- [ ] Oversized requests are rejected or shrunk before sending to the model.
- [ ] Per-run token and cost limits are enforced honestly and explained to the user.
- [ ] Models without published pricing report “unknown cost” instead of a false value.
- [ ] End-to-end tests cover context exhaustion and budget-stop conditions.

---

### [ ] P1-05: Terminate process trees on cancel and keep retries/transcripts coherent
Title: Terminate process trees on cancel and keep retries/transcripts coherent

Files to inspect:
- `packages/server/src/process-tree.ts`
- `packages/server/src/agent/tools/builtin.ts` (`run_terminal`, `runCommand`)
- `packages/server/src/agent/tools/executor.ts` (parent cancellation is never a tool result)
- `packages/server/src/agent/loop.ts` (malformed tool input → controlled `TOOL_FAILED`)
- `packages/server/test/builtin-tools.test.ts`, `packages/server/test/openai-compatible.test.ts`

Acceptance criteria:
- [x] Long-running terminal commands are terminated with their full process tree on timeout or Stop. *(POSIX: `detached` + `kill(-pgid)` TERM→KILL; verified by checking a grandchild pid is dead. Windows: `taskkill /T /F`.)*
- [ ] Windows and POSIX process cleanup are both covered. *(Both implemented; only the POSIX path asserts on grandchild pids — the Windows CI leg runs the suite with those cases skipped.)*
- [x] Cancellation while awaiting approval exits cleanly without hanging or leaking resources. *(`approvals.cancelTurn` on abort; covered in loop tests and browser E2E "Stop".)*
- [ ] Partial-stream retries do not duplicate visible text or create stale errors. *(No automatic retry exists; partial text is emitted once and the failure code is retryable where appropriate.)*
- [ ] Usage accounting remains consistent across retries. *(Same — no retries yet.)*
- [x] Malformed or unknown tool calls are handled as controlled errors instead of uncaught failures. *(`UNKNOWN_TOOL`; unparsable JSON arguments → `TOOL_FAILED` with the raw input, never an approval prompt.)*
- [x] Regression tests cover cancellation, retries, and malformed tool calls. *(Cancellation and malformed calls; retries n/a.)*

---

### [ ] P1-06: Add release artifact and CI validation for shipped install paths
Title: Add release-validated CI for clean install, build, and packaged artifact smoke tests

Files to inspect:
- `.github/workflows/ci.yml`
- `package.json`
- `scripts/smoke-packed.mjs`
- `docs/INSTALL.md`

Acceptance criteria:
- [x] CI runs clean install, typecheck, test, build, and artifact smoke tests — on **one** pinned Node version (22.23.2), not a matrix of supported versions.
- [x] Linux job included for core validation.
- [x] Windows job included for core validation — the `Platform` matrix runs the lifecycle, packed + startup smokes and `install.ps1 -NoStart` on `windows-latest` (and the same for macOS).
- [x] Packed artifact validation runs from a clean directory without repository-only dependencies — `smoke:packed:start` unpacks tarball outside repo and runs `npm start`, and packaging tests verify standalone bundle execution without node_modules (gaps G-01, G-03, G-04 closed).
- [x] Docker build smoke tests run when Docker is available — the `Docker` job builds the image via compose, runs a mock turn over SSE and asserts a clean exit. There is deliberately no `smoke:docker` repo script; the coverage lives inline in `ci.yml`.
- [ ] Security regressions remain in the normal suite — the referenced security modules (`auth.ts`, `access.ts`, `routes.ts`) are not present in this checkout. The boot path's loopback-only default and `WINDOWS_RUNNER_ALLOW_REMOTE` refusal are covered by `packages/server/test/boot.test.ts` and `scripts/smoke-start.mjs`.
- [x] The built server is tested as a running process, not inferred from source-only tests — `npm run smoke:start` boots `packages/server/dist/index.cjs` from a checkout and `npm run smoke:packed:start` boots it from the packed tarball.
- [ ] Failed CI gates block release — **false today**: branch protection is unconfigured, so a red `CI` run does not block a merge. Requires admin action.

Files that now exist and are exercised by CI: `.github/workflows/ci.yml`,
`scripts/smoke-packed.mjs`, `scripts/smoke-start.mjs`, `scripts/ensure-built.mjs`,
`docs/INSTALL.md`, `packages/server/src/index.ts` (boot entry), `src/boot.ts`,
`src/config.ts`, `packages/server/test/packaging.test.ts`, `test/boot.test.ts`,
`test/config.test.ts`. Still absent: every other path under
`packages/server/src/` that this issue lists for inspection except the agent,
provider and persistence modules.

---

### [ ] P1-07: Add end-to-end browser coverage and fake-provider failure tests
Title: Add end-to-end browser coverage and fake-provider failure tests

Boundary note: P1-05 covers loop-level cancellation/retry correctness (unit and
loop tests). P1-07 adds end-to-end breadth of the same behaviors through the
real UI and provider boundary, plus the browser flows no other issue exercises.

Status 2026-09-20: the web UI and browser suite exist (see "CI enforcement
status"). The UI is deliberately minimal — the smallest client that exercises
every server boundary: token entry (form or `#token=` fragment, kept in
`sessionStorage`, never in the URL), session create/delete, turn submission,
`fetch`-streamed SSE (not `EventSource`, so the bearer header rides on every
request, including reconnects, which resume with `Last-Event-ID`), streamed
text, Stop, approval cards, the project-trust prompt (grant/revoke) and error
banners. Electron, real providers and the broader product UI are out of scope.

Files to inspect:
- `packages/web/src/{api,app-state,main}.ts`, `packages/web/e2e/`, `packages/web/playwright.config.ts`
- `packages/server/src/app.ts` (static serving under `webDir`, protected prefixes bypass static), `packages/server/test/web-ui.test.ts`
- `.github/workflows/ci.yml` (`Browser E2E` job)
- `package.json` (`e2e`, `e2e:install`)

Acceptance criteria:
- [x] Browser E2E suite runs against the mock provider, no API keys required. *(`packages/web/e2e/ui.spec.ts`; scripted provider in `e2e/server.ts` reacts to the message text.)*
- [ ] E2E covers settings, session creation, streaming, approval/denial, edit/diff review, cancellation, reload, and error display. *(Covered: auth, session creation + root refusal, streaming, reconnect, approval/denial with diff preview for write/edit and command preview for run_terminal, cancellation, provider failure, trust prompt, error banner. Not covered: settings — no such UI; reload-resume of an in-flight turn.)*
- [ ] Fake-provider suite covers context exhaustion, rate limits (429 + backoff), broken/dropped streams, malformed tool calls, and cancellation mid-stream. *(All covered: `test/openai-compatible.test.ts` for the adapter; `test/retry.test.ts` for backoff — `providers/retry.ts` retries retryable errors up to `WINDOWS_RUNNER_MODEL_MAX_RETRIES` (default 2) with Retry-After or jittered exponential backoff, only before any chunk was streamed, and aborts the wait on cancel.)*
- [ ] Both suites run in the normal Linux CI job and gate merges. *(E2E runs in its own `Browser E2E` job; merge gating is not configured.)*
- [x] No real-provider keys are required by ordinary CI.

---

## P2 — Product clarity and supportability

### [ ] P2-01: Align product promise with verified behavior and support matrix
Title: Align product promise with user-tested evidence and support matrix

Files to inspect:
- `README.md`
- `docs/INSTALL.md`
- `docs/THREAT_MODEL.md`

Acceptance criteria:
- [ ] README distinguishes supported behavior from experimental behavior.
- [ ] Installation and safety claims match what is actually verified.
- [ ] Known limitations and support matrix are documented.
- [ ] Product positioning matches real user workflows and evaluation results.
- [ ] Unvalidated features are kept out of the standard product narrative.
- [ ] The project can clearly state who it helps, for what tasks, and why.

---

### [ ] P2-02: Add representative real-task evaluations and metrics
Title: Add evaluation harness for representative coding tasks and operational metrics

Files to inspect:
- `eval/run.mts`, `eval/tasks/*/`, `eval/README.md`, `eval/results/`
- `.github/workflows/ci.yml` (scripted run)

Acceptance criteria:
- [x] Evaluation set includes bug fix, feature work, refactor, build failure, and multi-file change tasks.
- [x] Each task uses hidden or independent checks where practical. *(`check.js` lives outside the project root the agent is confined to.)*
- [ ] Metrics are recorded for completion rate, regressions, user interventions, token/cost estimates, elapsed time, and recovery behavior. *(Completion, interventions, tokens, elapsed, steps, tool failures: yes. Cost and regressions: no — no committed real-model baseline yet.)*
- [x] Evaluation results identify model version, task fixture, limits, and failure modes.
- [x] Real-provider evaluations are explicitly separated from ordinary CI and require spending authorization. *(CI runs scripted mode only.)*
- [ ] Results are documented for fair comparison across releases. *(Format exists; first real-model report still to be committed.)*

---

## Persistence Operational Hardening (Phase 7)

### [x] P2-03: File persistence with safe defaults and operational observability
Title: File persistence C Hybrid with durability, security revalidation, and single-process writer boundary

Files:
- `packages/server/src/agent/file-turn-log-store.ts`
- `packages/server/src/agent/file-session-store.ts`
- `packages/server/src/agent/turn-manager.ts`
- `packages/server/src/agent/session-manager.ts`
- `packages/server/src/app.ts`

Acceptance:
- [x] Per-session meta.json + per-turn JSONL, serialized per-turn queue Map<turnId, Promise>
- [x] O_APPEND atomic <4KB, optional fsync, crash recovery truncates incomplete tail
- [x] Recovery: truncated final ignored, malformed middle skip+warn, duplicate keep first, out-of-order sorted with diagnostic never rewrites file automatically, gaps warn, identity mismatches reject/quarantine
- [x] Quarantine >50% invalid moved to quarantine/ dir, cannot be loaded as active
- [x] Boot re-validates every root via ProjectRoot.create with current allowedRoots, never trusts persisted canonicalRoot/realRoot/allowedRootsSnapshot
- [x] RESTART persisted and boot-idempotent across process restarts (file still 3 lines after second boot, not 4)
- [x] Durable-before-notify true never emits SSE before persistence succeeds, async mode records persistenceFailures and warnings
- [x] Retention: evictOldest only terminal, preserves active, deleteTurnFile
- [x] Diagnostics observable via /api/health and /api/diagnostics/persistence (boot diagnostics, persistenceFailures, quarantinedFiles, warnings)
- [x] Single-process writer limitation documented prominently: SERIALIZED WRITES WITHIN ONE PROCESS ONLY. Multi-process UNSUPPORTED — O_APPEND alone does NOT provide session-level correctness, no file lock. Run single instance per dataDir.
- [x] Tests passing, clean-install and clean-build verified on Linux as of
      2026-09-20. The suite has grown past the 101 recorded here (it was 125
      before the packaging contract tests were added); the count is deliberately
      not pinned, because a hardcoded number goes stale the way this one did.
      "Clean install" now means a plain `npm ci` with lifecycle scripts enabled —
      previously it required `--ignore-scripts` and so proved nothing about the
      install path. "Clean build" means `npm run build` emits `packages/*/dist`
      and self-contained bundle `packages/server/dist/index.cjs`, runnable as a server
      from checkout (`npm start`), from tarball (`npm run smoke:packed:start`),
      and in Docker (gaps G-01, G-02, G-03, G-04 closed).

## Release gate

### [ ] All P0 items are complete
### [ ] All Phase 1 acceptance criteria are satisfied
### [ ] All Phase 4 acceptance criteria are satisfied
### [ ] All Phase 5 acceptance criteria are satisfied
### [ ] README and docs match verified support status
### [ ] No open release-blocking security issues remain
### [ ] Release artifacts are tested and verified before publication
### [ ] Packaging gaps G-01..G-05 closed, or publication explicitly abandoned (docs/INSTALL.md) — G-01, G-02, G-03, G-04 closed 2026-09-20; G-05 open
### [ ] Branch protection on `main`: required `CI`, `Docker`, `Platform (windows-latest)`, and `Platform (macos-latest)` checks + >= 1 approval (admin action)
### [ ] `engines.node` narrowed off EOL Node 20, or the support matrix states why it stays
### [x] Persistence: durable-before-notify, RESTART idempotency, root revalidation, quarantine, retention preserving active, diagnostics exposed, single-process limitation documented

---

## Suggested execution order

1. Security hardening — P0-01, P0-02, P0-03, P0-04
   - API auth and origin checks
   - project trust and MCP approval
   - filesystem root restrictions
   - API input validation

2. Privacy and recovery — P1-01, P1-03, P1-02
   - redaction
   - session/report retention and deletion
   - recovery without erasing unrelated user edits

3. Reliability — P1-04, P1-05
   - context budgeting
   - cancellation cleanup
   - retry correctness

4. Release confidence — P1-06, P1-07, P2-01, P2-02
   - E2E coverage (P1-07)
   - fake-provider tests (P1-07)
   - packaged artifact validation (P1-06)
   - support matrix update (P2-01)
   - evaluation harness and metrics (P2-02)

---

## Source of truth

Only two of these documents exist in the repository. The others are cited
throughout this checklist and in the Dockerfile/README history, but were never
committed here; citing them as authoritative is what let claims like "Windows CI
green" survive unchecked.

- `PROJECT_HARDENING_PLAN.md` — **absent**
- `README.md` — present (install/packaging sections corrected 2026-09-20)
- `docs/BASELINE.md` — **absent** (the Dockerfile used to cite it for the F11 finding)
- `docs/THREAT_MODEL.md` — **absent**
- `docs/INSTALL.md` — present; authoritative for install-path status and gaps G-01..G-06
- `.github/workflows/ci.yml` — present; authoritative for what CI enforces
- `docs/research/2026-09-19-checkout-integrity-audit.md` — present; the audit that
  established which documented paths are missing
