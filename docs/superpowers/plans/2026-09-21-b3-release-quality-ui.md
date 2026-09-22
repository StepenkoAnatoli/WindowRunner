# B3 plan — Release-quality UI and route hardening

Date: 2026-09-22
Branch: `arena/01a0c761-windowrunner`
Base: `main` @ `8367e3a4941f48364a1a7244385138c484e9afbb`

B3 makes the B1/B2 product reliable for normal use: deep links survive refresh, the server actually serves those routes, layouts stay usable, keyboard access is real, and the browser and Electron shells agree. **No provider model discovery** (that is B4, and it does not start until B3 is merged and green).

## B3.0 baseline (recorded before implementation)

| Item | Value |
| --- | --- |
| Current main commit | `8367e3a4941f48364a1a7244385138c484e9afbb` (merge of PR #28) |
| B2 atomic gap-fill | COMPLETE. PR #27 merged as `0d0ae66`; PR #28 marked the checklist complete. Status file: `docs/superpowers/plans/2026-09-21-b2-atomic-status.md` |
| Eight CI checks on that commit | All success on run [35647669775](https://github.com/StepenkoAnatoli/WindowRunner/actions/runs/35647669775): CI, Browser E2E, Docker, Platform (windows-latest), Platform (macos-latest), Desktop (ubuntu-latest), Desktop (windows-latest), Desktop installer (windows-latest) |
| Deep-route behavior before B3 | Client `history.pushState` reaches `/providers`, `/usage`, `/settings/security`, `/settings/storage`, `/settings/about`. A hard load does not: `packages/server/src/app.ts` serves HTML only at `/` (static `index.html`), `/dashboard`, and `/desktop`. `GET /providers` is Express's default 404. `packages/web/public/index.html` references `./app.css` and `./app.js`, which would resolve under `/providers/` even if the shell were returned. |
| Installer path | `npm run package:desktop:win` → `packages/desktop/release/WindowRunner-Setup-<version>.exe`. Per-user NSIS install at `%LOCALAPPDATA%\Programs\WindowRunner` (`packages/desktop/electron-builder.yml`). Documented in `README.md` and `docs/INSTALL.md`. CI job `Desktop installer (windows-latest)` installs, runs both desktop specs, uninstalls. |
| Accessibility coverage before B3 | `packages/web/e2e/accessibility.spec.ts` (7 tests): named top nav, focus-visible outline, provider form labels and `aria-describedby` errors, masked-key explanation, card button names, native delete confirm copy, settings `aria-current` + Enter, no horizontal overflow at 360 and 720, dashboard token field. No accessibility dependency. Inspector tabs already use `role="tab"` and `aria-selected`. Settings sections stay page nav (`aria-current="page"`), not tabs. |
| Browser / Electron differences before B3 | Browser token: `#token=` fragment, then `sessionStorage` (`windows-runner.token`). Desktop token: preload `getBootstrap()`, published as `__WINDOWS_RUNNER_BOOTSTRAP__` only by `packages/desktop/src/renderer.ts` on the `/desktop` document. `loadToken()` prefers that global and then refuses to write storage. A refresh of a pushState deep route leaves `/desktop`, so the global is gone and a naive shell would show the token form (and a re-typed token would be written to `sessionStorage`). `/dashboard` hard load in the desktop window still shows its own token form; that is intentional and covered by `providers.spec.ts`. Catalog: `localStorage` in the browser, preload IPC file in Electron. Transcripts are not restored on reload (B1). |

## Non-goals

- No `POST /api/providers/discover-models`, no model list UI, no provider probing.
- No new provider kinds, no key persistence in the browser or workspace catalog.
- No catch-all SPA fallback. Unknown paths and missing assets stay 404.
- No server change to `/api/*`, `/healthz`, `/dashboard`, or `/desktop`.
- No transcript recovery. Refresh keeps the navigation catalog, not the live turn view.

## B3.1 — Server deep-route fallback

Confirmed mount point: `packages/server/src/app.ts`, inside the `webDir` block, **before** `express.static`, and **after** the `/dashboard` and `/desktop` mounts.

Allowlist (GET and HEAD only, trailing slash and case folded):

```text
/providers
/usage
/settings/security
/settings/storage
/settings/about
```

Response is `sendFile(webDir/index.html)` with the same UI security headers as `/` (`no-store`, nosniff, CSP, no token interpolation). The file is static, so the HTML cannot contain a bearer token or a provider key.

Companion change in `packages/web/public/index.html`: root-absolute `/app.css` and `/app.js`. Relative `./` URLs break when the document URL is `/providers`.

Companion change in `packages/web/src/main.ts`: if `window.windowRunnerDesktop.getBootstrap()` returns a token and the in-memory global is not set yet, publish it before `loadToken()`. That keeps a desktop refresh of a deep route on the in-memory token path (`saveToken` stays a no-op). Do not do this from `dashboard.ts` — a hard load of `/dashboard` keeps its own token form.

`packages/web/src/ui-route.ts` already parses these paths. Update its comment so it no longer claims the server refuses them.

Tests in `packages/server/test/web-ui.test.ts`:

- `/` still returns the main app shell.
- Each allowlisted route returns that same shell (200, `text/html`, shell marker, not the auth token).
- A query string is not reflected into the HTML.
- `/dashboard` still returns dashboard HTML when `dashboardDir` is set.
- `/api/*` is still 401 without a bearer token and is never the shell.
- `/healthz` stays JSON liveness.
- Missing assets, unknown paths, `/settings` without a section, and `POST /providers` are 404 and are not the shell.
- Without `webDir`, deep routes are 404.

## B3.2 — Browser route E2E

`packages/web/e2e/deep-routes.spec.ts` against the existing providers fixture (`PROVIDERS_PORT`).

For `/providers`, `/usage`, `/settings/security`, `/settings/storage`, `/settings/about`:

- open the route directly with the existing sessionStorage token;
- the matching page is visible and the pathname is the route;
- the token is not in the URL;
- reload; the page is still that route; the token is still not in the URL;
- return to Workspace; a catalog seeded in `localStorage` is still listed (project and session metadata). Transcripts are not asserted — B1 does not restore them.

CI inventory (`.github/workflows/ci.yml`) must require this spec so coverage cannot shrink silently.

## B3.3 — Accessibility and keyboard navigation

No new accessibility dependency.

- Keep `:focus-visible` outlines. Extend them to any primary control still missing one.
- Composer textarea and the project-folder input sit in real `<label>`s.
- Provider card actions get accessible names that include the profile label and never a raw or masked key.
- Inspector tablist: arrow keys move focus; Enter/Space still activate (native button). `aria-selected` stays. Settings sections stay `aria-current="page"` (they change the URL; they are not a tabpanel). Do not break the B2 settings contract.
- Top nav: arrow keys move focus; Enter activates.
- Usage table: caption plus `scope="col"` headers.
- Notices stay non-modal (no focus trap, not `aria-modal`). Page-level errors sit in document flow under the header, not a sticky bar over the composer.
- Escape: provider form cancels (existing); native `confirm()` is dismissed by the platform (existing test). Document both. Notices do not swallow Escape.

Tests: unit coverage for arrow-key focus movement; extend `accessibility.spec.ts` for labels, inspector/settings/provider keyboard, and the usage table.

## B3.4 — Responsive and visual hardening

`packages/web/public/app.css` (dashboard.css only where the shared usage table needs the same rule).

- Header and `.row` wrap.
- Grid children use `min-width: 0`; long tokens wrap.
- Provider cards are one column at 900px and below (covers 800 and 640).
- Existing 800px overlay collapse for sidebar and inspector stays.
- Error banners are not sticky.
- Streaming cursor honors `prefers-reduced-motion` (the only animation).

`packages/web/e2e/responsive.spec.ts` checks no horizontal overflow at 1440×900, 1280×800, 1100×800, 900×800, 800×800, and 640×800 on Workspace, Providers, Usage, and Settings. At 800 and 640 it also checks overlay collapse, one-column cards, and a usable provider form (add button and inputs visible). The desktop shell loads this same `app.css`.

## B3.5 — Electron and installer verification

`packages/desktop/e2e/deep-routes.spec.ts` (own app lifecycle, like `providers.spec.ts`):

- direct `/providers`, `/usage`, `/settings/security` in the Electron window;
- reload equivalent (`page.reload`);
- provider page and form open;
- workspace catalog still only project/session metadata after navigation;
- token absent from URL, web storage, and catalog JSON;
- clean shutdown (exit 0, backend stops).

`packages/desktop/test/packaging.test.ts` pins that README, INSTALL, and `electron-builder.yml` agree on `%LOCALAPPDATA%\Programs\WindowRunner`.

Desktop CI inventory includes the new spec. Electron itself is CI-only in this sandbox.

## B3.6 — Documentation

Update `README.md` and `docs/INSTALL.md`:

- deep-route refresh is supported for the allowlist (unknown paths still 404);
- Workspace / Providers / Usage / Settings;
- `/dashboard` compatibility unchanged;
- browser vs desktop token behavior, including deep-route refresh in the desktop window;
- catalog boundaries and the fact that refresh does not restore transcripts;
- provider-key handling (unchanged: server-side, masked, never in the catalog);
- installer path;
- Escape / confirmation behavior;
- known limitations (no model discovery, no catch-all fallback, no transcript restore).

Durable phase status: `docs/superpowers/plans/2026-09-21-b3-atomic-status.md`.

## Gate

B3 is complete only when B3.6 is PASS / GO and these checks are green:

```text
CI
Browser E2E
Docker
Platform (windows-latest)
Platform (macos-latest)
Desktop (ubuntu-latest)
Desktop (windows-latest)
Desktop installer (windows-latest)
```

Local suite, where the sandbox can run it:

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

`e2e:desktop` needs a real Electron binary. If the sandbox cannot download it, CI is the evidence — say so, do not claim a local Electron run.
