/**
 * Per-turn usage history for the dashboard's "recent turns" table.
 *
 * One record per terminal turn (completed / failed / cancelled) is appended to
 * `<dataDir>/usage.jsonl` — an append-only line format, the same pattern as
 * the turn JSONL files, but a dedicated file so turn transcripts are never
 * touched. The in-memory ring (newest `maxRecords`) serves GET /api/usage;
 * file writes are best-effort and never delay or fail a turn.
 *
 * Both sides are bounded, because this file only ever grows otherwise:
 * `loadInitial()` reads at most `tailBytes` off the END of the file (so boot
 * time and peak memory follow the ring size, not the accumulated history) and
 * an append past `maxFileBytes` rotates usage.jsonl to `usage.jsonl.1`,
 * keeping exactly one generation. When that means records are unavailable,
 * `bounded` is true and GET /api/usage passes it through so the dashboard can
 * say the table is recent turns rather than the full history.
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

/** Rotation target: usage.jsonl is renamed to usage.jsonl.1 once it would grow past this. */
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Never let the boot-time tail read exceed this, whatever maxRecords says. */
const HARD_TAIL_CAP = 4 * 1024 * 1024;

export interface UsageLogOptions {
  dataDir: string;
  now?: () => number;
  maxRecords?: number;
  /**
   * Bytes `loadInitial()` may read off the END of usage.jsonl. The file is
   * append-only and grows for as long as the data dir lives, so reading all
   * of it to keep the newest `maxRecords` made startup time and peak memory
   * scale with the whole history. Only the tail is read now; anything older
   * is not in the ring (see `bounded`). Default: `maxRecords * MAX_LINE_BYTES`,
   * capped at 4 MiB.
   */
  tailBytes?: number;
  /**
   * Size budget for usage.jsonl. Appending past it rotates the file to
   * `usage.jsonl.1`, replacing any previous generation, so on-disk history is
   * bounded at roughly 2x this value instead of growing forever.
   * Default 8 MiB; floored at 4 * MAX_LINE_BYTES so a single record can
   * always fit without rotating on every append.
   */
  maxFileBytes?: number;
}

export class UsageLog {
  readonly file: string;
  /** Previous generation after a rotation (`usage.jsonl.1`); absent until one happens. */
  readonly rotatedFile: string;
  private records: TurnUsageRecord[] = [];
  private maxRecords: number;
  private tailBytes: number;
  private maxFileBytes: number;
  /** Set when the file is unreadable/unwritable; the ring keeps working in memory. */
  private fileBroken = false;
  /** True once records are known to be missing: the ring trimmed, or the tail/rotation dropped older ones. */
  private incomplete = false;
  /** Chain of pending appends, so flush() (and tests) can await them. */
  private pending: Promise<void> = Promise.resolve();

  constructor(opts: UsageLogOptions) {
    const dir = path.resolve(opts.dataDir);
    this.file = path.join(dir, "usage.jsonl");
    this.rotatedFile = `${this.file}.1`;
    void opts.now;
    this.maxRecords = opts.maxRecords ?? 1_000;
    this.maxFileBytes = Math.max(opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, MAX_LINE_BYTES * 4);
    this.tailBytes = Math.min(Math.max(opts.tailBytes ?? this.maxRecords * MAX_LINE_BYTES, MAX_LINE_BYTES), Math.max(HARD_TAIL_CAP, this.maxFileBytes));
  }

  /**
   * Seed the in-memory ring from the TAIL of a previous run (best-effort).
   * Reads at most `tailBytes` from the end of the file, so boot cost is
   * bounded by the ring size rather than by how long usage.jsonl has been
   * accumulating. When the file is bigger than the tail budget the earlier
   * records are simply not loaded — `bounded` reports that.
   */
  async loadInitial(): Promise<void> {
    let text: string;
    let skippedEarlier: boolean;
    try {
      const handle = await fs.open(this.file, "r");
      try {
        const { size } = await handle.stat();
        const from = Math.max(0, size - this.tailBytes);
        const buffer = Buffer.alloc(size - from);
        if (buffer.length > 0) await handle.read(buffer, 0, buffer.length, from);
        text = buffer.toString("utf8");
        skippedEarlier = from > 0;
      } finally {
        await handle.close().catch(() => {});
      }
    } catch (err: any) {
      if (err?.code !== "ENOENT") this.fileBroken = true;
      return;
    }
    if (skippedEarlier) {
      // The window starts mid-line. Drop the first fragment: it is a partial
      // record, and the byte cut may also have split a multi-byte character
      // (the resulting U+FFFD lands in the fragment being dropped anyway).
      const nl = text.indexOf("\n");
      text = nl === -1 ? "" : text.slice(nl + 1);
      this.incomplete = true;
    }
    for (const line of text.split("\n")) {
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
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
      this.incomplete = true;
    }
    // A rotated generation means records exist that this ring will never show.
    if (!this.incomplete) this.incomplete = await fs.stat(this.rotatedFile).then(() => true, () => false);
  }

  /** Record a terminal turn. Synchronous in memory; the file append is best-effort. */
  append(record: TurnUsageRecord): void {
    const line = JSON.stringify(record);
    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
      this.incomplete = true;
    }
    if (this.fileBroken || line.length > MAX_LINE_BYTES) return;
    // Appends run one at a time in order (O_APPEND keeps each line atomic,
    // the chain keeps the sequence stable). `mode` applies when the file is
    // created (first write); appends to an existing file leave the mode
    // untouched — same 0600-at-creation convention as `<dataDir>/auth-token`.
    this.pending = this.pending
      .then(async () => {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await this.rotateIfNeeded(line.length + 1);
        await fs.appendFile(this.file, line + "\n", { mode: 0o600 });
      })
      .catch(() => {
        this.fileBroken = true; // e.g. read-only home dir: keep the in-memory ring only
      });
  }

  /**
   * Keep usage.jsonl inside its size budget by moving it aside to
   * `usage.jsonl.1` (replacing the previous generation). One retained
   * generation is deliberate: the dashboard shows recent turns, not an
   * archive, and a single generation bounds disk use at ~2x maxFileBytes.
   * A failed rename is not fatal — the append still goes to the old file.
   */
  private async rotateIfNeeded(incomingBytes: number): Promise<void> {
    let size: number;
    try {
      size = (await fs.stat(this.file)).size;
    } catch {
      return; // no file yet: nothing to rotate
    }
    if (size + incomingBytes <= this.maxFileBytes) return;
    await fs.rename(this.file, this.rotatedFile).catch(() => {});
    this.incomplete = true;
  }

  /**
   * True when the history behind `recent()` is known to be incomplete: the
   * ring trimmed older turns, the boot tail window skipped them, or a
   * rotation moved them into usage.jsonl.1. The dashboard says so rather
   * than implying the table is the whole history.
   */
  get bounded(): boolean {
    return this.incomplete;
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
