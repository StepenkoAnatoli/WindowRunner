# Implementation plan — skills system (ADR 003)

**Date:** 2026-09-23
**Spec:** `docs/adr/003-skills-are-instructions-only-project-markdown.md`
**Status:** Proposed — no code written yet

Sequenced for TDD: each phase writes the failing test first, then the code that satisfies it. Phases 1-5 are server-side and independently shippable; phase 6 is the UI; phases 7-8 close the loop.

A skill is instructions only. Nothing in this plan executes project-supplied code, so `ToolDefinition.trust` stays unused and `RELEASE_CHECKLIST.md:205` stays open by design.

---

## Phase 1 — Skills loader

**New:** `packages/server/src/agent/skills.ts`
**New test:** `packages/server/test/skills.test.ts`

Pure module: `loadSkills(root: ProjectRoot) => Promise<{ skills: SkillMeta[]; diagnostics: SkillDiagnostic[] }>`. No I/O outside `ProjectRoot`.

Scan `.windowrunner/skills/*/SKILL.md`, one directory per skill, directory name is the skill name. Parse YAML frontmatter; `name` must equal the directory name, `description` required and length-capped; unknown keys stripped, not rejected.

**DONE 2026-09-23.** `packages/server/src/agent/skills.ts` + `packages/server/test/skills.test.ts`, 16 tests, server suite 393 → 409.

Types landed locally in `skills.ts` (`SkillMeta`, `SkillDiagnostic`, `SkillsIndex`) rather than in `packages/shared` — the loader has no cross-package consumer until phase 3, and hoisting them now would put types in shared with nothing importing them. Phase 3 moves them.

