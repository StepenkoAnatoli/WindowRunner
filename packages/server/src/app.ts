import express from "express";
import type { TurnManager } from "./agent/turn-manager.js";
import type { ApprovalRegistry } from "./agent/approval-registry.js";
import type { LLMProvider } from "./providers/types.js";
import type { ToolDefinition } from "./agent/tools/types.js";
import { TurnRunner } from "./agent/loop.js";
import { SessionManager } from "./agent/session-manager.js";
import { MetricsRegistry } from "./agent/metrics.js";

export interface LongRunningThresholds {
  /** active turn duration before considered stuck; default 2h */
  stuckTurnMs?: number;
  /** approval wait duration before considered long-waiting; default 30m */
  approvalWaitMs?: number;
  /** idle session (no active turn) duration before flagged; default undefined (disabled) */
  idleSessionMs?: number;
}

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
  // Metrics: process-local, reset on restart, windowed alerts
  metrics?: MetricsRegistry;
  now?: () => number;
  validationIntervalMs?: number; // default 60000, 0 to disable (for tests)
  validationThresholds?: LongRunningThresholds;
  clock?: any; // optional fake clock for tests (provides now())
}

export interface ValidationResult {
  stuckTurns: Array<{ turnId: string; sessionId: string; durationMs: number; startedAt: number }>;
  longWaitingApprovals: Array<{ requestId: string; turnId: string; waitMs: number; createdAt: number }>;
  idleSessions: Array<{ sessionId: string; idleMs: number; lastActivityAt: number }>;
  activeTurns: number;
  activeApprovals: number;
}

function runValidation(
  manager: TurnManager,
  sessionManager: SessionManager,
  approvals: ApprovalRegistry,
  now: number,
  thresholds: Required<LongRunningThresholds>
): ValidationResult {
  const stuckTurns = (manager as any).getStuckTurns
    ? (manager as any).getStuckTurns(now, thresholds.stuckTurnMs)
    : [];
  const longWaitingApprovals = (approvals as any).getLongWaitingApprovals
    ? (approvals as any).getLongWaitingApprovals(now, thresholds.approvalWaitMs)
    : [];
  const idleSessions =
    thresholds.idleSessionMs !== undefined && (sessionManager as any).getIdleSessions
      ? (sessionManager as any).getIdleSessions(now, thresholds.idleSessionMs)
      : [];
  const activeTurns = (manager as any).getActiveTurnCount
    ? (manager as any).getActiveTurnCount()
    : 0;
  const activeApprovals = (approvals as any).getPendingCount
    ? (approvals as any).getPendingCount()
    : (approvals as any).entries
      ? (approvals as any).entries.size
      : 0;

  return { stuckTurns, longWaitingApprovals, idleSessions, activeTurns, activeApprovals };
}

