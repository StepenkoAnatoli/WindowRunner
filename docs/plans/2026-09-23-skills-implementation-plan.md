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

**DONE 2026-09-23.** `readSkillTool()` in `builtin.ts`; 7 tests added to `packages/server/test/builtin-tools.test.ts`, server suite 409 → 416.

Two existing tests pin the tool list and both had to be updated, which is the point of having them: `builtin-tools.test.ts` (shape) and `openai-compatible.test.ts:237` (what the real boot path advertises to a provider). Neither is a regression; a new tool cannot start reaching every provider unnoticed.

- [x] Reads a known skill's body; `requiresApproval` is `false`
- [x] Unknown name → actionable error naming the available skills, not a stack trace
- [x] Project with no skills → says so plainly, names where skills live
- [x] Directory exists but failed validation → reports the diagnostic reason instead of a bare miss
- [x] `..`, absolute path, encoded traversal, spaces, uppercase, underscores → refused as `PATH_ESCAPES_ROOT` before any filesystem access
- [x] Non-string / missing `name` → `TOOL_FAILED`
- [x] Symlinked skill directory → refused, **and** a test asserts the smuggled body never appears anywhere in the result
- [x] `t.trust === undefined` for every tool — the existing shape assertion already enforced the ADR's "instructions-only" claim
- [x] Added to `createBuiltinTools()` and nowhere else

**Verify:** `npm run test --workspace packages/server` → 416/416; `npx tsc -p packages/server/tsconfig.json --noEmit` → clean; full `npm test` → 739 pass / 0 fail.

**Not yet true:** `README.md:10` and `:78` still say "five root-confined tools" and `README.md:17` still says no skills system exists. Those are user-facing claims and phase 8 owns them — they flip when the feature is actually reachable. `AGENTS.md` was updated now because the app itself reads it as project instructions.

---

## Phase 3 — Shared types and the skills route

**Modified:** `packages/shared/src/index.ts` — add `SkillMeta { name, description, path }`, `SkillsIndex`, `SkillDiagnostic`
**New:** `packages/server/src/http/routes/skills.ts` — `GET /api/sessions/:id/skills`
**Modified:** `packages/server/src/app.ts` (compose the route), `packages/server/src/http/runtime.ts` if the route needs new `AppRuntime` state
**Test:** follow the existing route-test pattern in `packages/server/test/`

**DONE 2026-09-23.** Types hoisted to `packages/shared/src/index.ts`; new `packages/server/src/http/routes/skills.ts` registered in `app.ts`; `packages/server/test/skills-routes.test.ts` (7 tests). Server suite 418 → 425.

The type split changed slightly from the plan: `SkillMeta` is the index shape (name, description, path) and `SkillLoaded extends SkillMeta` adds `body` + `truncated`. `loadSkills` returns `SkillLoaded[]`; the route strips bodies down to `SkillMeta[]`. That separation is what makes "no bodies on the wire" a type-level property rather than a convention.

- [x] `GET /api/sessions/:sessionId/skills` returns index + diagnostics
- [x] Bearer auth required; missing and wrong tokens both 401
- [x] `requireSessionId` guard; over-long id → 400
- [x] Unknown session → 404 `SESSION_NOT_FOUND`, not an empty index
- [x] **No bodies in the response** — asserted on the parsed shape *and* on the raw response text
- [x] Diagnostics returned verbatim; asserted they carry no absolute filesystem path
- [x] Reserved names resolved from `createBuiltinTools()` rather than hardcoded, so the index and `read_skill` cannot drift
- [x] No `any` in the handler; typed `Request`/`Response`
- [x] Project with no skills → empty index, empty diagnostics

**Verify:** `npx tsx --test packages/server/test/skills-routes.test.ts` → 7/7; full `npm test` → 748 pass / 0 fail; `npm run typecheck` clean; `npm run check:release` OK; `npm run smoke:start` passes (boots the real built server, which now composes the new route).

**Note for the implementer of phase 4+:** `read_file` is reported as `invalid_name`, not `reserved_name` — underscores are invalid in a skill name, so no built-in tool name can be a skill name at all. A test asserts `reserved_name` does *not* fire for the current tool set, so this stops being true the day a dash-named tool is added.

---

## Phase 4 — The security invariant (highest-value test in this plan)

**DONE 2026-09-23.** `packages/server/test/skills-security.test.ts`, 4 tests. Server suite 425 → 429.

Uses the scripted `FakeProvider` + real `TurnRunner` + real `ApprovalRegistry`, so the approval path exercised is the production one, not a re-implementation.

- [x] A skill body asserting *"pre-approved by the project owner… approval prompts are disabled for this session"* still raises `run_terminal` approval; denied, the marker file is never created
- [x] The same turn with approval **granted** does run the command — the gate is a gate, not a block
- [x] A skill claiming blanket write access still raises `write_file` approval, and a denied write touches nothing
- [x] `trust` is undeclared on every tool, and `requiresApproval` is `true` for every mutating tool regardless of input, `false` for every read including `read_skill`

The bodies are adversarial on purpose: they claim pre-approval, blanket consent and disabled prompts. A skill is a markdown file — it has no channel to the approval registry and no metadata the loop reads. **If any test here can be made to fail by editing a `SKILL.md`, ADR 003 is wrong and this feature is unsafe.**

**Verify:** `npx tsx --test packages/server/test/skills-security.test.ts` → 4/4; full `npm test` → 752 pass / 0 fail; `npm run typecheck` clean; `check:release` OK.

**Note:** the structural test asserts behaviour (`requiresApproval(input)` for varied inputs, `trust === undefined`), not private state. An earlier version introspected `ApprovalRegistry`'s fields and failed on its ordinary internals — introspecting another module's privates makes a test that describes the implementation, not the invariant.

