# B4 atomic checklist — phase status

Durable progress record for B4 (provider model discovery). Chat history is not
durable — this file is. Updated at every B4 stop point.

Branch: `arena/01a0c816-windowrunner`
PR: https://github.com/StepenkoAnatoli/WindowRunner/pull/31
Base: `main` @ `126f5123f5d244130c6250f9ce1f7bb75d8c6875` (merge of PR #29, B3)
Plan: `docs/superpowers/plans/2026-09-21-b4-provider-model-discovery.md`

## Status

B4.0 done (with the three review corrections). **B4.1 done — server discovery
service + server tests.** Stopping for review before B4.2. B4.2–B4.6 not
started.

## Commits

```text
743066c — docs(plan): define provider model discovery
f3cb728 — docs(status): open the B4 atomic checklist
c701c9e — docs: correct B4 model discovery gate and key-path contract
82b7c6c — feat(server): add provider model discovery contract
1ff0fb5 — feat(server): probe openai-compatible model listings safely
0a0f05f — test(server): cover model discovery validation and redaction
```

## Files changed

`docs/superpowers/plans/2026-09-21-b4-provider-model-discovery.md` (plan),
`docs/superpowers/plans/2026-09-21-b4-atomic-status.md` (this file),
`packages/server/src/provider-discovery.ts` (new),
`packages/server/src/app.ts` (discovery route + import),
`packages/server/test/provider-discovery.test.ts` (new).

## Behavior now verified

- `POST /api/providers/discover-models` is mounted only with the provider
  admin (same gating as every other provider route), behind the existing
  Host/Origin/bearer middleware, and registered BEFORE the parameterized
  `/:id` provider routes.
- Request validation, all 400 `DISCOVERY_INVALID_REQUEST` before any I/O:
  non-object body (route-level `BODY_INVALID` for arrays), unknown/missing
  `kind`, `baseUrl` required for openai-compatible and must parse as an
  absolute http(s) URL with a host, no `user:pass@` credentials, printable
  ASCII, ≤ 2048 chars; `apiKey` optional, ≤ 512 chars, no whitespace,
  printable ASCII; empty/absent key = no key (Ollama-style endpoints).
- `mock` → `{ "models": ["mock"] }` with no network request (asserted with a
  fetch spy that must not run).
- `anthropic` → 501 `DISCOVERY_UNAVAILABLE`, message exactly
  `model discovery unavailable for this provider`, no network request.
- `openai-compatible` → exactly one `GET {baseUrl}/models` with
  `Accept: application/json` and `Authorization: Bearer <key>` only when a key
  was typed; trailing slashes stripped; timeout via AbortController
  (default `DISCOVERY_TIMEOUT_MS` = 5000, asserted; shortened timeout proven
  against a hanging real upstream → 504 `DISCOVERY_TIMEOUT`); redirects
  refused outright (`redirect: "error"`, real-302 test → 502
  `DISCOVERY_BAD_RESPONSE`); response body hard-capped at 2 MiB (streaming
  cap with abort teardown AND a lying-content-length precheck, both proven);
  non-2xx → 502 `DISCOVERY_UPSTREAM` carrying only the HTTP status; network
  failures → 502 with the OS error code (e.g. ECONNREFUSED); non-JSON body →
  502 `DISCOVERY_BAD_RESPONSE`.
- Normalization accepts ONLY `{data:[{id}|str]}`, a bare array, or
  `{models:[str]}`; non-conforming items are dropped (trim, non-empty, ≤ 256
  chars); dedupe then plain-UTF-16 sort (locale-independent, asserted with
  `ä`/`Z`) then cap at 500 (`MAX_DISCOVERED_MODELS`); empty listing →
  `{ models: [] }`.
- Redaction: the raw key appears in no response body, no error message
  (including a hostile upstream that echoes the `Authorization` header back
  in a 401 body — module AND route level), no URL, and no provider-profiles
  store write (discovery persists nothing; `redactKey` is a documented second
  layer on messages that are secret-free by construction).
- Route-level: 401 `AUTH_REQUIRED`/`AUTH_INVALID`; 400s; 200 mock; 501
  anthropic; 200 sorted/deduped happy path with exactly one upstream probe;
  502 echo/redirect/oversize/unreachable; array body → 400 `BODY_INVALID`.
  After discovery the store still has zero profiles and
  `activeProfileId === null` (discovery never activates anything).

## Tests

| Suite | Result |
| --- | --- |
| `packages/server/test/provider-discovery.test.ts` (new) | 37/37 pass |
| Full server suite | 385/385 pass |
| Full monorepo `npm test` (shared 9 + server 385 + web 213) | 607/607 pass |
| `tsc -p packages/server/tsconfig.json --noEmit` | pass |

## Acceptance criteria (B4.1)

- One-shot server-side provider probing endpoint exists and validates
  kind/baseUrl/key: pass.
- mock offline list, openai-compatible live probe, anthropic documented
  fallback (no static list passed off as live data): pass.
- Authenticated through the existing bearer middleware: pass (route-level 401
  test).
- Static route registered before parameterized provider-id routes: pass
  (registration order in `app.ts`; functional coverage via the happy path).
- Short timeout (~5 s), capped body, capped/deduped/sorted model ids, no
  unbounded redirects, no key persistence, redacted errors: pass (each has at
  least one dedicated test).
- Loopback/private targets allowed per approved decision: pass (all real
  upstream tests run against 127.0.0.1).

## Security checks

- Key path honored as corrected in the plan: transient form (later phases) →
  request body → request-handling memory → one upstream `Authorization`
  header. Never in a response, error, log, metric, URL, browser storage, or
  the catalog/profile store.
- Upstream response bodies are never included in any error message; a hostile
  upstream echoing the Authorization header cannot leak the key (proven).
- Errors carry stable codes + statuses only; the route additionally scrubs
  the request key from any outgoing message (`redactKey`).
- No new persistence, no new logs, no metrics with request content.

## Deviations

- The brief's suggested commit `feat(server): add provider model discovery
  contract` also carries the basic openai-compatible probe and route wiring
  (a contract-only commit with a dead probe path would not typecheck
  honestly); the follow-up `…probe … safely` commit carries the body-size
  caps and the undici redirect classification. Each commit is green.
- Node 22's undici reports a refused redirect as `TypeError: fetch failed`
  with cause `unexpected redirect` (not a message containing "redirect");
  classification checks both the outer message and the cause chain.
- One full-suite run had a single unrelated test failure that did not
  reproduce in three subsequent full runs (shared 9 + server 385 + web 213
  green). Watched; not attributed to B4.1.

## Known gaps

- Anthropic users have no live model listing yet (documented 501 fallback).
- Truncation at 500 ids is silent by design (documented).
- CI has not been asserted on these commits yet (pushed to PR #31; results
  recorded at the next stop point).

## CI status

Not asserted at this stop point (B4.1 is server-only; the local suite is
fully green). All eight checks must be green by the B4.6 gate.

## Verdict

B4.1 PASS — stopping for review before B4.2 (API client + provider
controller).
