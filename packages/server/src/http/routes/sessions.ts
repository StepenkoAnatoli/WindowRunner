import type { Express, Request, Response } from "express";
import { isValidConfigHash } from "../../agent/project-trust.js";
import type { AppRuntime } from "../runtime.js";
import { bodyObject, isPathString, MAX_PATH_CHARS, requireSessionId } from "../validate.js";

/**
 * Session routes: explicit creation with a pinned project root, deletion, and
 * the project-trust grants keyed by that root (P0-02).
 *
 * A trust grant is a separate, explicit act from approving a tool call: it is
 * keyed by the session's *real* root plus a configHash the client obtained
 * from the tool's PROJECT_NOT_TRUSTED result (or an approval request).
 *
 *   GET    /api/sessions/:sessionId/trust  -> { sessionId, realRoot, canonicalRoot, grant|null }
 *   POST   /api/sessions/:sessionId/trust  { configHash, source? } -> 201 grant
 *   DELETE /api/sessions/:sessionId/trust  -> 204 (revoked) | 404
 */

/** Session-creation errors with a stable HTTP mapping; anything else is a 500. */
function sendSessionError(res: Response, err: unknown, sessionId: string, fallbackMessage: string): void {
  const code = (err as { code?: unknown }).code;
  if (code === "SESSION_ALREADY_EXISTS") {
    res.status(409).json({ error: "session already exists", code: "SESSION_ALREADY_EXISTS", sessionId });
  } else if (code === "PATH_ESCAPES_ROOT") {
    res.status(403).json({ error: (err as Error).message, code: "PATH_ESCAPES_ROOT" });
  } else if (code === "PATH_NOT_FOUND") {
    res.status(400).json({ error: (err as Error).message, code: "PATH_NOT_FOUND" });
  } else if (code === "ROOT_MISMATCH") {
    res.status(400).json({ error: (err as Error).message, code: "ROOT_MISMATCH", details: (err as { details?: unknown }).details });
  } else {
    console.error(err);
    res.status(500).json({ error: fallbackMessage });
  }
}

export function registerSessionRoutes(app: Express, rt: AppRuntime): void {
  const { deps, sessionManager, trust } = rt;

  // POST /api/sessions/:sessionId — explicit session creation with pinned root
  app.post("/api/sessions/:sessionId", async (req: Request, res: Response) => {
    const sessionId = requireSessionId(req, res);
    if (!sessionId) return;
    const body = bodyObject(req, res);
    if (!body) return;
    const { cwd } = body;

    if (!isPathString(cwd)) {
      return res.status(400).json({ error: `cwd must be a non-empty string of at most ${MAX_PATH_CHARS} characters`, code: "CWD_REQUIRED" });
    }

    try {
      const session = await sessionManager.createSession(sessionId, cwd, deps.allowedRoots);
      return res.status(201).json({ sessionId, root: session.projectRoot.getRoot() });
    } catch (err) {
      sendSessionError(res, err, sessionId, "failed to create session");
    }
  });

  // DELETE /api/sessions/:sessionId — cleanup, cancel active turn
  app.delete("/api/sessions/:sessionId", async (req: Request, res: Response) => {
    const sessionId = requireSessionId(req, res);
    if (!sessionId) return;
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: "session not found", code: "SESSION_NOT_FOUND", sessionId });
    }

    if (session.activeTurnId) {
      const controller = rt.activeControllers.get(session.activeTurnId);
      if (controller) {
        controller.abort(new Error("session deleted"));
      }
      deps.approvals.cancelTurn(session.activeTurnId);
    }

    sessionManager.deleteSession(sessionId);
    return res.status(204).end();
  });

  app.get("/api/sessions/:sessionId/trust", (req: Request, res: Response) => {
    const sessionId = requireSessionId(req, res);
    if (!sessionId) return;
    const session = sessionManager.getSession(sessionId);
    if (!session) return res.status(404).json({ error: "session not found", code: "SESSION_NOT_FOUND", sessionId });
    const realRoot = session.projectRoot.getRealRoot();
    res.json({ sessionId, realRoot, canonicalRoot: session.projectRoot.getRoot(), grant: trust.get(realRoot) ?? null });
  });

  app.post("/api/sessions/:sessionId/trust", async (req: Request, res: Response) => {
    const sessionId = requireSessionId(req, res);
    if (!sessionId) return;
    const body = bodyObject(req, res);
    if (!body) return;
    const { configHash, source } = body;
    if (!isValidConfigHash(configHash)) {
      return res.status(400).json({ error: "configHash must be sha256:<64 hex>", code: "CONFIG_HASH_INVALID" });
    }
    if (source !== undefined && (typeof source !== "string" || source.length > 256)) {
      return res.status(400).json({ error: "source must be a string of at most 256 characters", code: "SOURCE_INVALID" });
    }
    const session = sessionManager.getSession(sessionId);
    if (!session) return res.status(404).json({ error: "session not found", code: "SESSION_NOT_FOUND", sessionId });
    const grant = await trust.grant({
      realRoot: session.projectRoot.getRealRoot(),
      canonicalRoot: session.projectRoot.getRoot(),
      configHash,
      source: typeof source === "string" ? source : undefined,
    });
    res.status(201).json({ sessionId, grant });
  });

  app.delete("/api/sessions/:sessionId/trust", async (req: Request, res: Response) => {
    const sessionId = requireSessionId(req, res);
    if (!sessionId) return;
    const session = sessionManager.getSession(sessionId);
    if (!session) return res.status(404).json({ error: "session not found", code: "SESSION_NOT_FOUND", sessionId });
    const revoked = await trust.revoke(session.projectRoot.getRealRoot());
    if (!revoked) return res.status(404).json({ error: "project is not trusted", code: "TRUST_NOT_FOUND" });
    res.status(204).end();
  });
}
