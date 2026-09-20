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

export type EventListener = (event: StreamEvent) => void;

export interface TurnLog {
  events: StreamEvent[];
  state: TurnState;
  seqCounter: number;
  listeners: Set<EventListener>;
  abortController?: AbortController;
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

    // Durable before notify: persist first
    if (this.durableBeforeNotify) {
      try {
        await this.store.append(turnId, sequenced);
      } catch (err) {
        console.error(`Failed to persist event ${turnId} seq ${sequenced.seq} before notify`, err);
        // Still fold and notify? For durability we should still notify after failure? But we log and continue
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
        console.error(`Failed to persist event ${turnId} seq ${sequenced.seq}`, err);
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

    return { turnsLoaded, turnsWithRestart, diagnostics };
  }

  // Eviction with file deletion if store supports it
  async evictOldestAsync(maxTurns = 100) {
    if (this.logs.size <= maxTurns) return;
    const toDelete = this.logs.size - maxTurns;
    const keys = [...this.logs.keys()];
    for (let i = 0; i < toDelete; i++) {
      const turnId = keys[i];
      this.logs.delete(turnId);
      if ((this.store as any).deleteTurnFile) {
        try {
          await (this.store as any).deleteTurnFile(turnId);
        } catch {}
      }
    }
  }

  // Keep sync version for backward compat
  evictOldest(maxTurns = 100) {
    if (this.logs.size <= maxTurns) return;
    const toDelete = this.logs.size - maxTurns;
    const keys = [...this.logs.keys()];
    for (let i = 0; i < toDelete; i++) {
      const turnId = keys[i];
      this.logs.delete(turnId);
      if ((this.store as any).deleteTurnFile) {
        (this.store as any).deleteTurnFile(turnId).catch(() => {});
      }
    }
  }
}
