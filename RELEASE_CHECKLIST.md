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

## Status snapshot (as of 2026-09-17, HEAD `b9ae7ac`)

| Issue | Snapshot |
| --- | --- |
| P0-01 | Core landed in Batch 2 (bearer-token auth, loopback-only CORS allowlist, Host validation, compose loopback bind). Residual: documented remote-mode auth/transport-security requirements. |
| P0-02 | Core landed in Batch 3 (consent gate before any spawn, `ENV_ALLOWLIST`, `DANGEROUS_TOOLS`, `try/finally` cleanup). Residual: remembered approvals keyed to project identity + `configHash` invalidation, and a consent UI showing the source configuration. |
| P0-03 | Landed — `packages/server/src/access.ts` binds every `cwd`-accepting endpoint (fs, sessions, skills, git, project-context, folder picker) to authorized roots (`allowedProjectRoots` + home by default), canonicalized so symlink/alias escapes are refused. (2026-09-17) |
| P0-04 | Partial — `PATCH /api/config` is strictly validated (F9); approval endpoints (`/approve`, `/mcp-approve`) and `/fs/*` query parameters are still loosely coerced. |
| P1-01 | Open (Phase 4). Related: F16 — the test suite still writes into the real `~/.windows-runner`. |
| P1-02 | Open (Phase 4). |
| P1-03 | Open (Phase 4). |
| P1-04 | Largely complete in Batch 5 — verify-and-guard. Known risk: the price table is a snapshot and will drift. |
| P1-05 | Largely complete in Batch 6, Windows CI green — verify-and-guard. Residual: Electron quit on Windows does not reach the SIGTERM handler. |
| P1-06 | Largely complete (Batch 4 + CI follow-ups; Linux/Windows/packed/Docker jobs all gating) — verify-and-guard. |
| P1-07 | Open (Phase 5 unchecked tasks). |
| P2-01 | Partial — `docs/INSTALL.md` carries a verified/experimental status table; Phase 6 positioning work not started. |
| P2-02 | Open (Phase 5). |

## P0 — Must fix before recommending installation

### [ ] P0-01: Secure local API access and require explicit network opt-in
Title: Secure local API boundary and explicit network exposure

Files to inspect:
- `packages/server/src/index.ts`
- `packages/server/src/routes.ts`
- `packages/server/src/auth.ts`
- `packages/web/src/api.ts`
- `packages/desktop/src/main.js`
- `docker-compose.yml`
- `docs/THREAT_MODEL.md`

Acceptance criteria:
- [ ] All sensitive endpoints require authentication before file, config, session, approval, diagnostic, or stream access succeeds.
- [ ] CORS is replaced with explicit allowed origins; wildcard origins are not used.
- [ ] Origin/Host validation rejects untrusted origins and DNS rebinding attempts.
- [ ] Missing or null Origin headers are handled safely and do not grant access.
- [ ] Default bind remains loopback-only; remote access is explicit and documented.
- [ ] Browser and Electron flows still work with valid credentials.
- [ ] Unauthorized requests cannot read files, change settings, start turns, or approve actions.
- [ ] Regression tests cover auth failure, host rejection, and valid client access.

---

### [ ] P0-02: Require explicit project trust before launching MCP commands
Title: Require explicit project trust and consent before MCP subprocess launch

Files to inspect:
- `packages/server/src/agent/loop.ts`
- `packages/server/src/mcp/manager.ts`
- `packages/server/src/mcp/client.ts`
- `packages/server/src/skills.ts`
- `packages/server/test/mcp-trust-baseline.test.ts`
- `docs/THREAT_MODEL.md`

Acceptance criteria:
- [ ] MCP subprocesses do not start until the user explicitly approves the command.
- [ ] Approval UI shows command, arguments, environment-variable names, and source configuration before launch.
- [ ] Approval is tied to canonical project identity and configuration contents.
- [ ] If approved MCP config changes, prior approval is invalidated.
- [ ] No subprocess starts when consent is denied or absent.
- [ ] Environment allowlisting prevents accidental secret leakage to child processes.
- [ ] Dummy secrets do not appear in child environment unless explicitly granted.
- [ ] Skill metadata cannot bypass user-required approvals.
- [ ] Error and cancellation paths clean up MCP clients using structured `try/finally`.
- [ ] Regression tests cover untrusted project launch blocking and config invalidation.

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

### [ ] P0-04: Validate API inputs before applying config or approval updates
Title: Validate request bodies and query parameters at the API boundary

