# B2 plan — Unified settings and provider integration

B2 begins **only after B1 is merged and `main` is green**.

---

## B2 objective

Move provider management into the main three-column workspace while preserving:

- the existing provider API;
- the standalone `/dashboard` route;
- browser token flow;
- Electron in-memory token flow;
- existing provider E2E coverage;
- provider validation, masking, activation, testing, deletion, usage, and quick chat behavior.

B2 is a **UI composition and routing phase**, not a provider-server redesign.

## Explicit non-goals

Do not add:

- new provider types;
- new authentication mechanisms;
- cloud provider storage;
- billing or usage quotas;
- automatic model discovery;
- new server routes;
- URL routers or frontend frameworks;
- provider secrets to workspace catalog storage;
- provider secrets to `localStorage`;
- provider secrets to Electron renderer state beyond the existing server/API boundary.

The server remains the source of truth for provider profiles. The UI only holds editable form state and masked response data.

---

# 1. B2 product structure

The main application becomes a small client-side route host:

```text
WindowRunner
├── Workspace
│   ├── Sidebar | Chat | Context
│   └── Existing B1 session workflow
├── Providers
│   ├── Provider list
│   ├── Add/edit provider
│   ├── Test connection
│   ├── Activate provider
│   └── Delete provider
├── Usage
│   └── Recent usage records
└── Settings
    ├── Security
    ├── Storage
    └── About
```

The primary top-level navigation should be:

```text
Workspace
Providers
Settings
```

The existing `/dashboard` page remains available as a compatibility entry point and should render the same provider-management components where practical.

---

# 2. Route/state contract

## Create `packages/web/src/ui-route.ts`

Define the small route model without adding a router dependency:

```ts name=packages/web/src/ui-route.ts
export type UiRoute =
  | { kind: "workspace" }
  | { kind: "providers" }
  | { kind: "usage" }
  | { kind: "settings"; section: SettingsSection };

export type SettingsSection = "security" | "storage" | "about";

export function parseUiRoute(pathname: string, hash?: string): UiRoute;

export function routePath(route: UiRoute): string;

export function navigate(route: UiRoute): void;
```

### Browser route mapping

```text
/                  → workspace
/providers         → providers
/usage             → usage
/settings/security → security settings
/settings/storage  → storage settings
/settings/about    → about settings
/dashboard         → compatibility provider entry
```

Use `history.pushState()` and `popstate`.

The route must not contain:

- bearer tokens;
- API keys;
- provider secret values;
- project roots if they may contain sensitive information.

The existing `#token=...` authentication flow remains separate and must continue to be stripped from the address bar.

## Compatibility behavior

`/dashboard` should render the provider route:

```text
/dashboard → Providers page
```

The URL may remain `/dashboard`; the page should not force a redirect unless there is a strong reason. This avoids breaking bookmarks and existing E2E tests.

The dashboard’s existing “main UI” link should navigate to `/`.

---

# 3. App state contract

## Modify `packages/web/src/app-state.ts`

Keep the B1 workspace state and add route/provider UI state separately.

```ts name=packages/web/src/app-state.ts
export interface ProviderUiState {
  status: "idle" | "loading" | "ready" | "error";
  activeProfileId: string | null;
  profiles: ProviderProfileView[];
  form?: ProviderFormState;
  testingProfileId?: string;
  deletingProfileId?: string;
  notice?: ProviderNotice;
  error?: { code: string; message: string };
}

export interface ProviderFormState {
  mode: "create" | "edit";
  profileId?: string;
  label: string;
  kind: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  apiKeyMode: "empty" | "unchanged" | "replace";
  validationErrors: Record<string, string>;
  submitting: boolean;
}

export interface UsageUiState {
  status: "idle" | "loading" | "ready" | "error";
  records: TurnUsageView[];
  retained?: number;
  bounded?: boolean;
  error?: { code: string; message: string };
}
```

Add to `AppState`:

```ts name=packages/web/src/app-state.ts
route: UiRoute;
providers: ProviderUiState;
usage: UsageUiState;
```

### State invariants

