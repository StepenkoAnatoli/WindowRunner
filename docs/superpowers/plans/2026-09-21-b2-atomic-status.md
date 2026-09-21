# B2 atomic checklist — phase status

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
B2.4 PASS — fb0a83d / 63f65a4, run 35632100275
            (run on the PR-head commit: all eight checks green on 63f65a4)
Current phase: B2.5 NOT STARTED
```

## Historical note — permanently red run on main

Run **35618145045** (post-merge push to `main` at `1be6875`) is permanently
red: `Desktop (windows-latest)` failed at "Electron smoke (real unpacked
Electron)" and `Desktop installer (windows-latest)` was skipped after it.
GitHub **refused the rerun** ("cannot be rerun; its workflow file may be
broken"). The failure was transient: the plan-only-branch rerun
(35621840761) and every run since are green. The red historical run is
superseded by PR #27 — do not panic when reading `main`'s Actions tab.

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
```