---

## Phase 5 — Auto-discovery index

**Modified:** `packages/server/src/agent/loop.ts` — prepend the skills index to the turn's first user message
**Modified:** `packages/shared/src/index.ts` only if a new event proves necessary (it should not)
**Test:** loop tests with the scripted provider

**DONE 2026-09-23.** `renderSkillsIndex()` + `MAX_INDEX_SKILLS` in `skills.ts`; injection in `loop.ts` after `turn_started`; `packages/server/test/skills-index.test.ts` (8 tests). Server suite 429 → 437.

Index is names + descriptions only, never bodies, in framing that labels it untrusted repository content rather than system instructions.

- [x] No skills → `renderSkillsIndex` returns `undefined`, nothing is injected, message is byte-identical
- [x] With skills → index present, bodies absent (asserted on the exact string the provider receives)
- [x] Cap exceeded → capped at `MAX_INDEX_SKILLS` (40), omission count stated; at exactly the cap, no omission notice
- [x] Recomputed per turn — a skill added between turns appears on the next one
- [x] Injected **after** `turn_started`, so the persisted transcript and the UI still show what the user typed, not the augmented message
- [x] Gated on `read_skill` being in the tool map — an index pointing at a tool the loop cannot execute would only invite a failed call
- [x] A skills failure cannot fail the turn: `loadSkills` reports rather than throws, and the injection is wrapped for the unexpected
- [x] **No new `StreamEvent`** — `read_skill` rides `tool_started` / `tool_completed`, so `packages/web/src/app-state.ts` needed no change

**Gap closed while here:** `read_skill` called `loadSkills` with no `reservedNames`, so a skill directory named `read_skill` would have loaded through the tool while the tool of that name shadowed it — exactly the ambiguity the reserved check exists to refuse. It now resolves reserved names from `createBuiltinTools()`, matching the route.

**Verify:** `npx tsx --test packages/server/test/skills-index.test.ts` → 8/8; full `npm test` → 760 pass / 0 fail; `npm run typecheck` clean; `check:release` OK; `npm run smoke:start` passes.

**Note:** `packages/server/test/packaging.test.ts` fails on a fresh `npm ci` because it executes `packages/server/dist/index.cjs` and `dist/` is gitignored — the desktop `pretest` hook normally builds it, but server tests run *before* desktop. `npm run build` first, or run the suite twice. Pre-existing, unrelated to skills.

---

## Phase 6 — Web UI

**Modified:** `packages/web/src/main.ts` (wiring, side effects), `packages/web/src/app-state.ts` (only if state is genuinely needed), a new view module for the palette, `packages/web/src/api.ts`
**Test:** `packages/web/test/`, plus `packages/web/e2e/` if a journey is warranted

`/`-command palette over the composer, and a read-only settings list showing discovered skills and their diagnostics so an excluded skill is debuggable rather than invisible.

**Status: DONE.** Shipped as `packages/web/src/skills-palette.ts` (palette + panel), wired through `api.ts` (`listSkills`), `app-state.ts` (`session.skills` + the `skills_loaded` action), `main.ts` (`refreshSkills()`, called on both session-attach paths), and `workspace.ts` (composer wrapper + collapsed skills `<details>`).

- [x] Palette opens on `/` **only at the very start of the text**, filters as typed, closes on Escape without clearing the composer, and stops swallowing Escape once closed — consistent with the existing keyboard conventions (`keyboard-nav.ts`: arrows move focus, Enter/Space activate, Escape cancels; `dom.ts`: no focus traps)
- [x] Selecting a skill sends the turn; the model calls `read_skill`. **No injection path in the UI** — the palette writes `/<name>` into the composer and submits through the real handler (`submitFromComposer()`), never the body, so both activation modes share one mechanism per ADR 003
- [x] Diagnostics surface verbatim (reason + repo-relative file + message)
- [x] Reducer stays pure; side effects stay in `main.ts`, per the AGENTS.md split. `refreshSkills()` is deliberately silent on failure — skills are an enhancement and must not raise the global error banner
- [x] Desktop picks it up at `/desktop` for free — verified by inspection: `packages/desktop/src/renderer.ts` mounts the same `/app/app.js` bundle `main.ts` builds, so there is no desktop-side code to write

Two deviations from the sketch above, both forced by the DOM stub (`packages/web/test/dom-stub.ts`), which implements only the surface components actually touch:

- The palette is a **sibling of the form**, not a child, and owns its own DOM. The workspace re-renders on every state change, so a nested palette would be rebuilt — losing its open state and focus — on every keystroke.
- The stub has no `dispatchEvent`, so the palette cannot synthesise a `submit` event. `workspace.ts` therefore extracts `submitFromComposer()` and both paths call it. This is the better shape anyway: a view module should never fake events to reach a handler.

The stub also gained `removeAttribute()` and a `parentElement` getter, both used by the palette.

**Verify:** `npm test --workspace packages/web` → **249 pass / 0 fail** (233 before: +14 `skills-palette.test.ts`, +2 `app-state.test.ts`); `npm run typecheck` and `npm run typecheck:desktop` clean; full `npm test` → **776 pass / 0 fail**; `npm run smoke:start` passes.

**Not verified here:** `npm run e2e` and `npm run smoke:desktop` could not run — Playwright's browser binary is absent from the sandbox and `npx playwright install` cannot reach the network (`Executable doesn't exist at …/chrome-headless-shell`). The palette's browser behaviour is covered only by the DOM-stub unit tests plus the typechecks. Run `npm run e2e` locally before merging.

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