1. `ProviderProfileView.apiKeyMasked` is display-only and never becomes an editable raw key.
2. A form in edit mode must distinguish:
   - no key change;
   - replace existing key;
   - clear key, if the server contract supports clearing.
3. `activeProfileId` must come from the server response.
4. Activating a profile must update the list from the server response rather than locally guessing its `active` state.
5. A provider test must not silently activate the provider.
6. Deleting the active provider requires a confirmation step or explicit warning.
7. Route changes do not clear the workspace catalog, current session, or token.
8. Sign-out clears provider and usage state but preserves B1 navigation metadata.
9. Provider form text is transient UI state and is never persisted.
10. Navigation away from a dirty provider form must either preserve it in memory or ask for confirmation; B2 should use an in-memory form and a confirmation message.

---

# 4. API contract

## Modify `packages/web/src/api.ts` only if required

Retain the existing methods:

```ts
listProviders(): Promise<ProviderListResult>;

createProfile(input: Record<string, unknown>): Promise<ProviderProfileView>;

updateProfile(
  id: string,
  patch: Record<string, unknown>
): Promise<ProviderProfileView>;

deleteProfile(id: string): Promise<void>;

activateProfile(
  id: string
): Promise<{
  activeProfileId: string;
  profile: ProviderProfileView;
}>;

testProfile(id: string): Promise<ProviderTestResult>;

usage(limit?: number): Promise<{
  records: TurnUsageView[];
  retained?: number;
  bounded?: boolean;
}>;
```

No server API changes are planned.

## Add typed provider input contracts

Avoid passing unvalidated arbitrary records from components.

```ts name=packages/web/src/provider-types.ts
export interface CreateProviderInput {
  label: string;
  kind: string;
  baseUrl?: string;
  model: string;
  apiKey: string;
}

export interface UpdateProviderInput {
  label?: string;
  kind?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}
```

Add a form-to-request adapter:

```ts name=packages/web/src/provider-types.ts
export function toCreateProviderInput(
  form: ProviderFormState
): CreateProviderInput;

export function toUpdateProviderInput(
  form: ProviderFormState
): UpdateProviderInput;
```

The adapter must:

- trim labels, URLs, model IDs, and API keys;
- omit optional `baseUrl` when empty;
- never send a masked API key such as `••••••`;
- never send `apiKey` in an edit request unless the user explicitly replaced it;
- reject empty required fields before making an API request.

---

# 5. Provider state coordinator

## Create `packages/web/src/provider-controller.ts`

This module owns provider effects but not DOM rendering.

```ts name=packages/web/src/provider-controller.ts
export interface ProviderController {
  load(): Promise<void>;
  openCreateForm(): void;
  openEditForm(profile: ProviderProfileView): void;
  closeForm(): void;
  submitForm(): Promise<void>;
  activate(profileId: string): Promise<void>;
  test(profileId: string): Promise<void>;
  delete(profileId: string): Promise<void>;
  dismissNotice(): void;
}
```

The actual implementation may be closures in `main.ts`, but keep the contract explicit.

### Required behavior

#### Load

```text
GET /api/providers
```

- show loading state;
- replace the provider list on success;
- display a non-secret error on failure;
- preserve the current route.

#### Create

```text
POST /api/providers
```

- validate locally;
- disable the form during submission;
- on success, close the form and reload the list;
- never display the raw key after submission.

#### Edit

```text
PATCH /api/providers/:id
```

- populate label/kind/base URL/model;
- show only the masked key;
- use a blank key field for optional replacement;
- never send the mask back to the server.

#### Test

```text
POST /api/providers/:id/test
```

- show testing state on only the selected profile;
- preserve the rest of the list;
- show latency, success, or server error;
- do not activate the profile.

#### Activate

```text
POST /api/providers/:id/activate
```

- show activation state;
- reload profiles after success;
- update active banner;
- make the active provider obvious in the list.

#### Delete

```text
DELETE /api/providers/:id
```

- require explicit confirmation;
- disable the delete control while pending;
- reload profiles after success;
- if the deleted profile was active, show the server’s resulting active state.

---

# 6. Provider components

## Create `packages/web/src/providers/provider-page.ts`

Top-level provider route composition:

