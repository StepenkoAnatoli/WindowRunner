import express from "express";
import * as path from "node:path";
import type { TurnManager } from "./agent/turn-manager.js";
import type { ApprovalRegistry } from "./agent/approval-registry.js";
import type { LLMProvider } from "./providers/types.js";
import type { ToolDefinition } from "./agent/tools/types.js";
import { TurnRunner, type TurnResult } from "./agent/loop.js";
import { SessionManager } from "./agent/session-manager.js";
import { MetricsRegistry } from "./agent/metrics.js";
import { createSecurityPolicy, type SecurityPolicy, type SecurityOptions } from "./security.js";
import { ProjectTrustRegistry, isValidConfigHash } from "./agent/project-trust.js";
import { ProfileError, type ActiveProviderBox } from "./provider-service.js";
import type { ProviderService } from "./provider-service.js";
import type { TurnUsageRecord } from "./usage-log.js";

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
  /** Per-turn loop limits; defaults are used for anything omitted. */
  limits?: Partial<{ maxSteps: number; modelCallTimeoutMs: number; toolTimeoutMs: number; approvalTimeoutMs: number }>;
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
  /**
   * HTTP security boundary (src/security.ts): Host validation, Origin
   * allowlist and bearer-token auth in front of every /api route. Boot always
   * supplies one. Tests that construct the app directly may omit it, which
   * yields an unauthenticated app — that is a test convenience, never a
   * production configuration (startServer refuses it off loopback).
   */
  security?: SecurityOptions | SecurityPolicy;
  /** Project trust registry; an in-memory one is created when omitted. */
  trust?: ProjectTrustRegistry;
  /**
   * Directory of the built web UI (packages/web/dist/app). When set, it is
   * served at `/` — public assets, but behind Host/Origin validation. Unset
   * when the UI has not been built; the API works without it.
   */
  webDir?: string;
  /**
   * Directory of the built provider dashboard (packages/web/dist/dashboard).
   * Served at `/dashboard` (+ /dashboard/* assets), same public-but-validated
   * treatment as the main UI. Unset when not built.
   */
  dashboardDir?: string;
  /**
   * Mutable active-provider box (provider-service.ts). When set, every new
   * turn reads the CURRENT provider from the box at turn start, so activating
   * or editing the active profile takes effect for the next turn without a
   * restart. When unset, `provider` is used for every turn (test apps).
   */
  activeProvider?: ActiveProviderBox;
  /**
   * Provider profile management (the /api/providers* routes). When unset
   * (test apps without a profile store) the routes are not registered.
   */
  providerAdmin?: ProviderService;
  /** Appended once per turn at its terminal state (dashboard usage table). */
  recordTurnUsage?: (turnId: string, sessionId: string, result: TurnResult) => void;
  /** Usage history behind GET /api/usage. When unset the route is not registered. */
  usageLog?: {
    recent(limit: number): TurnUsageRecord[];
    /** Records held in memory; the response reports it so the client can say "showing N of M". */
    readonly length?: number;
    /** True when older records are known to be missing (ring trimmed, tail window, or a rotation). */
    readonly bounded?: boolean;
  };
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

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const TURN_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_MESSAGE_CHARS = 200_000;
const MAX_PATH_CHARS = 4_096;
const MAX_REASON_CHARS = 1_000;

