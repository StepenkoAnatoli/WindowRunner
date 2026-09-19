# Checkout Integrity Audit — WindowsRunner

**Audit date:** 2026-09-19 (file written 2026-09-19)
**Repository:** `StepenkoAnatoli/WindowRunner` @ `7c25254feba4ecab75b8792dfa58fbe0e93771b1` (`main`)
**Audited branch:** `arena/01a0bb0a-windowrunner` (branched from the same commit)
**Auditor role:** investigative researcher / fact-checker / adversarial analyst
**Verification environment:** Node `v22.22.3`, npm `10.9.8`, git `2.39.5`, Linux 6.1.158+ x86_64, UTC

---

## 1. Executive Summary

**The repository does not contain the product it documents.**

The checkout holds 14 tracked files: documentation, licence, CI/ignore config, installers, a Docker setup, a root `package.json`, and a 6,419-line `package-lock.json`. It contains **zero source files** — no `.ts`, `.tsx`, `.js`, `.mjs`, `.css`, or `.html` anywhere in the working tree or in any of the three commits in its entire history.

`README.md` describes a working local-first coding agent with an Express server, React UI, agent loop, provider adapters, tools, MCP support, skills and crash reporting. `AGENTS.md` and the attached implementation plan (`docs/superpowers/plans/2026-09-19-robust-turn-execution.md`, 1,029 lines) describe in detail how to modify that codebase. **None of the referenced code exists.**

Every advertised entry path fails when executed on this commit. Of 77 file paths named by the documents, 3 exist and 74 do not (see the correction in §17). All 13 npm scripts that touch the product fail; only `npm ci` "succeeds", and it is a false positive (see §5, V-09).

The strongest counter-hypothesis — that the documents are aspirational marketing written before any code — is **rejected**. Forensic evidence (§5, V-11) shows the repository is a *partial upload* of a repository that did contain the implementation: the lockfile carries full dependency manifests for three workspaces (`@windows-runner/shared`, `@windows-runner/server`, `@windows-runner/web`) and `node_modules` symlink entries pointing at `packages/*`, while `install.sh`, `install.ps1`, `Dockerfile` and `docker-compose.yml` are coherent and functional *relative to a repository that has those directories*.

**Consequence for the attached plan:** implementing it as written is **not** a reliability-hardening change to an existing system. It is a **greenfield build of a large TypeScript product from scratch** — and even a complete implementation of the nine planned tasks would not produce a working product, because the plan covers only part of what the README promises.

**Decision-critical conclusion:** before any implementation work, the missing source must be located or its absence consciously accepted. This is the single highest-value unresolved question, and it is not answerable from inside this repository (§10, GAP-01).

---

## 2. Research Objective

**Primary objective:** Determine whether this checkout can support the product its documentation describes and the implementation plan attached to it — and, if not, establish exactly what is present, what is absent, and what evidence survives as to why.

**Decision this research must support:** Whether to (a) reconstruct the implementation from scratch, (b) correct the documentation to match verified reality, (c) restore the original source from wherever it exists, or (d) abandon the current direction.

**Explicitly out of scope:** evaluating the product's competitive merit, the quality of the original implementation (never observed), the security of the original code (never observed), and whether the README's *product* claims were ever true in the repository where that code lived.

**Note on framing.** The research objective was not supplied verbatim by the requester; it was derived from the artefacts in front of me (an implementation plan that presumes an existing codebase, plus documentation that presumes a shipped product) and the stated requirement that implementation may begin only after this package passes a sufficiency gate. If the intended objective differs, §13 and §15 identify exactly which conclusions that would invalidate.

---

## 3. Research Map

| Domain | Core question | Decision weight |
|---|---|---|
| D1 — Content inventory | What files actually exist on this commit? | Critical (baseline fact) |
| D2 — History & recoverability | Is the implementation hidden in git history, another branch, tags, stashes, submodules, or dangling objects? | Critical |
| D3 — Executability | Do the documented commands work as documented? | Critical |
| D4 — External verifiability | Are the externally-checkable claims (npm publication, CI) true today? | Critical |
| D5 — Provenance | Did a complete implementation ever exist, and how did this repo come to hold only part of it? | High (determines remedy) |
| D6 — Plan feasibility | What would implementing the attached plan actually require? | Critical (this is the immediate ask) |
| D7 — Documentation integrity | Which claims are false, unverifiable, or stale? | High |

**Falsification targets identified before searching** (what would disprove the central hypothesis "the implementation is absent"):
1. A branch, tag, or remote ref containing `packages/`.
2. Implementation objects recoverable from git (dangling blobs, stashes, reflog, grafts, submodules).
3. The implementation present on disk but gitignored.
4. A published npm package that ships the built product.
5. The "missing" files being generated on demand by an installed tool.

Each was tested. All five failed. See §5.

---

## 4. Key Findings

