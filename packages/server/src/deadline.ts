export type DeadlineOperationKind = "model" | "tool" | "approval";
export type DeadlineFailureKind = "deadline_expired" | "cancelled" | "shutdown_timeout";

export class DeadlineError extends Error {
  kind: DeadlineFailureKind;
  operationKind: DeadlineOperationKind;
  partialText?: string;
  partialToolCalls?: Array<{ id: string; name: string; input: unknown }>;
  partialUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };

  constructor(kind: DeadlineFailureKind, operationKind: DeadlineOperationKind, message: string) {
    super(message);
    this.name = "DeadlineError";
    this.kind = kind;
    this.operationKind = operationKind;
  }
}

export interface Clock {
  now(): number;
  setTimeout(cb: () => void, ms: number): any;
  clearTimeout(id: any): void;
}

export interface Deadline {
  readonly signal: AbortSignal;
  readonly expiresAt: number;
  readonly kind: DeadlineOperationKind;
  cancel(reason?: unknown): void;
  dispose(): void;
}

class DeadlineImpl implements Deadline {
  readonly signal: AbortSignal;
  readonly expiresAt: number;
  readonly kind: DeadlineOperationKind;

  private controller: AbortController;
  private parentSignal: AbortSignal;
  private parentListener?: () => void;
  private timer: any;
  private clock?: Clock;
  private disposed = false;
  private nowFn: () => number;

  constructor(
    parentSignal: AbortSignal,
    timeoutMs: number,
    kind: DeadlineOperationKind,
    clock?: Clock,
    nowFn?: () => number
  ) {
    this.kind = kind;
    this.parentSignal = parentSignal;
    this.clock = clock;
    this.nowFn = nowFn ?? (() => clock?.now() ?? Date.now());
    const parentExpiresAt = (parentSignal as any).__deadline_expiresAt as number | undefined;
    const ownExpiresAt = this.nowFn() + timeoutMs;
    this.expiresAt = parentExpiresAt !== undefined ? Math.min(parentExpiresAt, ownExpiresAt) : ownExpiresAt;

    this.controller = new AbortController();
    this.signal = this.controller.signal;
    (this.signal as any).__deadline_expiresAt = this.expiresAt;

    // Parent abort → abort child with cancelled
    const onParentAbort = () => {
      if (!this.controller.signal.aborted) {
        const reason = (parentSignal as any).reason ?? new DeadlineError("cancelled", kind, "parent cancelled");
        this.controller.abort(reason);
      }
    };

    this.parentListener = onParentAbort;

    if (parentSignal.aborted) {
      onParentAbort();
    } else {
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }

    // Deadline timer → abort child with expired
    const onExpired = () => {
      if (!this.controller.signal.aborted) {
        this.controller.abort(new DeadlineError("deadline_expired", kind, `${kind} deadline expired after ${timeoutMs}ms`));
      }
    };

    this.timer = clock ? clock.setTimeout(onExpired, timeoutMs) : setTimeout(onExpired, timeoutMs);
  }

  cancel(reason?: unknown): void {
    if (this.disposed) return;
    if (!this.controller.signal.aborted) {
      this.controller.abort(reason ?? new DeadlineError("cancelled", this.kind, "cancelled"));
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.timer !== undefined) {
      if (this.clock) {
        this.clock.clearTimeout(this.timer);
      } else {
        clearTimeout(this.timer);
      }
      this.timer = undefined;
    }

    if (this.parentListener) {
      this.parentSignal.removeEventListener("abort", this.parentListener);
      this.parentListener = undefined;
    }
  }

  // For testing: expose internal state
  get _timer() {
    return this.timer;
  }

  get _disposed() {
    return this.disposed;
  }
}

export function createDeadline(
  parentSignal: AbortSignal,
  timeoutMs: number,
  opts: { kind: DeadlineOperationKind; clock?: Clock; now?: () => number }
): Deadline {
  return new DeadlineImpl(parentSignal, timeoutMs, opts.kind, opts.clock, opts.now);
}

export async function runWithDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  opts: {
    parentSignal: AbortSignal;
    timeoutMs: number;
    kind: DeadlineOperationKind;
    clock?: Clock;
    shutdownGraceMs?: number;
    now?: () => number;
  }
): Promise<T> {
  const { parentSignal, timeoutMs, kind, clock, shutdownGraceMs = 5000, now } = opts;

  const deadline = createDeadline(parentSignal, timeoutMs, { kind, clock, now });
  const signal = deadline.signal;

  let operationPromise: Promise<T>;
  try {
    operationPromise = operation(signal);
  } catch (err) {
    // operation threw synchronously
    deadline.dispose();
    throw err;
  }

  // Abort promise that rejects when signal aborts
  const abortPromise = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject((signal as any).reason ?? new DeadlineError("cancelled", kind, "aborted"));
    } else {
      const onAbort = () => {
        reject((signal as any).reason ?? new DeadlineError("cancelled", kind, "aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });

  try {
    // Phase 1: race operation vs abort (parent cancellation or deadline expiry)
    const result = await Promise.race([operationPromise, abortPromise]);
    // Operation settled before abort — success
    deadline.dispose();
    return result as T;
  } catch (err) {
    // If signal not aborted, operation threw on its own — return its error
    if (!signal.aborted) {
      deadline.dispose();
      throw err;
    }

    // Signal aborted — operation may still be running (if it ignores abort) or may have thrown because of abort
    // Phase 2: await operation shutdown with bounded grace

    let graceTimer: any;
    const gracePromise = new Promise<never>((_, reject) => {
      const onGraceTimeout = () => {
        reject(new DeadlineError("shutdown_timeout", kind, `${kind} shutdown timed out after ${shutdownGraceMs}ms — abort requested, operation not confirmed stopped`));
      };
      graceTimer = clock ? clock.setTimeout(onGraceTimeout, shutdownGraceMs) : setTimeout(onGraceTimeout, shutdownGraceMs);
    });

    try {
      // Race operation settlement vs grace timeout
      const shutdownResult = await Promise.race([operationPromise, gracePromise]);

      // Operation settled within grace — it observed abort and cleaned up
      // Clear grace timer
      if (graceTimer !== undefined) {
        if (clock) clock.clearTimeout(graceTimer);
        else clearTimeout(graceTimer);
      }

      deadline.dispose();

      // If operation settled with value after abort, we should throw abort reason, not return value — caller's value is stale
      // So throw signal.reason (which is DeadlineError with kind expired or cancelled)
      throw (signal as any).reason ?? err;
    } catch (shutdownErr) {
      // Clear grace timer if still active
      if (graceTimer !== undefined) {
        if (clock) {
          try {
            clock.clearTimeout(graceTimer);
          } catch {}
        } else {
          try {
            clearTimeout(graceTimer);
          } catch {}
        }
      }

      deadline.dispose();

      if (shutdownErr instanceof DeadlineError && shutdownErr.kind === "shutdown_timeout") {
        // Operation did NOT terminate within grace — typed failure, no false claim dead
        throw shutdownErr;
      }

      // Operation settled within grace but threw abort reason — throw abort reason
      // If shutdownErr is the abort reason (deadline_expired or cancelled), throw it
      // If it's operation's own error after abort, throw abort reason still? For simplicity, throw signal.reason
      throw (signal as any).reason ?? shutdownErr;
    }
  }
}
