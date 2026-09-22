/**
 * Settings → Storage (B2): what is stored where, and the ONE action this page
 * offers — resetting the local navigation metadata (the workspace catalog).
 *
 * The reset clears ONLY the catalog of remembered {project, session} pairs on
 * this device. It never touches server sessions, provider profiles, provider
 * keys, or the bearer token. Persistence goes through the same catalog store
 * the app already uses (localStorage in the browser, the fixed preload IPC
 * pair in the desktop shell) — no arbitrary filesystem deletion exists.
 */
import type { HealthSummary } from "../api.js";
import { button, el } from "../dom.js";

export interface StoragePageProps {
  health?: HealthSummary;
  server?: { securityMode: string; persistenceMode: string };
  /** True inside the desktop shell (catalog persists via the preload bridge). */
  desktopAvailable: boolean;
  onResetNavigationMetadata(): void;
}

export function renderStoragePage(props: StoragePageProps): HTMLElement {
  const health = props.health;
  const persistenceMode = health?.persistence?.mode ?? props.server?.persistenceMode ?? "unknown";
  // The data directory is shown only when the server itself exposes it in its
  // health summary (file mode does; memory mode has none). It is display-only.
  const dataDir = health?.persistence?.dataDir;

  return el(
    "div",
    { class: "settings-section", "data-testid": "storage-page" },
    el("h3", {}, "Server storage"),
    el(
      "dl",
      { class: "context-list" },
      el("dt", {}, "Persistence mode"),
      el("dd", { "data-testid": "storage-persistence" }, persistenceMode),
      dataDir ? el("dt", {}, "Server data directory") : null,
      dataDir ? el("dd", {}, el("code", { "data-testid": "storage-data-dir" }, dataDir)) : null,
      el("dt", {}, "Provider profiles"),
      el("dd", {}, "Saved by the server (with keys stored only there and always shown masked here). Deleting a profile here deletes its server-side record; this page has no provider data of its own."),
      el("dt", {}, "Sessions & turns"),
      el("dd", {}, persistenceMode === "file" ? "Persisted by the server in its data directory." : "Held in server memory only; they end with the process.")
    ),
    el("h3", {}, "This device"),
    el(
      "dl",
      { class: "context-list" },
      el("dt", {}, "Remembered projects & sessions"),
      el(
        "dd",
        {},
        props.desktopAvailable
          ? "A small navigation catalog (project folders and session ids you opened) saved by the desktop app in its own application data — navigation metadata only, never transcripts, tokens, or keys."
          : "A small navigation catalog (project folders and session ids you opened) kept in this browser's localStorage under one key — navigation metadata only, never transcripts, tokens, or keys."
      ),
      el("dt", {}, "Sign-in token"),
      el(
        "dd",
        {},
        props.desktopAvailable
          ? "Held in the desktop app's memory only, including after a refresh of Workspace, Providers, Usage, or Settings; nothing is written to disk, the URL, or web storage."
          : "Held in this tab's sessionStorage only; a refresh reuses it and it is never written to the URL or localStorage. It dies with the tab."
      )
    ),
    el("h3", {}, "Reset navigation metadata"),
    el(
      "p",
      { class: "hint" },
      "Forgets the remembered projects and sessions on this device. Server sessions, provider profiles, and provider keys are NOT touched — the sidebar simply starts empty."
    ),
    button("reset-workspace-catalog", "Forget remembered projects & sessions", props.onResetNavigationMetadata, "danger")
  );
}
