import * as path from "node:path";
import { ProjectRoot, PathError } from "../project-root.js";
import type { SessionId, TurnId } from "@windows-runner/shared";

export type SessionErrorCode =
  | "SESSION_ALREADY_EXISTS"
  | "SESSION_NOT_FOUND"
  | "TURN_ALREADY_ACTIVE"
  | "ROOT_MISMATCH"
  | "PATH_ESCAPES_ROOT"
  | "PATH_NOT_FOUND";

export class SessionError extends Error {
  code: SessionErrorCode;
  details?: Record<string, unknown>;
  constructor(code: SessionErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "SessionError";
    this.code = code;
    this.details = details;
  }
}

export interface Session {
  sessionId: SessionId;
  projectRoot: ProjectRoot;
  activeTurnId: TurnId | null;
  createdAt: number;
  lastActivityAt: number;
  allowedRoots: string[];
}

export interface SessionManagerDeps {
  now?: () => number;
  isTurnTerminal?: (turnId: TurnId) => boolean;
  sessionStore?: { save: (meta: any) => Promise<void>; delete: (sessionId: string) => Promise<boolean>; boot?: (allowedRoots: string[], now?: () => number) => Promise<any> };
}

export class SessionManager {
  private sessions = new Map<SessionId, Session>();
  private pendingCreations = new Map<SessionId, Promise<Session>>();
  private now: () => number;
  private isTurnTerminal?: (turnId: TurnId) => boolean;
  private sessionStore?: { save: (meta: any) => Promise<void>; delete: (sessionId: string) => Promise<boolean> };

  constructor(deps: SessionManagerDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.isTurnTerminal = deps.isTurnTerminal;
    this.sessionStore = deps.sessionStore;
  }

  get _sessions() {
    return this.sessions;
  }
  get _pending() {
    return this.pendingCreations;
  }

  async createSession(sessionId: SessionId, requestedRoot: string, allowedRoots: string[] = []): Promise<Session> {
    if (this.sessions.has(sessionId)) {
      throw new SessionError("SESSION_ALREADY_EXISTS", `session already exists: ${sessionId}`, { sessionId });
    }
    if (this.pendingCreations.has(sessionId)) {
      throw new SessionError("SESSION_ALREADY_EXISTS", `session already exists (pending): ${sessionId}`, { sessionId });
    }

    const promise = (async () => {
      let projectRoot: ProjectRoot;
      try {
        projectRoot = await ProjectRoot.create(requestedRoot, allowedRoots);
      } catch (err: any) {
        if (err instanceof PathError) {
          throw new SessionError(err.code as SessionErrorCode, err.message, {
            requestedRoot,
            code: err.code,
          });
        }
        throw err;
      }

      const session: Session = {
        sessionId,
        projectRoot,
        activeTurnId: null,
        createdAt: this.now(),
        lastActivityAt: this.now(),
        allowedRoots: allowedRoots.map((r) => path.resolve(r)),
      };

      this.sessions.set(sessionId, session);

      if (this.sessionStore) {
        try {
          await this.sessionStore.save({
            version: 1,
            sessionId,
            canonicalRoot: projectRoot.canonicalRoot,
            realRoot: projectRoot.realRoot,
            createdAt: session.createdAt,
            lastActivityAt: session.lastActivityAt,
            activeTurnId: null,
            allowedRootsSnapshot: allowedRoots.map((r) => path.resolve(r)),
          });
        } catch (err) {
          console.warn(`Failed to persist session meta for ${sessionId}:`, err);
        }
      }

      return session;
    })();

    this.pendingCreations.set(sessionId, promise);

    try {
      const result = await promise;
      return result;
    } finally {
      this.pendingCreations.delete(sessionId);
    }
  }

