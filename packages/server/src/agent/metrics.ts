/**
 * Process-local metrics for persistence, quarantine, skipped sessions,
 * shutdown timeouts, and long-running validation.
 *
 * Design per review adjustments:
 * - No persistence (no metrics.json) — process-local, reset on restart.
 *   Existing durable diagnostics (FileTurnLogStore/FileSessionStore warnings)
 *   remain the historical source.
 * - Shutdown timeout counted exactly once at mapping boundary (loop/executor),
 *   not in deadline.ts.
 * - Time-windowed health via bounded ring buffer of timestamped incidents.
 * - No high-cardinality labels: turn/session IDs only in bounded incident
 *   records (maxIncidents FIFO), never as Prometheus label dimensions.
 * - Separate session age from stuck-turn age: alerts on active turn duration,
 *   approval wait duration, idle session duration (optional).
 * - Lifecycle: timer owned by app, cleared on close().
 * - JSON metrics first (/api/metrics), prom deferred.
 */

export type IncidentCategory =
  | "persistenceFailure"
  | "quarantine"
  | "skippedSession"
  | "shutdownTimeout"
  | "securityRejection";

export interface Incident {
  at: number;
  category: IncidentCategory;
  /** low-cardinality operation kind: model | tool | approval */
  operationKind?: string;
  detail?: string;
  /** bounded, truncated to 64 chars, not used as metric label */
  turnId?: string;
  sessionId?: string;
}

export interface MetricsOptions {
  /** wall-clock or injectable clock; default Date.now */
  now?: () => number;
  /** bounded ring buffer size; default 100 */
  maxIncidents?: number;
  /** health window; default 5 minutes */
  windowMs?: number;
  /** max duration samples per name; default 200 */
  maxDurationSamples?: number;
}

export interface MetricsSnapshot {
  timestamp: number;
  uptimeMs: number;
  /** process-local counters — reset on restart by design */
  counters: {
    persistenceFailures: number;
    quarantinedFiles: number;
    sessionsSkipped: number;
    shutdownTimeouts: number;
    shutdownTimeoutsByKind: Record<string, number>;
    /** requests refused by the security boundary (host, origin, auth) */
    securityRejections: number;
    securityRejectionsByKind: Record<string, number>;
  };
  gauges: {
    activeTurns: number;
    activeApprovals: number;
    stuckTurns: number;
    idleSessions: number;
  };
  recent: {
    windowMs: number;
    counts: {
      persistenceFailures: number;
      quarantinedFiles: number;
      sessionsSkipped: number;
      shutdownTimeouts: number;
      securityRejections: number;
    };
    incidents: Incident[];
  };
  durations: Record<
    string,
    { count: number; avgMs: number; maxMs: number; samples: number[] }
  >;
  meta: {
    resetOnRestart: boolean;
    windowClock: "injectable" | "wall";
    maxIncidents: number;
    note: string;
  };
}

const DEFAULT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_INCIDENTS = 100;
const DEFAULT_MAX_DURATION_SAMPLES = 200;

function truncateId(id: string | undefined, max = 64): string | undefined {
  if (!id) return undefined;
  return id.length > max ? id.slice(0, max) : id;
}

export class MetricsRegistry {
  private nowFn: () => number;
  private startedAt: number;
  private maxIncidents: number;
  private windowMs: number;
  private maxDurationSamples: number;
  private isInjectableClock: boolean;

  private counters = {
    persistenceFailures: 0,
    quarantinedFiles: 0,
    sessionsSkipped: 0,
    shutdownTimeouts: 0,
    shutdownTimeoutsByKind: new Map<string, number>(),
    securityRejections: 0,
    securityRejectionsByKind: new Map<string, number>(),
  };

  private gauges = {
    activeTurns: 0,
    activeApprovals: 0,
    stuckTurns: 0,
    idleSessions: 0,
  };

  private incidents: Incident[] = [];

  private durations = new Map<string, number[]>();

