import type { StreamEvent, TurnId, TurnLogStore } from "@windows-runner/shared";

export class InMemoryTurnLogStore implements TurnLogStore {
  private logs = new Map<TurnId, StreamEvent[]>();

  async append(turnId: TurnId, event: StreamEvent): Promise<void> {
    let arr = this.logs.get(turnId);
    if (!arr) {
      arr = [];
      this.logs.set(turnId, arr);
    }
    // idempotent on seq
    if (arr.some((e) => e.seq === event.seq)) return;
    arr.push(event);
  }

  async read(turnId: TurnId, afterSeq: number): Promise<StreamEvent[]> {
    const arr = this.logs.get(turnId) ?? [];
    return arr.filter((e) => e.seq > afterSeq);
  }

  async readAll(turnId: TurnId): Promise<StreamEvent[]> {
    return [...(this.logs.get(turnId) ?? [])];
  }

  async list(): Promise<TurnId[]> {
    return [...this.logs.keys()];
  }

  // For testing: direct access
  getEvents(turnId: TurnId): StreamEvent[] {
    return this.logs.get(turnId) ?? [];
  }

  clear() {
    this.logs.clear();
  }
}

// Future: FileTurnLogStore implements same interface with JSONL per turn under WINDOWS_RUNNER_DATA_DIR
// Deferred to candidate #7
