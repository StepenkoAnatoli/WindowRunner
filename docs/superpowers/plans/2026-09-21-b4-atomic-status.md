# B4 atomic checklist — phase status

Durable progress record for B4 (provider model discovery). Chat history is not
durable — this file is. Updated at every B4 stop point.

Branch: `arena/01a0c816-windowrunner`
PR: https://github.com/StepenkoAnatoli/WindowRunner/pull/31
Base: `main` @ `126f5123f5d244130c6250f9ce1f7bb75d8c6875` (merge of PR #29, B3)
Plan: `docs/superpowers/plans/2026-09-21-b4-provider-model-discovery.md`

## Status

B4.0–B4.6 implemented. **All local gate commands pass; awaiting the eight CI
checks on the head commit before merge.** GO-for-merge is recorded at the end
of this file once the run links land.

## Commits

```text
743066c — docs(plan): define provider model discovery
f3cb728 — docs(status): open the B4 atomic checklist
c701c9e — docs: correct B4 model discovery gate and key-path contract
82b7c6c — feat(server): add provider model discovery contract
1ff0fb5 — feat(server): probe openai-compatible model listings safely
0a0f05f — test(server): cover model discovery validation and redaction
37b4b3a — docs(status): record B4.1 server discovery service
4674d0b — feat(web): add model discovery API client flow
4d20f92 — test(web): cover model discovery controller states
7652216 — feat(web): add model discovery controls to provider form
1af57fd — test(web): cover model selection and manual fallback
f357981 — test(web): cover model discovery browser journeys
8b78422 — test(desktop): verify provider model discovery in Electron
60ce0c5 — docs: describe model discovery limits and key handling
817d934 — docs(status): record B4.2-B4.6 and the local gate
236719b — fix(web): let a picked discovered model reach the model field
169ee33 — test(web): make the discovery journey retry-safe
907902b — test(desktop): make the discovery journey retry-safe
cbeab3a — test(desktop): unstack dialog handlers before the dashboard navigation
```

(Sandbox note: between B4.1 and B4.2 the workspace's `.git` was reset to a
fresh clone while the file snapshot survived; the B4.2–B4.4 commits were
re-parented onto the pushed B4.1 history via cherry-pick — trees verified
byte-identical before and after. The commit hashes above are the reconciled,
pushed ones.)

## Files changed

Server: `packages/server/src/provider-discovery.ts` (new), `app.ts` (route),
`test/provider-discovery.test.ts` (new). Web: `api.ts`, `app-state.ts`,
`provider-controller.ts`, `provider-types.ts` (export), `providers/
provider-form.ts`, `providers/provider-page.ts`, `providers/compatibility.ts`,
`main.ts`, new `e2e/model-discovery.spec.ts`, four test files extended.
Desktop: new `e2e/model-discovery.spec.ts`. CI: `ci.yml` inventory. Docs:
README.md, docs/INSTALL.md, plan + this status file.

## Behavior now verified

- **Server (B4.1):** `POST /api/providers/discover-models` behind the existing
  Host/Origin/bearer middleware, registered before the `/:id` provider routes.
  Full validation matrix 400 before any I/O (kind; absolute http(s) baseUrl
  with host, no userinfo, printable ASCII, ≤ 2048; optional key ≤ 512,
  no whitespace, printable ASCII). `mock` → `["mock"]` offline; `anthropic` →
  501 with the exact message `model discovery unavailable for this provider`;
  `openai-compatible` → exactly one `GET {baseUrl}/models` with `Accept` and
  `Bearer` (only when a key was typed), trailing slashes stripped, 5 s
  AbortController timeout (default constant asserted; real hanging upstream →
  504), redirects refused outright (`redirect: "error"`, real 302 → 502
  `DISCOVERY_BAD_RESPONSE`, both undici error shapes covered), 2 MiB body cap
  (streaming cap with abort teardown + content-length precheck), non-2xx →
  502 with the status only, network failures → 502 with the OS code,
  non-JSON → 502. Normalization accepts only `{data:[{id}|str]}`, a bare
  array, `{models:[str]}`; non-conforming items dropped; dedupe → plain
  UTF-16 sort → 500 cap; empty listing → `{ models: [] }`.
- **Client flow (B4.2):** `ApiClient.discoverModels` posts the discovery body
  with the bearer header; the controller runs idle → loading → ready/error
  with exactly one request at a time, builds the input from current form
  values (trimmed; `apiKeyToSend` rule drops blank/pasted masks), never saves,
  never activates, never reloads; 401 hands back to the host; any
  kind/baseUrl/apiKey change resets discovery to `idle` (stale results
  cleared); the typed model text is only changed by an explicit selection.
- **Form UI (B4.3):** all required selectors
  (`provider-discover-models`, `provider-model-discovery[-loading|-error|
  -empty]`, `provider-model-select`, `provider-model-manual`) render in both
  hosts (workspace route + `/dashboard`). Manual input stays visible and
  enabled in every state; the select copies into the model field and returns
  to its placeholder; the empty state carries the exact required copy
  ("No models were returned. Enter the model id manually."); errors are
  `role=alert` and secret-free; `anthropic` shows the documented fallback
  instead of a button that can only fail; `mock` keeps the button (its
  offline list is real data).
- **Browser E2E (B4.4):** `e2e/model-discovery.spec.ts` (2 tests) covers the
  full brief: exactly one discovery request (page-level AND upstream hit
  count from an in-spec fake upstream), sorted/deduped dropdown
  (alpha/mid/zeta), choose → field updates → select resets, save → `****cdef`
  mask, raw key absent from URL / localStorage / sessionStorage (token
  boundary asserted as the only key) / catalog JSON / visible DOM / discovery
  responses / rendered errors — including a hostile upstream that echoes the
  `Authorization` header back (and an upstream 500 whose body carries the
  key), a refused redirect, stale-result clearing on base-URL change, empty
  state copy, manual fallback completing the save, no activation calls, and
  cancel-with-confirm never saving. CI inventory pins the spec.
- **Desktop E2E (B4.5):** `e2e/model-discovery.spec.ts` (2 tests) proves the
  journey in the real Electron shell on the in-memory bootstrap token (no
  token form), the same key-boundary set including the
  `userData/workspace-catalog.json` file, upstream Authorization assertion,
  a visible 5 s timeout that recovers in the same form, manual fallback save,
  cancel never saves, no activation, and `/dashboard` compatibility (its own
  token form on hard load).
- **Docs (B4.6):** README "Fetch models" bullet (behavior, kinds, one-shot,
  timeout, key handling, no browser-side provider request, no persistence)
  and INSTALL provider-management bullet + updated limitations; the old
  "there is no model discovery" statements removed.

## Tests

| Check | Result |
| --- | --- |
| `npm run typecheck` (shared + server + web) | pass |
| `npm run typecheck:desktop` (3 tsconfigs) | pass |
| `npm test` | pass — 626/626 (shared 9, server 385, web 232) |
| `npm run test:desktop` | pass (30; 4 skipped = CI-only paths) |
| `npm run build` | pass |
| `npm run smoke:packed` | pass |
| `npm run smoke:packed:start` | pass |
| `npm run smoke:start` | pass |
| `npm run eval` | pass (5/5) |
| `npm run e2e` | not runnable in this sandbox (playwright CDN ECONNRESET, same as B3) — **pass in CI** (Browser E2E, run 35710922400) after two real failures found and fixed (see Deviations) |
| `npm run e2e:desktop` | not runnable in this sandbox (Electron binary download blocked) — **pass in CI** (Desktop ubuntu + windows + installer, run 35710922400) after the same hardening |

## Acceptance criteria

- B4.0 plan committed before implementation: pass (`743066c`), with the three
  approved review corrections (`c701c9e`).
- One authenticated discovery request → presented models → user choice, with
  manual entry always available: pass (server + controller + form + e2e).
- All B4 non-goals respected: no auto-selection, no polling, no browser key
  persistence, no catalog key storage, no capability/pricing/context
  inference, no renderer-side provider requests, no secrets in logs/errors:
  pass (each enforced by tests).
- B4.1 security/limits checklist: pass (see Behavior verified).
- B4.2 controller semantics: pass.
- B4.3 required selectors + states + exact empty copy: pass.
- B4.4 browser scenarios 1–18: pass in the committed spec (executed by CI).
- B4.5 desktop checklist: pass in the committed spec (executed by CI).
- B4.6 docs + gate: pass locally; CI pending at write time.

## Security checks

- Key path exactly as corrected in the plan: open form (transient memory) →
  `POST /api/providers/discover-models` body → server request-handling memory
  → one upstream `Authorization` header. Nowhere else. Asserted at server,
  controller, browser-e2e, and desktop-e2e level.
- Raw key absent from: response bodies, errors (including hostile-upstream
  echo), logs (nothing new logs request content), metrics, URLs, browser
  storage (only the pre-existing bearer-token boundary key exists), the
  workspace catalog, visible post-save UI (mask only), and the provider
  profile store (discovery persists nothing).
- Upstream hardening: redirects refused, 5 s deadline, 2 MiB cap, upstream
  bodies never surfaced, bounded normalization only.
- No new environment variables, no new persistence, no catch-all routes.

## Deviations

- The B4.1 "contract" commit also carries the basic probe/route (a
  contract-only commit would not typecheck honestly).
- The browser/desktop fake upstream lives in the spec files (in-process hit
  counting) instead of the fixture server, and the web spec starts it in the
  test process — a stronger assertion than the planned control-endpoint
  approach.
- Node 22 undici reports refused redirects via the `cause` chain
  ("unexpected redirect"); classification checks both layers.
- Local `npm run e2e` / `npm run e2e:desktop` cannot run in this sandbox
  (playwright + Electron binary downloads blocked, same as B3); both were
  verified by `--list` discovery, typecheck, an API-level rehearsal of the
  browser journey against the real fixture server, and are executed by CI.
- The sandbox `.git` reset between B4.1 and B4.2 required cherry-picking the
  web commits onto the pushed history (trees verified identical).

## Known gaps

- Anthropic has no live model listing (documented 501 fallback; live
  `GET /v1/models` is an isolated follow-up).
- Truncation at 500 ids is silent by design (documented).
- Discovery accepts loopback/private targets by approved decision (local
  Ollama/LM Studio), relying on the same trust boundary as chat/test calls.

## CI status

All eight checks green on evidence commit `cbeab3a`, run
[35710922400](https://github.com/StepenkoAnatoli/WindowRunner/actions/runs/35710922400):
CI, Browser E2E, Docker, Platform (windows-latest), Platform (macos-latest),
Desktop (ubuntu-latest), Desktop (windows-latest),
Desktop installer (windows-latest). The installer job installed the built app,
ran both desktop specs against it, and uninstalled. This docs-only status
commit starts one more run; the merge proceeds on the evidence above (same
pattern as the B3 status file).

## Verdict

B4.6 PASS / GO — merge PR #31.
