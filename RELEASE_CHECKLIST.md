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

One job, `ubuntu-latest`, Node pinned exactly to `22.23.2`. Triggers: `push` to
`main` and every `pull_request`. Concurrency cancels superseded runs on the same
ref; the job has a 20-minute timeout; a diagnostics artifact (tool versions,
manifests, per-workspace scripts, `npm` logs) is uploaded on failure.

| Check | Command |
| --- | --- |
| Clean install **with lifecycle scripts enabled** | `npm ci` |
| Typecheck — shared, server, web | `npm run typecheck` |
| Build — emits `packages/*/dist` | `npm run build` |
| Full test suite | `npm test` |
| Packed-artifact contents | `npm run smoke:packed` |
| Packed-tarball startup — unpacks tarball and runs `npm start` in clean dir | `npm run smoke:packed:start` |
| Startup smoke — boots the built server, runs a turn over SSE, restarts, clean SIGTERM | `npm run smoke:start` |

`npm ci` runs without `--ignore-scripts` because `scripts/postinstall.mjs` now
exists and verifies the workspace tree. Skipping lifecycle scripts was a
bootstrap workaround for a missing hook, and it hid exactly the class of defect
this checklist tracks.

### Not implemented — nothing gates on these

| Previously claimed | Reality |
| --- | --- |
| Windows job ("Windows CI green") | No Windows runner in any workflow. `install.ps1` has never been executed (gap G-06). |
| macOS coverage | No job. |
| Docker build / `npm run smoke:docker` | No Docker job in CI, and no `smoke:docker` script exists. The image contract itself is now unblocked (gaps G-02, G-03, G-04 closed; `dist/index.cjs` is self-contained). |
| Packed CLI smoke (`npx windows-runner`, `wr`) | `bin/windows-runner.js` exists and is packaged; `smoke:packed:start` tests tarball startup; npm registry publication is open (gap G-05). |
| Electron desktop build | `packages/desktop` does not exist (gap G-04's neighbour). |
| Browser E2E (P1-07) | No E2E suite and no browser/Playwright dependency. |
| Matrix of supported Node versions | One exact version. `engines.node` still advertises `>=20.10`, and Node 20 is past its security-fix window — narrowing `engines` is an open support-matrix decision, not a packaging fix. |

### Merge gating is NOT configured

Branch protection on `main` is not set. The automation token used to open and
merge these PRs is refused read *and* write access to the protection rules
(HTTP 403), so it could not enable them and could not verify whether they exist.
Until a repository admin requires the `CI` status check and at least one approval
on `main`, a green `CI` run is **informational**: it does not block a merge, and
"failed CI gates block release" (P1-06) is not true.

**Outstanding admin action:** on `main`, require status check `CI` and >= 1
approving review. This is the only item in this section that cannot be done from
a pull request.

---

## Status snapshot (as of 2026-09-17, HEAD `b9ae7ac`)

> `b9ae7ac` is not an object in this repository, so every row below describes a
> state that cannot be reproduced from this checkout. Treat these rows as
> historical intent, not as verified status; "CI enforcement status" above is
> current.

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
| P1-05 | Claimed complete in Batch 6. **"Windows CI green" is not reproducible: there has never been a Windows job in this repository** (see "CI enforcement status"). None of the referenced files (`process-tree.ts`, `tools/terminal.ts`) exist in this checkout. Residual as written: Electron quit on Windows does not reach the SIGTERM handler. |
| P1-06 | **Partly true as of 2026-09-20.** Linux CI now runs clean install (with lifecycle scripts), typecheck, build, test, a packed-contents smoke test and a startup smoke test that boots the built server, and is enforced on `push`/`pull_request`. **Windows, packed-CLI and Docker jobs do not exist, and no job gates merges** — branch protection is unconfigured. See "CI enforcement status". |
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
- [ ] Default bind remains loopback-only; remote access is explicit and documented. *(Partial, 2026-09-20: the boot entry `packages/server/src/index.ts` defaults to `127.0.0.1` and refuses a non-loopback `HOST` unless `WINDOWS_RUNNER_ALLOW_REMOTE=1`; the rest of this issue — auth, CORS, Host validation — is untouched.)*
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
- [x] CI runs clean install, typecheck, test, build, and artifact smoke tests — on **one** pinned Node version (22.23.2), not a matrix of supported versions.
- [x] Linux job included for core validation.
- [ ] Windows job included for core validation — **not implemented**, no Windows runner.
- [x] Packed artifact validation runs from a clean directory without repository-only dependencies — `smoke:packed:start` unpacks tarball outside repo and runs `npm start`, and packaging tests verify standalone bundle execution without node_modules (gaps G-01, G-03, G-04 closed).
- [ ] Docker build smoke tests run when Docker is available — **not implemented**, although the image build itself is unblocked with self-contained bundle at `dist/index.cjs`. No `smoke:docker` script exists.
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
### [ ] Branch protection on `main`: required `CI` check + >= 1 approval (admin action)
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