- [x] Happy path: one well-formed skill returns one `SkillMeta`, no diagnostics
- [x] No `.windowrunner/skills/` directory → empty index, **no** diagnostic
- [x] Stray non-directory entry → ignored; directory with no `SKILL.md` → diagnostic
- [x] Missing frontmatter → excluded, diagnostic names the file
- [x] Malformed / non-scalar frontmatter → excluded, diagnostic, scan continues
- [x] Missing `description` → excluded
- [x] `name` ≠ directory name → excluded
- [x] Invalid name → excluded (pattern is `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, stricter than the ADR originally specified)
- [x] ~~Duplicate names → lexicographic precedence~~ — **rule removed as unreachable**; see the ADR. A test pins the property that makes shadowing impossible instead.
- [x] Reserved tool name → excluded (defence in depth; tested with a pattern-valid name so the assertion is not vacuous)
- [x] Over-long description → excluded; oversized body → truncated with a notice
- [x] Symlinked skill directory pointing out of the project → refused with `path_escapes`

**Verify:** `npx tsx --test packages/server/test/skills.test.ts` → 16/16; `npm run test --workspace packages/server` → 409/409; `npx tsc -p packages/server/tsconfig.json --noEmit` → clean.

**Note — the YAML decision, resolved.** There is no YAML parser as a direct dependency: `packages/server/package.json` declares only `express` and `@windows-runner/shared` as runtime dependencies, and `js-yaml` is present in the tree transitively only.

**Hand-roll a minimal frontmatter parser. Do not add `js-yaml`.** Reasoning:

- `ci.yml:86` runs `npm audit --omit=dev --audit-level=high`, and the comment above it at `ci.yml:81` states the invariant it protects: "Today the product has zero runtime npm dependencies". Adding a parser makes it one more package in the audited production surface, permanently, for two keys.
- The frontmatter this feature needs is `name` and `description` — both scalars. A ~30-line parser that accepts `key: value` scalars and *rejects anything else* is smaller and stricter than a general YAML parser, and "rejects anything else" is the correct posture for untrusted project-supplied files: a skill author who writes nested YAML gets a diagnostic, not silently-ignored structure.
- This mirrors the precedent in `packages/desktop/test/packaging.test.ts`: "No YAML dependency: the config is small and these are exact-shape assertions."
- If a future skill field genuinely needs real YAML, revisit it then — as its own decision with its own audit, not as a side effect of this plan.

Phase 1's malformed-YAML test becomes "malformed or non-scalar frontmatter → excluded with a diagnostic".

---

## Phase 2 — `read_skill` built-in tool

**Modified:** `packages/server/src/agent/tools/builtin.ts` (add to `createBuiltinTools()`, `builtin.ts:67`)
**Test:** `packages/server/test/` — extend the existing tool-confinement suite

`read_skill({ name })`. `requiresApproval: () => false` — it returns a text file inside the project root that `read_file` could already return. Resolves through `safePath` semantics.

- [ ] Reads a known skill's body
- [ ] Unknown name → actionable error ("no skill named X; available: …"), not a stack trace, per the AGENTS.md error convention
- [ ] `..`, absolute path, encoded traversal and symlink escape → refused identically to `read_file`
- [ ] Added to `createBuiltinTools()` and nowhere else — the AGENTS.md rule is "there is no plugin discovery"

**Verify:** `npm run test --workspace packages/server`

---

## Phase 3 — Shared types and the skills route

**Modified:** `packages/shared/src/index.ts` — add `SkillMeta { name, description, path }`, `SkillsIndex`, `SkillDiagnostic`
**New:** `packages/server/src/http/routes/skills.ts` — `GET /api/sessions/:id/skills`
**Modified:** `packages/server/src/app.ts` (compose the route), `packages/server/src/http/runtime.ts` if the route needs new `AppRuntime` state
**Test:** follow the existing route-test pattern in `packages/server/test/`

- [ ] Returns the index plus diagnostics
- [ ] Bearer auth required; missing/invalid token rejected like every other `/api` route
- [ ] `http/validate.ts` guards on the session id; stable error codes
- [ ] Unknown session → 404, not an empty index
- [ ] No `any` in the handler — typed `Request`/`Response`, per the AGENTS.md HTTP-layer rule

**Verify:** `npm run typecheck` (catches `any` drift), `npm run test --workspace packages/shared`, `npm run test --workspace packages/server`

---

## Phase 4 — The security invariant (highest-value test in this plan)

**Test:** `packages/server/test/` — new file, using the fake-SSE / scripted-provider pattern

A skill body that instructs the agent to run a terminal command **must still raise the existing `run_terminal` approval**. Scripted `FakeProvider`: model calls `read_skill`, receives a body saying "now run `npm test` via run_terminal", model calls `run_terminal`, assert an approval request is minted and the command does not execute without it.

- [ ] Approval is raised; nothing runs before resolution
- [ ] Denying the approval prevents execution
- [ ] The skill body cannot mark itself as pre-approved — there is no metadata path to do so

This is the assertion that proves "instructions-only" holds. If it is ever possible to make this test fail by editing a `SKILL.md`, the ADR's central claim is false.

**Verify:** `npm run test --workspace packages/server`

---

## Phase 5 — Auto-discovery index

**Modified:** `packages/server/src/agent/loop.ts` — prepend the skills index to the turn's first user message
**Modified:** `packages/shared/src/index.ts` only if a new event proves necessary (it should not)
**Test:** loop tests with the scripted provider

Index is names + descriptions only, never bodies, wrapped in framing that marks it as untrusted project-supplied content. Capped; oversized index truncated with a visible notice.

- [ ] No skills → no index text, no framing, byte-identical message
- [ ] With skills → index present, bodies absent
- [ ] Cap exceeded → truncated with a notice
- [ ] Index recomputed per turn, so mid-session edits take effect next turn
- [ ] **No new `StreamEvent`** — `read_skill` rides `tool_started` / `tool_completed`, so `packages/web/src/app-state.ts` needs no change

**Verify:** `npm run test --workspace packages/server`, `npm run eval -- --expect-pass`

---

## Phase 6 — Web UI

**Modified:** `packages/web/src/main.ts` (wiring, side effects), `packages/web/src/app-state.ts` (only if state is genuinely needed), a new view module for the palette, `packages/web/src/api.ts`
**Test:** `packages/web/test/`, plus `packages/web/e2e/` if a journey is warranted

`/`-command palette over the composer, and a read-only settings list showing discovered skills and their diagnostics so an excluded skill is debuggable rather than invisible.

- [ ] Palette opens on `/`, filters as typed, closes on Escape — consistent with the existing keyboard conventions (`keyboard-nav.ts`: arrows move focus, Enter/Space activate, Escape cancels)
- [ ] Selecting a skill sends the turn; the model calls `read_skill`. **No injection path in the UI.**
- [ ] Diagnostics surface verbatim
- [ ] Reducer stays pure; side effects stay in `main.ts`, per the AGENTS.md split
- [ ] Desktop picks it up at `/desktop` for free — verify, don't reimplement

**Verify:** `npm run test --workspace packages/web`, `npm run e2e`, `npm run smoke:desktop`

---

## Phase 7 — Eval task

**New:** `eval/tasks/skills/` — `task.json`, `project/` with a `.windowrunner/skills/` fixture, `check.js`, `solution.mjs`

A scripted end-to-end task driving a real turn through a skill against the real server.

**Verify:** `npm run eval -- --expect-pass`

---

## Phase 8 — Documentation, in the same commit as the code

This is not a follow-up. `CHANGELOG.md:63` records the project shipping docs that over-claimed features that did not exist; shipping skills without updating these two lines repeats that failure exactly.

- [ ] `README.md:17` — currently "No skills system, no MCP, … those are **not implemented**". Must be rewritten to describe what actually shipped.
- [ ] `AGENTS.md:121` — currently "The skills loader mentioned in older docs does not exist; there is no skills system in this checkout." Must be replaced with the real file map entry.
- [ ] `AGENTS.md` layout section — add `packages/server/src/agent/skills.ts` and `http/routes/skills.ts`
- [ ] `CHANGELOG.md` — an `[Unreleased]` → `Added` entry
- [ ] `docs/adr/003-…md` — flip **Status:** from "Proposed" to "Accepted"
- [ ] No new environment variables, so no `ENV` table entry and no `docs/INSTALL.md` table change — confirm this stayed true

**Verify:** `npm run check:release` (changelog format gate)

---

## Out of scope — explicitly

- **Executable skills / bundled scripts.** Would require declaring `ToolDefinition.trust` and building the consent UI. The upgrade path is additive: `ToolDefinition.trust` is unused and `ProjectTrustRegistry` is complete.
- **`RELEASE_CHECKLIST.md:205`** ("Skill metadata cannot bypass user-required approvals") stays open. It is unreachable while nothing executes project code. Phase 4's test is the guarantee that it stays unreachable.
- **User-global skills.** Project-local only. Adding a second scope later means defining shadowing rules.
- **MCP.** Untouched.
- **New `StreamEvent` types and provider-interface changes.** Neither is needed; both were rejected in the ADR.
- **Restoring `docs/superpowers/plans/`.** Note for whoever implements: `packages/server/test/teardown-hardening.test.ts:167` cites `docs/superpowers/plans/2026-09-22-windows-teardown-hardening-atomic-status.md` inside an assertion message, and `scripts/temp-path.mjs:17` cites the same tree. That directory was deliberately deleted (`CHANGELOG.md`). Nothing fails — these are message strings, not file checks — but do not add new citations to paths that do not exist.

## Final gate

```bash
npm test                      # all four workspaces
npm run typecheck             # shared + server + web
npm run typecheck:desktop
npm run check:release
npm run build
npm run eval -- --expect-pass
npm run smoke:desktop
```

All must pass before the change is called done. `npm run e2e:desktop` if phase 6 touched anything the desktop shell loads.
