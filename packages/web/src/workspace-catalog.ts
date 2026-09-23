/**
 * Persisted workspace catalog — browser/UI side (B1).
 *
 * The server API can create/reattach/delete a session, stream turns, cancel,
 * approve/deny, and inspect trust — but it has no session-list or
 * transcript-list endpoint. The B1 sidebar is therefore a *locally persisted
 * catalog* of `{ project root, sessionId }` pairs, not a server-backed
 * history browser. Selecting an entry reattaches through the normal
 * `createSession()` call; `SESSION_ALREADY_EXISTS` means the session is
 * still alive server-side.
 *
 * The catalog shape, limits and validation live in `@windows-runner/shared`
 * (single owner — the desktop main process validates the identical shape for
 * its file-backed store). This module keeps only what is UI-specific: the
 * inspector view state, the runtime stores, and client id generation.
 *
 * Runtime stores:
 * - browser: `localStorage` under `WORKSPACE_CATALOG_STORAGE_KEY`;
 * - Electron desktop: the fixed preload IPC methods (see
 *   `desktop-bridge.ts`), persisted by the main process under the app's
 *   userData directory — the renderer never chooses a path;
 * - tests: the in-memory store below.
 */

import {
  emptyWorkspaceCatalog,
  parseWorkspaceCatalogLenient,
  validateWorkspaceCatalog,
  sessionsForProject,
  sortedProjects,
  type SessionCatalogEntry,
  type WorkspaceCatalog,
} from "@windows-runner/shared";

// The shared core is the persistence contract; re-export it so UI modules
// keep one import surface for everything catalog-related.
export {
  MAX_CATALOG_PROJECTS,
  MAX_CATALOG_SESSIONS,
  emptyWorkspaceCatalog,
  parseWorkspaceCatalogLenient,
  sessionsForProject,
  sortedProjects,
  validateWorkspaceCatalog,
} from "@windows-runner/shared";
export type { ProjectCatalogEntry, SessionCatalogEntry, WorkspaceCatalog } from "@windows-runner/shared";

export const WORKSPACE_CATALOG_STORAGE_KEY = "windows-runner.workspace-catalog.v1";

export type InspectorTab = "approvals" | "activity" | "context" | "changes";

export type InspectorSelection =
  | { kind: "none" }
  | { kind: "turn"; turnId: string }
  | { kind: "tool"; turnId: string; callId: string }
  | { kind: "approval"; turnId: string; requestId: string };

export interface WorkspaceUiState {
  catalog: WorkspaceCatalog;
  selectedProjectId?: string;
  selectedSessionId?: string;
  inspectorTab: InspectorTab;
  inspectorSelection: InspectorSelection;
  sidebarOpen: boolean;
  inspectorOpen: boolean;
}

export const initialWorkspaceUiState: WorkspaceUiState = {
  catalog: { version: 1, projects: [], sessions: [] },
  inspectorTab: "context",
  inspectorSelection: { kind: "none" },
  sidebarOpen: true,
  inspectorOpen: true,
};

export interface WorkspaceCatalogStore {
  load(): Promise<WorkspaceCatalog>;
  save(catalog: WorkspaceCatalog): Promise<void>;
}

/** Test/SSR store: no persistence, but still validates on the way in and out. */
export function createInMemoryCatalogStore(initial: unknown = undefined): WorkspaceCatalogStore & { raw(): unknown } {
  let current: WorkspaceCatalog = initial === undefined ? emptyWorkspaceCatalog() : parseWorkspaceCatalogLenient(initial);
  return {
    raw: () => current,
    load: async () => parseWorkspaceCatalogLenient(current),
    save: async (catalog: WorkspaceCatalog) => {
      current = validateWorkspaceCatalog(catalog);
    },
  };
}

export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Browser store: one `localStorage` key, malformed data degrades to empty. */
export function createLocalStorageCatalogStore(storage: WebStorageLike): WorkspaceCatalogStore {
  return {
    load: async () => {
      const raw = storage.getItem(WORKSPACE_CATALOG_STORAGE_KEY);
      if (raw === null || raw === "") return emptyWorkspaceCatalog();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return emptyWorkspaceCatalog();
      }
      return parseWorkspaceCatalogLenient(parsed);
    },
    save: async (catalog: WorkspaceCatalog) => {
      const validated = validateWorkspaceCatalog(catalog);
      storage.setItem(WORKSPACE_CATALOG_STORAGE_KEY, JSON.stringify(validated));
    },
  };
}

/** Client-side id for catalog entries: `[A-Za-z0-9_-]`-safe, unique per call. */
export function newCatalogId(prefix: string): string {
  const rand = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.floor(Math.random() * 0xffff_ffff).toString(36);
  return `${prefix}-${Date.now().toString(36)}-${rand}`.replace(/[^A-Za-z0-9_-]/g, "");
}
