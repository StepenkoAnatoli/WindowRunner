import express from "express";
import type { Request, Response, NextFunction } from "express";
import type { TurnManager } from "./agent/turn-manager.js";
import type { ApprovalRegistry } from "./agent/approval-registry.js";
import type { LLMProvider } from "./providers/types.js";
import type { ToolDefinition } from "./agent/tools/types.js";
import { TurnRunner, type TurnResult } from "./agent/loop.js";
import { SessionManager } from "./agent/session-manager.js";
import { MetricsRegistry } from "./agent/metrics.js";
import { createSecurityPolicy, type SecurityPolicy, type SecurityOptions } from "./security.js";
import { ProjectTrustRegistry } from "./agent/project-trust.js";
import type { ActiveProviderBox } from "./provider-service.js";
import type { ProviderService } from "./provider-service.js";
import type { TurnUsageRecord } from "./usage-log.js";
import { registerSessionRoutes } from "./http/routes/sessions.js";
import { registerTurnRoutes } from "./http/routes/turns.js";
import { registerObservabilityRoutes } from "./http/routes/observability.js";
import { registerProviderRoutes } from "./http/routes/providers.js";
import { registerSkillRoutes } from "./http/routes/skills.js";
import { registerStaticUi, isClientAppRoute } from "./http/static-ui.js";
import { resolveThresholds, type AppHandle, type AppRuntime, type ResolvedThresholds } from "./http/runtime.js";

// Deep-route classification lives with the static-UI module; re-exported for
// the tests that reason about route serving.
export { isClientAppRoute };

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
  getBootDiagnostics?: () => unknown;
  getPersistenceDiagnostics?: () => unknown;
  // Metrics: process-local, reset on restart, windowed alerts
  metrics?: MetricsRegistry;
  now?: () => number;
  validationIntervalMs?: number; // default 60000, 0 to disable (for tests)
  validationThresholds?: LongRunningThresholds;
  clock?: unknown; // optional fake clock for tests, passed opaquely to TurnRunner
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
   * Directory of the built desktop renderer shell
   * (packages/desktop/dist/renderer). Served at `/desktop` (+ /desktop/*
   * assets), same public-but-validated treatment as the other UIs. The
   * Electron window loads this page from the server's own origin, so its API
   * and SSE calls are same-origin and the Origin policy is unchanged. Unset
   * when not built.
   */
  desktopDir?: string;
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
  thresholds: ResolvedThresholds
): ValidationResult {
  // All three classes declare their long-running detectors; the optional
  // idle threshold is the only conditional.
  return {
    stuckTurns: manager.getStuckTurns(now, thresholds.stuckTurnMs),
    longWaitingApprovals: approvals.getLongWaitingApprovals(now, thresholds.approvalWaitMs),
    idleSessions:
      thresholds.idleSessionMs !== undefined ? sessionManager.getIdleSessions(now, thresholds.idleSessionMs) : [],
    activeTurns: manager.getActiveTurnCount(),
    activeApprovals: approvals.getPendingCount(),
  };
}

