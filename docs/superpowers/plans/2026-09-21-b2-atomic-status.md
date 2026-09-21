# B2 atomic checklist — phase status

> **CLOSING NOTE — 2026-09-21: the entire B2 atomic checklist is COMPLETE.**
> All phases B2.0–B2.5 passed, were reported, and were reviewed and approved.
> PR #27 merged into `main` as `0d0ae66` ("Merge pull request #27 from
> StepenkoAnatoli/arena/01a0c48f-windowrunner"); the post-merge `main` run
> `35646976541` verified all eight checks SUCCESS on that merge commit.
> Roadmap next: B3 (`2026-09-21-b3-b4-roadmap.md`), then B4 model discovery.

Durable progress record for the B2 atomic-commit checklist (gap-fill over merged
PR #26). Chat history is not durable — this file is. **Update it after every
phase.**

## Approach

- Gap-fill over merged PR #26; do **not** revert or reimplement B2.
- PR #27 must remain open until B2.5 completes (evidence trail; no auto-merge).
- `eval/results/scripted-*.json` is intentionally gitignored (convention
  change; the tracked historical sample remains). Record this as an intentional
  convention change in the final B2.5 report.

## Phase status

```text
B2.0 PASS — baseline cleared by run 35621840761 (plan-only branch rerun of the
            Desktop (windows-latest) failure on the post-merge main run)
B2.1 PASS — d020434, run 35623562775
B2.2 PASS — e77f1e2 / f036576 / c97b5c4, run 35626280132
B2.3 PASS — 6e33e70 / 3b5fe20 / e6151ba, run 35629109152
            (run on the PR-head commit: all eight checks green on e6151ba)
B2.4 PASS — fb0a83d / 63f65a4 / 6ba81be
            Evidence run: 35632800343
            Head: 6ba81be
            (all eight checks green on the PR-head commit)
B2.5 PASS — 573190c / 6dd3564 / e106c41 / 34596b4 / bf6cdce
            (accessibility spec; isolated desktop provider+settings journey;
            web+desktop packaging contracts; CI B2 inventory enforcement;
            docs reconciliation)
            + 90aa0ef / ea83116 (focused fixes the B2.5 contracts caught:
            coalesced-render focus preservation; usage-table containment)
            + 59efb89 (session handoff record)
            Flakes found and fixed, not hidden:
            - Browser E2E on bf6cdce (run 35637909327, 7/8):
              Playwright 1.63 fill() = selectText() + keyboard.insertText()
              in separate protocol round-trips; the rAF-coalesced doRender()
              rebuild in that gap destroyed the focused input → ghost fill
              (zero DOM events). Fixed in 90aa0ef (focus+selection preserved
              across doRender).
            - The accessibility contract test then caught the usage table
              scrolling the page 73px at 360px (nowrap cells, no
              containment) plus a phantom empty table shell while usage
              loaded. Fixed in ea83116.
            Implementation evidence: run 35644103741 (all eight checks
            SUCCESS) on 59efb89 — the tested implementation tree is
            ea83116 + docs. This final documentation commit's own CI result
            is recorded in the PR #27 body (no self-citing commit, per
            review direction).
Current phase: B2 COMPLETE — B2.0–B2.5 all PASS and approved; PR #27 merged
            into main as 0d0ae66 (post-merge run 35646976541, eight checks
            SUCCESS). B3 starts per 2026-09-21-b3-b4-roadmap.md.
```

## Historical note — permanently red run on main

Run **35618145045** (post-merge push to `main` at `1be6875`) is permanently
red: `Desktop (windows-latest)` failed at "Electron smoke (real unpacked
Electron)" and `Desktop installer (windows-latest)` was skipped after it.
GitHub **refused the rerun** ("cannot be rerun; its workflow file may be
broken"). The failure was transient: the plan-only-branch rerun
(35621840761) and every run since are green. The red historical run is
superseded by PR #27 — do not panic when reading `main`'s Actions tab.

Run **35637909327** (PR #27 at `bf6cdce`) is the second historically red run:
Browser E2E flaked in `dashboard.spec.ts` (ghost-fill race, root-caused and
fixed in `90aa0ef`; see the B2.5 entry). Rerun was refused; it is superseded
by run 35644103741 and the runs after it.

## Commit index

```text
b35a7a5 docs(plan): define B2 settings and provider integration
d020434 test(web): complete B2 route and state contract coverage
777ade9 chore: keep locally generated eval reports out of git staging
e77f1e2 test(web): cover active provider banner states
f036576 test(web): cover provider controller workflows
c97b5c4 test(web): cover provider page composition
7bb4e95 docs: record B2 atomic checklist progress through B2.2
6e33e70 test(web): cover usage loading and bounded history
3b5fe20 test(web): cover settings models and catalog reset isolation
e6151ba docs: record B2 atomic checklist progress through B2.3
cf66865 docs: pin B2.3 evidence to the PR-head CI run
fb0a83d test(web): pin dashboard compatibility adapter behavior
63f65a4 docs: record B2 atomic checklist progress through B2.4
6ba81be docs: pin B2.4 evidence to the PR-head CI run
3dbdce0 docs: record B2.5 start and pin B2.4 evidence
573190c test(web): add B2 accessibility coverage
6dd3564 test(desktop): isolate provider and settings journey
e106c41 test(packaging): pin B2 route and dashboard assets
34596b4 ci: enforce B2 browser and desktop contracts
bf6cdce docs: reconcile B2 verification documentation
90aa0ef fix(web): keep form focus across coalesced dashboard renders
ea83116 fix(web): stop the usage table from scrolling the page sideways
59efb89 docs: save B2.5 handoff state for session continuity
(then this commit, "docs: pin B2.5 completion and CI evidence" — its SHA and
its own CI run are recorded in the PR #27 body, per the no-self-citation
review direction)
```