1. **F-01 — No source code exists on this commit.** 14 tracked files; zero source files by extension census (4 `.md`, 2 `.json`, 1 `.yml`, 1 `.sh`, 1 `.ps1`, 1 `.gitignore`, 1 `.dockerignore`, plus `LICENSE`/`NOTICE`). Verified.
2. **F-02 — No source code exists in any commit in history.** Full history is three commits. No commit contains any path under `packages/`. Verified across all reachable objects (22 objects total).
3. **F-03 — The history is not recoverable-in-reverse.** No tags, no stashes, no `.gitmodules`, no grafts, no dangling or unreachable objects, no packed remnants of a larger tree. Verified.
4. **F-04 — Every advertised path fails when run.** 74 of 77 documented paths are absent; 13 of 14 npm scripts fail; `npm start` fails at `prestart`. Verified by execution.
5. **F-05 — The `windows-runner` package is not published on npm.** The registry returns `E404`. README's npm/npx/`wr` install path is marked "**Verified**" and cannot be reproduced by anyone today. Verified against the authoritative registry.
6. **F-06 — There is no CI, and no `.github/` directory at all.** `RELEASE_CHECKLIST.md` states "Windows CI green" and that "Linux/Windows/packed/Docker jobs all gating". No workflow file exists in the repository. Contradiction recorded (§8, C-01).
7. **F-07 — `RELEASE_CHECKLIST.md` cites a commit that does not exist here.** Its status snapshot is anchored to HEAD `b9ae7ac`, which is not a valid object in this repository. The checklist was written against a different repository state.
8. **F-08 — A complete implementation previously existed.** The lockfile contains workspace dependency manifests for three packages and `node_modules` symlink entries to `packages/*`; the installers and Docker files are coherent only against a repo containing those directories. This is the strongest surviving evidence about the missing code (§5, V-11).
9. **F-09 — The repository was bootstrapped by a partial file upload.** Commit `2794ac9` ("Add files via upload", 2026-09-19 12:23 +0300, root commit, no parents) added exactly 13 loose top-level files and no directories. The implementation was therefore never pushed to this repository from a working checkout — it was left behind.
10. **F-10 — The attached plan is honest about the gap.** Its "File Structure" section states plainly that the checked-out commit "contains the repository shell and documentation but not the `packages/` implementation directories described by `AGENTS.md`". The plan's problem statement is accurate; only the README is un-reconciled with reality.
11. **F-11 — Implementing the plan is a from-scratch build, and is not sufficient on its own.** The plan specifies 9 tasks over ~45 files. The README additionally implies `bin/`, `scripts/` (5 files), skills, MCP manager/client, sessions, config, auth, access control, error reporter and context budgeting — none of which the plan creates.
12. **F-12 — `AGENTS.md`'s own verification command is unsafe in this state.** It instructs `npx tsc -p packages/server/tsconfig.json --noEmit`. With TypeScript absent, npx resolves `tsc@2.0.4` from npm — described by the registry as "A deprecated release of the TypeScript compiler", an unrelated package — and the target `tsconfig.json` does not exist either.

---

## 5. Verified Claims

Evidence class is stated for each claim because confidence here rests on **method**, not on source agreement. "Executed" means I ran the command in this checkout on 2026-09-19 and captured the observed result; this is primary empirical evidence about this commit and is not subject to source-independence concerns.