Files to inspect:
- `packages/server/src/routes.ts`
- `packages/server/src/index.ts`
- `packages/server/test/`

Acceptance criteria:
- [ ] Configuration update endpoints validate type, format, and allowed ranges before mutation.
- [ ] Approval update endpoints reject malformed or unexpected payloads.
- [ ] Query parameters are validated before any state-changing action.
- [ ] Invalid or null request values fail with a controlled error, not partial mutation.
- [ ] Regression tests cover malformed config payloads and approval payloads.

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
- `packages/server/src/agent/tools/terminal.ts`
- `packages/server/src/agent/loop.ts`
- `packages/server/test/process-cleanup.test.ts`
- `packages/server/test/`

Acceptance criteria:
- [ ] Long-running terminal commands are terminated with their full process tree on timeout or Stop.
- [ ] Windows and POSIX process cleanup are both covered.
- [ ] Cancellation while awaiting approval exits cleanly without hanging or leaking resources.
- [ ] Partial-stream retries do not duplicate visible text or create stale errors.
- [ ] Usage accounting remains consistent across retries.
- [ ] Malformed or unknown tool calls are handled as controlled errors instead of uncaught failures.
- [ ] Regression tests cover cancellation, retries, and malformed tool calls.

---

### [ ] P1-06: Add release artifact and CI validation for shipped install paths
Title: Add release-validated CI for clean install, build, and packaged artifact smoke tests

Files to inspect:
- `.github/workflows/ci.yml`
- `package.json`
- `scripts/smoke-packed.mjs`
- `docs/INSTALL.md`

Acceptance criteria:
- [ ] CI runs clean install, typecheck, test, build, and artifact smoke tests on supported Node versions.
- [ ] Linux and Windows jobs are included for core validation.
- [ ] Packed artifact validation runs from a clean directory without repository-only dependencies.
- [ ] Docker build smoke tests run when Docker is available.
- [ ] Security regressions remain in the normal suite.
- [ ] Release artifacts are tested, not inferred from source-only tests.
- [ ] Failed CI gates block release.

---

### [ ] P1-07: Add end-to-end browser coverage and fake-provider failure tests
Title: Add end-to-end browser coverage and fake-provider failure tests

Boundary note: P1-05 covers loop-level cancellation/retry correctness (unit and
loop tests). P1-07 adds end-to-end breadth of the same behaviors through the
real UI and provider boundary, plus the browser flows no other issue exercises.
It builds on existing infrastructure: the mock provider, the OpenAI-shaped fake
provider used by `mock-session-smoke.test.ts`, and the retry fixtures in
`process-cleanup.test.ts`.

Files to inspect:
- `packages/web/`
- `packages/server/test/`
- `.github/workflows/ci.yml`
- `package.json`

Acceptance criteria:
- [ ] Browser E2E suite runs against the mock provider, no API keys required.
- [ ] E2E covers settings, session creation, streaming, approval/denial, edit/diff review, cancellation, reload, and error display.
- [ ] Fake-provider suite covers context exhaustion, rate limits (429 + backoff), broken/dropped streams, malformed tool calls, and cancellation mid-stream.
- [ ] Both suites run in the normal Linux CI job and gate merges.
- [ ] No real-provider keys are required by ordinary CI.

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
- `docs/`
- `packages/server/test/`
- `README.md`

Acceptance criteria:
- [ ] Evaluation set includes bug fix, feature work, refactor, build failure, and multi-file change tasks.
- [ ] Each task uses hidden or independent checks where practical.
- [ ] Metrics are recorded for completion rate, regressions, user interventions, token/cost estimates, elapsed time, and recovery behavior.
- [ ] Evaluation results identify model version, task fixture, limits, and failure modes.
- [ ] Real-provider evaluations are explicitly separated from ordinary CI and require spending authorization.
- [ ] Results are documented for fair comparison across releases.

---

## Release gate

### [ ] All P0 items are complete
### [ ] All Phase 1 acceptance criteria are satisfied
### [ ] All Phase 4 acceptance criteria are satisfied
### [ ] All Phase 5 acceptance criteria are satisfied
### [ ] README and docs match verified support status
### [ ] No open release-blocking security issues remain
### [ ] Release artifacts are tested and verified before publication

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
- `PROJECT_HARDENING_PLAN.md`
- `README.md`
- `docs/BASELINE.md`
- `docs/THREAT_MODEL.md`
- `docs/INSTALL.md`
