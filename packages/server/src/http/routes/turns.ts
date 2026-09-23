import type { Express, Request, Response } from "express";
import { TurnRunner } from "../../agent/loop.js";
import type { StreamEvent } from "@windows-runner/shared";
import type { AppRuntime } from "../runtime.js";
import { sendSessionError } from "./sessions.js";
import { bodyObject, isPathString, MAX_MESSAGE_CHARS, MAX_PATH_CHARS, MAX_REASON_CHARS, requireSessionId, requireTurnId } from "../validate.js";

/**
 * Turn routes — the whole client-facing turn lifecycle lives here, because it
 * has exactly one owner for the in-flight state (`rt.activeControllers`) and
 * one place where a turn starts, streams, is cancelled, and settles approvals:
 *
 *   POST /api/sessions/:sessionId/turns                      -> 202 { turnId }
 *   GET  /api/sessions/:sessionId/turns/:turnId/events       -> text/event-stream
 *   POST /api/sessions/:sessionId/turns/:turnId/cancel       -> 202 | 404 | 409
 *   POST /api/sessions/:sessionId/approve                    -> 204
 */

/** True for the three events after which a turn emits nothing else. */
function isTerminalEvent(event: StreamEvent): boolean {
  return event.type === "turn_completed" || event.type === "turn_cancelled" || event.type === "turn_failed";
}

