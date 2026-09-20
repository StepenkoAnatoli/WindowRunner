/**
 * Per-turn usage history for the dashboard's "recent turns" table.
 *
 * One record per terminal turn (completed / failed / cancelled) is appended to
 * `<dataDir>/usage.jsonl` — an append-only line format, the same pattern as
 * the turn JSONL files, but a dedicated file so turn transcripts are never
 * touched. The in-memory ring (newest `maxRecords`) serves GET /api/usage;
 * file writes are best-effort and never delay or fail a turn.
 *
 * Cost: `estCostUsd` is only set when MODEL_PRICE_TABLE has an entry for the
 * exact model id. This checkout commits an empty table on purpose — the
 * dashboard shows "—" rather than a fabricated number (the eval harness takes
 * prices as CLI args instead, see eval/run.mts).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TurnUsage } from "@windows-runner/shared";

export type TurnOutcomeStatus = "completed" | "failed" | "cancelled";

export interface TurnUsageRecord {
  at: number;
  /** Profile id that served the turn (falls back to "default"). */
  providerId: string;
  model: string;
  turnId: string;
  sessionId?: string;
  status: TurnOutcomeStatus;
  /** Failure code for failed turns (e.g. MODEL_AUTH). */
  code?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Omitted/undefined when no price table entry exists for `model`. */
  estCostUsd?: number;
}

/** Static pricing (USD per 1M tokens) keyed by exact model id. Intentionally empty — see header. */
export const MODEL_PRICE_TABLE: Record<string, { inputPer1M: number; outputPer1M: number }> = {};

/** USD estimate for a turn, or undefined when the model is not priced. Never invents a number. */
export function estimateCostUsd(model: string, usage: TurnUsage | undefined): number | undefined {
  const price = MODEL_PRICE_TABLE[model];
  if (!price || !usage) return undefined;
  const usd = ((usage.inputTokens ?? 0) * price.inputPer1M + (usage.outputTokens ?? 0) * price.outputPer1M) / 1_000_000;
  return Number(usd.toFixed(6));
}

const MAX_LINE_BYTES = 8 * 1024; // one record is a few hundred bytes; keep the O_APPEND guarantee

export class UsageLog {
  readonly file: string;
  private records: TurnUsageRecord[] = [];
  private maxRecords: number;
  /** Set when the file is unreadable/unwritable; the ring keeps working in memory. */
  private fileBroken = false;
  /** Chain of pending appends, so flush() (and tests) can await them. */
  private pending: Promise<void> = Promise.resolve();

  constructor(opts: { dataDir: string; now?: () => number; maxRecords?: number }) {
    this.file = path.join(path.resolve(opts.dataDir), "usage.jsonl");
    void opts.now;
    this.maxRecords = opts.maxRecords ?? 1_000;
  }

  /** Seed the in-memory ring from the tail of a previous run (best-effort). */
  async loadInitial(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch (err: any) {
      if (err?.code !== "ENOENT") this.fileBroken = true;
      return;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as TurnUsageRecord;
        if (rec && typeof rec.at === "number" && typeof rec.turnId === "string" && typeof rec.status === "string" && typeof rec.providerId === "string") {
          this.records.push(rec);
        }
      } catch {
        // skip malformed lines (partial write at a crash boundary)
      }
    }
    if (this.records.length > this.maxRecords) this.records = this.records.slice(-this.maxRecords);
  }

  /** Record a terminal turn. Synchronous in memory; the file append is best-effort. */
  append(record: TurnUsageRecord): void {
    const line = JSON.stringify(record);
    this.records.push(record);
    if (this.records.length > this.maxRecords) this.records.splice(0, this.records.length - this.maxRecords);
    if (this.fileBroken || line.length > MAX_LINE_BYTES) return;
    // Appends run one at a time in order (O_APPEND keeps each line atomic,
    // the chain keeps the sequence stable). `mode` applies when the file is
    // created (first write); appends to an existing file leave the mode
    // untouched — same 0600-at-creation convention as `<dataDir>/auth-token`.
    this.pending = this.pending
      .then(async () => {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await fs.appendFile(this.file, line + "\n", { mode: 0o600 });
      })
      .catch(() => {
        this.fileBroken = true; // e.g. read-only home dir: keep the in-memory ring only
      });
  }

  /** Await all pending appends (tests, clean shutdown). */
  async flush(): Promise<void> {
    await this.pending;
  }

  /** Newest first, up to `limit` records. */
  recent(limit: number): TurnUsageRecord[] {
    const n = Math.max(1, Math.min(Math.floor(limit), this.maxRecords));
    return this.records.slice(-n).reverse();
  }

  get length(): number {
    return this.records.length;
  }
}
