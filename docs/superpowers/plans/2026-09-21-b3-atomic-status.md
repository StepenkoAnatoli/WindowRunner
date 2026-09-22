# B3 atomic checklist — phase status

> **CLOSING NOTE — 2026-09-22: B3 is merged and the post-merge checks are green.**
> PR #29 merged into `main` as `126f512` ("Merge pull request #29 from
> StepenkoAnatoli/arena/01a0c761-windowrunner"). Post-merge run
> [35700641678](https://github.com/StepenkoAnatoli/WindowRunner/actions/runs/35700641678)
> finished success on that merge commit: CI, Browser E2E, Docker, Platform
> windows-latest, Platform macos-latest, Desktop ubuntu-latest, Desktop
> windows-latest, and Desktop installer windows-latest. B4 is unblocked by
> that gate and has not been started here.

Durable progress record for B3 (release-quality UI and route hardening). Chat history is not durable — this file is.

Branch: `arena/01a0c761-windowrunner`
PR: https://github.com/StepenkoAnatoli/WindowRunner/pull/29
Base: `main` @ `8367e3a4941f48364a1a7244385138c484e9afbb`
Evidence head: `5a0ffc942c056abede3532fe1efe8d3ae8931a61`
Evidence run: https://github.com/StepenkoAnatoli/WindowRunner/actions/runs/35692202945
Status-commit head: `8b43c4689089ec428a2ae7d5b76f3e012fc342ac`
Status-commit run: https://github.com/StepenkoAnatoli/WindowRunner/actions/runs/35692629309

The eight checks were green on `5a0ffc9` and again on the status commit `8b43c46` (run 35692629309, completed success). This follow-up only records that finished run. It does not claim a result for the run this commit itself starts.

## Status

B3.0–B3.6 implemented and merged. PR #29 merged as `126f512`. Post-merge run 35700641678 is success on that commit. B4 has not started.

## Commits

```text
f19f65c docs(plan): define B3 release-quality UI work
1b3fc69 feat(server): serve the main app shell for deep client routes
eaf6069 test(server): cover deep-route fallback boundaries
730d142 test(web): cover deep-route refresh and navigation
db7dfb8 style(web): improve keyboard focus and responsive controls
1120808 test(web): cover accessibility-critical interactions
f59b123 style(web): harden responsive workspace and settings layouts
60742e9 test(desktop): verify deep routes and release navigation
8107de8 docs: describe deep-route refresh and release limits
9874c9c fix(web): keep narrow-width header controls above the rail overlays
049e989 test(web): reset rails between narrow-width checks
5a0ffc9 test(web): dismiss the narrow provider form from a focused field
```

## Files changed

Server allowlist and tests, root-absolute shell assets, desktop bootstrap republish, keyboard navigation, responsive CSS, browser and desktop e2e, CI inventory, README, INSTALL. Plan: `docs/superpowers/plans/2026-09-21-b3-release-quality-ui.md`.

## Behavior now verified

- GET/HEAD of `/providers`, `/usage`, `/settings/security`, `/settings/storage`, `/settings/about` return the static main shell. Trailing slash and case are folded. A query string is not reflected into the HTML.
- `/api/*` stays 401 without a bearer token. `/healthz` stays JSON. `/dashboard` stays the dashboard page. Unknown paths, `/settings` with no section, missing assets, and POST stay 404 and are not the shell.
- Browser deep-route load and reload stay on the page. The token is not in the URL. Returning to Workspace keeps the catalog.
- Desktop deep-route load and reload stay authenticated from the in-memory bootstrap. The token is not in the URL, web storage, or catalog JSON. Shutdown is exit 0 and the backend stops. CI ran this on Ubuntu and Windows Electron.
- Arrow keys move focus in the top nav, settings sections, and inspector tabs. Enter/Space activate. Provider action names include the profile label and not a key. Usage table has a caption and `scope="col"`.
- Widths 1440, 1280, 1100, 900, 800, and 640 do not scroll the page sideways. Cards are one column from 900px down. At 800 and below the rails overlay, and the header stays above them so the collapse toggles remain clickable.
- Installer path in README, INSTALL, and `electron-builder.yml` is `%LOCALAPPDATA%\Programs\WindowRunner`. The Desktop installer job installed, ran the journey, and uninstalled.

## Tests

| Check | Result |
| --- | --- |
| Local `npm run typecheck` | pass |
| Local `npm test` | pass (shared, server, web) |
| Local `npm run test:desktop` | pass (30) |
| Local `npm run build` | pass |
| Local `smoke:packed`, `smoke:start`, `smoke:packed:start` | pass |
| Local `npm run eval` | 5/5 pass |
| Local `npm run e2e` | not run — Playwright Chromium download failed (`cdn.playwright.dev` ECONNRESET) |
| Local `npm run e2e:desktop` | not run — Electron binary download failed |
| CI | pass on run 35692202945 |
| Browser E2E | pass on run 35692202945 |
| Docker | pass on run 35692202945 |
| Platform (windows-latest) | pass on run 35692202945 |
| Platform (macos-latest) | pass on run 35692202945 |
| Desktop (ubuntu-latest) | pass on run 35692202945 |
| Desktop (windows-latest) | pass on run 35692202945 |
| Desktop installer (windows-latest) | pass on run 35692202945 |

## Acceptance criteria

- B3.0 plan committed before implementation: pass (`f19f65c`).
- B3.1 allowlisted shell only: pass.
- B3.2 direct load, auth, refresh, token not in URL, back to Workspace with catalog: pass in Browser E2E.
- B3.3 keyboard and labels, no new a11y dependency: pass.
- B3.4 six widths, no horizontal page scroll, overlay collapse, one-column cards: pass.
- B3.5 desktop deep routes, catalog boundaries, installer path: pass in CI (not locally).
- B3.6 docs: pass.
- No provider model discovery: pass (not added).

## Security checks

- Shell HTML is `sendFile` of static `index.html`. No token or provider key is interpolated.
- Deep-route fallback is GET/HEAD and an allowlist. It does not answer `/api/*`.
- Browser token stays in `sessionStorage`, never written back into the URL on refresh.
- Desktop token is republished from the preload bridge into memory. `saveToken` stays a no-op while that bootstrap is set.
- Provider action accessible names do not include a raw or masked key.
- Catalog assertions reject token and provider-key fields.

## Deviations

- `packages/web/src/main.ts` could not be split cleanly across commits. The deep-route bootstrap landed in `1b3fc69`; keyboard wiring and in-flow notices landed in `db7dfb8`.
- `api.test.ts` and the index.html asset assertion shipped with the server feature commit, not a separate web test commit.
- Responsive e2e shipped with the CSS commit (`f59b123`). CI inventory for the new specs shipped with the desktop test commit (`60742e9`).
- CI on `8107de8` failed Browser E2E and both Desktop e2e jobs (installer skipped). Fixed in `9874c9c`, `049e989`, and `5a0ffc9`. Those failures were real: overlays covered the header toggles, and Escape does not reach the form handler unless focus is inside the form.
- Provider cards are one column from 900px, matching the plan. An earlier 800px rule lost the cascade to the base grid and was moved so it wins.

## Known gaps

- Refresh does not restore the live transcript. Reattach the session. The catalog survives.
- `/settings` with no section, unknown paths, and missing assets stay 404.
- No model discovery.
- A hard load of `/dashboard` in the desktop window still shows that page's own token form.
- This sandbox cannot run Playwright Chromium or Electron. CI is the evidence for those suites.
- Not merged. B4 must wait until PR #29 is merged and the eight checks are green on the merge commit.

## CI status

Run [35692202945](https://github.com/StepenkoAnatoli/WindowRunner/actions/runs/35692202945) on `5a0ffc9`: all eight checks success.
Run [35692629309](https://github.com/StepenkoAnatoli/WindowRunner/actions/runs/35692629309) on `8b43c46`: all eight checks success.
Run [35695575112](https://github.com/StepenkoAnatoli/WindowRunner/actions/runs/35695575112) on `202c72d`: all eight checks success. That was the PR tip that merged.
Run [35700641678](https://github.com/StepenkoAnatoli/WindowRunner/actions/runs/35700641678) on merge commit `126f512`: all eight checks success.

## Go / no-go

**B3 is complete.** PR #29 is merged and the merge commit is green. **B4 has not started.**
