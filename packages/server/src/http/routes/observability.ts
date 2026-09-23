import type { Express, Request, Response } from "express";
import type { AppRuntime, ResolvedThresholds } from "../runtime.js";
import type { ValidationResult } from "../../app.js";

/**
 * Observability routes: process-local metrics, operational health, and
 * persistence diagnostics. `/healthz` (liveness) lives with the static-UI
 * registration; everything here is under /api and therefore authenticated.
 *
 *   GET /api/metrics                    — metrics snapshot + fresh validation
 *   GET /api/health                     — status/alerts/security/trust/persistence/metrics
 *   GET /api/diagnostics/persistence    — detailed persistence failures + quarantine
 */

/** Run validation, degrading to gauge-only state when it throws. */
function validateOrGaugeFallback(rt: AppRuntime): ValidationResult {
  try {
    return rt.doValidation();
  } catch {
    return {
      stuckTurns: [],
      longWaitingApprovals: [],
      idleSessions: [],
      activeTurns: rt.metrics.getGauge("activeTurns"),
      activeApprovals: rt.metrics.getGauge("activeApprovals"),
    };
  }
}

/** File stores expose these; the in-memory test store does not. */
interface FileStoreLike {
  getDataDir?: () => string;
  getDiagnostics?: () => unknown;
  getPersistenceFailures?: () => unknown;
}

/** The validation slice both payloads report: thresholds plus the live detectors. */
function validationView(validation: ValidationResult, thresholds: ResolvedThresholds) {
  return {
    thresholds,
    stuckTurns: validation.stuckTurns,
    longWaitingApprovals: validation.longWaitingApprovals,
    idleSessions: validation.idleSessions,
  };
}

export function registerObservabilityRoutes(app: Express, rt: AppRuntime): void {
  const { deps, metrics, trust, now, thresholds, security } = rt;

  // GET /api/metrics — JSON metrics (process-local, reset on restart)
  app.get("/api/metrics", (_req: Request, res: Response) => {
    // Validation first so gauges in snapshot are fresh
    let validation: ValidationResult | undefined;
    try {
      validation = rt.doValidation();
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
  app.get("/api/health", (_req: Request, res: Response) => {
    const n = now();
    // Validation first so snapshot gauges reflect current stuck/idle state
    const validation = validateOrGaugeFallback(rt);
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

    const store = deps.manager.getStore() as FileStoreLike;
    const approvalsRegistry = deps.approvals as unknown as { byTurn?: Map<unknown, unknown> };

    res.json({
      status,
      timestamp: n,
      alerts,
      security: security ? security.describe() : { mode: "off", allowedHosts: [], allowedOrigins: "loopback", note: "no security policy configured (test app)" },
      trust: trust.getDiagnostics(),
      persistence: {
        mode: store.getDataDir ? "file" : "memory",
        dataDir: store.getDataDir ? store.getDataDir() : undefined,
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
        validation: validationView(validation, thresholds),
        meta: snapshot.meta,
      },
      diagnostics: {
        boot: deps.getBootDiagnostics ? deps.getBootDiagnostics() : undefined,
        persistence: deps.getPersistenceDiagnostics
          ? deps.getPersistenceDiagnostics()
          : store.getDiagnostics
            ? store.getDiagnostics()
            : undefined,
        approvals: {
          pendingCount: deps.approvals.getPendingCount(),
          byTurnCount: approvalsRegistry.byTurn ? approvalsRegistry.byTurn.size : undefined,
        },
      },
    });
  });

  // GET /api/diagnostics/persistence — detailed persistence failures and quarantine
  app.get("/api/diagnostics/persistence", (_req: Request, res: Response) => {
    const store = deps.manager.getStore() as FileStoreLike;
    const diagnostics = (store.getDiagnostics ? store.getDiagnostics() : { warnings: [], persistenceFailures: [] }) as Record<string, unknown>;
    res.json({
      ...diagnostics,
      persistenceFailures: store.getPersistenceFailures ? store.getPersistenceFailures() : diagnostics.persistenceFailures || [],
      metrics: metrics.snapshot(now()),
    });
  });
}
