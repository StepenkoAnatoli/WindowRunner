import {
  createInitialTurnState,
  reduceTurnState,
  type StreamEvent,
  type StreamEventWithoutSeq,
  type TurnState,
  type TurnId,
  type SessionId,
  type TurnLogStore,
} from "@windows-runner/shared";
import { InMemoryTurnLogStore } from "./turn-log-store.js";

/** Event types after which a turn emits nothing else. See appendAsync: these are
 *  applied in-memory even when durability is unavailable, so a turn always
 *  converges to a terminal state. */
const TERMINAL_EVENT_TYPES = new Set(["turn_completed", "turn_cancelled", "turn_failed"]);

export type EventListener = (event: StreamEvent) => void;

export interface TurnLog {
  events: StreamEvent[];
  state: TurnState;
  seqCounter: number;
  listeners: Set<EventListener>;
  abortController?: AbortController;
  /** When this log entered in-memory state (created here or recovered at boot). Fallback age reference for turns whose first event was never recorded (e.g. durable write failed at seq 1). */
  createdAt: number;
}

export interface TurnManagerDeps {
  store?: TurnLogStore;
  now?: () => number;
  durableBeforeNotify?: boolean; // when true, await store.append before notifying listeners (file persistence)
}

export class TurnManager {
  private logs = new Map<TurnId, TurnLog>();
  private store: TurnLogStore;
  private now: () => number;
  private durableBeforeNotify: boolean;

  constructor(deps: TurnManagerDeps = {}) {
    this.store = deps.store ?? new InMemoryTurnLogStore();
    this.now = deps.now ?? (() => Date.now());
    this.durableBeforeNotify = deps.durableBeforeNotify ?? false;
  }

  getStore(): TurnLogStore {
    return this.store;
  }

  // Create a new turn log, if not exists
  ensureLog(sessionId: SessionId, turnId: TurnId, limits?: TurnState["limits"]): TurnLog {
    let log = this.logs.get(turnId);
    if (!log) {
      const state = createInitialTurnState();
      state.sessionId = sessionId;
      state.turnId = turnId;
      if (limits) state.limits = limits;
      log = {
        events: [],
        state,
        seqCounter: 0,
        listeners: new Set(),
        createdAt: this.now(),
      };
      this.logs.set(turnId, log);
    }
    return log;
  }

  // Single writer: stamps seq + at, folds, notifies, persists
  // Sync version — async persistence (notify before durable), for backward compat and InMemory
  append(
    sessionId: SessionId,
    turnId: TurnId,
    eventWithoutSeq: StreamEventWithoutSeq
  ): StreamEvent {
    const log = this.ensureLog(sessionId, turnId);

    if (log.state.isTerminal) {
      return {
        seq: log.state.seq,
        at: this.now(),
        sessionId,
        turnId,
        ...eventWithoutSeq,
      } as StreamEvent;
    }

    log.seqCounter += 1;
    const sequenced = {
      seq: log.seqCounter,
      at: (eventWithoutSeq as any).at ?? this.now(),
      sessionId: eventWithoutSeq.sessionId ?? sessionId,
      turnId: eventWithoutSeq.turnId ?? turnId,
      ...eventWithoutSeq,
    } as StreamEvent;

    const newState = reduceTurnState(log.state, sequenced);
    log.events.push(sequenced);
    log.state = newState;

    for (const listener of log.listeners) {
      try {
        listener(sequenced);
      } catch {
        // ignore listener errors
      }
    }

    // Persist async, don't block (async mode)
    if (!this.durableBeforeNotify) {
      this.store.append(turnId, sequenced).catch((err) => {
        console.error(`Failed to persist event ${turnId} seq ${sequenced.seq}`, err);
      });
    } else {
      // Even in durable mode, sync append still fires async but caller should use appendAsync for true durability
      this.store.append(turnId, sequenced).catch((err) => {
        console.error(`Failed to persist event ${turnId} seq ${sequenced.seq}`, err);
      });
    }

    return sequenced;
  }