```ts name=packages/web/src/providers/provider-page.ts
export interface ProviderPageProps {
  state: ProviderUiState;
  onAdd(): void;
  onEdit(profileId: string): void;
  onTest(profileId: string): void;
  onActivate(profileId: string): void;
  onDelete(profileId: string): void;
  onSubmit(): void;
  onCancelForm(): void;
  onFieldChange(field: string, value: string): void;
  onDismissNotice(): void;
}
```

Render:

```text
Provider page
├── page header
├── active provider banner
├── provider cards
├── add/edit form
├── provider notice/error
└── navigation back to workspace
```

Required stable IDs:

```text
providers-page
providers-main-link
providers-add
providers-active
providers-list
providers-loading
providers-error
providers-notice
```

## Create `packages/web/src/providers/provider-cards.ts`

Move/adapt the existing dashboard card rendering.

```ts name=packages/web/src/providers/provider-cards.ts
export interface ProviderCardsProps {
  profiles: ProviderProfileView[];
  activeProfileId: string | null;
  testingProfileId?: string;
  deletingProfileId?: string;
  onEdit(profile: ProviderProfileView): void;
  onTest(profile: ProviderProfileView): void;
  onActivate(profile: ProviderProfileView): void;
  onDelete(profile: ProviderProfileView): void;
}
```

Each card must show:

- label;
- provider kind;
- model;
- base URL when applicable;
- masked key only;
- active state;
- last-test state;
- Use/Activate;
- Test;
- Edit;
- Delete.

Required selectors should preserve existing dashboard IDs where they already exist. Do not rename existing provider E2E selectors without updating tests deliberately.

## Create `packages/web/src/providers/provider-form.ts`

```ts name=packages/web/src/providers/provider-form.ts
export interface ProviderFormProps {
  form: ProviderFormState;
  onChange(field: ProviderFormField, value: string): void;
  onSubmit(): void;
  onCancel(): void;
}

export type ProviderFormField =
  | "label"
  | "kind"
  | "baseUrl"
  | "model"
  | "apiKey";
```

### Form rules

- API key input uses `type="password"`.
- API key autocomplete must be disabled or set to a safe value.
- The form must never render the raw key after a successful create/edit.
- Edit mode displays:
  ```text
  Leave blank to keep the existing key
  ```
- The current masked key is explanatory text, not an input value.
- Provider kind determines whether `baseUrl` is shown or required.
- Validation errors are associated with fields using `aria-describedby`.
- Submit is disabled while pending.
- Escape or Cancel closes the form only if no unsaved value exists; otherwise show a confirmation.

Required selectors:

```text
provider-form
provider-label
provider-kind
provider-base-url
provider-model
provider-api-key
provider-submit
provider-cancel
provider-field-error
```

## Create `packages/web/src/providers/active-provider-banner.ts`

Show:

```text
Currently using: <label> · <kind> · <model>
```

States:

- active profile exists;
- no active profile;
- loading;
- active profile unavailable after deletion.

Required selector:

```text
providers-active
```

---

# 7. Usage page

## Create `packages/web/src/usage/usage-page.ts`

Reuse the existing `usage()` API method and dashboard usage table.

```ts name=packages/web/src/usage/usage-page.ts
export interface UsagePageProps {
  state: UsageUiState;
  limit: number;
  onRefresh(): void;
}
```

Render:

- recent turn records;
- provider;
- model;
- status;
- timestamp;
- token counts;
- estimated cost when available;
- bounded-history notice when `bounded === true`;
- empty state;
- loading/error state.

Do not claim that usage is complete if the server reports bounded history.

Required selectors:

```text
usage-page
usage-refresh
usage-loading
usage-empty
usage-table
usage-bounded
usage-error
```

---

# 8. Settings pages

## Create `packages/web/src/settings/settings-shell.ts`

```ts name=packages/web/src/settings/settings-shell.ts
export interface SettingsShellProps {
  section: SettingsSection;
  onSelect(section: SettingsSection): void;
  content: HTMLElement;
}
```

Required navigation:

```text
Security
Storage
About
```

## Create `packages/web/src/settings/security-page.ts`

