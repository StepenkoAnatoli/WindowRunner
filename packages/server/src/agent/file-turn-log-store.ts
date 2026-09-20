import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createWriteStream } from "node:fs";
import type { StreamEvent, TurnId, TurnLogStore, SessionId } from "@windows-runner/shared";

export interface FileTurnLogStoreOptions {
  dataDir: string;
  fsync?: boolean; // default false
  maxLineBytes?: number; // default 1MB
}

export interface BootDiagnostics {
  turnsLoaded: number;
  turnsWithRestart: number;
  eventsSkipped: number;
  truncatedLinesIgnored: number;
  gapsDetected: number;
  outOfOrderDetected: number;
  duplicatesSkipped: number;
  quarantinedFiles: string[];
  warnings: string[];
}

interface ParsedResult {
  events: StreamEvent[];
  truncatedIgnored: number;
  malformedSkipped: number;
  duplicatesSkipped: number;
  outOfOrder: boolean;
  gaps: number;
  identityMismatches: number;
  warnings: string[];
}

const TURN_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

function isValidTurnId(id: string): boolean {
  return TURN_ID_RE.test(id);
}

function isValidSessionId(id: string): boolean {
  return TURN_ID_RE.test(id);
}

/**
 * FileTurnLogStore — C Hybrid implementation
 *
 * Layout:
 *   dataDir/sessions/<sessionId>/turns/<turnId>.jsonl (primary)
 *   dataDir/turns/<turnId>.jsonl (legacy flat fallback)
 *
 * Guarantees:
 * - Per-turn serialized append queue via Map<turnId, Promise>
 * - O_APPEND atomic <4KB (Node appendFile)
 * - Optional fsync
 * - Recovery: truncated final line ignored, malformed middle skip+warn, duplicate seq keep first, out-of-order sort by seq (diagnostic), gaps warn, identity mismatches reject
 * - Sorting only on read normalization, never rewrites original file automatically
 * - Concurrency: serialized writes within one process. Multi-process unsupported — documented, no file lock, O_APPEND alone does not provide session-level correctness
 */
export class FileTurnLogStore implements TurnLogStore {
  private dataDir: string;
  private fsync: boolean;
  private queues = new Map<TurnId, Promise<void>>();
  private maxLineBytes: number;

  // For diagnostics during boot/read
  private diagnostics: BootDiagnostics = {
    turnsLoaded: 0,
    turnsWithRestart: 0,
    eventsSkipped: 0,
    truncatedLinesIgnored: 0,
    gapsDetected: 0,
    outOfOrderDetected: 0,
    duplicatesSkipped: 0,
    quarantinedFiles: [],
    warnings: [],
  };

  constructor(opts: FileTurnLogStoreOptions) {
    this.dataDir = path.resolve(opts.dataDir);
    this.fsync = opts.fsync ?? false;
    this.maxLineBytes = opts.maxLineBytes ?? 1024 * 1024;
  }

  private getSessionTurnPath(sessionId: SessionId, turnId: TurnId): string {
    return path.join(this.dataDir, "sessions", sessionId, "turns", `${turnId}.jsonl`);
  }

  private getFlatTurnPath(turnId: TurnId): string {
    return path.join(this.dataDir, "turns", `${turnId}.jsonl`);
  }

  private async findTurnFile(turnId: TurnId): Promise<string | null> {
    if (!isValidTurnId(turnId)) return null;

    // Search per-session dirs first
    const sessionsDir = path.join(this.dataDir, "sessions");
    try {
      const sessionEntries = await fs.readdir(sessionsDir, { withFileTypes: true });
      for (const entry of sessionEntries) {
        if (!entry.isDirectory()) continue;
        if (!isValidSessionId(entry.name)) continue;
        const candidate = path.join(sessionsDir, entry.name, "turns", `${turnId}.jsonl`);
        try {
          await fs.stat(candidate);
          return candidate;
        } catch {
          // not found, continue
        }
      }
    } catch {
      // sessions dir may not exist
    }

    // Check flat fallback
    const flat = this.getFlatTurnPath(turnId);
    try {
      await fs.stat(flat);
      return flat;
    } catch {
      return null;
    }
  }

  private async ensureDirForFile(filePath: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
  }

