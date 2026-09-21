# B2 plan — Settings and provider integration (atomic-commit checklist)

Date: 2026-09-21
Branch: `arena/01a0c48f-windowrunner`
Spec: the B2 atomic-commit checklist — five implementation phases (B2.0–B2.5),
one or more focused commits per phase, stop and report after each phase, and no
next phase starts until the phase's acceptance report is reviewed.

B2 begins **only after B1 is merged and `main` is green** (PR #25), and this
plan file is committed in its own commit before any implementation.

---

## B2 objective

Make provider management, usage, and settings first-class routes of the main
application while preserving:

- the existing provider API (no server changes);
- the standalone `/dashboard` route as a compatibility entry point;
- browser `#token=` → `sessionStorage` flow;
- desktop in-memory token flow;
- existing provider E2E coverage;
- provider validation, masking, activation, testing, deletion, usage, and
  quick-chat behavior;
- the B1 three-column workspace (state, catalog, active session, turn reducer,
  token behavior).

B2 is a **UI composition and routing phase**, not a provider-server redesign.

## Explicit non-goals

Do not add:

- new provider types or new authentication mechanisms;
- cloud provider storage, billing, usage quotas, or automatic model discovery;
- new server routes (the server keeps serving only `/` and `/dashboard` HTML);
- URL router dependencies or frontend frameworks;
- provider secrets to workspace catalog storage, `localStorage`, URLs, or any
  persisted UI state.

The server remains the source of truth for provider profiles. The UI holds only
editable form state and masked response data.

---

# 1. Route contract

Required routes (client-side: `history.pushState()` + `popstate`; no router
dependency):

```text
/                  workspace
/providers         providers
/usage             usage
/settings/security security
/settings/storage  storage
/settings/about    about
/dashboard         provider compatibility entry
```

- `parseUiRoute()` maps unknown paths back to the workspace route (fallback).
- `/dashboard` maps to the provider compatibility entry (kept out of the main
  app shell; it is its own page root).
- Route paths never carry bearer tokens, API keys, provider secret values, or
  project roots. The existing `#token=…` fragment flow remains separate and
  must continue to be stripped from the address bar.

# 2. Application structure

```text
WindowRunner (main shell, client-side route host)
├── Workspace   — existing B1 three-column workspace, unchanged behavior
├── Providers   — providers page
│   ├── page header
│   ├── active provider banner
│   ├── provider list
│   ├── add/edit form
│   └── notice/error state
├── Usage       — usage records table
└── Settings
    ├── security (read-only)
    ├── storage
    └── about
```

Top-level navigation: **Workspace | Providers | Usage | Settings**.

`/dashboard` remains a directly loadable compatibility entry that renders the
same provider cards/form/controller and keeps its own root, its own
`dashboard.css` styling (never dependent on `app.css`), the shared token
behavior, the "main UI" link, and (where possible) its existing selectors. It
must not depend on B1 workspace state.

# 3. State contract

Extend `app-state.ts` (additive only):

- `current route`;
- provider UI state (loading/error/notice, form state);
- usage UI state (loading/error, records, bounded-history status);
- `route-change` action;
- provider loading/error actions;
- usage loading/error actions;
- form state actions.

Preserve exactly: B1 workspace state, current turn reducer behavior, token
behavior, catalog persistence, active-session behavior.

# 4. Provider input contract

Typed form/request layer in `provider-types.ts`:

- create input type (carries `id` — the server requires `id` matching
  `PROFILE_ID_RE = /^[a-z0-9-]{1,64}$/`);
- update input type (never emits `id` or `kind` — the server rejects them as
  immutable);
- form-to-request conversion with trimming;
- optional `baseUrl` omission;
- unchanged edit key omission (blank key on edit = keep existing key);
- **masked key rejection** — a masked API key is display-only and must never be
  sent back as a replacement key;
- required-field validation.

# 5. Provider controller contract

`provider-controller.ts` centralizes every provider workflow effect:
`load`, `create`, `edit`, `update`, `test`, `activate`, `delete`, notices,
provider errors. The controller may call existing `ApiClient` methods; provider
components must remain fetch-free. One controller is shared by the providers
page and the `/dashboard` compatibility entry (no duplicated provider logic).

Server behaviors the controller must surface as actionable, non-secret
messages:

- `POST /api/providers` validates `id` (`PROFILE_ID_RE`);
- `PATCH` rejects `id`/`kind` ("id and kind are immutable");
- deleting the active profile returns `409 PROVIDER_ACTIVE` — the delete
  confirmation must warn when the target is active;
- `apiKey` patch semantics: omitted = keep, `""`/`null` = clear, string = set.
  The edit form sends no `apiKey` unless the user explicitly typed a
  replacement.

# 6. Provider components

- `providers/provider-cards.ts` — extracted/adapted dashboard card rendering.
  Preserves: provider labels, provider kind, model, base URL, masked API key,
  last-test status, active status, Use/Activate, Test, Edit, Delete.
- `providers/provider-form.ts` — create and edit modes, masked-key behavior,
  field validation, loading/disabled states, cancel behavior, accessible field
  errors.
- `providers/active-provider-banner.ts` — active profile / no active profile /
  loading / deleted-or-unavailable active profile.
- `providers/provider-page.ts` — composes header + banner + list + form +
  notice/error.
- `providers/compatibility.ts` + `dashboard.ts` — `/dashboard` reuses the same
  components and controller.

Required selectors:

```text
providers-page
providers-active
providers-list
providers-add
providers-notice
providers-error
provider-form
provider-submit
provider-cancel
```

Existing dashboard selectors (`dash-card*`, `dash-activate`, `dash-test`,
`dash-edit`, `dash-delete`, `dash-usage-*`) are preserved where possible so
existing dashboard E2E stays meaningful.

# 7. Usage page

`usage/usage-page.ts` reuses `ApiClient.usage()` and renders: records,
provider, model, status, timestamp, tokens, estimated cost, loading state,
empty state, bounded-history warning, refresh.

# 8. Settings pages

- `settings/settings-shell.ts` — settings navigation shell.
- `settings/security-page.ts` — read-only: security mode, authentication
  behavior, project trust model, approval model, local/remote access
  information if available.
- `settings/storage-page.ts` — browser catalog behavior, desktop catalog
  behavior, reset navigation catalog. Reset affects **only** the navigation
  catalog: no provider deletion, no session deletion, no arbitrary filesystem
  access.
- `settings/about-page.ts` — version, runtime, browser/desktop mode,
  documentation links, diagnostic information **without tokens**.

# 9. Main application integration

`main.ts` stays the side-effect coordinator. `app-shell.ts` hosts route
rendering, route navigation controls, popstate, provider route loading,
workspace preservation (B1 workspace state survives navigation), and
route-specific errors. A header module is extracted only if needed.

Route data loading is route-specific: the providers route loads provider state
through the controller; the usage route loads usage; workspace keeps its own
session/turn loading. Watch for and document any route-loading race
conditions.

---

# 10. Phases and commits

## Phase B2.0 — Plan and baseline

**Commit B2.0.1** — `docs(plan): define B2 settings and provider integration`

- `docs/superpowers/plans/2026-09-21-b2-settings-provider-integration.md`
  (this file, in its own commit).

Verification — run the existing baseline:

```bash
npm run typecheck
npm test
npm run build
npm run smoke:packed
npm run smoke:packed:start
npm run smoke:start
npm run eval
```

Record: root test count; desktop test count; browser E2E count; current CI
status; current `/dashboard` behavior.

Report must include: plan file path and commit; branch base commit; baseline
test results; files changed; known pre-existing failures; confirmation that no
implementation has started.

**Gate:** no B2 implementation until the plan is committed and the baseline is
green.

## Phase B2.1 — Route and state foundation

Goal: introduce application routes and provider/usage state without changing
provider behavior or redesigning the dashboard.

**Commit B2.1.1** — `feat(web): add lightweight application route model`

- `packages/web/src/ui-route.ts`
- `packages/web/test/ui-route.test.ts`
- Implement: `UiRoute`; `SettingsSection`; `parseUiRoute()`; `routePath()`;
  `navigate()`; `/dashboard` compatibility mapping; unknown-path fallback to
  workspace; `popstate` support.

**Commit B2.1.2** — `feat(web): type and validate provider form inputs`

- `packages/web/src/provider-types.ts`
- `packages/web/test/provider-types.test.ts`
- Implement: create input type; update input type; form-to-request conversion;
  trimming; optional `baseUrl` omission; unchanged edit key omission; masked
  key rejection; required-field validation.

**Commit B2.1.3** — `feat(web): add provider and route state to app reducer`

- `packages/web/src/app-state.ts`
- `packages/web/test/app-state.test.ts`
- Add: current route; provider UI state; usage UI state; route-change action;
  provider loading/error actions; usage loading/error actions; form state
  actions.
- Preserve: B1 workspace state; current turn reducer; token behavior; catalog
  persistence; active-session behavior.

Acceptance tests:

```bash
npm run typecheck --workspace packages/web
npm run test --workspace packages/web
npm run build --workspace packages/web
```

Verify manually or through E2E: `/` still renders B1 workspace; `/dashboard`
still renders the existing dashboard; unknown paths return to workspace;
browser refresh on `/providers` does not expose secrets; route changes
preserve the B1 catalog in memory; no provider API request has changed.

**Gate:** route/state foundation green before provider components are
extracted.

## Phase B2.2 — Provider page and controller

Goal: provider management from the main application without duplicating
provider state logic.

**Commit B2.2.1** — `refactor(web): extract reusable provider cards`

- `packages/web/src/providers/provider-cards.ts`
- `packages/web/test/provider-cards.test.ts`
- Move/adapt existing dashboard card rendering (labels, kind, model, base URL,
  masked key, last-test status, active status, Use/Activate, Test, Edit,
  Delete). No API call changes in this commit.

**Commit B2.2.2** — `refactor(web): extract reusable provider form`

- `packages/web/src/providers/provider-form.ts`
- `packages/web/test/provider-form.test.ts`
- Create mode; edit mode; masked-key behavior; field validation;
  loading/disabled states; cancel behavior; accessible field errors.
- Required rule: a masked API key is display-only and must never be sent back
  as a replacement key.

**Commit B2.2.3** — `feat(web): add active provider banner`

- `packages/web/src/providers/active-provider-banner.ts`
- `packages/web/test/active-provider-banner.test.ts`
- Active profile; no active profile; loading; deleted/unavailable active
  profile.

**Commit B2.2.4** — `refactor(web): centralize provider workflow effects`

- `packages/web/src/provider-controller.ts`
- `packages/web/test/provider-controller.test.ts`
- Centralize: load; create; edit; update; test; activate; delete; notices;
  provider errors. Controller may call existing ApiClient methods; provider
  components stay fetch-free.

**Commit B2.2.5** — `feat(web): add unified providers page`

- `packages/web/src/providers/provider-page.ts`
- `packages/web/test/provider-page.test.ts`
- Render: page header, active provider banner, provider list, add/edit form,
  notice/error state. Required selectors as listed in section 6.

Acceptance tests: provider list loads; add works; edit works; blank edit key
preserves the existing key; test works; activate works; delete requires
confirmation; provider errors are actionable; raw API keys never appear in
rendered cards, route URLs, `localStorage`, or catalog data; `/dashboard`
remains unchanged at this point. Plus web workspace typecheck/test/build.

**Gate:** all provider CRUD and secret-handling tests pass before integrating
routes.

## Phase B2.3 — Integrate providers, usage, and settings into the main app

Goal: make the new routes usable from the main application.

**Commit B2.3.1** — `feat(web): integrate application routes with the main shell`

- `packages/web/src/main.ts`
- `packages/web/src/app-shell.ts`
- `packages/web/src/header.ts` (only if extracted)
- `packages/web/test/main-routes.test.ts`
- Route rendering; route navigation controls; popstate; provider route
  loading; workspace preservation; route-specific errors. `main.ts` remains
  the side-effect coordinator.

**Commit B2.3.2** — `feat(web): add usage page`

- `packages/web/src/usage/usage-page.ts`
- `packages/web/test/usage-page.test.ts`
- Reuse `ApiClient.usage()`. Render: records; provider; model; status;
  timestamp; tokens; estimated cost; loading; empty state; bounded-history
  warning; refresh.

**Commit B2.3.3** — `feat(web): add security settings page`

- `packages/web/src/settings/settings-shell.ts`
- `packages/web/src/settings/security-page.ts`
- `packages/web/test/settings-pages.test.ts`
- Read-only security page: security mode; authentication behavior; project
  trust model; approval model; local/remote access information if available.

**Commit B2.3.4** — `feat(web): add storage and about settings pages`

- `packages/web/src/settings/storage-page.ts`
- `packages/web/src/settings/about-page.ts`
- `packages/web/test/settings-pages.test.ts`
- Storage page: browser catalog behavior; desktop catalog behavior; reset
  navigation catalog; no provider deletion; no session deletion; no arbitrary
  filesystem access. About page: version; runtime; browser/desktop mode;
  documentation links; diagnostic information without tokens.

Acceptance tests: Workspace → Providers works; Providers → Usage works;
Settings navigation works; browser back/forward works; refresh on each route
works; B1 catalog remains available after navigation; current token remains
valid; route URLs contain no token or provider secret; usage bounded-history
status is honest; storage reset affects only the navigation catalog.

```bash
npm run typecheck
npm test
npm run build
npm run smoke:start
npm run eval
```

**Gate:** main application routes stable before dashboard migration.

## Phase B2.4 — Dashboard compatibility adapter

Goal: keep `/dashboard` working while reusing the provider implementation.

**Commit B2.4.1** — `refactor(web): reuse provider page from dashboard compatibility entry`

- `packages/web/src/providers/compatibility.ts`
- `packages/web/src/dashboard.ts`
- `packages/web/test/provider-compatibility.test.ts`
- `/dashboard` must: remain directly loadable; reuse provider
  cards/form/controller; retain its existing root; retain shared token
  behavior; retain the "main UI" link; preserve existing selectors where
  possible; not depend on B1 workspace state.

**Commit B2.4.2** — `style(web): preserve dashboard compatibility styling`

- `packages/web/public/dashboard.css`
- `packages/web/public/dashboard.html`
- Only changes necessary to support shared components. Dashboard rendering
  must not become dependent on `app.css`.

**Commit B2.4.3** — `test(web): cover provider workspace and dashboard compatibility`

- `packages/web/e2e/providers-workspace.spec.ts`
- `packages/web/e2e/dashboard.spec.ts`
- Required scenarios: direct `/dashboard` load; provider list; add; edit;
  test; activate; delete; usage; quick chat if it remains part of the
  dashboard contract; return to main UI; token sharing; no key leakage.

Acceptance tests:

```bash
npm run typecheck
npm test
npm run build
npm run e2e
```

Verify: `/dashboard` works when opened directly; existing dashboard tests
pass; provider behavior is not duplicated; dashboard and `/providers` use the
same API/controller behavior; dashboard CSS remains isolated; browser token
flow is unchanged.

**Gate:** do not begin desktop B2 verification until `/dashboard` is green in
browser CI.

## Phase B2.5 — Desktop integration, polish, and final verification

Goal: prove B2 works in the installed desktop product and does not weaken the
security boundary.

**Commit B2.5.1** — `test(desktop): cover B2 provider flows in the installed app`

- `packages/desktop/e2e/desktop.spec.ts`
- `packages/desktop/e2e/providers.spec.ts`
- Launch installed app; workspace loads; navigate to Providers; provider list
  loads; mock provider can be created or activated; API key remains masked;
  navigate back to Workspace; workspace catalog still contains only
  project/session metadata; token absent from URL, catalog JSON, and visible
  DOM text; `/dashboard` loads; clean shutdown.

**Commit B2.5.2** — `style(web): polish provider and settings routes`

- `packages/web/public/app.css`
- `packages/web/public/dashboard.css`
- `packages/web/e2e/accessibility.spec.ts`
- Visible keyboard focus; labels and descriptions; tab semantics; button
  names; modal/confirmation focus; no horizontal overflow; responsive
  providers page; accessible masked-key explanation; reduced-motion behavior
  where applicable. Do not introduce an accessibility dependency unless the
  repository already uses one.

**Commit B2.5.3** — `docs: document workspace provider and settings flows`

- `README.md`
- `docs/INSTALL.md`
- Document: Workspace; Providers; Usage; Settings; `/dashboard`; browser
  authentication; desktop authentication; provider-key handling; catalog
  storage; catalog reset behavior.

**Commit B2.5.4** — `ci: enforce B2 browser and desktop verification`

- `packages/web/test/packaging.test.ts`
- `packages/desktop/test/packaging.test.ts`
- `.github/workflows/ci.yml`
- New route assets are included; provider page assets build; dashboard assets
  still build; desktop E2E uses the installed app; no Electron binary download
  added to unrelated jobs; B2 browser and desktop checks run in CI.

Acceptance tests — complete local suite:

```bash
npm run typecheck
npm test
npm run build
npm run smoke:packed
npm run smoke:packed:start
npm run smoke:start
npm run eval
npm run e2e
npm run e2e:desktop
```

Where the sandbox cannot run Electron, report that explicitly and require CI
evidence.

Required CI checks: `CI`, `Browser E2E`, `Docker`, `Platform (windows-latest)`,
`Platform (macos-latest)`, `Desktop (ubuntu-latest)`, `Desktop (windows-latest)`,
`Desktop installer (windows-latest)`.

**Gate:** B2 complete only after all browser, desktop, and installer checks are
green.

---

# 11. Secret-handling rules (all phases)

- [ ] No raw provider key in URL (routes, redirects, or `#fragment`).
- [ ] No raw provider key in `localStorage`.
- [ ] No raw provider key in workspace catalog (browser or desktop).
- [ ] Masked keys are never submitted as replacement keys.
- [ ] Desktop token remains in memory (never written to catalog, DOM text, or
      diagnostics).
- Raw API keys must never appear in rendered cards, route URLs, `localStorage`,
  or catalog data.

# 12. Test-file contract

```text
packages/web/test/ui-route.test.ts
packages/web/test/provider-types.test.ts
packages/web/test/app-state.test.ts
packages/web/test/provider-cards.test.ts
packages/web/test/provider-form.test.ts
packages/web/test/active-provider-banner.test.ts
packages/web/test/provider-controller.test.ts
packages/web/test/provider-page.test.ts
packages/web/test/main-routes.test.ts
packages/web/test/usage-page.test.ts
packages/web/test/settings-pages.test.ts
packages/web/test/provider-compatibility.test.ts
packages/web/test/packaging.test.ts
packages/web/e2e/providers-workspace.spec.ts
packages/web/e2e/dashboard.spec.ts
packages/web/e2e/accessibility.spec.ts
packages/desktop/e2e/desktop.spec.ts
packages/desktop/e2e/providers.spec.ts
packages/desktop/test/packaging.test.ts
```

Do not delete existing E2E coverage while replacing components.

# 13. Atomic commit rules (all commits)

1. One conceptual change.
2. No unrelated formatting.
3. Typecheck passes after the commit.
4. Unit tests for the changed module pass.
5. No server changes unless explicitly approved.
6. No secrets in fixtures, logs, snapshots, URLs, or persisted state.
7. Do not combine dashboard migration with new settings pages.
8. Do not delete existing E2E coverage while replacing components.
9. Keep the plan file committed before implementation.
10. Stop after each phase and wait for review.

# 14. Phase-report format (required, every phase)

At the end of every phase, report with: `Status` (PASS / BLOCKED / NEEDS
REVIEW); `Commits` (sha + message); `Files changed` (Added / Modified);
`Behavior now verified`; `Tests` table (Typecheck, Unit tests, Browser E2E,
Desktop E2E, Smoke/eval); `Acceptance criteria` checklist; `Security checks`
checklist (the five rules in section 11); `Deviations`; `Known gaps carried
forward`; `CI status` (actual check names and conclusions — never claim a
check passed without its real result); `Go/no-go` (GO / STOP).

---

## Appendix — verified server facts (constrains the implementation)

1. `POST /api/providers` validates `id` against `PROFILE_ID_RE`
   (`/^[a-z0-9-]{1,64}$/`, `packages/server/src/provider-profiles.ts`).
   `CreateProviderInput` must carry `id`.
2. `kind` is immutable on update; `PATCH` rejects `id`/`kind`. The update
   conversion must never emit them.
3. The server refuses to delete the active profile (`409 PROVIDER_ACTIVE`).
4. `apiKey` patch semantics: omitted = keep, `""`/`null` = clear, string =
   set. B2 edit forms use blank = keep (no key sent unless typed).
5. The server has no SPA history fallback: only `/` and `/dashboard` (plus
   `/desktop` for the shell) serve HTML. B2 routes are client-side
   (`pushState` + `popstate`); in-app navigation works everywhere and hard
   reloads of app routes stay a documented limitation (no new server route).
6. Dashboard test ids (`dash-card*`, `dash-activate`, `dash-test`, `dash-edit`,
   `dash-delete`, `dash-usage-*`) are kept alive by the shared components so
   existing dashboard E2E stays meaningful.
7. The desktop shell reuses the web UI over `/desktop` with a preload bridge;
   its token lives in memory in the main process.