Display read-only information from `HealthSummary`:

- security mode;
- authentication behavior;
- project trust explanation;
- approval explanation;
- local versus remote access warning if available.

Do not add settings mutations in B2.

## Create `packages/web/src/settings/storage-page.ts`

Display:

- persistence mode;
- server data directory only when the API intentionally exposes it;
- desktop workspace catalog location as a user-facing description, not an arbitrary path browser;
- browser storage behavior;
- reset navigation metadata action.

The reset action must clear only the workspace catalog, not server sessions, provider profiles, or provider secrets.

For Electron, use a fixed preload method if a catalog reset is required. Do not expose arbitrary filesystem deletion.

## Create `packages/web/src/settings/about-page.ts`

Display:

- app version;
- desktop/browser mode;
- server persistence mode;
- runtime version where safely available;
- links to documentation and repository;
- diagnostic information without tokens.

---

# 9. Main application integration

## Modify `packages/web/src/main.ts`

The main coordinator remains responsible for:

- route changes;
- loading provider state;
- provider mutations;
- usage loading;
- workspace state;
- authentication;
- rendering;
- error handling.

Add route handling:

```ts name=packages/web/src/main.ts
function navigateTo(route: UiRoute): void {
  history.pushState({}, "", routePath(route));
  dispatch({ type: "route_changed", route });
  void loadRouteData(route);
}
```

### Route data loading

```text
workspace → existing B1 state
providers → listProviders()
usage → usage(limit)
settings → health() if not already loaded
```

Avoid duplicate requests:

- cache provider data while the route remains active;
- provide explicit Refresh;
- reload after mutations;
- invalidate provider state on sign-out.

### Browser versus desktop bootstrap

No change to the security boundary:

- desktop token remains supplied through the in-memory bootstrap;
- browser token remains fragment/session-storage based;
- provider form state is never persisted;
- workspace catalog remains separate from provider data.

---

# 10. Dashboard compatibility strategy

## Modify `packages/web/src/dashboard.ts`

Convert the dashboard entry point into a compatibility adapter:

```ts name=packages/web/src/dashboard.ts
import { loadToken } from "./api.js";
import { mountProviderCompatibilityPage } from "./providers/compatibility.js";

const token = loadToken();

mountProviderCompatibilityPage({
  token,
  mode: "dashboard",
});
```

## Create `packages/web/src/providers/compatibility.ts`

```ts name=packages/web/src/providers/compatibility.ts
export interface ProviderCompatibilityOptions {
  mode: "dashboard" | "workspace";
  token?: string | null;
}

export function mountProviderCompatibilityPage(
  options: ProviderCompatibilityOptions
): void;
```

The compatibility page should:

- reuse `provider-page.ts`;
- use the existing dashboard root;
- preserve `/dashboard` selectors;
- preserve the existing `/dashboard/dashboard.css`;
- retain the main UI link;
- retain the shared token behavior.

Do not make `/dashboard` depend on B1 workspace state. It must remain independently loadable.

---

# 11. CSS plan

## Modify `packages/web/public/app.css`

Add styles for:

- top-level route navigation;
- provider page;
- active provider banner;
- provider cards;
- provider form;
- usage page;
- settings shell;
- responsive provider controls;
- focus states;
- error and success notices.

Do not copy all of `dashboard.css` into `app.css` blindly. Extract shared design tokens where helpful.

## Modify `packages/web/public/dashboard.css`

Keep the compatibility dashboard visually stable.

Only make changes required for:

- shared provider component class names;
- existing dashboard E2E;
- accessibility fixes;
- responsive behavior.

The dashboard route should not become dependent on the three-column workspace CSS.

---

# 12. Tests

## Create `packages/web/test/provider-types.test.ts`

Test:

- required field validation;
- trimming;
- omitted optional base URL;
- blank edit API key omitted;
- masked API key never sent;
- raw API key not included in display model.

## Create `packages/web/test/ui-route.test.ts`

Test:

- pathname parsing;
- route generation;
- `/dashboard` compatibility;
- unknown paths fallback to workspace;
- token fragments are not treated as application routes.

## Create `packages/web/test/provider-form.test.ts`

Test:

