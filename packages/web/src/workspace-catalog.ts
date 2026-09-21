/**
 * Persisted workspace catalog (B1).
 *
 * The server API can create/reattach/delete a session, stream turns, cancel,
 * approve/deny, and inspect trust — but it has no session-list or
 * transcript-list endpoint. The B1 sidebar is therefore a *locally persisted
 * catalog* of `{ project root, sessionId }` pairs, not a server-backed
 * history browser. Selecting an entry reattaches through the normal
 * `createSession()` call; `SESSION_ALREADY_EXISTS` means the session is
 * still alive server-side.
 *
 * Storage policy: this module owns navigation metadata only. It never
 * persists bearer tokens, API keys, tool inputs/outputs, transcript text,
 * filesystem snapshots, or provider configuration. `validateWorkspaceCatalog`
 * builds the persisted shape by picking known fields, so any token-like
 * unknown field is dropped rather than stored.
 *
 * Runtime stores:
 * - browser: `localStorage` under `WORKSPACE_CATALOG_STORAGE_KEY`;
 * - Electron desktop: the fixed preload IPC methods (see
 *   `desktop-bridge.ts`), persisted by the main process under the app's
 *   userData directory — the renderer never chooses a path;
 * - tests: the in-memory store below.
 */

export interface ProjectCatalogEntry {
  /** Stable client-generated id; never derived from an untrusted path directly. */
  id: string;
  /** Absolute project root selected by the user. No secrets, keys, or file contents. */
  root: string;
  /** Display-only basename or user label. */
  label: string;
  /** `Date.now()` of the last open/attach; drives most-recent-first ordering. */
  lastOpenedAt: number;
}

export interface SessionCatalogEntry {
  /** Server session id (client-generated, `[A-Za-z0-9_-]{1,128}`). */
  sessionId: string;
  /** Owning project entry id. A session always belongs to exactly one project. */
  projectId: string;
  /** `Date.now()` of the last attach; drives most-recent-first ordering. */
  lastOpenedAt: number;
}

export interface WorkspaceCatalog {
  version: 1;
  projects: ProjectCatalogEntry[];
  sessions: SessionCatalogEntry[];
}

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

export const WORKSPACE_CATALOG_VERSION = 1 as const;
export const WORKSPACE_CATALOG_STORAGE_KEY = "windows-runner.workspace-catalog.v1";
/** Caps keep a hand-edited file from growing the sidebar without bound. */
export const MAX_CATALOG_PROJECTS = 50;
export const MAX_CATALOG_SESSIONS = 200;
const MAX_ID_LENGTH = 128;
const MAX_ROOT_LENGTH = 4096;
const MAX_LABEL_LENGTH = 256;

export function emptyWorkspaceCatalog(): WorkspaceCatalog {
  return { version: WORKSPACE_CATALOG_VERSION, projects: [], sessions: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !value.includes("\0");
}

/** Absolute-path check without `node:path` (this module also runs in browsers). */
function isAbsolutePath(value: string): boolean {
  if (value.startsWith("/")) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (value.startsWith("\\\\")) return true;
  return false;
}

function basenameOf(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || root;
}

function asTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function byRecency(a: { lastOpenedAt: number }, b: { lastOpenedAt: number }): number {
  return b.lastOpenedAt - a.lastOpenedAt;
}

/**
 * Strictly validate an untrusted value into the persisted catalog shape.
 * Throws on malformed top-level data or malformed entries; unknown fields
 * (including any token/key-like stragglers) are stripped by construction.
 * Callers on the *load* path must catch and fall back to
 * `emptyWorkspaceCatalog()`; callers on the *save* path (notably the desktop
 * main process) must let the throw reject the write.
 */
export function validateWorkspaceCatalog(value: unknown): WorkspaceCatalog {
  if (!isRecord(value)) throw new Error("workspace catalog must be an object");
  if (value.version !== WORKSPACE_CATALOG_VERSION) throw new Error(`workspace catalog version must be ${WORKSPACE_CATALOG_VERSION}`);
  if (!Array.isArray(value.projects)) throw new Error("workspace catalog projects must be an array");
  if (!Array.isArray(value.sessions)) throw new Error("workspace catalog sessions must be an array");

  const projects: ProjectCatalogEntry[] = [];
  const seenProjectIds = new Set<string>();
  for (const raw of value.projects) {
    if (!isRecord(raw)) throw new Error("workspace catalog project must be an object");
    if (!isNonEmptyString(raw.id, MAX_ID_LENGTH)) throw new Error("workspace catalog project id is invalid");
    if (!isNonEmptyString(raw.root, MAX_ROOT_LENGTH) || !isAbsolutePath(raw.root)) {
      throw new Error("workspace catalog project root must be an absolute path");
    }
    if (seenProjectIds.has(raw.id)) continue;
    seenProjectIds.add(raw.id);
    const label = isNonEmptyString(raw.label, MAX_LABEL_LENGTH) ? raw.label : basenameOf(raw.root);
    projects.push({ id: raw.id, root: raw.root, label, lastOpenedAt: asTimestamp(raw.lastOpenedAt) });
  }

  const sessions: SessionCatalogEntry[] = [];
  const seenSessionIds = new Set<string>();
  for (const raw of value.sessions) {
    if (!isRecord(raw)) throw new Error("workspace catalog session must be an object");
    if (!isNonEmptyString(raw.sessionId, MAX_ID_LENGTH)) throw new Error("workspace catalog session id is invalid");
    if (!isNonEmptyString(raw.projectId, MAX_ID_LENGTH)) throw new Error("workspace catalog session project is invalid");
    if (seenSessionIds.has(raw.sessionId)) continue;
    seenSessionIds.add(raw.sessionId);
    // Orphaned sessions (no matching project) carry no meaning; drop them.
    if (!seenProjectIds.has(raw.projectId)) continue;
    sessions.push({ sessionId: raw.sessionId, projectId: raw.projectId, lastOpenedAt: asTimestamp(raw.lastOpenedAt) });
  }

  projects.sort(byRecency);
  sessions.sort(byRecency);
  return {
    version: WORKSPACE_CATALOG_VERSION,
    projects: projects.slice(0, MAX_CATALOG_PROJECTS),
    sessions: sessions.slice(0, MAX_CATALOG_SESSIONS),
  };
}

/** Lenient load-path parse: malformed data becomes an empty catalog, never a crash. */
export function parseWorkspaceCatalogLenient(value: unknown): WorkspaceCatalog {
  try {
    return validateWorkspaceCatalog(value);
  } catch {
    return emptyWorkspaceCatalog();
  }
}

/** Most-recent-first projects; the catalog is already sorted, this is a view helper. */
export function sortedProjects(catalog: WorkspaceCatalog): ProjectCatalogEntry[] {
  return [...catalog.projects].sort(byRecency);
}

/** Most-recent-first sessions scoped to one project. */
export function sessionsForProject(catalog: WorkspaceCatalog, projectId: string): SessionCatalogEntry[] {
  return catalog.sessions.filter((s) => s.projectId === projectId).sort(byRecency);
}

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