  constructor(opts: MetricsOptions = {}) {
    this.nowFn = opts.now ?? (() => Date.now());
    this.startedAt = this.nowFn();
    this.maxIncidents = opts.maxIncidents ?? DEFAULT_MAX_INCIDENTS;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxDurationSamples = opts.maxDurationSamples ?? DEFAULT_MAX_DURATION_SAMPLES;
    this.isInjectableClock = !!opts.now;
  }

  // ---- Counters + incidents (bounded ring) ----

  private pushIncident(incident: Incident): void {
    const bounded: Incident = {
      at: incident.at,
      category: incident.category,
      operationKind: incident.operationKind,
      detail: incident.detail ? incident.detail.slice(0, 256) : undefined,
      turnId: truncateId(incident.turnId),
      sessionId: truncateId(incident.sessionId),
    };
    this.incidents.push(bounded);
    if (this.incidents.length > this.maxIncidents) {
      // FIFO eviction
      this.incidents.splice(0, this.incidents.length - this.maxIncidents);
    }
  }

  recordPersistenceFailure(opts: { turnId?: string; sessionId?: string; detail?: string; at?: number } = {}): void {
    this.counters.persistenceFailures++;
    this.pushIncident({
      at: opts.at ?? this.nowFn(),
      category: "persistenceFailure",
      detail: opts.detail,
      turnId: opts.turnId,
      sessionId: opts.sessionId,
    });
  }

  recordQuarantine(opts: { turnId?: string; sessionId?: string; detail?: string; at?: number } = {}): void {
    this.counters.quarantinedFiles++;
    this.pushIncident({
      at: opts.at ?? this.nowFn(),
      category: "quarantine",
      detail: opts.detail,
      turnId: opts.turnId,
      sessionId: opts.sessionId,
    });
  }

  recordSkippedSession(opts: { sessionId?: string; detail?: string; at?: number } = {}): void {
    this.counters.sessionsSkipped++;
    this.pushIncident({
      at: opts.at ?? this.nowFn(),
      category: "skippedSession",
      detail: opts.detail,
      sessionId: opts.sessionId,
    });
  }

  /**
   * Single ownership point for shutdown timeout counting.
   * Call exactly once per abort-ignoring operation at mapping boundary
   * (loop for model, executor for tool). Do NOT call from deadline.ts.
   */
  recordShutdownTimeout(
    kind: string,
    opts: { turnId?: string; sessionId?: string; detail?: string; at?: number } = {}
  ): void {
    this.counters.shutdownTimeouts++;
    const cur = this.counters.shutdownTimeoutsByKind.get(kind) ?? 0;
    this.counters.shutdownTimeoutsByKind.set(kind, cur + 1);
    this.pushIncident({
      at: opts.at ?? this.nowFn(),
      category: "shutdownTimeout",
      operationKind: kind,
      detail: opts.detail,
      turnId: opts.turnId,
      sessionId: opts.sessionId,
    });
  }

  // ---- Gauges ----

  setGauge(name: keyof typeof this.gauges, value: number): void {
    this.gauges[name] = value;
  }

  getGauge(name: keyof typeof this.gauges): number {
    return this.gauges[name];
  }

  // ---- Durations ----

  observeDuration(name: string, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    let arr = this.durations.get(name);
    if (!arr) {
      arr = [];
      this.durations.set(name, arr);
    }
    arr.push(ms);
    if (arr.length > this.maxDurationSamples) {
      arr.splice(0, arr.length - this.maxDurationSamples);
    }
  }

  // ---- Windowed queries ----

  private recentIncidents(windowMs?: number, now?: number): Incident[] {
    const w = windowMs ?? this.windowMs;
    const n = now ?? this.nowFn();
    const cutoff = n - w;
    return this.incidents.filter((i) => i.at >= cutoff);
  }

