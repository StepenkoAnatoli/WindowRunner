# B4 atomic checklist — phase status

Durable progress record for B4 (provider model discovery). Chat history is not
durable — this file is. Updated at every B4 stop point.

Branch: `arena/01a0c816-windowrunner`
Base: `main` @ `126f5123f5d244130c6250f9ce1f7bb75d8c6875` (merge of PR #29, B3)
Plan: `docs/superpowers/plans/2026-09-21-b4-provider-model-discovery.md`

## Status

B4.0 done. B4.1–B4.6 not started.

## Commits

```text
(this commit) docs(plan): define provider model discovery
```

## Files changed

`docs/superpowers/plans/2026-09-21-b4-provider-model-discovery.md` (plan),
this status file.

## Behavior verified

None yet — planning only. The plan records the API contract, per-kind
behavior (mock offline list, openai-compatible live probe, anthropic
documented fallback), security limits, and the deliberate deviations
(loopback targets allowed; anthropic fallback now, live listing later).

## Tests

Not applicable at B4.0. The plan fixes the test matrix for B4.1–B4.5.

## Acceptance criteria

- B4.0 plan committed before implementation: done (this commit).

## Security checks

Plan-level only: the key's permitted path is fixed in the plan (transient
form field → one authenticated server request → `Authorization` header of the
one upstream call → masked after save). Never: response bodies, errors, logs,
metrics, URLs, browser storage, workspace catalog.

## Deviations

Recorded in the plan ("Deviations and decisions to review"): no
loopback/private-target rejection (local Ollama is a first-class use case; no
existing outbound SSRF policy to hook); anthropic discovery is the documented
501 fallback in this pass; `{ models: string[] }` response shape; redirect
refusal instead of bounded redirects; `provider-model-manual` wraps the
existing input rather than renaming it.

Review corrections applied to B4.0 (plan-only, before B4.1):

1. Final-gate command fixed: `npm smoke:start` → `npm run smoke:start` (the
   repo defines no `smoke` script; `smoke:start` is an npm script).
2. Raw-key data-path wording corrected: the key does not exist in "exactly two
   places" — during discovery it also travels in the authenticated
   browser-to-server request body and sits in server request-handling memory.
   The rule is now: the raw key is transient only (open form + in-flight
   request memory; sent in the client-to-server body and the upstream
   `Authorization` header), and must never enter a response, URL, logs,
   metrics, browser storage, workspace catalog, rendered post-save UI, or
   persisted provider form state. Wording/security-audit fix, not a design
   change.
3. Commit index corrected to list both B4.0 commits explicitly (`743066c`,
   `f3cb728`) instead of describing the plan commit as "this commit".

## Known gaps

- Anthropic users have no live model listing yet (documented fallback).
- Model-count truncation at 500 is silent by design (documented).

## CI status

Not run at B4.0 (docs-only commit). Eight checks must be green on the B4.6
gate commit.

## Verdict

B4.0 PASS — plan committed, stopping for review before implementation.