export function createApp(deps: AppDeps) {
  const app: any = express();
  app.disable("x-powered-by");

  const now = deps.now ?? (() => Date.now());
  const metrics = deps.metrics ?? new MetricsRegistry({ now });
  const trust = deps.trust ?? new ProjectTrustRegistry({ now });

  // Security boundary first: nothing below runs for a request that fails
  // Host/Origin validation or (in token mode) lacks a valid bearer token.
  // Body parsing comes after it so an unauthenticated client cannot make the
  // server buffer a payload.
  const security: SecurityPolicy | undefined = deps.security
    ? "middleware" in deps.security
      ? deps.security
      : createSecurityPolicy({
          ...deps.security,
          onReject: (rejection) => {
            metrics.recordSecurityRejection(rejection.kind, { detail: `${rejection.code} ${rejection.method} ${rejection.path}` });
            deps.security && "onReject" in deps.security && deps.security.onReject?.(rejection);
          },
        })
    : undefined;
  if (security) app.use(security.middleware);
  app.use(express.json({ limit: "1mb" }));
  app.use((err: any, _req: any, res: any, next: any) => {
    if (err && (err.type === "entity.parse.failed" || err.type === "entity.too.large" || err.status === 400 || err.status === 413)) {
      return res.status(err.status ?? 400).json({ error: err.type === "entity.too.large" ? "request body too large" : "request body must be valid JSON", code: err.type === "entity.too.large" ? "BODY_TOO_LARGE" : "BODY_INVALID" });
    }
    next(err);
  });

  // Path/body validation helpers. Each returns undefined on success or sends
  // the 400 and returns the response.
  const requireSessionId = (req: any, res: any): string | undefined => {
    const sessionId = req.params.sessionId;
    if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
      res.status(400).json({ error: "sessionId must match [A-Za-z0-9_-]{1,128}", code: "SESSION_ID_INVALID" });
      return undefined;
    }
    return sessionId;
  };
  const requireTurnId = (req: any, res: any): string | undefined => {
    const turnId = req.params.turnId;
    if (typeof turnId !== "string" || !TURN_ID_RE.test(turnId)) {
      res.status(400).json({ error: "turnId must match [A-Za-z0-9_-]{1,128}", code: "TURN_ID_INVALID" });
      return undefined;
    }
    return turnId;
  };
  const bodyObject = (req: any, res: any): Record<string, unknown> | undefined => {
    const body = req.body;
    if (body === undefined || body === null) return {};
    if (typeof body !== "object" || Array.isArray(body)) {
      res.status(400).json({ error: "request body must be a JSON object", code: "BODY_INVALID" });
      return undefined;
    }
    return body;
  };
  const isPathString = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= MAX_PATH_CHARS && !value.includes("\0");
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

  // Security headers for the static UIs (main app and dashboard): nothing is
  // cached so a rebuilt bundle is picked up, and the same strict CSP the main
  // UI gets (same-origin scripts/connections only) applies to the dashboard.
  const uiHeaders: Record<string, string> = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'",
  };

  // Provider dashboard (packages/web/dist/dashboard), served at /dashboard.
  // Public assets like the main UI — Host/Origin validation still applies and
  // every API call the page makes carries the bearer token — but it is NOT
  // under /api/, so no token is needed to load the page itself. Registered
  // before the main static handler so /dashboard* can never be answered by
  // the app bundle.
  if (deps.dashboardDir) {
    const dashDir = deps.dashboardDir;
    app.get("/dashboard", (_req: any, res: any, next: any) => {
      res.sendFile(path.join(dashDir, "dashboard.html"), { headers: uiHeaders }, (err: any) => {
        if (err) next();
      });
    });
    app.use(
      "/dashboard",
      express.static(dashDir, {
        fallthrough: true,
        setHeaders: (res: any) => {
          for (const [k, v] of Object.entries(uiHeaders)) res.setHeader(k, v);
        },
      })
    );
  }

  // Static web UI. index.html is never cached so a rebuilt bundle is picked up
  // and a stale page cannot keep an old API contract; hashed assets could be
  // cached but the bundle is small, so keep it simple and uniform. The static
  // handler is skipped for every protected prefix (/api/ …) so a file in the UI
  // directory can never shadow or answer for an API route.
  if (deps.webDir) {
    const protectedPrefixes = security?.protectedPrefixes ?? ["/api/"];
    const serveStatic = express.static(deps.webDir, {
      index: "index.html",
      fallthrough: true,
      etag: true,
      setHeaders: (res: any) => {
        for (const [k, v] of Object.entries(uiHeaders)) res.setHeader(k, v);
      },
    });
    app.use((req: any, res: any, next: any) => {
      const p: string = req.path ?? "";
      if (p === "/healthz" || protectedPrefixes.some((prefix) => p.startsWith(prefix))) return next();
      return serveStatic(req, res, next);
    });
  }

  // GET /healthz — liveness only: "the process is up and serving HTTP". It
  // deliberately runs no validation and touches no store, so it stays cheap
  // enough for container health checks. Readiness/diagnostics live at
  // /api/health.
  app.get("/healthz", (_req: any, res: any) => {
    res.json({ status: "ok" });
  });

  // POST /api/sessions/:sessionId — explicit session creation with pinned root
  app.post("/api/sessions/:sessionId", async (req: any, res: any) => {
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
    const sessionId = requireSessionId(req, res);
    if (!sessionId) return;
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

    // Read the CURRENT provider at turn start (hot-swap box): activating or
    // editing the active profile changes the next turn, not a restart.
    const provider = deps.activeProvider ? deps.activeProvider.get() : deps.provider;

    const runner = new TurnRunner({
      provider,
      tools: deps.tools,
      approvals: deps.approvals,
      manager: deps.manager,
      allowedRoots: deps.allowedRoots,
      metrics,
      now,
      clock: deps.clock,
      trust,
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
  app.get("/api/sessions/:sessionId/turns/:turnId/events", (req: any, res: any) => {
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
      if (typeof cursorRaw !== "string" || !/^\d{1,15}$/.test(cursorRaw)) {
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
    if (log && log.state.sessionId !== sessionId) {
      return res.status(404).json({ error: "turn does not belong to session", code: "TURN_NOT_FOUND" });
    }

    const controller = activeControllers.get(turnId);
    if (controller) {
      controller.abort(new Error(reason ?? "cancelled"));
    }
    deps.approvals.cancelTurn(turnId);

    res.status(202).json({ cancelled: true });
  });

  // POST /api/sessions/:sessionId/approve
  app.post("/api/sessions/:sessionId/approve", (req: any, res: any) => {
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

  // Project trust (P0-02). A grant is keyed by the session's *real* root and a
  // configHash the client obtained from the tool's PROJECT_NOT_TRUSTED result
  // (or from an approval request). It is a separate, explicit act from
  // approving a tool call.
  //
  // GET    /api/sessions/:sessionId/trust  -> { realRoot, canonicalRoot, grant|null }
  // POST   /api/sessions/:sessionId/trust  { configHash, source? } -> 201 grant
  // DELETE /api/sessions/:sessionId/trust  -> 204 (revoked) | 404
  app.get("/api/sessions/:sessionId/trust", (req: any, res: any) => {
    const sessionId = requireSessionId(req, res);
    if (!sessionId) return;
    const session = sessionManager.getSession(sessionId);
    if (!session) return res.status(404).json({ error: "session not found", code: "SESSION_NOT_FOUND", sessionId });
    const realRoot = session.projectRoot.getRealRoot();
    res.json({ sessionId, realRoot, canonicalRoot: session.projectRoot.getRoot(), grant: trust.get(realRoot) ?? null });
  });

  app.post("/api/sessions/:sessionId/trust", async (req: any, res: any) => {
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

  app.delete("/api/sessions/:sessionId/trust", async (req: any, res: any) => {
    const sessionId = requireSessionId(req, res);
    if (!sessionId) return;
    const session = sessionManager.getSession(sessionId);
    if (!session) return res.status(404).json({ error: "session not found", code: "SESSION_NOT_FOUND", sessionId });
    const revoked = await trust.revoke(session.projectRoot.getRealRoot());
    if (!revoked) return res.status(404).json({ error: "project is not trusted", code: "TRUST_NOT_FOUND" });
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
    if (recent.securityRejections > 0) alerts.push({ level: "warn", category: "securityRejection", message: `${recent.securityRejections} request(s) refused by the security boundary in last ${snapshot.recent.windowMs}ms` });
    if (validation.stuckTurns.length > 0) alerts.push({ level: "warn", category: "stuckTurn", message: `${validation.stuckTurns.length} active turn(s) exceed stuckTurnMs=${thresholds.stuckTurnMs}` });
    if (validation.longWaitingApprovals.length > 0) alerts.push({ level: "warn", category: "approvalWait", message: `${validation.longWaitingApprovals.length} approval(s) exceed approvalWaitMs=${thresholds.approvalWaitMs}` });
    if (validation.idleSessions.length > 0) alerts.push({ level: "info", category: "idleSession", message: `${validation.idleSessions.length} idle session(s) exceed idleSessionMs=${thresholds.idleSessionMs}` });

    const status = hasRecentFailure || hasStuck ? "degraded" : "ok";

    const health: any = {
      status,
      timestamp: n,
      alerts,
      security: security ? security.describe() : { mode: "off", allowedHosts: [], allowedOrigins: "loopback", note: "no security policy configured (test app)" },
      trust: trust.getDiagnostics(),
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

  // ---------------------------------------------------------------------------
  // Provider profiles (dashboard). All under /api/ → bearer token required by
  // the security middleware like every other API route. Responses are always
  // redacted: an apiKey never leaves the process unmasked (provider-service).
  // ---------------------------------------------------------------------------
  if (deps.providerAdmin) {
    const sendProfileError = (res: any, err: unknown) => {
      if (err instanceof ProfileError) {
        const body: Record<string, unknown> = { error: err.message, code: err.code };
        if (err.errors) body.errors = err.errors;
        return res.status(err.status).json(body);
      }
      console.error(err);
      return res.status(500).json({ error: "provider operation failed", code: "PROVIDER_ERROR" });
    };
    const requireProfileId = (req: any, res: any): string | undefined => {
      const id = req.params.id;
      if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
        res.status(404).json({ error: `profile "${id ?? ""}" not found`, code: "PROFILE_NOT_FOUND" });
        return undefined;
      }
      return id;
    };

    // GET /api/providers — list profiles (keys masked) + which is active + last health check
    app.get("/api/providers", (_req: any, res: any) => {
      res.json({ activeProfileId: deps.providerAdmin!.activeProfileId, profiles: deps.providerAdmin!.listProfiles() });
    });

    // POST /api/providers — create a profile. Body: { id, label, kind, baseUrl?, model, apiKey? }
    app.post("/api/providers", async (req: any, res: any) => {
      const body = bodyObject(req, res);
      if (!body) return;
      try {
        const profile = await deps.providerAdmin!.create(body);
        res.status(201).json(profile);
      } catch (err) {
        sendProfileError(res, err);
      }
    });

    // PATCH /api/providers/:id — update label/model/baseUrl/apiKey (apiKey omitted = keep existing)
    app.patch("/api/providers/:id", async (req: any, res: any) => {
      const id = requireProfileId(req, res);
      if (!id) return;
      const body = bodyObject(req, res);
      if (!body) return;
      try {
        const profile = await deps.providerAdmin!.update(id, body);
        res.json(profile);
      } catch (err) {
        sendProfileError(res, err);
      }
    });

    // DELETE /api/providers/:id — refuse if it is the active profile (409 PROVIDER_ACTIVE)
    app.delete("/api/providers/:id", async (req: any, res: any) => {
      const id = requireProfileId(req, res);
      if (!id) return;
      try {
        await deps.providerAdmin!.remove(id);
        res.status(204).end();
      } catch (err) {
        sendProfileError(res, err);
      }
    });

    // POST /api/providers/:id/activate — hot-swap; 404 if id unknown
    app.post("/api/providers/:id/activate", async (req: any, res: any) => {
      const id = requireProfileId(req, res);
      if (!id) return;
      try {
        const profile = await deps.providerAdmin!.activate(id);
        res.json({ activeProfileId: id, profile });
      } catch (err) {
        sendProfileError(res, err);
      }
    });

    // POST /api/providers/:id/test — one minimal request ("say OK") with a short
    // timeout. { ok, latencyMs, reply } or { ok: false, code, message }. The
    // reply goes only to the authenticated dashboard, never to a log.
    app.post("/api/providers/:id/test", async (req: any, res: any) => {
      const id = requireProfileId(req, res);
      if (!id) return;
      try {
        res.json(await deps.providerAdmin!.test(id));
      } catch (err) {
        sendProfileError(res, err);
      }
    });
  }

  // GET /api/usage?limit=50 — recent turns for the dashboard's history table.
  // Newest first; estCostUsd is only present when a price table entry exists
  // for the exact model id (never fabricated).
  if (deps.usageLog) {
    app.get("/api/usage", (req: any, res: any) => {
      const raw = req.query.limit;
      let limit = 50;
      if (raw !== undefined) {
        if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
          return res.status(400).json({ error: "limit must be a positive integer", code: "LIMIT_INVALID" });
        }
        limit = Number(raw);
        if (limit < 1 || limit > 500) {
          return res.status(400).json({ error: "limit must be between 1 and 500", code: "LIMIT_INVALID" });
        }
      }
      // `retained`/`bounded` let the dashboard state that the table is the
      // newest turns only: the ring is capped, the boot read is a bounded
      // tail, and usage.jsonl rotates — so "no more rows" is not "no more
      // turns ever".
      res.json({
        records: deps.usageLog!.recent(limit),
        retained: deps.usageLog!.length,
        bounded: deps.usageLog!.bounded ?? false,
      });
    });
  }

  return app;
}