  getRecentCounts(windowMs?: number, now?: number): MetricsSnapshot["recent"]["counts"] {
    const recent = this.recentIncidents(windowMs, now);
    const counts = {
      persistenceFailures: 0,
      quarantinedFiles: 0,
      sessionsSkipped: 0,
      shutdownTimeouts: 0,
      securityRejections: 0,
    };
    for (const inc of recent) {
      switch (inc.category) {
        case "persistenceFailure":
          counts.persistenceFailures++;
          break;
        case "quarantine":
          counts.quarantinedFiles++;
          break;
        case "skippedSession":
          counts.sessionsSkipped++;
          break;
        case "shutdownTimeout":
          counts.shutdownTimeouts++;
          break;
        case "securityRejection":
          counts.securityRejections++;
          break;
      }
    }
    return counts;
  }

  /**
   * A request refused by the security middleware (src/security.ts). `kind` is
   * host | origin | auth; `detail` is the route and code, never a credential.
   */
  recordSecurityRejection(kind: string, opts: { detail?: string; at?: number } = {}): void {
    this.counters.securityRejections++;
    const cur = this.counters.securityRejectionsByKind.get(kind) ?? 0;
    this.counters.securityRejectionsByKind.set(kind, cur + 1);
    this.pushIncident({
      at: opts.at ?? this.nowFn(),
      category: "securityRejection",
      operationKind: kind,
      detail: opts.detail,
    });
  }

  // ---- Snapshot / reset ----

  snapshot(now?: number): MetricsSnapshot {
    const n = now ?? this.nowFn();
    const recentIncidents = this.recentIncidents(this.windowMs, n);
    const recentCounts = this.getRecentCounts(this.windowMs, n);

    const shutdownByKind: Record<string, number> = {};
    for (const [k, v] of this.counters.shutdownTimeoutsByKind.entries()) {
      shutdownByKind[k] = v;
    }

    const securityByKind: Record<string, number> = {};
    for (const [k, v] of this.counters.securityRejectionsByKind.entries()) {
      securityByKind[k] = v;
    }

    const durations: MetricsSnapshot["durations"] = {};
    for (const [name, samples] of this.durations.entries()) {
      if (samples.length === 0) continue;
      const sum = samples.reduce((a, b) => a + b, 0);
      const avg = sum / samples.length;
      const max = Math.max(...samples);
      durations[name] = {
        count: samples.length,
        avgMs: Math.round(avg),
        maxMs: max,
        samples: [...samples],
      };
    }

    return {
      timestamp: n,
      uptimeMs: n - this.startedAt,
      counters: {
        persistenceFailures: this.counters.persistenceFailures,
        quarantinedFiles: this.counters.quarantinedFiles,
        sessionsSkipped: this.counters.sessionsSkipped,
        shutdownTimeouts: this.counters.shutdownTimeouts,
        shutdownTimeoutsByKind: shutdownByKind,
        securityRejections: this.counters.securityRejections,
        securityRejectionsByKind: securityByKind,
      },
      gauges: { ...this.gauges },
      recent: {
        windowMs: this.windowMs,
        counts: recentCounts,
        incidents: [...recentIncidents],
      },
      durations,
      meta: {
        resetOnRestart: true,
        windowClock: this.isInjectableClock ? "injectable" : "wall",
        maxIncidents: this.maxIncidents,
        note: "Process-local, reset on restart. Historical persistence info remains in durable diagnostics (FileTurnLogStore warnings / FileSessionStore boot).",
      },
    };
  }

  reset(): void {
    this.counters.persistenceFailures = 0;
    this.counters.quarantinedFiles = 0;
    this.counters.sessionsSkipped = 0;
    this.counters.shutdownTimeouts = 0;
    this.counters.shutdownTimeoutsByKind.clear();
    this.counters.securityRejections = 0;
    this.counters.securityRejectionsByKind.clear();
    this.gauges.activeTurns = 0;
    this.gauges.activeApprovals = 0;
    this.gauges.stuckTurns = 0;
    this.gauges.idleSessions = 0;
    this.incidents = [];
    this.durations.clear();
    this.startedAt = this.nowFn();
  }

  // For health derivation
  getWindowMs(): number {
    return this.windowMs;
  }

  getMaxIncidents(): number {
    return this.maxIncidents;
  }

  getIncidents(): Incident[] {
    return [...this.incidents];
  }
}
