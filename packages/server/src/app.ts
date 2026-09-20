import express from "express";
import type { TurnManager } from "./agent/turn-manager.js";
import type { ApprovalRegistry } from "./agent/approval-registry.js";
import type { LLMProvider } from "./providers/types.js";
import type { ToolDefinition } from "./agent/tools/types.js";
import { TurnRunner } from "./agent/loop.js";
import { SessionManager } from "./agent/session-manager.js";

export interface AppDeps {
  manager: TurnManager;
  provider: LLMProvider;
  tools: Map<string, ToolDefinition>;
  approvals: ApprovalRegistry;
  allowedRoots?: string[];
  sessionManager?: SessionManager;
  // For operational observability — optional, exposed via /api/health
  getBootDiagnostics?: () => any;
  getPersistenceDiagnostics?: () => any;
}

export function createApp(deps: AppDeps) {
  const app = express();
  app.use(express.json());

  const activeControllers = new Map<string, AbortController>();
  const sessionManager = deps.sessionManager ?? new SessionManager({
    isTurnTerminal: (turnId) => {
      const log = deps.manager.getLog(turnId);
      return log ? log.state.isTerminal : true;
    },
  });

  sessionManager.setTurnTerminalChecker((turnId) => {
    const log = deps.manager.getLog(turnId);
    return log ? log.state.isTerminal : true;
  });

  // POST /api/sessions/:sessionId — explicit session creation with pinned root
  app.post("/api/sessions/:sessionId", async (req, res) => {
    const sessionId = req.params.sessionId;
    const { cwd } = req.body ?? {};

    if (typeof cwd !== "string") {
      return res.status(400).json({ error: "cwd must be string", code: "CWD_REQUIRED" });
    }

    try {
      const session = await sessionManager.createSession(sessionId, cwd, deps.allowedRoots);
      return res.status(201).json({ sessionId, root: session.projectRoot.getRoot() });
    } catch (err: any) {
      if (err.code === "SESSION_ALREADY_EXISTS") {
        return res.status(409).json({ error: "session already exists", code: "SESSION_ALREADY_EXISTS", sessionId });
      }
      if (err.code === "PATH_ESCAPES_ROOT") {
        return res.status(403).json({ error: err.message, code: "PATH_ESCAPES_ROOT" });
      }
      if (err.code === "PATH_NOT_FOUND") {
        return res.status(400).json({ error: err.message, code: "PATH_NOT_FOUND" });
      }
      if (err.code === "ROOT_MISMATCH") {
        return res.status(400).json({ error: err.message, code: "ROOT_MISMATCH", details: err.details });
      }
      console.error(err);
      return res.status(500).json({ error: "failed to create session" });
    }
  });

  // DELETE /api/sessions/:sessionId — cleanup, cancel active turn
  app.delete("/api/sessions/:sessionId", async (req, res) => {
    const sessionId = req.params.sessionId;
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: "session not found", code: "SESSION_NOT_FOUND", sessionId });
    }

    if (session.activeTurnId) {
      const controller = activeControllers.get(session.activeTurnId);
      if (controller) {
        controller.abort(new Error("session deleted"));
      }
      deps.approvals.cancelTurn(session.activeTurnId);
    }

    sessionManager.deleteSession(sessionId);
    return res.status(204).end();
  });

  // POST /api/sessions/:sessionId/turns
  app.post("/api/sessions/:sessionId/turns", async (req, res) => {
    const sessionId = req.params.sessionId;
    const { cwd, message } = req.body ?? {};

    if (typeof message !== "string") {
      return res.status(400).json({ error: "message must be string", code: "MESSAGE_REQUIRED" });
    }

    let session = sessionManager.getSession(sessionId);

    if (!session) {
      if (typeof cwd !== "string") {
        return res.status(400).json({ error: "cwd required for new session", code: "CWD_REQUIRED" });
      }
      try {
        session = await sessionManager.getOrCreateSession(sessionId, cwd, deps.allowedRoots);
      } catch (err: any) {
        if (err.code === "ROOT_MISMATCH") {
          return res.status(400).json({ error: err.message, code: "ROOT_MISMATCH", details: err.details });
        }
        if (err.code === "PATH_ESCAPES_ROOT") {
          return res.status(403).json({ error: err.message, code: "PATH_ESCAPES_ROOT" });
        }
        if (err.code === "PATH_NOT_FOUND") {
          return res.status(400).json({ error: err.message, code: "PATH_NOT_FOUND" });
        }
        console.error(err);
        return res.status(500).json({ error: "failed to create session" });
      }
    } else {
      if (typeof cwd === "string") {
        try {
          await sessionManager.getOrCreateSession(sessionId, cwd, deps.allowedRoots);
        } catch (err: any) {
          if (err.code === "ROOT_MISMATCH") {
            return res.status(400).json({ error: err.message, code: "ROOT_MISMATCH", details: err.details });
          }
          if (err.code === "PATH_ESCAPES_ROOT") {
            return res.status(403).json({ error: err.message, code: "PATH_ESCAPES_ROOT" });
          }
          console.error(err);
          return res.status(500).json({ error: "failed to validate root" });
        }
      }
    }

    const turnId = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      const guard = sessionManager.tryStartTurn(sessionId, turnId);
      if (!guard.ok) {
        return res.status(409).json({ error: "turn already active", code: "TURN_ALREADY_ACTIVE", activeTurnId: guard.activeTurnId });
      }
    } catch (err: any) {
      if (err.code === "SESSION_NOT_FOUND") {
        return res.status(404).json({ error: "session not found", code: "SESSION_NOT_FOUND", sessionId });
      }
      throw err;
    }

    const controller = new AbortController();
    activeControllers.set(turnId, controller);

    const runner = new TurnRunner({
      provider: deps.provider,
      tools: deps.tools,
      approvals: deps.approvals,
      manager: deps.manager,
      allowedRoots: deps.allowedRoots,
    });

    const request = {
      messages: [{ role: "user" as const, content: message }],
      tools: [...deps.tools.values()].map((t) => ({ name: t.name, description: t.description })),
    };

    const limits = {
      maxSteps: 10,
      modelCallTimeoutMs: 30_000,
      toolTimeoutMs: 30_000,
      approvalTimeoutMs: 300_000,
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
  app.get("/api/sessions/:sessionId/turns/:turnId/events", (req, res) => {
    const sessionId = req.params.sessionId;
    const turnId = req.params.turnId;

    const lastEventIdHeader = req.headers["last-event-id"] as string | undefined;
    const afterSeqQuery = req.query.afterSeq as string | undefined;
    let afterSeq = 0;
    if (lastEventIdHeader) {
      const parsed = parseInt(lastEventIdHeader, 10);
      if (!Number.isNaN(parsed)) afterSeq = parsed;
    } else if (afterSeqQuery) {
      const parsed = parseInt(afterSeqQuery, 10);
      if (!Number.isNaN(parsed)) afterSeq = parsed;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    try {
      const { replay, state, unsubscribe } = deps.manager.subscribe(sessionId, turnId, afterSeq, (event) => {
        res.write(`id: ${event.seq}\n`);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      });

      for (const event of replay) {
        res.write(`id: ${event.seq}\n`);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }

      if (state.isTerminal) {
        res.end();
        unsubscribe();
        return;
      }

      req.on("close", () => {
        unsubscribe();
      });
    } catch (err: any) {
      if (err.message?.includes("Turn not found")) {
        res.write(`data: ${JSON.stringify({ type: "error", message: "turn not found" })}\n\n`);
        res.end();
        return;
      }
      if (err.message?.includes("Session mismatch")) {
        res.status(403).end();
        return;
      }
      console.error(err);
      res.status(500).end();
    }
  });

  // POST /api/sessions/:sessionId/turns/:turnId/cancel
  app.post("/api/sessions/:sessionId/turns/:turnId/cancel", (req, res) => {
    const turnId = req.params.turnId;
    const { reason } = req.body ?? {};

    const controller = activeControllers.get(turnId);
    if (controller) {
      controller.abort(new Error(reason ?? "cancelled"));
    }
    deps.approvals.cancelTurn(turnId);

    res.status(202).json({ cancelled: true });
  });

  // POST /api/sessions/:sessionId/approve
  app.post("/api/sessions/:sessionId/approve", (req, res) => {
    const urlSessionId = req.params.sessionId;
    const { requestId, decision } = req.body ?? {};

    if (typeof requestId !== "string" || (decision !== "approve" && decision !== "deny")) {
      return res.status(400).json({ error: "requestId and decision (approve|deny) required" });
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

  // GET /api/health — operational observability: boot diagnostics, persistence failures, single-process writer limitation
  app.get("/api/health", (req, res) => {
    const health: any = {
      status: "ok",
      timestamp: Date.now(),
      persistence: {
        mode: (deps.manager.getStore() as any).getDataDir ? "file" : "memory",
        dataDir: (deps.manager.getStore() as any).getDataDir ? (deps.manager.getStore() as any).getDataDir() : undefined,
        writer: {
          mode: "single-process only",
          limitation:
            "SERIALIZED WRITES WITHIN ONE PROCESS ONLY. Multi-process writers UNSUPPORTED — O_APPEND alone does NOT provide session-level correctness, no file lock. Run single server instance per dataDir.",
          concurrency: "per-turn queue Map<turnId, Promise> ensures serialized writes within one process",
        },
      },
      diagnostics: {
        boot: deps.getBootDiagnostics ? deps.getBootDiagnostics() : undefined,
        persistence: deps.getPersistenceDiagnostics
          ? deps.getPersistenceDiagnostics()
          : (deps.manager.getStore() as any).getDiagnostics
            ? (deps.manager.getStore() as any).getDiagnostics()
            : undefined,
        approvals: {
          pendingCount: (deps.approvals as any).entries ? (deps.approvals as any).entries.size : undefined,
          byTurnCount: (deps.approvals as any).byTurn ? (deps.approvals as any).byTurn.size : undefined,
        },
      },
    };

    res.json(health);
  });

  // GET /api/diagnostics/persistence — detailed persistence failures and quarantine
  app.get("/api/diagnostics/persistence", (req, res) => {
    const store: any = deps.manager.getStore();
    const diagnostics = store.getDiagnostics ? store.getDiagnostics() : { warnings: [], persistenceFailures: [] };
    res.json({
      ...diagnostics,
      persistenceFailures: store.getPersistenceFailures ? store.getPersistenceFailures() : diagnostics.persistenceFailures || [],
    });
  });

  return app;
}
