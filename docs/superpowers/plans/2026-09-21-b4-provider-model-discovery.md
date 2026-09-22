# B4 plan — Provider model discovery

Date: 2026-09-22
Branch: `arena/01a0c816-windowrunner`
Base: `main` @ `126f5123f5d244130c6250f9ce1f7bb75d8c6875` (merge of PR #29, B3)

B4 adds one-shot, server-side model discovery: after the user types a provider
kind, base URL, and API key, the app makes ONE authenticated discovery request,
presents the returned models, and lets the user pick one. Manual model entry
stays available and never goes away. Discovery never saves, never activates,
never polls, and never persists the key anywhere new.

## B4.0 baseline (recorded before implementation)

| Item | Value |
| --- | --- |
| Current base | `main` @ `126f5123f5d244130c6250f9ce1f7bb75d8c6875`, B3 (PR #29) merged |
| Provider kinds | `mock`, `openai-compatible`, `anthropic` (`KINDS` in `packages/server/src/provider-profiles.ts`) |
| Provider routes | `POST/GET/PATCH/DELETE /api/providers`, `POST /api/providers/:id/{activate,test}` in `packages/server/src/app.ts`, mounted only when `deps.providerAdmin` is set, behind the existing bearer/Host/Origin middleware (`security.ts`) |
| Existing outbound server requests | Only the chat adapters (`providers/openai-compatible.ts`, `providers/anthropic.ts`) and the `/test` probe (5 s timeout, `ProviderService.testTimeoutMs`). There is NO existing outbound SSRF policy in the server — the existing guards are inbound (Host header, Origin, bearer). |
| Existing baseUrl/key validation | `validateProfile` (`provider-profiles.ts`): baseUrl must start `http(s)://` and be printable ASCII; apiKey ≤ 512, no whitespace, printable ASCII; `invalidHeaderValue` names the offending character. |
| Key redaction precedent | `redactProfile` masks to `****last4`; the openai-compatible adapter scrubs its key from error detail (`redact(detail, this.apiKey)`); `ProviderService.test` scrubs the profile key from any returned text. |
| Form/controller | `ProviderFormState` in `packages/web/src/app-state.ts` (transient, dropped on close); `createProviderController` is a factory over `{getClient,get,set,onAuthError}`; `provider-types.ts` holds the pure adapters (`apiKeyToSend` drops blank/pasted-mask keys). |
| Form rendering | `renderProviderForm` (`packages/web/src/providers/provider-form.ts`) is shared by the workspace Providers route AND the `/dashboard` compatibility page. Model text input testid today: `provider-model` (used by `accessibility.spec.ts`, `dashboard.spec.ts`, `providers-workspace.spec.ts`, `provider-form.test.ts`). |
| E2E fixtures | `packages/web/e2e/providers-server.ts` boots the REAL server on `PROVIDERS_PORT` (7703) with its own temp data dir; CI's "Enforce B2 browser contract inventory" step pins the spec-file list and must gain the new spec. Desktop: `packages/desktop/e2e/providers.spec.ts` + `launch.ts`. |
| Eight CI checks | CI, Browser E2E, Docker, Platform (windows-latest), Platform (macos-latest), Desktop (ubuntu-latest), Desktop (windows-latest), Desktop installer (windows-latest). |
| Model discovery before B4 | None. The B2 plan explicitly listed "automatic model discovery" as a non-goal; B4 lifts that for one-shot discovery only. |

## Non-goals (B4 brief, unchanged)

No automatic model selection; no continuous polling; no provider key
persistence in the browser; no provider key storage in the workspace catalog;
no capability inference; no pricing lookup; no context-window detection; no
arbitrary HTTP requests from the renderer; no provider-specific secrets in logs
or errors. B5 (signing, SmartScreen, crash diagnostics, upgrade/uninstall,
release artifacts, versioning, changelog, final security review) stays a
separate stage.

## API contract

```text
POST /api/providers/discover-models
Authorization: Bearer <existing server token>   (same middleware as every /api route)

{ "kind": "openai-compatible", "baseUrl": "https://provider.example/v1", "apiKey": "secret" }

200 -> { "models": ["model-a", "model-b"] }      (sorted, deduplicated, capped)
```

Typed result (shared shape, client mirrors it in `api.ts`):

```ts
export interface ModelDiscoveryResult {
  models: string[];
}
```

Errors use the existing provider-route shape `{ error, code }`:

| Code | Status | When |
| --- | --- | --- |
| `DISCOVERY_INVALID_REQUEST` | 400 | bad `kind`, bad/missing `baseUrl`, bad `apiKey` charset/length, non-object body |
| `DISCOVERY_UNAVAILABLE` | 501 | the kind has no live discovery (anthropic in this pass; message exactly: `model discovery unavailable for this provider`) |
| `DISCOVERY_TIMEOUT` | 504 | upstream did not answer within the timeout (default 5 s) |
| `DISCOVERY_UPSTREAM` | 502 | upstream answered with a non-2xx status (message carries the status, never the upstream body, never the key) |
| `DISCOVERY_BAD_RESPONSE` | 502 | upstream body unparseable, wrong shape, over the size cap, or redirect attempted |

The raw key never appears in a response body, an error, a log line, a metric, a
URL, browser storage, or the workspace catalog. It exists in exactly two places:
the transient form field while typed, and the `Authorization` header of the one
outbound upstream request.

## B4.1 — Server discovery service

New module `packages/server/src/provider-discovery.ts` (pure logic, injectable
`fetch` + timeout for tests); route wired in `app.ts` inside the existing
`deps.providerAdmin` block, registered BEFORE the `/:id` param routes (static
paths first — no conflict today, kept as an invariant).

Request validation (fail 400 before any I/O):

- body must be a JSON object (existing `bodyObject` + 1 MB cap);
- `kind` ∈ `KINDS`;
- `baseUrl`: required for `openai-compatible`; must parse as `http(s)` URL,
  non-empty hostname, no `user:pass@` userinfo, printable ASCII, ≤ 2048 chars;
- `apiKey`: optional (Ollama-style endpoints need none — a key is required only
  when the provider requires it, which we cannot know, so it is never forced);
  when present: ≤ 512 chars, no whitespace, printable ASCII (mirrors
  `validateProfile`); ignored for `mock`.

Per kind:

- `mock` → `{ models: ["mock"] }`. No network request.
- `openai-compatible` → `GET {baseUrl}/models` with `Authorization: Bearer <apiKey>`
  (header omitted when no key) and `Accept: application/json`. Trailing slashes
  stripped. `redirect: "error"` — a redirect is refused, not followed
  (stronger than "no unbounded redirects"; documented). `AbortController` at
  `discoveryTimeoutMs` (default 5000, injectable). Response body read through a
  capped stream reader, hard stop at 2 MiB → `DISCOVERY_BAD_RESPONSE`.
  Normalization accepts ONLY bounded shapes: `{ "data": [ {"id": "..."} | "..." ] }`,
  a top-level array of the same items, or `{ "models": ["..."] }`. Items must be
  strings or `{ id: string }` (trimmed, non-empty, ≤ 256 chars); non-conforming
  items are dropped; an unrecognized payload is `DISCOVERY_BAD_RESPONSE`.
  Then: dedupe exact ids, sort with plain UTF-16 `<` (locale-independent, so the
  order is deterministic everywhere), cap at 500 (`MAX_DISCOVERED_MODELS`;
  documented truncation). Empty result → `{ models: [] }` with 200 — the UI owns
  the empty-state copy.
- `anthropic` → no live listing in this pass (the adapter implements only
  `POST /v1/messages`). Return `501 DISCOVERY_UNAVAILABLE` with the exact
  message `model discovery unavailable for this provider`. No static list is
  ever presented as live data. (The official API has `GET /v1/models`; adding
  it is a documented follow-up, not silently deferred.)

Security/limits checklist (all covered by tests): authenticated through the
existing bearer middleware; `kind`/`baseUrl`/`apiKey` validated; loopback and
private targets are DELIBERATELY allowed (see Deviations); ~5 s timeout; capped
body; capped + deduped + sorted models; key never persisted anywhere; keys
scrubbed from any error text that could carry them (same belt-and-braces scrub
as the adapter) — and, defense in depth, upstream response bodies are never
included in errors at all, so a hostile upstream cannot echo the key back into
the UI.

Tests (`packages/server/test/provider-discovery.test.ts`, plus route-level
cases in `providers-routes.test.ts`): validation matrix; mock path; openai-
compatible via a fake upstream HTTP server (existing fake-server pattern);
normalization (dedupe/sort/cap/shape rejection); timeout with injected short
timeout; body-cap; redirect refusal; 401 without bearer token; and a hostile
upstream that echoes the Authorization header — asserting the key appears in no
response, no rendered error, and no log.

## B4.2 — API client and provider controller

`packages/web/src/api.ts`:

```ts
export interface DiscoverModelsInput { kind: string; baseUrl?: string; apiKey?: string; }
export interface ModelDiscoveryResult { models: string[]; }
async discoverModels(input: DiscoverModelsInput): Promise<ModelDiscoveryResult>;
```

POSTs `/api/providers/discover-models` with the same bearer headers as every
other call. The key rides only in this request body; nothing stores it.

`packages/web/src/app-state.ts` — transient form field:

```ts
modelDiscovery:
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; models: string[] }
  | { status: "error"; message: string };
```

Initialized `idle` by `openCreateForm`/`openEditForm`; dies with the form.

`createProviderController` gains `discoverModels(): Promise<void>`:

- no-op unless a form is open, not submitting, and discovery is not already
  loading (exactly one request at a time);
- builds the input from CURRENT form values (trimmed; `apiKey` only when typed
  and not a pasted mask — reuses the `apiKeyToSend` rule);
- sets `loading` → `ready{models}` / `error{message}` from the server response
  (`describeError` wording, secret-free); 401 hands back via `onAuthError`;
- NEVER saves a profile, NEVER activates one, NEVER reloads the list.

`handleFieldChange`: any change to `kind`, `baseUrl`, or `apiKey` resets
`modelDiscovery` to `idle` — stale results are cleared, never shown against
values they were not fetched for. The typed `model` text is never replaced
unless the user picks from the select. The raw key lives only in the transient
form while typed (unchanged rule).

Tests: `provider-controller.test.ts` (state machine, one-at-a-time guard,
stale-reset matrix, no save/activate calls, key present only in the request
body, masked-key paste never sends a key) and `api.test.ts` (path, headers,
body parse, error mapping).

## B4.3 — Provider form selection UI

`packages/web/src/providers/provider-form.ts` — under the Model field, a
discovery region (`data-testid="provider-model-discovery"`):

```text
Model:
[ provider-model-manual (text input, always visible) ]

[ provider-discover-models  "Fetch models" ]

provider-model-discovery:
  idle    -> hint: "or enter the model id manually"
  loading -> provider-model-discovery-loading ("Fetching models…", button disabled)
  ready   -> non-empty: provider-model-select <select> (placeholder "Select a model…";
             choosing an option copies the id into the model field and the select
             returns to the placeholder — the text field stays the source of truth)
          -> empty:     provider-model-discovery-empty, exact text:
             "No models were returned. Enter the model id manually."
  error   -> provider-model-discovery-error (role=alert, secret-free message)
```

Decisions (recorded for review):

- `provider-model-manual` is the testid of the LABEL wrapping the always-
  visible manual model input; the input itself keeps `data-testid="provider-model"`
  so every B2/B3 browser/desktop spec and the `/dashboard` compatibility page
  stay untouched. Manual entry remains available in every state — discovery is
  never required, never replaces typed text on its own.
- The Fetch models button renders for `openai-compatible` and `mock` (mock
  answers `["mock"]` offline, honestly). For `anthropic` the region renders the
  documented fallback text `model discovery unavailable for this provider` as a
  static hint — the fallback is surfaced up front instead of by a click that can
  only fail. The `DISCOVERY_UNAVAILABLE` server path is still exercised by
  server tests and by any direct API use.
- Staleness is communicated by clearing (B4.2 resets to `idle` on kind/baseUrl/
  key changes); the region visibly returns to its idle hint.

Tests: `provider-form.test.ts` (states, selectors, select-copies-into-field,
empty copy, error copy, manual input never disabled) and
`provider-compatibility.test.ts` (the `/dashboard` page gets the same region
without breaking its contract).

## B4.4 — Browser E2E and security verification

New `packages/web/e2e/model-discovery.spec.ts` against the existing providers
fixture; `providers-server.ts` gains an in-process fake upstream (own port)
serving `GET /v1/models` (ids out of order, with a duplicate, to prove
dedupe+sort in the dropdown), `/v1/empty/models` (`{data:[]}`), `/v1/error/models`
(500), and `/v1/echo/models` (401 whose body echoes the fake key — proving the
server never forwards upstream bodies into errors). Add the spec to the CI
inventory step so coverage cannot shrink silently.

Scenarios (mapped 1:1 from the brief): open Providers → type kind/base URL/key
(fake upstream, fake key) → click Fetch models → assert EXACTLY ONE
`POST /api/providers/discover-models` request (Playwright request counter AND
upstream hit counter) → options appear sorted/deduped → choose one → model
field updated, select back at placeholder → save → card shows the
`****last4` mask → the raw key is absent from: the URL, `localStorage`,
`sessionStorage` (existing token boundary aside), the workspace catalog entry,
the visible DOM after save, the discovery response body (captured via
`page.on("response")`), and every rendered error (including the echo upstream).
Then: failure run (unreachable port) → actionable secret-free error, manual
entry still works; empty run → exact empty-state copy; change base URL/key after
discovery → results cleared; discovery never activates (active banner
unchanged, no `activate` call); Cancel/Escape discards without saving (existing
dirty-confirm).

## B4.5 — Desktop verification

New `packages/desktop/e2e/model-discovery.spec.ts` following
`providers.spec.ts`/`launch.ts` with the same in-process fake upstream:

- discovery runs on the existing in-memory API token (no re-entry);
- the key travels only in the authenticated `POST /api/providers/discover-models`
  body; not in the URL; not in the workspace catalog JSON (preload IPC file);
  not in the visible UI after save (mask only);
- model selection fills the field; manual fallback works; a failed discovery
  shows the error and the form stays usable; cancelling never saves;
- `/dashboard` compatibility page still renders and works.

Timeout visibility: the server timeout is proven by unit tests (injected short
timeout + default-constant assertion); the UI renders timeouts through the same
error path as every other discovery failure, which the e2e covers with an
immediate-failure upstream — no 5-second hang in CI.

## B4.6 — Documentation and final gate

Update `README.md` and `docs/INSTALL.md`: Fetch models behavior (one request,
button, select, manual fallback always available), supported kinds
(`openai-compatible` live, `mock` offline list, `anthropic` documented
fallback), one-shot semantics (no polling, no auto-selection), ~5 s timeout and
its error, key handling (transient form → one authenticated server request →
masked after save; never in browser storage, catalog, logs, errors, or URLs),
no browser-side direct provider requests (the browser talks only to this
server), and the deliberate loopback/private-target allowance (local Ollama) —
same trust level as the existing chat path.

Durable phase status file: `docs/superpowers/plans/2026-09-21-b4-atomic-status.md`
(status, commits, files, behavior, tests, acceptance criteria, security checks,
deviations, known gaps, CI status, GO/STOP) — maintained from B4.1 onward.

Final gate — all local, then all eight CI checks green:

```bash
npm run typecheck && npm test && npm run build
npm run smoke:packed && npm run smoke:packed:start && npm smoke:start  # smoke:start
npm run eval && npm run e2e && npm run e2e:desktop
```

```text
CI | Browser E2E | Docker | Platform (windows-latest) | Platform (macos-latest)
Desktop (ubuntu-latest) | Desktop (windows-latest) | Desktop installer (windows-latest)
```

B4 is complete only when B4.6 reports `B4.6 PASS / GO`.

## Deviations and decisions to review

1. **No loopback/private-target rejection.** The brief rejects private targets
   "if the server's existing SSRF policy requires that". No such outbound
   policy exists, and rejecting loopback would break the documented local
   Ollama/LM Studio use case (`http://127.0.0.1:11434/v1` is in the kind hint).
   The discovery target is the same class of user-configured endpoint the chat
   and test paths already hit server-side, behind the same bearer auth.
   Compensating controls: scheme/userinfo/charset validation, no redirects,
   timeout, body cap, and upstream bodies never surfaced in errors.
2. **`anthropic` gets the documented fallback now** (501 + exact message), not
   a live `GET /v1/models` call — the repo's anthropic adapter does not
   implement listing, and the brief forbids passing a static list off as live
   data. Adding the live call later is a small, isolated follow-up.
3. **Response shape is the recommended `{ models: string[] }`**, matching the
   repo's plain-JSON route style; per-field error lists are unnecessary here,
   so errors stay `{ error, code }`.
4. **`provider-model-manual` wraps the existing input** instead of renaming it,
   so B2/B3 specs and the `/dashboard` compatibility page keep their handles.
5. **Redirects are refused outright** (`redirect: "error"`), which is stricter
   than "no unbounded redirects" and simpler to reason about.

## Suggested commit sequence

```text
docs(plan): define provider model discovery                        (B4.0)
feat(server): add provider model discovery contract                 (B4.1)
feat(server): probe openai-compatible model listings safely         (B4.1)
test(server): cover model discovery validation and redaction        (B4.1)
feat(web): add model discovery API client flow                      (B4.2)
test(web): cover model discovery controller states                  (B4.2)
feat(web): add model discovery controls to provider form            (B4.3)
test(web): cover model selection and manual fallback                (B4.3)
test(web): cover model discovery browser journeys                   (B4.4)
test(web): enforce provider-key discovery boundaries                (B4.4)
test(desktop): verify provider model discovery in Electron          (B4.5)
docs: describe model discovery limits and key handling              (B4.6)
docs(status): record the B4 phase report                            (B4.6)
```
