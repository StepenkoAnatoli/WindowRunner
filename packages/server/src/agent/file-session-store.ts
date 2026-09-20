import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { ProjectRoot } from "../project-root.js";

export interface SessionMetaV1 {
  version: 1;
  sessionId: string;
  canonicalRoot: string;
  realRoot: string;
  createdAt: number;
  lastActivityAt: number;
  activeTurnId: string | null;
  allowedRootsSnapshot?: string[];
}

export interface FileSessionStoreOptions {
  dataDir: string;
}

export interface SessionBootDiagnostics {
  sessionsLoaded: number;
  sessionsSkipped: number;
  sessionsWithClearedActiveTurn: number;
  warnings: string[];
  skippedSessions: { sessionId: string; reason: string }[];
}

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

/**
 * FileSessionStore — C Hybrid implementation
 *
 * Layout: dataDir/sessions/<sessionId>/meta.json
 * Atomic write via temp file + rename
 * Security: persisted canonicalRoot/realRoot informational only, must re-validate against current allowedRoots via ProjectRoot.create on boot, never override
 */
export class FileSessionStore {
  private dataDir: string;

  constructor(opts: FileSessionStoreOptions) {
    this.dataDir = path.resolve(opts.dataDir);
  }

  private getSessionDir(sessionId: string): string {
    return path.join(this.dataDir, "sessions", sessionId);
  }

  private getMetaPath(sessionId: string): string {
    return path.join(this.getSessionDir(sessionId), "meta.json");
  }

  async save(meta: SessionMetaV1): Promise<void> {
    if (!isValidSessionId(meta.sessionId)) {
      throw new Error(`Invalid sessionId: ${meta.sessionId}`);
    }

    const dir = this.getSessionDir(meta.sessionId);
    await fs.mkdir(dir, { recursive: true });

    const metaPath = this.getMetaPath(meta.sessionId);
    const tmpPath = `${metaPath}.tmp.${Date.now()}.${randomBytes(4).toString("hex")}`;

    const content = JSON.stringify(meta, null, 2);

    await fs.writeFile(tmpPath, content, "utf8");
    await fs.rename(tmpPath, metaPath);
  }

  async load(sessionId: string): Promise<SessionMetaV1 | null> {
    if (!isValidSessionId(sessionId)) return null;

    const metaPath = this.getMetaPath(sessionId);
    try {
      const content = await fs.readFile(metaPath, "utf8");
      const parsed = JSON.parse(content);

      // Version handling: if missing, assume 1
      if (!parsed.version) parsed.version = 1;

      // Basic validation
      if (parsed.version !== 1) {
        console.warn(`Unsupported session meta version ${parsed.version} for ${sessionId}, skipping`);
        return null;
      }
      if (parsed.sessionId !== sessionId) {
        console.warn(`SessionId mismatch in meta: file dir ${sessionId} vs meta ${parsed.sessionId}, skipping`);
        return null;
      }
      if (typeof parsed.canonicalRoot !== "string" || !parsed.canonicalRoot) return null;
      if (typeof parsed.realRoot !== "string" || !parsed.realRoot) return null;
      if (typeof parsed.createdAt !== "number" || parsed.createdAt <= 0) return null;
      if (typeof parsed.lastActivityAt !== "number" || parsed.lastActivityAt <= 0) return null;
      if (parsed.activeTurnId !== null && typeof parsed.activeTurnId !== "string") return null;

      return parsed as SessionMetaV1;
    } catch (err: any) {
      if (err.code === "ENOENT") return null;
      console.warn(`Failed to load session meta for ${sessionId}:`, err);
      return null;
    }
  }

