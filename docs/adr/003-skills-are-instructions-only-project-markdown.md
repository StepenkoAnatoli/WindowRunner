# ADR 003 — Skills are instructions-only project markdown, loaded on demand by a `read_skill` tool

**Date:** 2026-09-23
**Status:** Proposed (awaiting owner review)
**Context:** `README.md:17` and `AGENTS.md:121` both state that no skills system exists, and `CHANGELOG.md:65` records that an earlier skills system (`SKILL.md`, `/`-commands, seven named skills, auto/manual-build modes) was *advertised but never implemented* and was stripped from the docs rather than built. So this is a blank slate, not a restoration: `RELEASE_CHECKLIST.md:146` cites a `packages/server/src/access.ts` that does not exist in this tree.

Two pieces of infrastructure already exist and shape the design:

- `ToolDefinition.trust` (`packages/server/src/agent/tools/types.ts:32`) is a complete hook for gating tools that execute project-supplied configuration. **Nothing declares it** — `builtin.ts` contains no `trust` key. It was built for MCP servers and project-defined skills and has sat unused.
- `ProjectTrustRegistry` (`packages/server/src/agent/project-trust.ts`) is complete: grants keyed by symlink-resolved root, bound to a `configHash`, persisted atomically to `<dataDir>/trust.json`, with stale grants detected and named. Its own header comment names "a project-defined skill" as a motivating case.

The requested scope was project-local skills with both manual (`/`-command) and automatic activation. That combination is the security-relevant one: cloning a repository would place instruction files where they can be auto-loaded into the model's context with no user action.

## Decision

### 1. A skill is instructions only. No execution, no bundled scripts.

A skill is a `SKILL.md`: YAML frontmatter plus a markdown body. It contains guidance for the model and nothing that runs.

- **Why:** with project-local + auto-discovery, an untrusted clone can place text in the model's context. If skills are text, the ceiling is "the model reads hostile instructions" — already true of any `README.md` the agent opens with `read_file`. If skills can execute, the same clone runs arbitrary code on the user's machine.
- **Capability loss is small.** The agent keeps `run_terminal`. A skill that says "run `scripts/lint.ps1`" produces the same outcome as an executable skill, except the command passes the *existing* `run_terminal` approval, with its bounded output buffer, wall-clock limit, secret-stripped environment and whole-process-tree kill. What is lost is the ability to act *without asking*.
- **Consequence, stated plainly:** `ToolDefinition.trust` stays unused and `RELEASE_CHECKLIST.md:205` ("Skill metadata cannot bypass user-required approvals") stays an open checkbox. That is correct, not an oversight — the criterion is only reachable once something executes project code.

### 2. Layout and format

```
<project root>/.windowrunner/skills/<name>/SKILL.md
```

One directory per skill; the directory name is the skill name.

```markdown
---
name: release-notes
description: Draft changelog entries from a diff. Use when asked to write release notes.
---
Read `CHANGELOG.md` first. Follow Keep a Changelog...
```

- Frontmatter is strict: `name` must equal the directory name, `description` is required and length-capped. Unknown keys are **stripped, not rejected** — the posture of `packages/shared/src/workspace-catalog.ts`, which the AGENTS.md conventions already hold up as the model.
- A malformed skill is **excluded with a diagnostic**, never fatal to the scan, following `ProjectTrustRegistry.boot()`'s "malformed files are ignored with a warning, never trusted".
- Every read goes through `ProjectRoot`. No direct `fs` on user-influenced paths.

### 3. One loading mechanism, two entry points

- A new built-in tool `read_skill({ name })` in `createBuiltinTools()`. `requiresApproval: false`, because it returns a text file inside the project root that `read_file` could already return. It resolves through `safePath` semantics, so `..`, absolute paths, encoded traversal and symlink escapes are refused exactly as for `read_file`.
- **Manual:** the UI sends the turn; the model calls `read_skill`. **No injection code path exists.**
- **Auto:** the server prepends a skills *index* (names and descriptions only, never bodies) to the turn's first user message, wrapped in framing that marks it as untrusted project-supplied content. The model decides whether to call `read_skill`.

Collapsing both modes onto one mechanism is deliberate: two activation paths would mean two code paths to keep consistent, and the manual one would need an injection route that the tool already covers.

### 4. The index goes in the turn's first user message, not the system prompt

`DEFAULT_SYSTEM_PROMPT` is fixed at provider construction (`packages/server/src/boot.ts:343`, `providers/index.ts:55`) and is not composed per turn. Threading a per-turn prompt would mean changing the `LLMProvider` interface that `openai-compatible.ts`, `anthropic.ts` and `mock.ts` all implement. The index is re-sent per turn instead. Bodies are never in the index, so a project with forty skills costs forty lines rather than forty files. The index is capped; an oversized index is truncated with a notice rather than silently consuming the context window.

### 5. Interface surface