  async append(turnId: TurnId, event: StreamEvent): Promise<void> {
    if (!isValidTurnId(turnId)) {
      throw new Error(`Invalid turnId: ${turnId}`);
    }
    if (event.turnId !== turnId) {
      throw new Error(`Event turnId mismatch: event.turnId=${event.turnId} arg=${turnId}`);
    }
    if (!event.sessionId || !isValidSessionId(event.sessionId)) {
      throw new Error(`Invalid event.sessionId: ${event.sessionId}`);
    }
    if (typeof event.seq !== "number" || event.seq <= 0 || !Number.isInteger(event.seq)) {
      throw new Error(`Invalid event.seq: ${event.seq}`);
    }

    // Determine file path: existing file takes precedence, else session-based
    let filePath: string;
    const existing = await this.findTurnFile(turnId);
    if (existing) {
      filePath = existing;
    } else {
      filePath = this.getSessionTurnPath(event.sessionId, turnId);
    }

    // Serialize per-turn
    const prev = this.queues.get(turnId) ?? Promise.resolve();
    const next = prev.then(async () => {
      await this.ensureDirForFile(filePath);
      const line = JSON.stringify(event) + "\n";

      if (line.length > this.maxLineBytes) {
        throw new Error(`Event line too large: ${line.length} > ${this.maxLineBytes}`);
      }

      // Crash recovery: if file exists and doesn't end with newline, truncate incomplete last line
      try {
        const stat = await fs.stat(filePath);
        if (stat.size > 0) {
          const fhCheck = await fs.open(filePath, "r");
          try {
            const buffer = Buffer.alloc(1);
            await fhCheck.read(buffer, 0, 1, stat.size - 1);
            if (buffer[0] !== 0x0a) {
              // Last byte not newline, find last newline and truncate
              const content = await fs.readFile(filePath, "utf8");
              const lastNewline = content.lastIndexOf("\n");
              if (lastNewline === -1) {
                // No newline at all, truncate entire file (all truncated)
                await fs.truncate(filePath, 0);
              } else {
                await fs.truncate(filePath, lastNewline + 1);
              }
            }
          } finally {
            await fhCheck.close();
          }
        }
      } catch (err: any) {
        if (err.code !== "ENOENT") {
          // ignore other errors, proceed to append
        }
      }

      if (this.fsync) {
        // Open, write, fsync, close for durability
        const fh = await fs.open(filePath, "a");
        try {
          await fh.writeFile(line);
          await fh.sync();
        } finally {
          await fh.close();
        }
      } else {
        await fs.appendFile(filePath, line, { encoding: "utf8" });
      }
    });

    // Store queue, with error handling to not break chain
    const queueWithCleanup = next.catch((err) => {
      // Log but don't break queue chain for next appends
      console.warn(`FileTurnLogStore append failed for ${turnId}:`, err);
      throw err;
    }).finally(() => {
      // Only delete if this is still the current queue
      if (this.queues.get(turnId) === queueWithCleanup) {
        this.queues.delete(turnId);
      }
    });

    this.queues.set(turnId, queueWithCleanup as Promise<void>);
    await queueWithCleanup;
  }

  private parseFileContent(content: string, expectedTurnId: TurnId, expectedSessionId?: SessionId): ParsedResult {
    const warnings: string[] = [];
    let truncatedIgnored = 0;
    let malformedSkipped = 0;
    let duplicatesSkipped = 0;
    let identityMismatches = 0;
    let gaps = 0;
    let outOfOrder = false;

    const endsWithNewline = content.endsWith("\n");
    const rawLines = content.split("\n");

    // If content ends with newline, last element is empty string from split, ignore
    // If not ends with newline, last element may be incomplete truncated line
    const lines = rawLines;

    const events: StreamEvent[] = [];
    const seqMap = new Map<number, StreamEvent>();
    const fileOrderSeqs: number[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "") continue;

      const isLast = i === lines.length - 1;
      const isPotentiallyTruncated = isLast && !endsWithNewline;

      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        if (isPotentiallyTruncated) {
          truncatedIgnored++;
          warnings.push(`Truncated final line ignored in ${expectedTurnId} at line ${i + 1}`);
        } else {
          malformedSkipped++;
          warnings.push(`Malformed middle line skipped in ${expectedTurnId} at line ${i + 1}: ${line.slice(0, 100)}`);
        }
        continue;
      }

