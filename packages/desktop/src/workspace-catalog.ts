/**
 * Workspace catalog persistence for the desktop main process (B1).
 *
 * Mirrors the validation in `packages/web/src/workspace-catalog.ts` (kept as
 * a small self-contained copy so the main process never imports web
 * sources): the persisted shape is built by picking known fields, so any
 * token-like unknown field is dropped rather than stored. The main process
 * validates before every write and writes atomically (temp file + rename)
 * to the fixed catalog path below the per-user data directory — the
 * renderer can neither choose a path nor read arbitrary files.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";

export interface ProjectCatalogEntry {
  id: string;
  root: string;
  label: string;
  lastOpenedAt: number;
}

export interface SessionCatalogEntry {
  sessionId: string;
  projectId: string;
  lastOpenedAt: number;
}

export interface WorkspaceCatalog {
  version: 1;
  projects: ProjectCatalogEntry[];
  sessions: SessionCatalogEntry[];
}

export const WORKSPACE_CATALOG_VERSION = 1 as const;
export const WORKSPACE_CATALOG_FILE = "workspace-catalog.json";
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

function basenameOf(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || root;
}

function asTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * Strictly validate an untrusted value into the persisted catalog shape.
 * Throws on malformed data (the IPC handler turns that into a rejected
 * `invoke`, never a partial write); unknown fields are stripped.
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
    if (!isNonEmptyString(raw.root, MAX_ROOT_LENGTH) || !path.isAbsolute(raw.root)) {
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
    if (!seenProjectIds.has(raw.projectId)) continue;
    sessions.push({ sessionId: raw.sessionId, projectId: raw.projectId, lastOpenedAt: asTimestamp(raw.lastOpenedAt) });
  }

  const byRecency = (a: { lastOpenedAt: number }, b: { lastOpenedAt: number }) => b.lastOpenedAt - a.lastOpenedAt;
  projects.sort(byRecency);
  sessions.sort(byRecency);
  return {
    version: WORKSPACE_CATALOG_VERSION,
    projects: projects.slice(0, MAX_CATALOG_PROJECTS),
    sessions: sessions.slice(0, MAX_CATALOG_SESSIONS),
  };
}

/** Load-path parse: missing or malformed files become `null`, never a crash. */
export async function loadWorkspaceCatalogFile(filePath: string): Promise<WorkspaceCatalog | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  try {
    return validateWorkspaceCatalog(parsed);
  } catch {
    return null;
  }
}

/**
 * Validate and atomically persist the catalog (temp file in the same
 * directory + rename). Validation failures throw before anything is
 * written; a crash mid-write leaves either the old file or the new one.
 */
export async function saveWorkspaceCatalogFile(filePath: string, catalog: unknown): Promise<void> {
  const validated = validateWorkspaceCatalog(catalog);
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(validated), "utf8");
  await fsp.rename(tmp, filePath);
}
