export class FakeClock {
  private nowMs: number;
  private timers: Array<{ at: number; cb: () => void; id: number }> = [];
  private nextId = 1;

  constructor(initialMs = 0) {
    this.nowMs = initialMs;
  }

  now() {
    return this.nowMs;
  }

  advance(ms: number) {
    const target = this.nowMs + ms;
    while (true) {
      const next = this.timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.nowMs = next.at;
      this.timers = this.timers.filter((t) => t.id !== next.id);
      next.cb();
    }
    this.nowMs = target;
  }

  setTimeout(cb: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.push({ at: this.nowMs + ms, cb, id });
    return id;
  }

  clearTimeout(id: number) {
    this.timers = this.timers.filter((t) => t.id !== id);
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.setTimeout(() => resolve(), ms);
    });
  }
}