      // Validate identity fields
      if (typeof parsed.seq !== "number" || !Number.isInteger(parsed.seq) || parsed.seq <= 0) {
        malformedSkipped++;
        warnings.push(`Invalid seq in ${expectedTurnId} line ${i + 1}: ${parsed.seq}`);
        continue;
      }
      if (parsed.turnId !== expectedTurnId) {
        identityMismatches++;
        warnings.push(`Identity mismatch turnId in ${expectedTurnId} line ${i + 1}: event.turnId=${parsed.turnId} != file=${expectedTurnId}`);
        continue;
      }
      if (expectedSessionId && parsed.sessionId !== expectedSessionId) {
        identityMismatches++;
        warnings.push(`Identity mismatch sessionId in ${expectedTurnId} line ${i + 1}: event.sessionId=${parsed.sessionId} != expected=${expectedSessionId}`);
        continue;
      }
      if (!parsed.sessionId || typeof parsed.sessionId !== "string") {
        malformedSkipped++;
        warnings.push(`Missing sessionId in ${expectedTurnId} line ${i + 1}`);
        continue;
      }

      // Legacy fallback: providerCallId missing
      if (parsed.type === "turn_waiting_for_approval" && parsed.request) {
        if (!parsed.request.providerCallId) {
          parsed.request.providerCallId = parsed.request.requestId || "";
        }
        if (!parsed.request.createdAt) {
          parsed.request.createdAt = parsed.at;
        }
        if (!parsed.request.expiresAt) {
          parsed.request.expiresAt = parsed.at + 300000;
        }
      }

      // Duplicate seq handling: keep first
      if (seqMap.has(parsed.seq)) {
        duplicatesSkipped++;
        warnings.push(`Duplicate seq ${parsed.seq} in ${expectedTurnId} line ${i + 1}, keeping first`);
        continue;
      }