function writeSseEvent(res: Response, event: StreamEvent): void {
  res.write(`id: ${event.seq}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function registerTurnRoutes(app: Express, rt: AppRuntime): void {
  const { deps, sessionManager, activeControllers } = rt;

  // POST /api/sessions/:sessionId/turns
  app.post("/api/sessions/:sessionId/turns", async (req: Request, res: Response) => {
    const sessionId = requireSessionId(req, res);
    if (!sessionId) return;
    const body = bodyObject(req, res);
    if (!body) return;
    const { cwd, message } = body;

    if (typeof message !== "string") {
      return res.status(400).json({ error: "message must be string", code: "MESSAGE_REQUIRED" });
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      return res.status(400).json({ error: `message must be at most ${MAX_MESSAGE_CHARS} characters`, code: "MESSAGE_TOO_LONG" });
    }
    if (cwd !== undefined && !isPathString(cwd)) {
      return res.status(400).json({ error: `cwd must be a non-empty string of at most ${MAX_PATH_CHARS} characters`, code: "CWD_INVALID" });
    }

    let session = sessionManager.getSession(sessionId);

    if (!session) {
      if (typeof cwd !== "string") {
        return res.status(400).json({ error: "cwd required for new session", code: "CWD_REQUIRED" });
      }
      try {
        session = await sessionManager.getOrCreateSession(sessionId, cwd, deps.allowedRoots);
      } catch (err) {
        return sendSessionError(res, err, sessionId, "failed to create session");
      }
    } else {
      if (typeof cwd === "string") {
        try {
          await sessionManager.getOrCreateSession(sessionId, cwd, deps.allowedRoots);
        } catch (err) {
          return sendSessionError(res, err, sessionId, "failed to validate root");
        }
      }
    }

    const turnId = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      const guard = sessionManager.tryStartTurn(sessionId, turnId);
      if (!guard.ok) {
        return res.status(409).json({ error: "turn already active", code: "TURN_ALREADY_ACTIVE", activeTurnId: guard.activeTurnId });
      }
    } catch (err) {
      if ((err as { code?: unknown }).code === "SESSION_NOT_FOUND") {
        return res.status(404).json({ error: "session not found", code: "SESSION_NOT_FOUND", sessionId });
      }
      throw err;
    }

    const controller = new AbortController();
    activeControllers.set(turnId, controller);

    // Read the CURRENT provider at turn start (hot-swap box): activating or
    // editing the active profile changes the next turn, not a restart.
    const provider = deps.activeProvider ? deps.activeProvider.get() : deps.provider;

    const runner = new TurnRunner({
      provider,
      tools: deps.tools,
      approvals: deps.approvals,
      manager: deps.manager,
      allowedRoots: deps.allowedRoots,
      metrics: rt.metrics,
      now: rt.now,
      clock: deps.clock,
      trust: rt.trust,
    });

    const request = {
      messages: [{ role: "user" as const, content: message }],
      tools: [...deps.tools.values()].map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })),
    };

    const limits = {
      maxSteps: 10,
      modelCallTimeoutMs: 30_000,
      toolTimeoutMs: 30_000,
      approvalTimeoutMs: 300_000,
      ...deps.limits,
    };

    runner
      .run({
        sessionId,
        turnId,
        cwd: session.projectRoot.getRoot(),
        request,
        limits,
        signal: controller.signal,
        allowedRoots: deps.allowedRoots,
        projectRoot: session.projectRoot,
      })
      .then((result) => {
        // Dashboard usage history: one record per terminal turn (best-effort;
        // a failure here must never affect the turn itself).
        try {
          deps.recordTurnUsage?.(turnId, sessionId, result);
        } catch (err) {
          console.error(`usage record for turn ${turnId} failed`, err);
        }
      })
      .finally(() => {
        activeControllers.delete(turnId);
        sessionManager.finishTurn(sessionId, turnId);
        deps.manager.evictOldest(100);
        sessionManager.evictOldest(100);
      })
      .catch((err) => {
        console.error(`Turn ${turnId} failed`, err);
      });

    res.status(202).json({ turnId });
  });

  // GET /api/sessions/:sessionId/turns/:turnId/events — SSE with Last-Event-ID
  app.get("/api/sessions/:sessionId/turns/:turnId/events", (req: Request, res: Response) => {
    const sessionId = requireSessionId(req, res);
    if (!sessionId) return;
    const turnId = requireTurnId(req, res);
    if (!turnId) return;

    // Both cursors must be a non-negative decimal integer; anything else is a
    // 400 rather than a silent replay from 0 (which would hand a reconnecting
    // client a duplicated stream).
    const lastEventIdHeader = req.headers["last-event-id"];
    const afterSeqQuery = req.query.afterSeq;
    let afterSeq = 0;
    const cursorRaw = lastEventIdHeader !== undefined ? lastEventIdHeader : afterSeqQuery;
    if (cursorRaw !== undefined) {
      // Repeated params arrive as arrays (e.g. ?afterSeq=1&afterSeq=2) — an
      // ambiguous cursor is a 400, never "take the first".
      if (Array.isArray(cursorRaw) || typeof cursorRaw !== "string" || !/^\d{1,15}$/.test(cursorRaw)) {
        return res.status(400).json({ error: "Last-Event-ID / afterSeq must be a non-negative integer", code: "CURSOR_INVALID" });
      }
      afterSeq = Number(cursorRaw);
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    try {
      const { replay, state, unsubscribe } = deps.manager.subscribe(sessionId, turnId, afterSeq, (event) => {
        writeSseEvent(res, event);
        // A turn emits nothing after its terminal event (TurnManager refuses
        // further appends), so end the stream here — the same thing the replay
        // path below already does for turns that were terminal at subscribe
        // time. Without this, finished streams stay open until the client
        // hangs up, which also holds a draining server open on shutdown.
        if (isTerminalEvent(event)) {
          unsubscribe();
          res.end();
        }
      });

      for (const event of replay) {
        writeSseEvent(res, event);
      }

      if (state.isTerminal) {
        res.end();
        unsubscribe();
        return;
      }

      req.on("close", () => {
        unsubscribe();
      });
    } catch (err) {
      if ((err as Error).message?.includes("Turn not found")) {
        res.write(`data: ${JSON.stringify({ type: "error", message: "turn not found" })}\n\n`);
        res.end();
        return;
      }
      if ((err as Error).message?.includes("Session mismatch")) {
        res.status(403).end();
        return;
      }
      console.error(err);
      res.status(500).end();
    }
  });

  // POST /api/sessions/:sessionId/turns/:turnId/cancel
  //
  // The response says what actually happened: 202 for an in-flight turn that
  // was aborted, 404 TURN_NOT_FOUND for a turn that does not exist (or does
  // not belong to this session), 409 TURN_NOT_ACTIVE for a turn that already
  // reached a terminal state. A client racing the completion of a turn gets
  // the honest 409 instead of a success that lied.
  app.post("/api/sessions/:sessionId/turns/:turnId/cancel", (req: Request, res: Response) => {
    const sessionId = requireSessionId(req, res);
    if (!sessionId) return;
    const turnId = requireTurnId(req, res);
    if (!turnId) return;
    const body = bodyObject(req, res);
    if (!body) return;
    const { reason } = body;
    if (reason !== undefined && (typeof reason !== "string" || reason.length > MAX_REASON_CHARS)) {
      return res.status(400).json({ error: `reason must be a string of at most ${MAX_REASON_CHARS} characters`, code: "REASON_INVALID" });
    }

    // A turn may only be cancelled through the session it belongs to.
    const log = deps.manager.getLog(turnId);
    if (!log || log.state.sessionId !== sessionId) {
      return res.status(404).json({ error: "turn not found", code: "TURN_NOT_FOUND" });
    }
    if (log.state.isTerminal) {
      return res.status(409).json({ error: `turn is already ${log.state.status}`, code: "TURN_NOT_ACTIVE", state: log.state.status });
    }

    const controller = activeControllers.get(turnId);
    if (controller) {
      controller.abort(new Error(reason ?? "cancelled"));
    }
    deps.approvals.cancelTurn(turnId);

    res.status(202).json({ cancelled: true });
  });

  // POST /api/sessions/:sessionId/approve
  app.post("/api/sessions/:sessionId/approve", (req: Request, res: Response) => {
    const urlSessionId = requireSessionId(req, res);
    if (!urlSessionId) return;
    const body = bodyObject(req, res);
    if (!body) return;
    const { requestId, decision } = body;

    if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 256 || (decision !== "approve" && decision !== "deny")) {
      return res.status(400).json({ error: "requestId and decision (approve|deny) required", code: "APPROVAL_INVALID" });
    }

    const peeked = deps.approvals.peek(requestId);
    if (!peeked) {
      return res.status(409).json({ error: "approval not pending or already resolved" });
    }
    if (peeked.request.sessionId !== urlSessionId) {
      return res.status(404).json({ error: "approval does not belong to session" });
    }

    const result = decision === "approve" ? deps.approvals.approve(requestId) : deps.approvals.deny(requestId);
    if (!result.settled) {
      return res.status(409).json({ error: "approval already settled" });
    }

    res.status(204).end();
  });
}
