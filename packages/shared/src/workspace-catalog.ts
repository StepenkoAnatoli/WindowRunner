/**
 * Persisted workspace catalog — the shared core (B1).
 *
 * The sidebar's `{ project root, sessionId }` catalog is persisted by two
 * frontends: the browser UI (one `localStorage` key) and the Electron desktop
 * main process (one JSON file under the app's userData directory, written
 * atomically). Both must accept and reject exactly the same shapes, so the
 * types, limits and validation live here — single ownership — and each
 * frontend keeps only its own I/O adapter.
 *
 * Storage policy: this module owns navigation metadata only. It never
 * persists bearer tokens, API keys, tool inputs/outputs, transcript text,
 * filesystem snapshots, or provider configuration. `validateWorkspaceCatalog`
 * builds the persisted shape by picking known fields, so any token-like
 * unknown field is dropped rather than stored.
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

export const WORKSPACE_CATALOG_VERSION = 1 as const;
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

/**
 * Absolute-path check without `node:path` (this module also runs in browsers):
 * accepts POSIX absolute paths, Windows drive paths and UNC paths. Windows
 * drive-relative forms (`\foo`) are rejected as ambiguous.
 */
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
