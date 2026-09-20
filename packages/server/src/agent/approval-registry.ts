import type { ApprovalId, ApprovalRequest, ApprovalDecision, SessionId, TurnId } from "@windows-runner/shared";
import { createDeadline, type Deadline, type Clock, DeadlineError } from "../deadline.js";

export type ApprovalResolution =
  | { kind: "approved"; input?: unknown }
  | { kind: "denied"; reason?: string }
  | { kind: "expired" }
  | { kind: "cancelled" };

interface Entry {
  request: ApprovalRequest;
  resolve: (resolution: ApprovalResolution) => void;
  promise: Promise<ApprovalResolution>;
  deadline?: Deadline; // owns timer, parent listener, disposal — single owner
  timeoutId?: any; // fallback for old path, but will be replaced by deadline
}

export class ApprovalRegistry {
  private entries = new Map<ApprovalId, Entry>();
  private byTurn = new Map<TurnId, Set<ApprovalId>>();
  private counter = 0;
  private clock?: Clock;
  private nowFn: () => number;

  constructor(opts: { clock?: Clock; now?: () => number } = {}) {
    this.clock = opts.clock;
    this.nowFn = opts.now ?? (() => opts.clock?.now() ?? Date.now());
  }

  private newId(): ApprovalId {
    this.counter += 1;
    // deterministic for tests when clock is fake, random suffix for prod
    const rand = Math.random().toString(36).slice(2, 6);
    return `apr_${this.nowFn()}_${this.counter}_${rand}`;
  }

  // Single mutator — only function that mutates settlement state
  private settle(requestId: ApprovalId, resolution: ApprovalResolution): { settled: boolean; request?: ApprovalRequest } {
    const entry = this.entries.get(requestId);
    if (!entry) {
      return { settled: false };
    }

    // First caller wins: remove from global map and turn index, clear timer/deadline, resolve promise once
    this.entries.delete(requestId);
    const turnSet = this.byTurn.get(entry.request.turnId);
    if (turnSet) {
      turnSet.delete(requestId);
      if (turnSet.size === 0) {
        this.byTurn.delete(entry.request.turnId);
      }
    }

    if (entry.deadline) {
      entry.deadline.dispose();
    }
    if (entry.timeoutId !== undefined) {
      if (this.clock) {
        this.clock.clearTimeout(entry.timeoutId);
      } else {
        clearTimeout(entry.timeoutId);
      }
    }

    entry.resolve(resolution);

    return { settled: true, request: entry.request };
  }

  // New API: mints id, computes expiresAt and createdAt, single expiry source
  request(input: {
    sessionId: SessionId;
    turnId: TurnId;
    providerCallId: string;
    toolName: string;
    input: unknown;
    reason: string;
    timeoutMs: number;
    parentSignal?: AbortSignal; // turn signal — child may shorten, never extend
  }): ApprovalRequest {
    const now = this.nowFn();
    const requestId = this.newId();

    const request: ApprovalRequest & { providerCallId: string; createdAt: number } = {
      requestId,
      providerCallId: input.providerCallId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      toolName: input.toolName,
      input: input.input,
      reason: input.reason,
      expiresAt: now + input.timeoutMs,
      createdAt: now,
    } as any;

    // Create entry with promise
    let resolve!: (res: ApprovalResolution) => void;
    const promise = new Promise<ApprovalResolution>((res) => {
      resolve = res;
    });

    const entry: Entry = { request: request as ApprovalRequest, resolve, promise };

    // Deadline for expiry — consumes deadline abstraction, not duplicate timer
    // For now, we use Deadline with parentSignal = input.parentSignal ?? AbortSignal that never aborts
    // Later, Deadline will be the only timer owner
    const parentSignal = input.parentSignal ?? new AbortController().signal;

    if (input.timeoutMs > 0) {
      const deadline = createDeadline(parentSignal, input.timeoutMs, {
        kind: "approval",
        clock: this.clock,
        now: this.nowFn,
      });

      // When deadline expires, settle with expired
      const onAbort = () => {
        const reason = (deadline.signal as any).reason;
        if (reason instanceof DeadlineError && reason.kind === "deadline_expired") {
          this.settle(requestId, { kind: "expired" });
        } else if (reason instanceof DeadlineError && reason.kind === "cancelled") {
          this.settle(requestId, { kind: "cancelled" });
        }
      };

      if (deadline.signal.aborted) {
        onAbort();
      } else {
        deadline.signal.addEventListener("abort", onAbort, { once: true });
      }

      entry.deadline = deadline;
    }

    this.entries.set(requestId, entry);
    let set = this.byTurn.get(input.turnId);
    if (!set) {
      set = new Set();
      this.byTurn.set(input.turnId, set);
    }
    set.add(requestId);

    return request as ApprovalRequest;
  }