      seqMap.set(parsed.seq, parsed as StreamEvent);
      fileOrderSeqs.push(parsed.seq);
      events.push(parsed as StreamEvent);
    }

    // Check out-of-order: file order vs sorted order
    const sortedSeqs = [...fileOrderSeqs].sort((a, b) => a - b);
    for (let i = 0; i < fileOrderSeqs.length; i++) {
      if (fileOrderSeqs[i] !== sortedSeqs[i]) {
        outOfOrder = true;
        warnings.push(`Out-of-order detected in ${expectedTurnId}: file order ${fileOrderSeqs.join(",")} vs sorted ${sortedSeqs.join(",")}`);
        break;
      }
    }

    // Sort by seq ascending for normalization (only on read, never rewrites file)
    events.sort((a, b) => a.seq - b.seq);

    // Gap detection
    for (let i = 1; i < events.length; i++) {
      const expected = events[i - 1].seq + 1;
      if (events[i].seq !== expected) {
        gaps++;
        warnings.push(`Gap detected in ${expectedTurnId}: expected seq ${expected} but got ${events[i].seq} (jump from ${events[i - 1].seq})`);
      }
    }

    return {
      events,
      truncatedIgnored,
      malformedSkipped,
      duplicatesSkipped,
      outOfOrder,
      gaps,
      identityMismatches,
      warnings,
    };
  }

  private async readAndParseFile(filePath: string, expectedTurnId: TurnId): Promise<ParsedResult> {
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return {
          events: [],
          truncatedIgnored: 0,
          malformedSkipped: 0,
          duplicatesSkipped: 0,
          outOfOrder: false,
          gaps: 0,
          identityMismatches: 0,
          warnings: [],
        };
      }
      throw err;
    }

    // Derive expectedSessionId from path if per-session layout
    let expectedSessionId: SessionId | undefined;
    const sessionsPrefix = path.join(this.dataDir, "sessions");
    if (filePath.startsWith(sessionsPrefix)) {
      const rel = path.relative(sessionsPrefix, filePath);
      const parts = rel.split(path.sep);
      if (parts.length >= 1) {
        expectedSessionId = parts[0];
      }
    }

    const result = this.parseFileContent(content, expectedTurnId, expectedSessionId);

    // Quarantine check: if >50% lines invalid, quarantine file
    const totalLines = content.split("\n").filter((l) => l.trim() !== "").length;
    const invalidLines = result.malformedSkipped + result.identityMismatches;
    if (totalLines > 0 && invalidLines / totalLines > 0.5) {
      const quarantineDir = path.join(this.dataDir, "quarantine");
      await fs.mkdir(quarantineDir, { recursive: true });
      const quarantinePath = path.join(quarantineDir, `${expectedTurnId}.jsonl.quarantined`);
      try {
        await fs.copyFile(filePath, quarantinePath);
        result.warnings.push(`Quarantined file ${filePath} to ${quarantinePath} due to >50% invalid lines (${invalidLines}/${totalLines})`);
        this.diagnostics.quarantinedFiles.push(filePath);
      } catch (err) {
        result.warnings.push(`Failed to quarantine ${filePath}: ${err}`);
      }
    }

    return result;
  }

  async readAll(turnId: TurnId): Promise<StreamEvent[]> {
    if (!isValidTurnId(turnId)) return [];

    const filePath = await this.findTurnFile(turnId);
    if (!filePath) return [];

    const result = await this.readAndParseFile(filePath, turnId);

    // Update diagnostics (for observability)
    this.diagnostics.eventsSkipped += result.malformedSkipped + result.identityMismatches;
    this.diagnostics.truncatedLinesIgnored += result.truncatedIgnored;
    this.diagnostics.gapsDetected += result.gaps;
    this.diagnostics.duplicatesSkipped += result.duplicatesSkipped;
    if (result.outOfOrder) this.diagnostics.outOfOrderDetected++;
    this.diagnostics.warnings.push(...result.warnings);

    return result.events;
  }

  async read(turnId: TurnId, afterSeq: number): Promise<StreamEvent[]> {
    const all = await this.readAll(turnId);
    return all.filter((e) => e.seq > afterSeq);
  }

  async list(): Promise<TurnId[]> {
    const turnIds = new Set<TurnId>();

    // Scan sessions/*/turns/*.jsonl
    const sessionsDir = path.join(this.dataDir, "sessions");
    try {
      const sessionEntries = await fs.readdir(sessionsDir, { withFileTypes: true });
      for (const entry of sessionEntries) {
        if (!entry.isDirectory()) continue;
        if (!isValidSessionId(entry.name)) continue;
        const turnsDir = path.join(sessionsDir, entry.name, "turns");
        try {
          const turnFiles = await fs.readdir(turnsDir);
          for (const file of turnFiles) {
            if (!file.endsWith(".jsonl")) continue;
            const turnId = file.slice(0, -6);
            if (isValidTurnId(turnId)) turnIds.add(turnId);
          }
        } catch {
          // turns dir may not exist
        }
      }
    } catch {
      // sessions dir may not exist
    }

    // Scan flat fallback
    const flatDir = path.join(this.dataDir, "turns");
    try {
      const flatFiles = await fs.readdir(flatDir);
      for (const file of flatFiles) {
        if (!file.endsWith(".jsonl")) continue;
        const turnId = file.slice(0, -6);
        if (isValidTurnId(turnId)) turnIds.add(turnId);
      }
    } catch {
      // flat dir may not exist
    }

    return [...turnIds];
  }

  // For boot diagnostics and observability
  getDiagnostics(): BootDiagnostics {
    return { ...this.diagnostics, warnings: [...this.diagnostics.warnings], quarantinedFiles: [...this.diagnostics.quarantinedFiles] };
  }

  resetDiagnostics(): void {
    this.diagnostics = {
      turnsLoaded: 0,
      turnsWithRestart: 0,
      eventsSkipped: 0,
      truncatedLinesIgnored: 0,
      gapsDetected: 0,
      outOfOrderDetected: 0,
      duplicatesSkipped: 0,
      quarantinedFiles: [],
      warnings: [],
    };
  }

  // For retention/eviction
  async deleteTurnFile(turnId: TurnId): Promise<boolean> {
    const filePath = await this.findTurnFile(turnId);
    if (!filePath) return false;
    try {
      await fs.unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }

  // Expose dataDir for session store integration
  getDataDir(): string {
    return this.dataDir;
  }
}