  // Async version — when durableBeforeNotify=true, awaits store.append before notifying (durable before SSE)
  // Invariant: durableBeforeNotify=true never emits SSE before persistence succeeds
  // If persistence fails in durable mode, do NOT emit, throw error
  async appendAsync(
    sessionId: SessionId,
    turnId: TurnId,
    eventWithoutSeq: StreamEventWithoutSeq
  ): Promise<StreamEvent> {
    const log = this.ensureLog(sessionId, turnId);

    if (log.state.isTerminal) {
      return {
        seq: log.state.seq,
        at: this.now(),
        sessionId,
        turnId,
        ...eventWithoutSeq,
      } as StreamEvent;
    }

    log.seqCounter += 1;
    const sequenced = {
      seq: log.seqCounter,
      at: (eventWithoutSeq as any).at ?? this.now(),
      sessionId: eventWithoutSeq.sessionId ?? sessionId,
      turnId: eventWithoutSeq.turnId ?? turnId,
      ...eventWithoutSeq,
    } as StreamEvent;

    // Durable before notify: persist first, only notify if persist succeeds
    if (this.durableBeforeNotify) {
      try {
        await this.store.append(turnId, sequenced);
      } catch (err) {
        // A terminal event is the turn's last word. If it cannot be made
        // durable, throwing would leave the turn non-terminal in memory
        // forever — it could not even record its own failure, and would ride
        // along as a zombie through every /api/health check and every
        // shutdown drain. Fold the terminal event in-memory instead: the
        // store has already recorded the persistence failure
        // (persistenceFailures + warning + metric), so nothing is lost
        // silently. Non-terminal events keep the strict contract: throw,
        // never emit before durable.
        if (TERMINAL_EVENT_TYPES.has(sequenced.type)) {
          const terminalState = reduceTurnState(log.state, sequenced);
          log.events.push(sequenced);
          log.state = terminalState;
          for (const listener of log.listeners) {
            try {
              listener(sequenced);
            } catch {
              // ignore
            }
          }
          console.error(`Terminal event ${turnId} seq ${sequenced.seq} (${sequenced.type}) could not be persisted; applied in-memory only`, err);
          return sequenced;
        }
        // Rollback seqCounter on failure to keep monotonic but allow retry
        log.seqCounter -= 1;
        console.error(`Failed to persist event ${turnId} seq ${sequenced.seq} before notify (durable mode, not emitting SSE)`, err);
        throw err;
      }
    }

    const newState = reduceTurnState(log.state, sequenced);
    log.events.push(sequenced);
    log.state = newState;

    for (const listener of log.listeners) {
      try {
        listener(sequenced);
      } catch {
        // ignore
      }
    }

    if (!this.durableBeforeNotify) {
      this.store.append(turnId, sequenced).catch((err) => {
        console.error(`Failed to persist event ${turnId} seq ${sequenced.seq} (async mode, reporting failure)`, err);
        // Failure is recorded in FileTurnLogStore persistenceFailures for observability
      });
    }

    return sequenced;
  }

  // Atomic replay-then-subscribe
  subscribe(
    sessionId: SessionId,
    turnId: TurnId,
    afterSeq: number,
    listener: EventListener
  ): { replay: StreamEvent[]; state: TurnState; unsubscribe: () => void } {
    const log = this.logs.get(turnId);
    if (!log) {
      throw new Error(`Turn not found: ${turnId}`);
    }
    if (log.state.sessionId !== sessionId) {
      throw new Error(`Session mismatch for turn ${turnId}`);
    }

    // Critical section: synchronous, no await
    const replay = log.events.filter((e) => e.seq > afterSeq);
    log.listeners.add(listener);

    const unsubscribe = () => {
      log.listeners.delete(listener);
    };

    return {
      replay,
      state: log.state,
      unsubscribe,
    };
  }

  snapshot(sessionId: SessionId, turnId: TurnId): TurnState & { events: StreamEvent[] } {
    const log = this.logs.get(turnId);
    if (!log) {
      throw new Error(`Turn not found: ${turnId}`);
    }
    if (log.state.sessionId !== sessionId) {
      throw new Error(`Session mismatch for turn ${turnId}`);
    }
    return {
      ...log.state,
      events: [...log.events],
      // clone maps for safety
      pendingApprovals: new Map(log.state.pendingApprovals),
      activeTools: new Map(log.state.activeTools),
    } as TurnState & { events: StreamEvent[] };
  }

  // For testing and routes
  getLog(turnId: TurnId): TurnLog | undefined {
    return this.logs.get(turnId);
  }

  // ---- Public snapshot API for long-running validation (avoids direct log access) ----
  getActiveTurnCount(): number {
    let count = 0;
    for (const log of this.logs.values()) {
      if (!log.state.isTerminal) count++;
    }
    return count;
  }

  getAllTurnStates(): Array<{
    turnId: TurnId;
    sessionId: SessionId;
    startedAt?: number;
    updatedAt: number;
    isTerminal: boolean;
    status: TurnState["status"];
  }> {
    const out: Array<{
      turnId: TurnId;
      sessionId: SessionId;
      startedAt?: number;
      updatedAt: number;
      isTerminal: boolean;
      status: TurnState["status"];
    }> = [];
    for (const [turnId, log] of this.logs.entries()) {
      out.push({
        turnId,
        sessionId: log.state.sessionId,
        startedAt: log.state.startedAt,
        updatedAt: log.state.updatedAt,
        isTerminal: log.state.isTerminal,
        status: log.state.status,
      });
    }
    return out;
  }