| ID | Claim | Evidence | Class | Verdict | Confidence |
|---|---|---|---|---|---|
| V-01 | `main` and the audited branch both point at `7c25254`; the checkout matches upstream exactly | `git rev-parse` for `main`, `origin/main`, `HEAD`; `git ls-remote origin` returns the same SHA for `refs/heads/main` | Executed | **VERIFIED** | Very high |
| V-02 | The checkout contains 14 tracked files and no source files | `git ls-files`; extension census returns `0` for `.ts/.tsx/.js/.jsx/.mjs/.cjs/.css/.html` | Executed | **VERIFIED** | Very high |
| V-03 | 74 of 77 documented file paths do not exist | Extracted every backticked path matching `packages/|bin/|scripts/|docs/|.github/|.windows-runner/|install.|PROJECT_|src/|test/` from all markdown and tested existence | Executed | **VERIFIED** | Very high |
| V-04 | No implementation exists in any commit | `git rev-list --all` (3 commits) × `git ls-tree -r` → 0 files under `packages/` in every commit | Executed | **VERIFIED** | Very high |
| V-05 | Nothing is recoverable from git internals | `git fsck --unreachable --dangling` → empty; `git stash list` → empty; `git tag` → empty; `.gitmodules` absent; no grafts; 22 objects total | Executed | **VERIFIED** | Very high |
| V-06 | All advertised entry points fail | `npm run setup` → exit 1, `MODULE_NOT_FOUND scripts/setup.mjs`; `npm start` → exit 1, `MODULE_NOT_FOUND scripts/ensure-built.mjs`; `npm run build\|test\|typecheck\|dev\|dev:server\|dev:web` → exit 1, `No workspaces found`; `smoke:packed`, `desktop` → `MODULE_NOT_FOUND`; `skills:check` → exit 127 `tsx: not found`; `desktop:install` → exit 254 `ENOENT` | Executed | **VERIFIED** | Very high |
| V-07 | The README's recommended install path is non-functional | `npm run setup` is step 3 of README Option 1 and fails; `install.sh` line 99 invokes the same command (`WINDOWS_RUNNER_SKIP_POSTINSTALL=1 npm run setup`) so the curl installer fails identically | Executed | **VERIFIED** | Very high |
| V-08 | The npm-install path is non-functional and the package is unpublished | `npm view windows-runner` → `E404 Not Found`; `bin/` absent so no local binary; 5 of 8 `package.json` `files[]` entries missing | Executed + registry | **VERIFIED** | Very high |
| V-09 | `npm ci` succeeds *misleadingly* | `npm ci --ignore-scripts --no-audit --no-fund` → "added 25 packages in 2s", lockfile unchanged. Only root devDependencies install; the three missing workspaces are silently skipped, so a green install leaves the product absent | Executed | **VERIFIED WITH QUALIFICATION** — the command succeeds; the README's implied conclusion ("`npm install && npm start` also works") does not follow | Very high |
| V-10 | `README.md`'s relative links are broken | `./docs/INSTALL.md` and `./docs/THREAT_MODEL.md#5-secrets-and-data-egress` do not resolve | Executed | **VERIFIED** | Very high |
| V-11 | A complete implementation previously existed at lockfile-generation time | `package-lock.json` (lockfileVersion 3, 439 entries) declares workspaces `packages/{shared,server,web}` with names `@windows-runner/{shared,server,web}` and full dependency sets (server: express, cors, diff, gray-matter, ignore, picomatch, esbuild, tsx, typescript, `@types/*`; web: react 19, vite 6, tailwind 4, highlight.js, react-markdown, remark-gfm). It also contains `node_modules/@windows-runner/{server,shared,web}` entries whose `resolved` field is `packages/*`. The lockfile's root metadata matches `package.json` in every field the lockfile records and I compared (name, version, license, workspaces, bin, devDependencies, engines, `hasInstallScript`); the lockfile is not a byte-for-byte copy of the manifest, since it stores a subset of fields | Forensic / primary artefact | **VERIFIED WITH QUALIFICATION** — proves the *manifests* were generated in a repo containing those workspaces; says nothing about the contents, completeness, quality or functionality of the code, which I never observed | High |
| V-12 | The repo was created by a partial upload, not by a failed push | `git log` per commit: `2794ac9` (root, "Add files via upload", 13 top-level files, 0 directories), `025ce19` (plan doc), `7c25254` (merge of PR #1) | Executed | **VERIFIED** | High |
| V-13 | `RELEASE_CHECKLIST.md` is anchored to a different repository state | It cites HEAD `b9ae7ac`, which `git cat-file -t` rejects as "Not a valid object name"; it also cites `PROJECT_HARDENING_PLAN.md`, `docs/BASELINE.md`, `docs/THREAT_MODEL.md`, `docs/INSTALL.md`, `.github/workflows/ci.yml` — none exist | Executed | **VERIFIED** | Very high |
| V-14 | The plan's own gap statement is accurate | Plan "File Structure": the commit "contains the repository shell and documentation but not the `packages/` implementation directories described by `AGENTS.md`" — confirmed by V-02/V-04 | Executed | **VERIFIED** | Very high |
| V-15 | `AGENTS.md`'s typecheck instruction resolves to the wrong package | `npx tsc -p packages/server/tsconfig.json --noEmit` → npm warns it will install `tsc@2.0.4`; `npm view tsc description` → "A deprecated release of the TypeScript compiler" | Executed + registry | **VERIFIED** | Very high |

**Why confidence is stated as very high for V-01–V-10, V-13–V-15.** The protocol cautions against 90%+ confidence merely because several sources agree. That caution does not apply here: these claims are not source-based at all. They are direct, reproducible observations of this filesystem and of authoritative registries (`registry.npmjs.org`, the GitHub API), obtained by commands documented in §11 so that anyone can re-run them. The residual uncertainty is limited to nondeterminism in tooling, which is why the exact environment is recorded in the header.

---

## 6. Qualified Claims

| ID | Claim | Qualification |
|---|---|---|
| Q-01 | The README's "**Verified**" install statuses were false when written | **Not established, and the more probable reading is the opposite.** Those rows most plausibly record real tests run in the repository that contained `packages/*` — the lockfile, `install.sh` and the Dockerfile are all internally coherent with such a repository. The defensible claim is narrower: *those statuses are not reproducible against this commit, and the npm row is false as a present-tense claim about a published artefact.* |
| Q-02 | The Docker image cannot build | **Reasoned, not executed.** Docker is not installed in the verification environment. `Dockerfile` lines 20–22 `COPY packages/{shared,server,web}/package.json`, and those files do not exist; Docker's `COPY` fails when a source path is absent. High confidence by mechanism, but honestly tagged as untested. |
| Q-03 | The implementation still exists somewhere | **Unknown.** It is absent from this repository, absent from its history, and absent from the other public repositories of the same account (`Agent` is a *Python* agent with a superficially similar architecture — `app/agent.py`, `providers.py`, `tools.py`, `storage.py`, `system_prompt.py`, SSE tests — but no `packages/`, no `@windows-runner/*`, no relation to this TypeScript codebase; `machinelearningmachine` contains no matching paths). It may exist privately or offline. It may not exist at all. |
| Q-04 | `npm ci` succeeding means dependencies are correctly installed | **False conclusion, true command.** See V-09. |
| Q-05 | The plan can be implemented "in a checkout where those source files already exist" | **Untestable here.** The plan is written to be applied to two different worlds at once ("preserve the same interfaces while modifying the existing implementations"). Only the greenfield branch of that instruction is available in this checkout. |

---

## 7. False / Rejected Claims

| ID | Claim (as stated in the repo) | Verdict | Basis |
|---|---|---|---|
| R-01 | "Packed artifact: `npx windows-runner` / `npm i -g windows-runner` / `wr` — **Verified**" | **FALSE** (as a present-tense claim) | The package does not exist on npm (`E404`). No user can run it. |
| R-02 | "`npm start` **auto-builds if `dist` is missing**, so `npm install && npm start` also works" | **FALSE** for this commit | `npm start` dies at `prestart` with `MODULE_NOT_FOUND scripts/ensure-built.mjs`. |
| R-03 | "Clone + `npm run setup` (Linux) — **Verified**" | **FALSE** for this commit | `npm run setup` → `MODULE_NOT_FOUND scripts/setup.mjs`. |
| R-04 | "P1-05 … Windows CI green" / "P1-06 … Linux/Windows/packed/Docker jobs all gating" | **UNSUPPORTED / CONTRADICTED here** | No `.github/` directory exists in the repository. |
| R-05 | Status snapshot anchored to HEAD `b9ae7ac` | **FALSE here** | Not a valid object in this repository. |
| R-06 | `AGENTS.md` "Layout" describes files under `packages/…` as if present | **FALSE here** | None of the listed paths exist. |
| R-07 | `package.json` `files[]` describes a publishable package | **FALSE** | 5 of 8 entries do not exist; `npm pack` would ship a broken tarball. |
| R-08 | "Windows Runner … a local-first, desktop coding agent you run with your own API keys" (present tense, as a usable product) | **Not demonstrable from this repository** | Nothing here can be run. This is a claim about an artefact that is not in evidence. |

**Not rejected, deliberately.** Several README sections describe *intent* rather than observed state — the threat model, the "this is not a sandbox" warning, and the data-flow description are honest and unusually candid. I found no evidence of intent to deceive. The failure pattern is consistent with un-reconciled documentation surviving a partial upload, not with fabrication.

---

## 8. Conflicting Evidence

| ID | Conflict | Resolution |
|---|---|---|
| C-01 | `RELEASE_CHECKLIST.md` asserts green CI on Linux, Windows, packed and Docker jobs; the repository contains no CI configuration whatsoever | **Unresolved, and characterisable.** The checklist is dated 2026-09-17 and explicitly says it "records what must be true for release, not implementation" and that "status snapshots … must be re-verified when each issue is picked up". Its snapshot refers to a repository state (`b9ae7ac`) that is not this one. Treat every status row in it as **unverifiable against this checkout**. |
| C-02 | `README.md` marks install paths "Verified"; none are reproducible | Reconcilable: the verification claim belongs to the original full repository. The claim is stale-or-misplaced rather than invented (see R-01 for the one present-tense exception). |
| C-03 | `AGENTS.md` says "this file is also read by the app itself as project instructions for sessions opened here"; the app does not exist | Explained by F-09. The statement was true of the original repository. |
| C-04 | The plan says "preserve the same interfaces while modifying the existing implementations"; no implementations exist | The plan anticipates both worlds. In this checkout only the scaffolding branch is live — which is precisely why the plan spends its first two tasks adding scaffolding. |

---

## 9. Critical Assumptions

| ID | Assumption | If it is wrong |
|---|---|---|
| A-01 | The uploaded artefacts are genuine exports from a real project rather than assembled demo material | If they were assembled, then no implementation ever existed, and the "restore the source" option disappears entirely — leaving only rebuild or abandon. |
| A-02 | `gh`/API access reflects the complete public state of the account | If the real source is in a **private** repository, the recoverability picture changes completely and restore becomes viable. Not falsifiable from the sandbox. |
| A-03 | Executed command results are representative (not distorted by sandbox specifics — e.g. missing global `tsx`) | If a global toolchain were absent, some failures could be environmental rather than structural. Mitigated: the dominant failures are `MODULE_NOT_FOUND` on literally absent files and `No workspaces found` on literally absent workspace directories — neither can be caused by a missing global tool. |
| A-04 | The plan is the work the requester intends to start | If the intent is instead to fix the documentation or to ship something runnable, the recommended next action changes (see §15). |
| A-05 | Absence from this repository implies absence for the user | If the user holds a local copy that was never pushed — the most likely repair path — everything downstream is easy. |

---

## 10. Evidence Gaps

| ID | Gap | Class | Effect on decision |
|---|---|---|---|
| GAP-01 | **The missing source has not been located, and its existence is unknown.** Not in this repo, not in its history, not in the account's other public repos. GitHub code search is unavailable (`gh search code` is not a subcommand in the installed `gh`), so a platform-wide search could not be performed. | **Critical** | Determines whether the work is *restore* (cheap) or *rebuild* (very expensive). No implementation decision is well-founded until this is closed. |
| GAP-02 | **The requester's actual objective is unstated.** The attached plan presumes a codebase; the README presumes a product; neither is the other. | **Critical** | Selects between rebuild, documentation remediation, and restore. |
| GAP-03 | Docker build failure is reasoned, not executed (Docker absent). | Important | Affects only the "Docker path" remediation item, not the central conclusion. |
| GAP-04 | The original implementation's content, quality and security posture are entirely unobserved. | Important | Any claim about "hardening" the original code is unfalsifiable. Also means the plan's acceptance criteria (e.g. `safePath()`, process-tree cleanup) cannot be tested against prior behaviour — only implemented fresh. |
| GAP-05 | No evidence about whether the npm name was ever published and later unpublished. | Minor | Would refine the R-01 verdict slightly; does not change any action. |
| GAP-06 | The 30 non-code artefacts' own correctness (e.g. `install.ps1` on real Windows) is untested. | Minor | Out of scope; they are coherent by inspection. |

**Accepted-and-conscious gaps.** GAP-03, GAP-05 and GAP-06 are consciously accepted: none can change the central finding or the choice of remedy. GAP-01 and GAP-02 cannot be accepted — they are escalated to the requester (§15).

---

## 11. Risk Areas

1. **Rebuild risk (highest).** Building from scratch to the standard the README advertises is a multi-session, multi-thousand-line effort spanning server, providers, tools, process lifecycle, SSE, React UI and persistence — with **no reference implementation to test against** and **no way to falsify progress** against the plan's criteria, which were written as modifications to code that does not exist. Partial completion yields a product that still does not match its own documentation; the documentation-integrity problem is therefore *not solved by more code alone*.
2. **Documentation-trust risk.** A repository whose README advertises verified install paths, a published npm package, and green CI — none of which hold — is a reputational and supply-chain hazard: the documented `npx windows-runner` invocation would install *any* package that later claims that name. The npm namespace is currently unclaimed.
3. **Agent-guidance risk.** `AGENTS.md` is read by the coding agents that open this repo (as it was in this session). Its layout map points at non-existent files, and its check commands are unrunnable — the first of which (`npx tsc`) additionally resolves to a deprecated, unrelated package. Any agent following it will waste its turn budget, as the second bullet of §12 anticipates.
4. **Provenance/attribution risk.** `NOTICE` asserts the loop, tools, adapters and UI "were written for this project". That is consistent with the evidence (a real project existed) but cannot be *confirmed* from this repository, since none of that code is here.

---

## 12. Adversarial Self-Audit

**"Where would an expert attack this audit first?"**

| Attack | Test performed | Outcome |
|---|---|---|
| "You looked at the wrong branch." | Enumerated local and remote refs: `main`, audited branch, `origin/main`, `origin/arena/01a0bafe-windowrunner`. No other refs exist upstream. | Survives. |
| "The `git log` output was misleading — it showed one commit." | The clone is **shallow** (`.git/shallow` contains `7c25254`), which is why only one commit appeared at first. I fetched the remaining branch and enumerated the history via the GitHub API: three commits. This is a real trap I initially fell into, and it is why the finding is stated as *three* commits with zero code, not *one*. | Survives, and materially strengthened. |
| "The code is gitignored." | Inspected `.gitignore` (ignores `node_modules/`, `dist/`, `build/`, `release/`, logs, `.env`) and searched the filesystem directly. No `packages/`, `bin/`, `scripts/`, or `.windows-runner/` directory exists on disk. | Survives. |
| "It's in a submodule." | No `.gitmodules`; `git ls-files` contains no submodule entry. | Survives. |
| "It's recoverable from dangling objects or a stash." | `git fsck --unreachable --dangling` empty; `git stash list` empty; whole repository is 22 objects. | Survives. |
| "A published package makes the code available." | Queried the npm registry directly: `E404`. | Survives — and creates a new finding (R-01). |
| "The documents are aspirational, so you're over-reading them." | Distinguished present-tense claims about artefacts (falsifiable, and tested) from statements of intent (not falsifiable, and not counted as false). Recorded the separation in §7's closing note. This is the strongest form of the attack and it is why the verdicts are scoped to "for this commit" rather than to the author's honesty. | Partially conceded, then contained. |
| "Your falsification pass was weak — you only sought confirming evidence." | The falsification targets were enumerated *before* checking (§3) and all five failed. I searched for a counter-explanation (aspirational docs) and found the lockfile evidence actively against it. I also searched for the code in *other* repositories of the same account rather than assuming its absence. | Survives. |
| "Selection bias — you tested only paths you knew would fail." | Paths were extracted mechanically from every backticked token in every markdown file, not hand-picked: 77 candidates, 3 existing, 74 missing. (First pass reported 43/40 because `docs/**/*.md` does not expand without `globstar` — see §17.) | Survives. |
| "`npm ci` succeeding contradicts the picture." | Correct, and it is a genuine trap: the command is green while the product is absent. Flagged as V-09/Q-04 rather than left as an inconsistency. | Turned into a finding. |
| "Confidence inflation — you claimed 'very high' repeatedly." | Justified by evidence class, not by agreement: these are reproducible executions and registry queries, not concurring secondary sources. The one forensic inference (V-11) is deliberately capped at *High* and qualified. | Survives. |
| "Correlation vs. causation / extrapolation." | Two places where I deliberately stopped short: I do **not** claim the README was dishonest, and I do **not** claim the original implementation was complete, good, or secure — I never saw it. | Survives. |
| **"Did your own test commands contaminate the evidence?"** | **Yes — one artefact, found and removed.** The command sweep at 19:01 ran `npm run desktop:install` (`npm --prefix packages/desktop install`), and npm *created* `packages/desktop/package-lock.json` — an empty stub whose only content is `{"name":"desktop","lockfileVersion":3,"requires":true,"packages":{}}` — before failing. `git status` then showed `?? packages/`. It appears in no commit, its mtime matches my test run, and its emptiness is inconsistent with a real workspace, so it is my artefact and not the repository's; the directory was deleted and the checkout restored to its as-cloned state (15 files: the 14 tracked ones plus this document). `node_modules/` from `npm ci` was removed for the same reason. **Disclosed because a less careful audit could have read that stub as evidence that `packages/desktop` exists** — in which case the reader should also note that the four other directories the README needs (`bin/`, `scripts/`, and the three workspace sources) produced no such artefact. | Contained and disclosed. |

**Residual weaknesses honestly held.** (a) The central conclusion is about *this* checkout; if the user holds an unpushed local copy, the practical situation is far better than this document implies. (b) Platform-wide code search was not possible, so "the code is nowhere" is not proven — only "it is not here, not in history, and not in this account's other public repositories". (c) The document's strongest positive evidence (V-11) is indirect: it evidences manifests, not code.

---

## 13. Final Conclusions

**C-1 (VERIFIED, very high confidence).** This checkout cannot build, test, typecheck, start, or install the product that its documentation describes. Nothing here is runnable.

**C-2 (VERIFIED, very high confidence).** The absence is total and structural — not a partial checkout, not a git-state problem, not a build-artefact problem. The source is not in the working tree, not in the history, not recoverable from git internals, and not published to npm.

**C-3 (VERIFIED WITH QUALIFICATION, high confidence).** A fuller implementation existed at the time the lockfile and installers were produced. It is not present, and I have no evidence about its contents or quality.

**C-4 (VERIFIED, very high confidence).** The immediate consequence for the attached plan: on this checkout, **Task 1 is not "write a failing test" — it is "create the project"**, and satisfying the plan's acceptance criteria would require writing the overwhelming majority of a product that the plan itself does not scope (skills, MCP, sessions, config, auth, access control, context budgeting, crash reporting, CLI entry points, build scripts).

**C-5 (INFERRED, high confidence).** The README is the un-reconciled survivor of a partial upload — a *documentation-integrity* problem caused by F-09, not evidence of bad faith. The plan document, written later, correctly identifies the gap; the README was never updated to match.

**C-6 (INSUFFICIENT EVIDENCE).** Whether the original implementation still exists, and whether the requester wants a rebuild, a documentation correction, or a restore. **GAP-01 and GAP-02 are decision-blocking, and both are answerable only by the requester.**

**Sufficiency-gate status: PASSED for the audit's own conclusion ("this repository is docs-only and nothing here runs"), which is established at the strongest evidence class available. NOT PASSED for proceeding to implementation**, because the decision-critical gap GAP-02 is open and GAP-01 (whether the source exists anywhere) can still change the remedy from "rebuild" to "restore". Proceeding to write code now would mean committing to the most expensive of the available options on the basis of an unstated objective.

---

## 14. What Is Still Unknown

1. Whether the original implementation exists — privately, on another machine, in a backup, or nowhere.
2. What the requester actually wants built, fixed, or shipped.
3. What the original code was like: architecture fidelity, test coverage, security posture, and whether it ever worked end-to-end.
4. Whether the npm name `windows-runner` was ever claimed and released, and how its absence squares with the README's "Verified" row.
5. Whether the Docker, PowerShell and Electron paths ever worked anywhere.

---

## 15. Implementation Requirements

**No implementation should begin until the requester answers two questions** (they are the only blockers; everything else is ready):

> **Q1 — Does the original source exist anywhere you can reach?** (local machine, private repo, backup, another account)
> **Q2 — What is the actual objective: a runnable product, or documentation that tells the truth?**

**Branch A — the source is reachable.** Restore it. Then this audit's §5 becomes the acceptance test: `npm run setup`, `npm start`, `npm test`, `npm run build`, `npm run typecheck` must all pass, and only then does the attached plan become the reliability work it was written to be. Lowest cost, highest fidelity.

**Branch B — the source is gone; the objective is a runnable product.** Treat this as greenfield and re-scope honestly: the plan's 9 tasks are a *subset*. Requirements that must be added before implementation: owner of `bin/` + `scripts/` (5 files), the build pipeline (`esbuild` → `packages/server/dist/index.cjs`, Vite → `packages/web/dist`) that `package.json`, `Dockerfile` and `install.sh` all depend on, plus whatever README features are in scope. Expect a multi-session build. Every task's "Expected: PASS" must be re-derived, because it was written against implementations that do not exist.

**Branch C — the source is gone; the objective is integrity.** Do not write the product. Instead make every claim verifiable and correct: mark unbuilt paths as non-existent rather than "Experimental"; remove or scope the "Verified" language; fix the two broken README links; correct `AGENTS.md`'s layout and check commands (including the `npx tsc` hazard, V-15); remove `package.json`'s `files[]`/`bin` claims and the `postinstall`/`prestart` hooks that guarantee failure; or reduce `package.json` to honest metadata. This is small, fully verifiable, and immediately restores trust in the repository.

**Requirements that hold regardless of branch:**
- **IR-01** — The repository must not advertise an install path that does not exist. (R-01, R-02, R-03, V-08)
- **IR-02** — `AGENTS.md` must describe only files that exist, and its checks must run without installing an unrelated package. (V-15, F-12, R-06)
- **IR-03** — Any tooling under `packages/` must go through a root-bounded `safePath()` and a real process-tree teardown, per the plan's own constraints. (Plan Global Constraints; unverifiable against prior art — GAP-04)
- **IR-04** — Every acceptance criterion an implementer is asked to satisfy must be executable in this checkout. (F-11, C-4)

---

## 16. Research-to-Requirement Traceability

| Finding | Evidence | Verdict | Requirement it drives |
|---|---|---|---|
| F-01/F-02/F-03 — no source, anywhere recoverable | V-02, V-04, V-05 | VERIFIED | Block implementation; escalate GAP-01 |
| F-04/V-06 — all entry points fail | Executed command matrix | VERIFIED | IR-01, IR-04 |
| F-05/V-08 — package unpublished | registry `E404` | VERIFIED | IR-01; Branch C item |
| F-06/C-01 — claims of green CI vs. no `.github/` | V-13 | CONTRADICTED | Delete or correct status claims; Branch C |
| F-07/V-13 — checklist anchored to a non-existent commit | `git cat-file -t b9ae7ac` fails | VERIFIED | Treat all checklist status rows as unverified |
| F-08/V-11 — a fuller implementation existed | lockfile manifests + symlink entries | VERIFIED WITH QUALIFICATION | Makes Branch A plausible; caps Branch B expectations (GAP-04) |
| F-09/V-12 — partial upload, root commit, no directories | `git log` per commit | VERIFIED | Explains cause; informs Branch C's framing |
| F-10/V-14 — the plan states the gap correctly | plan §File Structure | VERIFIED | Plan's premise accepted; its *effort estimate* rejected (C-4) |
| F-11/C-4 — plan is a subset of the product | path census: 74/77 missing; `files[]` 5/8 missing | VERIFIED + INFERRED | IR-04; Branch B re-scope; add `bin/`, `scripts/`, build pipeline |
| F-12/V-15 — `npx tsc` installs a deprecated package | npm registry description | VERIFIED | IR-02 |
| V-09/Q-04 — `npm ci` is a false-positive success | executed; 25 packages, workspaces skipped | VERIFIED WITH QUALIFICATION | Warn implementers: green install ≠ product present |
| V-10/R-07 — broken links; unpublishable `files[]` | executed | VERIFIED | Branch C; IR-01 |
| GAP-01 / GAP-02 — source location and objective unknown | cannot be resolved in-sandbox | **CRITICAL GAP** | **Decision blocked pending requester input** |

---

## 17. Corrections and Method Notes

Three defects were found in this audit by attacking it after completion. All three are disclosed rather than silently fixed, because the audit's value depends on its own claims being checkable.

**CN-1 — Path census corrected from 43/3/40 to 77/3/74.**
The first pass searched `*.md docs/**/*.md`. Without `shopt -s globstar`, `docs/**/*.md` expands to `docs/*/*.md`, which matches nothing at the depth of `docs/superpowers/plans/…`. That pass therefore scanned only the three root markdown files and **silently omitted the 1,029-line plan document** — the document containing the densest concentration of file paths. Corrected by enumerating tracked documents with `git ls-files '*.md'` instead of shell globs: **77 concrete paths, 3 present, 74 missing**. The corrected figure is the one used throughout this document. The direction of the error matters: the omission *understated* the extent of the absence, so the central conclusion is unaffected — it was already established by the stronger evidence (V-02, V-04, V-06) that does not depend on counting.

**CN-2 — The extraction was later polluted by this document itself.**
Once this audit file existed at `docs/research/…` (two levels deep), `docs/*/*.md` began matching it, and its own quoted examples of path-like tokens were harvested as if they were repository references. Detected by the appearance of the impossible entry `packages/|bin/|scripts/|docs/|…` in the results — my own grep pattern. The published manifest is scoped to tracked documents only and excludes this audit and the restore kit. Any re-run should use `git ls-files '*.md'`, not a glob.

**CN-3 — Self-test artefacts were removed.**
`npm run desktop:install` left a stub `packages/desktop/package-lock.json` behind, and `npm ci` created `node_modules/`. Neither is repository content (neither appears in any commit; the stub is an empty `{"packages":{}}`). Both were deleted and the working tree restored. See the corresponding row in §12. The `packages/` entry that a re-run of the census will still report is the *path reference*, not the directory — confirm with `ls packages 2>&1` before concluding otherwise.

**Standing method note.** All claims in §5 marked *Executed* are reproducible from this checkout using §Appendix. Claims resting on reasoning rather than execution are marked as such and capped below *Very high* (Q-02, and V-11 at *High*). No claim about the missing implementation's quality, security or completeness is made anywhere in this document, because none of it was ever observed.

---

## Appendix — Reproduction Commands

Run from the repository root. Environment: Node `v22.22.3`, npm `10.9.8`, git `2.39.5`, Linux x86_64, 2026-09-19.

```bash
# Content inventory and history
git ls-files | wc -l
git ls-files | grep -E '\.(ts|tsx|js|mjs|cjs|css|html)$' | wc -l   # → 0
git rev-list --all --count                                          # → 3
git rev-parse --is-shallow-repository                               # → true (why log shows 1 commit)
for c in $(git rev-list --all); do git ls-tree -r --name-only $c | grep -c '^packages/'; done  # → 0,0,0
git fsck --unreachable --dangling                                   # → (empty)
git stash list; git tag; ls .gitmodules                             # → none
git cat-file -t b9ae7ac                                             # → fatal: Not a valid object name

# Executability
npm ci --ignore-scripts --no-audit --no-fund        # succeeds — and is misleading
npm run setup                                       # MODULE_NOT_FOUND scripts/setup.mjs
npm start                                           # MODULE_NOT_FOUND scripts/ensure-built.mjs
npm test; npm run build; npm run typecheck          # No workspaces found
npm run dev; npm run dev:server; npm run dev:web    # No workspaces found
npm run smoke:packed; npm run desktop               # MODULE_NOT_FOUND
npm run skills:check                                # tsx: not found (exit 127)
npm run desktop:install   # ENOENT — SIDE EFFECT: npm creates a stub packages/desktop/package-lock.json
                          # and leaves it behind. Delete packages/ afterwards; it is not repo content.

# External verification
npm view windows-runner                             # E404 Not Found
npm view tsc description                            # "A deprecated release of the TypeScript compiler"
gh api repos/StepenkoAnatoli/WindowRunner --jq '{size,pushed_at}'
gh api 'repos/StepenkoAnatoli/WindowRunner/commits?per_page=10' --jq '.[]|"\(.sha[0:8]) parents=\(.parents|length)"'

# Forensic evidence for a prior implementation
node -e "const l=require('./package-lock.json');console.log(Object.keys(l.packages).filter(k=>k.startsWith('packages/')||k.includes('@windows-runner')))"
```
