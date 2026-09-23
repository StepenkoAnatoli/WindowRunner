/**
 * Workspace catalog persistence for the desktop main process (B1).
 *
 * The catalog shape, limits and validation are owned by
 * `@windows-runner/shared` — the exact same contract the browser enforces for
 * its localStorage copy. This module keeps only the main-process I/O: it
 * validates before every write and writes atomically (temp file + rename) to
 * the fixed catalog path below the per-user data directory — the renderer can
 * neither choose a path nor read arbitrary files.
 */

import * as fsp from "node:fs/promises";
import { validateWorkspaceCatalog, type WorkspaceCatalog } from "@windows-runner/shared";

export { emptyWorkspaceCatalog, validateWorkspaceCatalog } from "@windows-runner/shared";

export const WORKSPACE_CATALOG_FILE = "workspace-catalog.json";

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
