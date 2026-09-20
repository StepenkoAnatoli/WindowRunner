# @windows-runner/web

The smallest functional browser client for the windows-runner server.

- `src/api.ts` — `ApiClient`: bearer token on every request; SSE is read via
  `fetch` streaming (not `EventSource`, which cannot send headers); `streamTurn`
  reconnects with `Last-Event-ID` and bounded backoff. Token comes from the
  `#token=` URL fragment (memory-mode banner) or the form and lives in
  `sessionStorage`; it is removed from the URL immediately.
- `src/app-state.ts` — pure UI reducer on top of the shared `reduceTurnState`.
- `src/main.ts` — vanilla DOM UI. Every interactive element has a `data-testid`.
- `scripts/bundle.mjs` — esbuild → `dist/app/{index.html,app.js,app.css}`, which
  the server serves at `/` (`resolveWebDir` in `packages/server/src/boot.ts`).

## Tests

- `npm test` — unit tests (`test/*.test.ts`, node:test).
- `npm run e2e` — Playwright browser suite (`e2e/ui.spec.ts`). `playwright.config.ts`
  starts `e2e/server.ts`: the real server in memory mode with a fixed token and a
  scripted provider (`approve: …`, `trust: …`, `hang`, `fail`, `slow: …`) plus two
  fixture tools, behind a tiny proxy whose `POST /__e2e/cut-next-events` severs the
  next SSE response to exercise reconnect. First run `npm run e2e:install`
  (downloads Chromium). Needs `npm run build` at the repo root first.