  async getOrCreateSession(sessionId: SessionId, requestedRoot: string, allowedRoots: string[] = []): Promise<Session> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      const canonicalRequested = path.resolve(requestedRoot);
      if (canonicalRequested !== existing.projectRoot.canonicalRoot) {
        throw new SessionError("ROOT_MISMATCH", `root mismatch: session pinned to ${existing.projectRoot.canonicalRoot} but requested ${canonicalRequested}`, {
          pinnedRoot: existing.projectRoot.canonicalRoot,
          requestedRoot: canonicalRequested,
          sessionId,
        });
      }
      return existing;
    }

    if (this.pendingCreations.has(sessionId)) {
      const pending = this.pendingCreations.get(sessionId)!;
      try {
        const session = await pending;
        const canonicalRequested = path.resolve(requestedRoot);
        if (canonicalRequested !== session.projectRoot.canonicalRoot) {
          throw new SessionError("ROOT_MISMATCH", `root mismatch: session pinned to ${session.projectRoot.canonicalRoot} but requested ${canonicalRequested}`, {
            pinnedRoot: session.projectRoot.canonicalRoot,
            requestedRoot: canonicalRequested,
            sessionId,
          });
        }
        return session;
      } catch (err) {
        if (err instanceof SessionError && err.code === "ROOT_MISMATCH") throw err;
      }
    }

    return await this.createSession(sessionId, requestedRoot, allowedRoots);
  }

  getSession(sessionId: SessionId): Session | null {
    return this.sessions.get(sessionId) ?? null;
  }

  tryStartTurn(sessionId: SessionId, turnId: TurnId): { ok: true } | { ok: false; code: "TURN_ALREADY_ACTIVE"; activeTurnId: TurnId } {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new SessionError("SESSION_NOT_FOUND", `session not found: ${sessionId}`, { sessionId });
    }

    if (session.activeTurnId) {
      if (this.isTurnTerminal) {
        try {
          if (this.isTurnTerminal(session.activeTurnId)) {
            session.activeTurnId = null;
          } else {
            return { ok: false, code: "TURN_ALREADY_ACTIVE", activeTurnId: session.activeTurnId! };
          }
        } catch {
          return { ok: false, code: "TURN_ALREADY_ACTIVE", activeTurnId: session.activeTurnId! };
        }
      } else {
        return { ok: false, code: "TURN_ALREADY_ACTIVE", activeTurnId: session.activeTurnId! };
      }
    }

    session.activeTurnId = turnId;
    session.lastActivityAt = this.now();

    if (this.sessionStore) {
      this.sessionStore.save({
        version: 1,
        sessionId,
        canonicalRoot: session.projectRoot.canonicalRoot,
        realRoot: session.projectRoot.realRoot,
        createdAt: session.createdAt,
        lastActivityAt: session.lastActivityAt,
        activeTurnId: turnId,
        allowedRootsSnapshot: session.allowedRoots,
      }).catch((err) => console.warn(`Failed to persist activeTurnId for ${sessionId}:`, err));
    }

    return { ok: true };
  }

  finishTurn(sessionId: SessionId, turnId: TurnId): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.activeTurnId === turnId) {
      session.activeTurnId = null;
      session.lastActivityAt = this.now();

      if (this.sessionStore) {
        this.sessionStore.save({
          version: 1,
          sessionId,
          canonicalRoot: session.projectRoot.canonicalRoot,
          realRoot: session.projectRoot.realRoot,
          createdAt: session.createdAt,
          lastActivityAt: session.lastActivityAt,
          activeTurnId: null,
          allowedRootsSnapshot: session.allowedRoots,
        }).catch((err) => console.warn(`Failed to clear activeTurnId for ${sessionId}:`, err));
      }
    }
  }

  deleteSession(sessionId: SessionId): { deleted: boolean; activeTurnId?: TurnId | null } {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { deleted: false };
    }
    const activeTurnId = session.activeTurnId;
    this.sessions.delete(sessionId);

    if (this.sessionStore) {
      this.sessionStore.delete(sessionId).catch((err) => console.warn(`Failed to delete session meta for ${sessionId}:`, err));
    }

    return { deleted: true, activeTurnId };
  }

  evictOldest(maxSessions = 100): void {
    if (this.sessions.size <= maxSessions) return;
    const sorted = [...this.sessions.values()].sort((a, b) => a.lastActivityAt - b.lastActivityAt);
    const toDelete = this.sessions.size - maxSessions;
    for (let i = 0; i < toDelete; i++) {
      const s = sorted[i];
      if (s.activeTurnId === null) {
        this.sessions.delete(s.sessionId);
      }
    }
  }

  setTurnTerminalChecker(fn: (turnId: TurnId) => boolean): void {
    this.isTurnTerminal = fn;
  }
}