- create fields;
- edit fields;
- masked key behavior;
- validation errors;
- submit/cancel callbacks;
- disabled pending state.

## Create `packages/web/test/provider-cards.test.ts`

Test:

- active card state;
- masked key rendering;
- test status rendering;
- callbacks;
- delete confirmation entry point.

## Create `packages/web/test/settings-pages.test.ts`

Test:

- settings navigation;
- no token rendering;
- storage reset only targets catalog state;
- security page is read-only.

## Extend existing API tests

Verify:

- provider methods continue sending bearer auth;
- update requests omit unchanged API keys;
- test/activate/delete paths remain unchanged;
- usage parsing handles `bounded` and `retained`.

---

# 13. Browser E2E tests

## Create `packages/web/e2e/providers-workspace.spec.ts`

Scenarios:

1. Authenticate and navigate from Workspace to Providers.
2. Load provider profiles.
3. Add a provider using the existing mock provider fixture.
4. Verify the API key is masked after creation.
5. Edit label/model while leaving the key blank.
6. Confirm the update request does not replace the key.
7. Test a provider and verify latency/status.
8. Activate a provider and verify the active banner.
9. Delete a non-active provider with confirmation.
10. Navigate to Usage and verify records render.
11. Navigate through Security, Storage, and About.
12. Return to Workspace and verify the active session/catalog is preserved.
13. Open `/dashboard` directly and verify the compatibility UI still works.
14. Verify provider secrets do not appear in:
    - URL;
    - localStorage;
    - workspace catalog;
    - rendered provider card text.

## Preserve existing dashboard E2E

Do not delete the existing dashboard tests. Adapt only their setup if selectors move into shared provider components.

The existing `/dashboard` tests remain a B2 completion gate.

---

# 14. Desktop verification

## Modify desktop integration only where required

The desktop renderer already provides the in-memory API bootstrap. B2 must verify:

- navigating to `/providers` preserves the same in-memory token;
- provider API requests remain authenticated;
- provider keys never enter Electron workspace catalog persistence;
- `/dashboard` works in the desktop window;
- returning to `/` preserves the B1 catalog and current application state where applicable.

## Add to `packages/desktop/e2e/desktop.spec.ts`

Scenarios:

1. Launch installed desktop app.
2. Load Workspace.
3. Navigate to Providers.
4. Load provider list.
5. Create or update the mock provider.
6. Confirm masked key behavior.
7. Navigate back to Workspace.
8. Confirm no token exists in:
   - URL;
   - workspace catalog file;
   - visible page text.
9. Quit cleanly.

Do not add a second token transport.

---

# 15. Documentation

## Create the B2 plan file

```text
docs/superpowers/plans/2026-09-21-b2-settings-provider-integration.md
```

Commit the plan separately before implementation.

## Modify `README.md`

Document:

- Workspace;
- Providers;
- Usage;
- Settings;
- `/dashboard` compatibility;
- browser and desktop behavior;
- provider key masking and storage boundary.

## Modify `docs/INSTALL.md`

Document:

- provider configuration;
- browser token behavior;
- desktop in-memory authentication;
- where provider profiles are persisted by the server;
- what the workspace catalog stores;
- how to reset navigation metadata without deleting provider profiles.

Do not document raw provider-key file paths unless the server explicitly guarantees them.

---

# 16. Implementation sequence

## B2.1 — Route and provider state foundation

Files:

```text
packages/web/src/ui-route.ts
packages/web/src/provider-types.ts
packages/web/src/app-state.ts
packages/web/src/main.ts
packages/web/test/ui-route.test.ts
packages/web/test/provider-types.test.ts
```

Acceptance:

- route changes work without a framework;
- workspace remains functional;
- provider state loads through existing API;
- no secrets are persisted.

## B2.2 — Provider page

Files:

```text
packages/web/src/providers/provider-page.ts
packages/web/src/providers/provider-cards.ts
packages/web/src/providers/provider-form.ts
packages/web/src/providers/active-provider-banner.ts
packages/web/src/provider-controller.ts
packages/web/test/provider-form.test.ts
packages/web/test/provider-cards.test.ts
```