- **New:** `packages/server/src/http/routes/skills.ts` — `GET /api/sessions/:id/skills` returns the index plus diagnostics, so the UI can render the palette *and* why a skill was excluded. One owner per resource, composed by `app.ts`, bearer auth and `http/validate.ts` guards like every other route.
- **New shared types** in `packages/shared/src/index.ts`: `SkillMeta { name, description, path }`, `SkillsIndex`, `SkillDiagnostic`.
- **No new `StreamEvent`.** `read_skill` is an ordinary tool call, so `tool_started` / `tool_completed` already carry it and the web reducer in `app-state.ts` needs no change. Deliberate omission.
- **UI:** a `/`-command palette over the composer, respecting the keyboard-nav and focus conventions in `keyboard-nav.ts`; plus a read-only settings list showing discovered skills and their diagnostics. The desktop shell reuses all of it at `/desktop`.
- **No new environment variables** — so no `ENV` entry in `config.ts` and no `docs/INSTALL.md` / `README.md` table changes.

### 6. Error handling — every case non-fatal and self-reporting

| Case | Behaviour |
| --- | --- |
| No `.windowrunner/skills/` | Empty index, no diagnostic |
| Malformed or missing frontmatter | Skill excluded; diagnostic names file and reason |
| `name` ≠ directory name | Excluded with a diagnostic |
| Duplicate names | The lexicographically-first path by relative directory name wins; diagnostic for each shadowed skill |
| Name collides with a built-in tool | Excluded — ambiguity is refused, not resolved silently |
| Invalid name (not `^[a-z0-9][a-z0-9-]*$`) | Excluded |
| Oversized body | Truncated with a notice |
| Path escape (`..`, absolute, symlink) | Refused by `ProjectRoot`, as for `read_file` |

### 7. Testing

Following `packages/server/test/`'s fake-SSE pattern — no real API keys, per AGENTS.md:

- `skills.ts` unit tests: happy path, each exclusion case, duplicate precedence, truncation.
- `read_skill` confinement: `..`, absolute and symlink escapes refused.
- Route tests: auth required, validation, stable error codes.
- **The security invariant, asserted explicitly:** a skill body instructing the agent to run a terminal command must still raise the existing `run_terminal` approval. This is the test that proves "instructions-only" actually holds.
- Eval: a scripted task in `eval/tasks/` driving a real turn through a skill.

## Alternatives considered and rejected

### Alternative A — Instructions plus bundled scripts, gated by `ProjectTrustRegistry` (rejected for v1)

- A skill is a folder with `SKILL.md` plus scripts. Executing project-supplied code would require a trust grant keyed by real root and bound to a `configHash` that invalidates on edit.
- **Why rejected:** it is the right *eventual* shape, and `ToolDefinition.trust` is already waiting for it — but it multiplies the surface (trust UI, grant lifecycle, config-hash invalidation, subprocess handling) to buy capability that `run_terminal` already provides behind an approval. It would also make `RELEASE_CHECKLIST.md:205` load-bearing on day one rather than reachable later. **Ratchet:** adding this later is additive; removing execution after shipping it is a breaking change.

### Alternative B — Skills register as model-visible tools (rejected)

- Each skill becomes a callable tool with its own input schema.
- **Why rejected:** it breaks the AGENTS.md rule that there is no plugin discovery — "new tools are added to `createBuiltinTools()` and nowhere else" — and would require reworking the tool-registry and provider surfaces. Most of the benefit is already available: `read_skill` gives the model access to the same content without a dynamic registry.

### Alternative C — Compose the index into the system prompt (rejected)

- **Why rejected:** correct placement, but it requires making the system prompt per-turn across `LLMProvider` and all three provider adapters. An interface change every provider depends on is not justified by the prominence gain, and the user-message placement is re-evaluated per turn anyway, so mid-session skill edits are still picked up.

### Alternative D — Two separate activation paths, manual injecting content directly (rejected)

- **Why rejected:** duplicates the loading path and creates a second place where skill content enters a turn. One tool with two entry points keeps a single code path and a single set of confinement guarantees.

## Consequences

**Accepted risks, not designed away:**

- A cloned repository *can* place instructions in the model's context without user action. Inherent to project-local + auto-discovery. Mitigations: nothing executes, the index is explicitly framed as untrusted project content, and bodies load only when the model asks for them. This does not make the vector absent; it caps the damage at the level of any other file the agent can read.
- Skill names are visible to the model, so a hostile skill can be written to *look* like a legitimate one (`release-notes` vs `release-notes-v2`). The palette shows the source path so a human can tell them apart.

**Operational:**

- The index is recomputed each turn, so edits mid-session take effect on the next turn. This leans on the documented single-process limitation.
- Documentation must change in step with the code: `README.md:17` currently says "No skills system … those are **not implemented**", and `AGENTS.md:121` says "there is no skills system in this checkout". Both must be updated in the same change that ships this, or the docs will over-claim again — which is precisely the failure recorded at `CHANGELOG.md:63` ("The user-facing documentation told a different story than the code").

**Upgrade path:** Alternative A remains open. `ToolDefinition.trust` is unused and `ProjectTrustRegistry` is complete, so adding executable skills later means declaring `trust` on a new tool and building the consent UI — not rearchitecting.