  // Old API for backward compat — delegates to new request() but keeps provider id as requestId for old tests
  // Will be removed after migration
  register(request: ApprovalRequest, timeoutMs: number): void {
    if (this.entries.has(request.requestId)) {
      throw new Error(`Approval already exists: ${request.requestId}`);
    }

    let resolve!: (res: ApprovalResolution) => void;
    const promise = new Promise<ApprovalResolution>((res) => {
      resolve = res;
    });

    const entry: Entry = { request, resolve, promise };

    if (timeoutMs > 0) {
      // For backward compat, use setTimeout, but will be replaced by Deadline
      entry.timeoutId = this.clock
        ? this.clock.setTimeout(() => {
            this.settle(request.requestId, { kind: "expired" });
          }, timeoutMs)
        : setTimeout(() => {
            this.settle(request.requestId, { kind: "expired" });
          }, timeoutMs);
    }

    this.entries.set(request.requestId, entry);
    let set = this.byTurn.get(request.turnId);
    if (!set) {
      set = new Set();
      this.byTurn.set(request.turnId, set);
    }
    set.add(request.requestId);
  }

  wait(requestId: ApprovalId): Promise<ApprovalResolution> {
    const entry = this.entries.get(requestId);
    if (!entry) {
      throw new Error(`Approval not found: ${requestId}`);
    }
    return entry.promise;
  }

  // Public approve/deny — go through settle, return settled flag for 409 handling
  approve(requestId: ApprovalId, input?: unknown): { settled: boolean; request?: ApprovalRequest } {
    return this.settle(requestId, { kind: "approved", input });
  }

  deny(requestId: ApprovalId, reason?: string): { settled: boolean; request?: ApprovalRequest } {
    return this.settle(requestId, { kind: "denied", reason });
  }

  // Old API returning boolean for decision string
  resolve(requestId: ApprovalId, decision: ApprovalDecision): boolean {
    const res = decision === "approve" ? this.approve(requestId) : this.deny(requestId);
    return res.settled;
  }

  cancelTurn(turnId: TurnId): void {
    const set = this.byTurn.get(turnId);
    if (!set) return;
    const ids = [...set];
    for (const id of ids) {
      this.settle(id, { kind: "cancelled" });
    }
  }

  cleanupTurn(turnId: TurnId): void {
    this.cancelTurn(turnId);
  }

  snapshot(turnId: TurnId): ApprovalRequest[] {
    const set = this.byTurn.get(turnId);
    if (!set) return [];
    const result: ApprovalRequest[] = [];
    for (const id of set) {
      const entry = this.entries.get(id);
      if (entry) result.push(entry.request);
    }
    return result;
  }

  peek(requestId: ApprovalId): { request: ApprovalRequest } | undefined {
    const entry = this.entries.get(requestId);
    if (!entry) return undefined;
    return { request: entry.request };
  }

  has(requestId: ApprovalId): boolean {
    return this.entries.has(requestId);
  }

  // For leak assertions in tests
  get _entries() {
    return this.entries;
  }

  get _byTurn() {
    return this.byTurn;
  }
}