  getStuckTurns(now: number, thresholdMs: number): Array<{ turnId: TurnId; sessionId: SessionId; durationMs: number; startedAt: number }> {
    const stuck: Array<{ turnId: TurnId; sessionId: SessionId; durationMs: number; startedAt: number }> = [];
    for (const [turnId, log] of this.logs.entries()) {
      if (log.state.isTerminal) continue;
      // `updatedAt` is 0 until the first event is folded in (createInitialTurnState);
      // 0 would otherwise age the turn from the Unix epoch. Fall back to the log's
      // in-memory creation time for turns whose first event was never recorded
      // (e.g. the durable write of turn_started failed).
      const startedAt = log.state.startedAt ?? (log.state.updatedAt > 0 ? log.state.updatedAt : log.createdAt);
      const duration = now - startedAt;
      if (duration > thresholdMs) {
        stuck.push({ turnId, sessionId: log.state.sessionId, durationMs: duration, startedAt });
      }
    }
    return stuck;
  }

  /**
   * Recovery counts from the last boot(). FileTurnLogStore.getDiagnostics()
   * returns a fresh copy on every call, so values mutated onto that copy during
   * boot() would be lost; the corrected figures are kept here so the live
   * endpoints (getStoreDiagnostics, /api/health, /api/diagnostics/persistence)
   * report the real recovered/RESTART counts instead of the store's zero defaults.
   */
  private bootStats?: { turnsLoaded: number; turnsWithRestart: number };

  // Expose store diagnostics if available for metrics integration
  getStoreDiagnostics(): any {
    const s: any = this.store as any;
    if (typeof s.getDiagnostics !== "function") return undefined;
    const d = s.getDiagnostics();
    if (this.bootStats) return { ...d, turnsLoaded: this.bootStats.turnsLoaded, turnsWithRestart: this.bootStats.turnsWithRestart };
    return d;
  }

  // For restart recovery — handles FileTurnLogStore corruption cases via readAll
  async boot(): Promise<{ turnsLoaded: number; turnsWithRestart: number; diagnostics?: any }> {
    const turnIds = await this.store.list();
    let turnsLoaded = 0;
    let turnsWithRestart = 0;

    for (const turnId of turnIds) {
      const events = await this.store.readAll(turnId);
      if (events.length === 0) continue;
      let state = createInitialTurnState();
      let seqCounter = 0;
      for (const e of events) {
        state = reduceTurnState(state, e);
        seqCounter = Math.max(seqCounter, e.seq);
      }
      const existing = this.logs.get(turnId);
      if (existing) continue; // don't overwrite active

      const log: TurnLog = {
        events: [...events],
        state,
        seqCounter,
        listeners: new Set(),
        createdAt: this.now(),
      };

      // If not terminal, append exactly one RESTART failure at maxSeq+1
      if (!state.isTerminal) {
        seqCounter += 1;
        const restartEvent: StreamEvent = {
          seq: seqCounter,
          at: this.now(),
          sessionId: state.sessionId,
          turnId: state.turnId,
          type: "turn_failed",
          code: "RESTART",
          message: "server restarted",
          retryable: false,
        };
        log.events.push(restartEvent);
        log.state = reduceTurnState(state, restartEvent);
        log.seqCounter = seqCounter;
        await this.store.append(turnId, restartEvent).catch(() => {});
        turnsWithRestart++;
      }

      this.logs.set(turnId, log);
      turnsLoaded++;
    }

    // Collect diagnostics from file store if available
    let diagnostics: any = undefined;
    if ((this.store as any).getDiagnostics) {
      diagnostics = (this.store as any).getDiagnostics();
      diagnostics.turnsLoaded = turnsLoaded;
      diagnostics.turnsWithRestart = turnsWithRestart;
    }
    this.bootStats = { turnsLoaded, turnsWithRestart };

    return { turnsLoaded, turnsWithRestart, diagnostics };
  }

  // Eviction with file deletion if store supports it — never delete active (non-terminal) turns
  async evictOldestAsync(maxTurns = 100) {
    if (this.logs.size <= maxTurns) return;
    // Only evict terminal turns, preserve active
    const terminalTurns = [...this.logs.entries()].filter(([, log]) => log.state.isTerminal).sort((a, b) => a[1].state.updatedAt - b[1].state.updatedAt);
    const toDelete = Math.min(this.logs.size - maxTurns, terminalTurns.length);
    for (let i = 0; i < toDelete; i++) {
      const turnId = terminalTurns[i][0];
      this.logs.delete(turnId);
      if ((this.store as any).deleteTurnFile) {
        try {
          await (this.store as any).deleteTurnFile(turnId);
        } catch {}
      }
    }
  }

  // Keep sync version for backward compat — never delete active turns
  evictOldest(maxTurns = 100) {
    if (this.logs.size <= maxTurns) return;
    const terminalTurns = [...this.logs.entries()].filter(([, log]) => log.state.isTerminal).sort((a, b) => a[1].state.updatedAt - b[1].state.updatedAt);
    const toDelete = Math.min(this.logs.size - maxTurns, terminalTurns.length);
    for (let i = 0; i < toDelete; i++) {
      const turnId = terminalTurns[i][0];
      this.logs.delete(turnId);
      if ((this.store as any).deleteTurnFile) {
        (this.store as any).deleteTurnFile(turnId).catch(() => {});
      }
    }
  }
}
