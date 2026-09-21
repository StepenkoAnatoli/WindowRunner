/**
 * Desktop renderer entry — served by the WindowRunner server at `/desktop`.
 *
 * The page runs in the server's own HTTP origin (the Electron window loads
 * `http://127.0.0.1:<port>/desktop`), so every API and SSE call it makes is
 * same-origin and the server's Origin policy is unchanged. Its jobs (A1):
 *
 *  1. Read the in-memory bootstrap (baseUrl + token) from the preload bridge.
 *     The token is published to a single in-memory global that the web API
 *     client's token helpers prefer over URL fragments and sessionStorage.
 *     It is never written to the URL, storage, or logs.
 *  2. Mount the existing web application bundle (`/app/app.js`, same origin),
 *     so the proven session UI is reused unchanged.
 *  3. Surface startup failures in the shell's error container.
 *
 * Without the bridge (plain browser open of `/desktop`) the web app falls
 * back to its usual fragment/sessionStorage token flow.
 */

interface HostBootstrap {
  baseUrl: string;
  token: string;
}

interface DesktopHost {
  getBootstrap(): HostBootstrap;
}

/** Must match `BOOTSTRAP_GLOBAL` in packages/web/src/api.ts. */
const BOOTSTRAP_GLOBAL = "__WINDOWS_RUNNER_BOOTSTRAP__";

function host(): DesktopHost | undefined {
  const candidate = (window as unknown as { windowRunnerDesktop?: DesktopHost }).windowRunnerDesktop;
  return candidate && typeof candidate.getBootstrap === "function" ? candidate : undefined;
}

function publishBootstrap(): void {
  const bridge = host();
  if (!bridge) return;
  const bootstrap = bridge.getBootstrap();
  if (
    !bootstrap ||
    typeof bootstrap.baseUrl !== "string" ||
    typeof bootstrap.token !== "string" ||
    bootstrap.token.length === 0
  ) {
    throw new Error("desktop bootstrap is malformed");
  }
  (globalThis as Record<string, unknown>)[BOOTSTRAP_GLOBAL] = {
    baseUrl: bootstrap.baseUrl,
    token: bootstrap.token,
  };
}

/** Indirection keeps the app entry a runtime URL import (never bundled in). */
function loadAppEntry(entry: string): Promise<unknown> {
  return import(entry);
}

async function start(): Promise<void> {
  const loading = document.getElementById("desktop-loading");
  const errorBox = document.getElementById("desktop-error");
  try {
    publishBootstrap();
    await loadAppEntry("/app.js");
    if (loading) loading.hidden = true;
  } catch (err) {
    if (loading) loading.hidden = true;
    if (errorBox) {
      errorBox.hidden = false;
      const message = err instanceof Error ? err.message : String(err);
      errorBox.textContent = `WindowRunner failed to start: ${message}`;
    }
  }
}

void start();
