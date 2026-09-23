import type { Express } from "express";
import type { TurnManager } from "../agent/turn-manager.js";
import type { ApprovalRegistry } from "../agent/approval-registry.js";
import type { SessionManager } from "../agent/session-manager.js";
import type { MetricsRegistry } from "../agent/metrics.js";
import type { ProjectTrustRegistry } from "../agent/project-trust.js";
import type { SecurityPolicy } from "../security.js";
import type { AppDeps, LongRunningThresholds, ValidationResult } from "../app.js";

/**
 * Thresholds after boot defaults are applied. `idleSessionMs` stays nullable:
 * unlike the other two it is disabled by default.
 */
export interface ResolvedThresholds {
  stuckTurnMs: number;
  approvalWaitMs: number;
  idleSessionMs: number | undefined;
}

/**
 * Everything the route modules need, composed once in `createApp` and passed
 * to each `register*` function. Owning it in one place keeps single ownership
 * of the per-app state: `activeControllers` (turn lifecycle), the metrics
 * registry, the trust registry and the session manager each have exactly one
 * instance per app, created here — never inside a route module.
 */
export interface AppRuntime {
  deps: AppDeps;
  sessionManager: SessionManager;
  /** Abort controller per in-flight turn; the only writers are the turn routes and `abortActiveTurns`. */
  activeControllers: Map<string, AbortController>;
  metrics: MetricsRegistry;
  trust: ProjectTrustRegistry;
  now: () => number;
  thresholds: ResolvedThresholds;
  doValidation: () => ValidationResult;
  security: SecurityPolicy | undefined;
}

/**
 * The express app plus the lifecycle hooks `boot.ts` and the tests consume.
 * Express has no typed place for these, so the app object is built as an
 * `AppHandle` from the start instead of monkey-patching untyped fields.
 */
export interface AppHandle extends Express {
  /** Clears the validation timer. Idempotent; safe to call from every drain path. */
  close(): void;
  /** Aborts every in-flight turn the way POST .../cancel does. Returns how many were aborted. */
  abortActiveTurns(reason?: string): number;
  _validationTimer(): ReturnType<typeof setInterval> | undefined;
  _metrics: MetricsRegistry;
  _doValidation(): ValidationResult;
}

/** The long-running-turn thresholds, with boot defaults filled in. */
export function resolveThresholds(partial: LongRunningThresholds | undefined): ResolvedThresholds {
  return {
    stuckTurnMs: partial?.stuckTurnMs ?? 2 * 60 * 60 * 1000,
    approvalWaitMs: partial?.approvalWaitMs ?? 30 * 60 * 1000,
    idleSessionMs: partial?.idleSessionMs,
  };
}