export function createApp(deps: AppDeps): AppHandle {
  const now = deps.now ?? (() => Date.now());
  const metrics = deps.metrics ?? new MetricsRegistry({ now });
  const trust = deps.trust ?? new ProjectTrustRegistry({ now });

  // Security boundary first: nothing below runs for a request that fails
  // Host/Origin validation or (in token mode) lacks a valid bearer token.
  // Body parsing comes after it so an unauthenticated client cannot make the
  // server buffer a payload.
  let security: SecurityPolicy | undefined;
  if (deps.security) {
    if ("middleware" in deps.security) {
      security = deps.security;
    } else {
      const options = deps.security;
      security = createSecurityPolicy({
        ...options,
        onReject: (rejection) => {
          metrics.recordSecurityRejection(rejection.kind, { detail: `${rejection.code} ${rejection.method} ${rejection.path}` });
          options.onReject?.(rejection);
        },
      });
    }
  }

  // Session lifecycle (one-active-turn policy, root pinning). The terminal
  // checker is wired to the same TurnManager the routes read, so there is one
  // source of truth for "is this turn still running".
  const sessionManager = deps.sessionManager ?? new SessionManager();
  sessionManager.setTurnTerminalChecker((turnId) => {
    const log = deps.manager.getLog(turnId);
    return log ? log.state.isTerminal : true;
  });

  const runtime: AppRuntime = {
    deps,
    sessionManager,
    activeControllers: new Map<string, AbortController>(),
    metrics,
    trust,
    now,
    thresholds: resolveThresholds(deps.validationThresholds),
    doValidation: () => {
      const result = runValidation(deps.manager, sessionManager, deps.approvals, now(), runtime.thresholds);
      metrics.setGauge("activeTurns", result.activeTurns);
      metrics.setGauge("activeApprovals", result.activeApprovals);
      metrics.setGauge("stuckTurns", result.stuckTurns.length);
      metrics.setGauge("idleSessions", result.idleSessions.length);
      return result;
    },
    security,
  };

  // Wire metrics into stores if they support it (optional capability).
  wireMetrics(deps.manager.getStore(), metrics, now);
  wireMetrics(sessionStoreOf(sessionManager), metrics, now);

  const app = express() as AppHandle;
  app.disable("x-powered-by");
  if (security) app.use(security.middleware);
  app.use(express.json({ limit: "1mb" }));
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const type = (err as { type?: unknown } | null)?.type;
    const status = (err as { status?: unknown } | null)?.status;
    if (type === "entity.parse.failed" || type === "entity.too.large" || status === 400 || status === 413) {
      const tooLarge = type === "entity.too.large" || status === 413;
      return res.status(tooLarge ? 413 : 400).json(
        tooLarge
          ? { error: "request body too large", code: "BODY_TOO_LARGE" }
          : { error: "request body must be valid JSON", code: "BODY_INVALID" }
      );
    }
    next(err);
  });

  // Validation loop — explicit lifecycle ownership
  const validationIntervalMs = deps.validationIntervalMs ?? 60_000;
  let validationTimer: ReturnType<typeof setInterval> | undefined;

  if (validationIntervalMs > 0) {
    validationTimer = setInterval(() => runtime.doValidation(), validationIntervalMs);
    // Don't prevent process exit if only timer remains
    if (validationTimer && typeof validationTimer.unref === "function") validationTimer.unref();
    // Initial validation
    try { runtime.doValidation(); } catch {}
  }

  // Lifecycle hooks (AppHandle): used by boot drain paths and the tests.
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
    for (const [turnId, controller] of runtime.activeControllers) {
      controller.abort(new Error(reason));
      deps.approvals.cancelTurn(turnId);
      aborted++;
    }
    return aborted;
  };
  app._validationTimer = () => validationTimer;
  app._metrics = metrics;
  app._doValidation = () => runtime.doValidation();

  // Route modules, in the order the surface is documented: static UIs first
  // (exact paths win over the app bundle), then the API resources.
  registerStaticUi(app, runtime);
  registerSessionRoutes(app, runtime);
  registerTurnRoutes(app, runtime);
  registerObservabilityRoutes(app, runtime);
  registerProviderRoutes(app, runtime);
  registerSkillRoutes(app, runtime);

  return app;
}

/** Structural probe for SessionManager's private optional session store field. */
function sessionStoreOf(sessionManager: SessionManager): unknown {
  return (sessionManager as unknown as { sessionStore?: unknown }).sessionStore;
}

/** Optional metrics capability on persistence/session stores. */
function wireMetrics(
  store: unknown,
  metrics: MetricsRegistry,
  now: () => number
): void {
  const capable = store as {
    setMetrics?: (m: MetricsRegistry) => void;
    setNow?: (n: () => number) => void;
  };
  try {
    if (capable && typeof capable.setMetrics === "function") {
      capable.setMetrics(metrics);
      if (typeof capable.setNow === "function") capable.setNow(now);
    }
  } catch {}
}