  async list(): Promise<SessionMetaV1[]> {
    const sessionsDir = path.join(this.dataDir, "sessions");
    const result: SessionMetaV1[] = [];

    try {
      const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!isValidSessionId(entry.name)) continue;
        const meta = await this.load(entry.name);
        if (meta) result.push(meta);
      }
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        console.warn(`Failed to list sessions:`, err);
      }
    }

    return result;
  }

  async delete(sessionId: string): Promise<boolean> {
    if (!isValidSessionId(sessionId)) return false;

    const dir = this.getSessionDir(sessionId);
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Boot recovery:
   * - List all session metas
   * - For each, re-validate canonicalRoot via ProjectRoot.create with currentAllowedRoots
   * - If fails, skip session (security: never override allowedRoots)
   * - Clear activeTurnId (transient)
   * - Persist updated meta
   * - Return diagnostics
   */
  async boot(currentAllowedRoots: string[], now: () => number = () => Date.now()): Promise<SessionBootDiagnostics> {
    const diagnostics: SessionBootDiagnostics = {
      sessionsLoaded: 0,
      sessionsSkipped: 0,
      sessionsWithClearedActiveTurn: 0,
      warnings: [],
      skippedSessions: [],
    };

    const sessionsDir = path.join(this.dataDir, "sessions");
    let entries: any[] = [];
    try {
      entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return diagnostics;
      }
      throw err;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!isValidSessionId(entry.name)) continue;

      const sessionId = entry.name;
      const meta = await this.load(sessionId);
      if (!meta) {
        diagnostics.sessionsSkipped++;
        diagnostics.warnings.push(`Failed to load meta for ${sessionId}, skipping`);
        diagnostics.skippedSessions.push({ sessionId, reason: "load failed or invalid" });
        continue;
      }

      // Re-validate canonicalRoot against currentAllowedRoots — security critical
      try {
        const projectRoot = await ProjectRoot.create(meta.canonicalRoot, currentAllowedRoots);
        // Compare realRoot with validated realRoot, warn if mismatch but use validated
        if (projectRoot.realRoot !== meta.realRoot) {
          diagnostics.warnings.push(`RealRoot mismatch for ${sessionId}: persisted ${meta.realRoot} vs validated ${projectRoot.realRoot}, using validated`);
        }
        // Update meta with validated roots? Keep canonical but ensure realRoot is validated one
        // For security, we use validated canonical and real
        const updatedMeta: SessionMetaV1 = {
          ...meta,
          canonicalRoot: projectRoot.canonicalRoot,
          realRoot: projectRoot.realRoot,
          activeTurnId: null, // clear transient
          lastActivityAt: now(),
        };

        if (meta.activeTurnId !== null) {
          diagnostics.sessionsWithClearedActiveTurn++;
          diagnostics.warnings.push(`Cleared activeTurnId ${meta.activeTurnId} for session ${sessionId} on boot`);
        }

        await this.save(updatedMeta);
        diagnostics.sessionsLoaded++;
      } catch (err: any) {
        diagnostics.sessionsSkipped++;
        const reason = err.message ?? String(err);
        diagnostics.warnings.push(`Root re-validation failed for ${sessionId} canonicalRoot=${meta.canonicalRoot}: ${reason}, skipping session`);
        diagnostics.skippedSessions.push({ sessionId, reason });
        // Do not delete, just skip loading — optionally quarantine?
        continue;
      }
    }

    // Also handle flat fallback migration without changing source files? We support reading flat but not auto-moving for boot?
    // For migration, we could detect legacy flat turns and derive session meta if missing, but spec says without changing source files
    // So we only list sessions, not auto-migrate flat files here. Migration can be done explicitly.

    return diagnostics;
  }

  /**
   * Derive session meta from turn_started events if meta.json missing — for migration
   * Scans turn files in session dir, finds first turn_started, extracts root
   * Does not auto-create meta unless explicitly called
   */
  async deriveMetaFromTurns(sessionId: string, turnEvents: { at: number; root?: string; realRoot?: string }[]): Promise<SessionMetaV1 | null> {
    if (turnEvents.length === 0) return null;

    const first = turnEvents[0];
    if (!first.root) return null;

    // This is informational, still needs re-validation via ProjectRoot.create by caller
    const meta: SessionMetaV1 = {
      version: 1,
      sessionId,
      canonicalRoot: first.root,
      realRoot: first.realRoot || first.root,
      createdAt: first.at,
      lastActivityAt: Date.now(),
      activeTurnId: null,
    };

    return meta;
  }

  getDataDir(): string {
    return this.dataDir;
  }
}