Acceptance:

- add/edit/test/activate/delete workflows work;
- masked keys remain masked;
- validation and loading states are visible.

## B2.3 — Usage and settings

Files:

```text
packages/web/src/usage/usage-page.ts
packages/web/src/settings/settings-shell.ts
packages/web/src/settings/security-page.ts
packages/web/src/settings/storage-page.ts
packages/web/src/settings/about-page.ts
packages/web/test/settings-pages.test.ts
```

Acceptance:

- usage table works;
- bounded-history behavior is honest;
- settings are navigable;
- storage reset does not affect providers or sessions.

## B2.4 — Dashboard compatibility

Files:

```text
packages/web/src/dashboard.ts
packages/web/src/providers/compatibility.ts
packages/web/public/dashboard.css
packages/web/e2e/providers-workspace.spec.ts
```

Acceptance:

- `/dashboard` still loads directly;
- existing provider E2E remains green;
- dashboard and workspace share provider behavior without duplicate API logic.

## B2.5 — Desktop integration and final verification

Files:

```text
packages/desktop/e2e/desktop.spec.ts
packages/web/e2e/providers-workspace.spec.ts
README.md
docs/INSTALL.md
```

Acceptance:

- provider route works in the installed Electron app;
- token remains in memory;
- provider secrets never enter catalog persistence;
- browser and desktop flows both pass.

---

# B2 completion gate

B2 is complete only when:

- Providers are accessible from the main workspace.
- Add/edit/test/activate/delete workflows work.
- Provider keys are masked and never persisted by the UI.
- Usage is available in the main UI.
- Settings pages are available.
- `/dashboard` still works as a direct compatibility entry point.
- Browser fragment/session-storage authentication remains unchanged.
- Desktop in-memory bootstrap remains unchanged.
- B1 workspace catalog and active session behavior remain intact.
- No new server route was required.
- Existing browser, desktop, installer, smoke, and evaluation checks pass.
- New B2 unit and E2E tests pass.
- The B2 plan file is committed before implementation.

---

## Appendix — implementation notes from reading the current code (B2.0 planning)

Facts discovered in the tree that constrain the implementation above:

1. **The server create contract requires `id`.** `POST /api/providers` validates
   `id` against `[a-z0-9-]{1,64}` (`PROFILE_ID_RE` in
   `packages/server/src/provider-profiles.ts`). The plan's `CreateProviderInput`
   sketch omits it; the implementation adds `id: string` (the new profile's
   slug, bound to the form's `profileId` in create mode) so the existing
   provider API is preserved unchanged.
2. **`kind` is immutable on update.** The server rejects a PATCH containing
   `id` or `kind` ("id and kind are immutable"). `toUpdateProviderInput`
   therefore never emits `kind`, even though the type keeps it optional.
3. **The server refuses to delete the active profile** (`409 PROVIDER_ACTIVE`).
   The delete confirmation must warn when the target is active, and the 409
   must surface as a visible, non-secret notice.
4. **`apiKey` patch semantics:** omitted = keep, `""`/`null` = clear, string =
   set. B2's edit form uses blank = keep (no key is ever sent unless the user
   typed one), which matches the plan's "never send `apiKey` in an edit request
   unless the user explicitly replaced it".
5. **The server has no SPA history fallback.** Only `/` and `/dashboard` serve
   HTML. B2's routes are client-side (`history.pushState` + `popstate`): in-app
   navigation works everywhere; a hard reload of `/providers` is not served by
   the server in B2 and is documented as such (no new server route is added).
6. **Existing dashboard selectors.** The shared provider cards keep the
   dashboard's `dash-card*` / `dash-activate` / `dash-test` / `dash-edit` /
   `dash-delete` test ids so the existing dashboard E2E stays meaningful; the
   dashboard spec's *setup* (preset form) is adapted deliberately to the new
   shared form selectors (`provider-*`).
7. **Usage rows keep their ids.** `usage-page.ts` renders rows with the
   existing `dash-usage-row` / `dash-usage-provider` / `dash-usage-cost` ids
   inside the new `usage-table` section, so `/dashboard` compatibility tests
   and the new usage page share one component.