export function createApp(deps: AppDeps) {
  const app: any = express();
  app.use(express.json());

  const now = deps.now ?? (() => Date.now());
  const metrics = deps.metrics ?? new MetricsRegistry({ now });
  const thresholds: Required<LongRunningThresholds> = {
    stuckTurnMs: deps.validationThresholds?.stuckTurnMs ?? 2 * 60 * 60 * 1000,
    approvalWaitMs: deps.validationThresholds?.approvalWaitMs ?? 30 * 60 * 1000,
    idleSessionMs: deps.validationThresholds?.idleSessionMs ?? undefined as any,
  };

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

  // Wire metrics into stores if they support setMetrics (after sessionManager created)
  try {
    const store: any = deps.manager.getStore();
    if (store && typeof store.setMetrics === "function") {
      store.setMetrics(metrics);
      if (typeof store.setNow === "function") store.setNow(now);
    }
  } catch {}
  try {
    const smStore: any = (sessionManager as any).sessionStore;
    if (smStore && typeof smStore.setMetrics === "function") {
      smStore.setMetrics(metrics);
      if (typeof smStore.setNow === "function") smStore.setNow(now);
    }
  } catch {}

  // Validation loop — explicit lifecycle ownership
  const validationIntervalMs = deps.validationIntervalMs ?? 60_000;
  let validationTimer: any = undefined;

  const doValidation = () => {
    const n = now();
    const result = runValidation(deps.manager, sessionManager, deps.approvals, n, thresholds);
    metrics.setGauge("activeTurns", result.activeTurns);
    metrics.setGauge("activeApprovals", result.activeApprovals);
    metrics.setGauge("stuckTurns", result.stuckTurns.length);
    metrics.setGauge("idleSessions", result.idleSessions.length);
    return result;
  };

  if (validationIntervalMs > 0) {
    validationTimer = setInterval(doValidation, validationIntervalMs);
    // Don't prevent process exit if only timer remains
    if (validationTimer && typeof validationTimer.unref === "function") validationTimer.unref();
    // Initial validation
    try { doValidation(); } catch {}
  }

  // Expose close for lifecycle ownership test and graceful shutdown
  app.close = () => {
    if (validationTimer !== undefined) {
      clearInterval(validationTimer);
      validationTimer = undefined;
    }
  };
  // Shutdown hook used by the boot path (src/boot.ts): abort every in-flight
  // turn the same way POST .../cancel does, so each one records a terminal
  // turn_cancelled event before the process exits instead of being discovered
  // as a RESTART on the next boot. Returns how many turns were aborted.
  app.abortActiveTurns = (reason: string = "server shutting down"): number => {
    let aborted = 0;
    for (const [turnId, controller] of activeControllers) {
      controller.abort(new Error(reason));
      deps.approvals.cancelTurn(turnId);
      aborted++;
    }
    return aborted;
  };
  app._validationTimer = () => validationTimer;
  app._metrics = metrics;
  app._doValidation = doValidation;

  // GET /healthz — liveness only: "the process is up and serving HTTP". It
  // deliberately runs no validation and touches no store, so it stays cheap
  // enough for container health checks. Readiness/diagnostics live at
  // /api/health.
  app.get("/healthz", (_req: any, res: any) => {
    res.json({ status: "ok" });
  });

  // POST /api/sessions/:sessionId — explicit session creation with pinned root
  app.post("/api/sessions/:sessionId", async (req: any, res: any) => {
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
  app.delete("/api/sessions/:sessionId", async (req: any, res: any) => {
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
  app.post("/api/sessions/:sessionId/turns", async (req: any, res: any) => {
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
      metrics,
      now,
      clock: deps.clock,
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
  app.get("/api/sessions/:sessionId/turns/:turnId/events", (req: any, res: any) => {
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
      const isTerminalEvent = (event: any) =>
        event.type === "turn_completed" || event.type === "turn_cancelled" || event.type === "turn_failed";

      const { replay, state, unsubscribe } = deps.manager.subscribe(sessionId, turnId, afterSeq, (event: any) => {
        res.write(`id: ${event.seq}\n`);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
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
  app.post("/api/sessions/:sessionId/turns/:turnId/cancel", (req: any, res: any) => {
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
  app.post("/api/sessions/:sessionId/approve", (req: any, res: any) => {
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

  // GET /api/metrics — JSON metrics (process-local, reset on restart)
  app.get("/api/metrics", (req: any, res: any) => {
    // Validation first so gauges in snapshot are fresh
    let validation: ValidationResult | undefined;
    try {
      validation = doValidation();
    } catch {
      validation = undefined;
    }
    const snapshot = metrics.snapshot(now());
    res.json({
      ...snapshot,
      validation: validation
        ? {
            thresholds,
            stuckTurns: validation.stuckTurns,
            longWaitingApprovals: validation.longWaitingApprovals,
            idleSessions: validation.idleSessions,
          }
        : undefined,
    });
  });

  // GET /api/health — operational observability: boot diagnostics, persistence failures, single-process writer limitation, metrics
  app.get("/api/health", (req: any, res: any) => {
    const n = now();
    // Validation first so snapshot gauges reflect current stuck/idle state
    let validation: ValidationResult;
    try {
      validation = doValidation();
    } catch {
      validation = {
        stuckTurns: [],
        longWaitingApprovals: [],
        idleSessions: [],
        activeTurns: metrics.getGauge("activeTurns"),
        activeApprovals: metrics.getGauge("activeApprovals"),
      };
    }
    const snapshot = metrics.snapshot(n);

    const recent = snapshot.recent.counts;
    const hasRecentFailure =
      recent.persistenceFailures > 0 ||
      recent.quarantinedFiles > 0 ||
      recent.shutdownTimeouts > 0 ||
      recent.sessionsSkipped > 0;
    const hasStuck = validation.stuckTurns.length > 0 || validation.longWaitingApprovals.length > 0;

    const alerts: Array<{ level: string; category: string; message: string }> = [];
    if (recent.persistenceFailures > 0) alerts.push({ level: "error", category: "persistenceFailure", message: `${recent.persistenceFailures} persistence failures in last ${snapshot.recent.windowMs}ms` });
    if (recent.quarantinedFiles > 0) alerts.push({ level: "warn", category: "quarantine", message: `${recent.quarantinedFiles} quarantined files in last ${snapshot.recent.windowMs}ms` });
    if (recent.sessionsSkipped > 0) alerts.push({ level: "warn", category: "skippedSession", message: `${recent.sessionsSkipped} sessions skipped in last ${snapshot.recent.windowMs}ms` });
    if (recent.shutdownTimeouts > 0) alerts.push({ level: "warn", category: "shutdownTimeout", message: `${recent.shutdownTimeouts} shutdown timeouts in last ${snapshot.recent.windowMs}ms` });
    if (validation.stuckTurns.length > 0) alerts.push({ level: "warn", category: "stuckTurn", message: `${validation.stuckTurns.length} active turn(s) exceed stuckTurnMs=${thresholds.stuckTurnMs}` });
    if (validation.longWaitingApprovals.length > 0) alerts.push({ level: "warn", category: "approvalWait", message: `${validation.longWaitingApprovals.length} approval(s) exceed approvalWaitMs=${thresholds.approvalWaitMs}` });
    if (validation.idleSessions.length > 0) alerts.push({ level: "info", category: "idleSession", message: `${validation.idleSessions.length} idle session(s) exceed idleSessionMs=${thresholds.idleSessionMs}` });

    const status = hasRecentFailure || hasStuck ? "degraded" : "ok";

    const health: any = {
      status,
      timestamp: n,
      alerts,
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
      metrics: {
        counters: snapshot.counters,
        gauges: snapshot.gauges,
        recent: snapshot.recent,
        durations: snapshot.durations,
        validation: {
          thresholds,
          stuckTurns: validation.stuckTurns,
          longWaitingApprovals: validation.longWaitingApprovals,
          idleSessions: validation.idleSessions,
        },
        meta: snapshot.meta,
      },
      diagnostics: {
        boot: deps.getBootDiagnostics ? deps.getBootDiagnostics() : undefined,
        persistence: deps.getPersistenceDiagnostics
          ? deps.getPersistenceDiagnostics()
          : (deps.manager.getStore() as any).getDiagnostics
            ? (deps.manager.getStore() as any).getDiagnostics()
            : undefined,
        approvals: {
          pendingCount: (deps.approvals as any).getPendingCount ? (deps.approvals as any).getPendingCount() : (deps.approvals as any).entries ? (deps.approvals as any).entries.size : undefined,
          byTurnCount: (deps.approvals as any).byTurn ? (deps.approvals as any).byTurn.size : undefined,
        },
      },
    };

    res.json(health);
  });

  // GET /api/diagnostics/persistence — detailed persistence failures and quarantine
  app.get("/api/diagnostics/persistence", (req: any, res: any) => {
    const store: any = deps.manager.getStore();
    const diagnostics = store.getDiagnostics ? store.getDiagnostics() : { warnings: [], persistenceFailures: [] };
    res.json({
      ...diagnostics,
      persistenceFailures: store.getPersistenceFailures ? store.getPersistenceFailures() : diagnostics.persistenceFailures || [],
      metrics: metrics.snapshot(now()),
    });
  });

  return app;
}
