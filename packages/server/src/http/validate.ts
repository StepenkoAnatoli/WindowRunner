import type { Request, Response } from "express";

/** Shared path/body limits for the HTTP surface. */
export const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
export const TURN_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
export const MAX_MESSAGE_CHARS = 200_000;
export const MAX_PATH_CHARS = 4_096;
export const MAX_REASON_CHARS = 1_000;

/**
 * Path/body validation helpers for the route modules. Each `require*` helper
 * sends the error response itself and returns undefined on failure, so a
 * handler reads as a flat guard sequence:
 *
 *   const sessionId = requireSessionId(req, res);
 *   if (!sessionId) return;
 */

export function requireSessionId(req: Request, res: Response): string | undefined {
  const sessionId = req.params.sessionId;
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    res.status(400).json({ error: "sessionId must match [A-Za-z0-9_-]{1,128}", code: "SESSION_ID_INVALID" });
    return undefined;
  }
  return sessionId;
}

export function requireTurnId(req: Request, res: Response): string | undefined {
  const turnId = req.params.turnId;
  if (typeof turnId !== "string" || !TURN_ID_RE.test(turnId)) {
    res.status(400).json({ error: "turnId must match [A-Za-z0-9_-]{1,128}", code: "TURN_ID_INVALID" });
    return undefined;
  }
  return turnId;
}

export function bodyObject(req: Request, res: Response): Record<string, unknown> | undefined {
  const body = req.body;
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) {
    res.status(400).json({ error: "request body must be a JSON object", code: "BODY_INVALID" });
    return undefined;
  }
  return body;
}

export function isPathString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PATH_CHARS && !value.includes("\0");
}
