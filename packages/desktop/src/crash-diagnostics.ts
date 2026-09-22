/**
 * Local-first crash diagnostics for the desktop shell (B5.5).
 *
 * Two complementary records are kept in the per-user data directory:
 *
 *  - `logs/crash-<stamp>-<pid>.log` — a small, bounded, REDACTED plain-text
 *    record written by the main process for every failure it survives or dies
 *    from: uncaught exceptions, unhandled rejections, renderer/child-process
 *    loss, backend exit. Enough to answer "what happened", never enough to
 *    leak secrets (the caller passes a scrub list; details are capped).
 *  - `crashes/*.dmp` — Crashpad minidumps produced by Electron's
 *    `crashReporter` with `uploadToServer: false`. These are native memory
 *    snapshots: they can contain anything that was in process memory, so they
 *    stay on the machine, are never uploaded anywhere, and are pruned to a
 *    bounded count on every boot.
 *
 * Everything here is synchronous on purpose: the two moments this code runs
 * are "the process is dying" (fatal) and "something just went wrong"
 * (handler) — event-loop availability cannot be assumed, and the files are
 * tiny (details capped at MAX_DETAILS_LENGTH). Pure functions + a module of
 * fs operations, all injectable-free so tests run against temp dirs.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type CrashKind =
  | "uncaughtException"
  | "unhandledRejection"
  | "render-process-gone"
  | "child-process-gone"
  | "backend-exit";

export interface CrashRecord {
  kind: CrashKind;
  /** ISO timestamp of when the record was written. */
  writtenAt: string;
  appVersion: string;
  platform: string;
  electronVersion?: string;
  nodeVersion?: string;
  pid: number;
  /** Free-form bounded context (stack, reason, exit code…). */
  details: string;
  /** Small bounded key/value extras (e.g. reason/type of a gone renderer). */
  extras?: Record<string, string | number>;
}

/** Details are truncated at this length — crash logs stay small and safe. */
export const MAX_DETAILS_LENGTH = 8192;
/** How many crash-*.log files to keep (oldest deleted beyond that). */
export const CRASH_LOG_KEEP = 20;
/** How many minidumps to keep (oldest deleted beyond that). */
export const CRASH_DUMP_KEEP = 10;

export const CRASH_LOG_PREFIX = "crash-";
export const CRASH_LOG_SUFFIX = ".log";

/** Replace every scrub-list value with a placeholder (secrets never land on disk). */
export function scrubText(text: string, scrub: readonly string[]): string {
  let out = text;
  for (const secret of scrub) {
    if (secret && secret.length > 0) {
      out = out.split(secret).join("[redacted]");
    }
  }
  return out;
}

function boundDetails(details: string): string {
  if (details.length <= MAX_DETAILS_LENGTH) return details;
  return `${details.slice(0, MAX_DETAILS_LENGTH)}\n…(truncated at ${MAX_DETAILS_LENGTH} characters)`;
}

/** Render a crash record as the exact file content. */
export function formatCrashRecord(record: CrashRecord, scrub: readonly string[] = []): string {
  const lines: string[] = [
    "WindowRunner desktop crash record",
    `kind: ${record.kind}`,
    `written: ${record.writtenAt}`,
    `appVersion: ${record.appVersion}`,
    `platform: ${record.platform}`,
  ];
  if (record.electronVersion) lines.push(`electron: ${record.electronVersion}`);
  if (record.nodeVersion) lines.push(`node: ${record.nodeVersion}`);
  lines.push(`pid: ${record.pid}`);
  for (const [key, value] of Object.entries(record.extras ?? {})) {
    lines.push(`${key}: ${scrubText(String(value), scrub)}`);
  }
  lines.push("details:");
  lines.push(scrubText(boundDetails(record.details), scrub));
  lines.push("");
  return lines.join("\n");
}

/** Zero-padded local timestamp safe for filenames (no colons). */
export function crashLogFileName(record: Pick<CrashRecord, "pid">, writtenAt: string = new Date().toISOString()): string {
  const stamp = writtenAt.replace(/[:.]/g, "").replace(/-/g, "");
  return `${CRASH_LOG_PREFIX}${stamp}-${record.pid}${CRASH_LOG_SUFFIX}`;
}

function listCrashLogs(logsDir: string): string[] {
  try {
    return fs
      .readdirSync(logsDir)
      .filter((name) => name.startsWith(CRASH_LOG_PREFIX) && name.endsWith(CRASH_LOG_SUFFIX))
      .sort(); // timestamped names: lexicographic order == chronological order
  } catch {
    return [];
  }
}

/**
 * Write a crash record into `logsDir` (tmp-then-rename so a partial write is
 * never mistaken for a record) and prune old crash logs. Returns the file
 * path, or undefined when even the write failed (the caller is often dying).
 */
export function writeCrashLog(
  logsDir: string,
  record: CrashRecord,
  options: { scrub?: readonly string[]; keep?: number } = {}
): string | undefined {
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    const content = formatCrashRecord(record, options.scrub ?? []);
    const finalPath = path.join(logsDir, crashLogFileName(record, record.writtenAt));
    const tmpPath = `${finalPath}.tmp`;
    fs.writeFileSync(tmpPath, content, "utf8");
    fs.renameSync(tmpPath, finalPath);
    pruneCrashLogs(logsDir, options.keep ?? CRASH_LOG_KEEP);
    return finalPath;
  } catch {
    return undefined;
  }
}

/** Delete the oldest crash logs beyond `keep`. Returns how many were removed. */
export function pruneCrashLogs(logsDir: string, keep: number = CRASH_LOG_KEEP): number {
  const logs = listCrashLogs(logsDir);
  let removed = 0;
  for (const name of logs.slice(0, Math.max(0, logs.length - keep))) {
    try {
      fs.unlinkSync(path.join(logsDir, name));
      removed += 1;
    } catch {
      // Retention is best-effort; a locked file must never crash the boot.
    }
  }
  return removed;
}

/** Delete the oldest minidumps beyond `keep` (by mtime). Returns how many were removed. */
export function pruneCrashDumps(crashesDir: string, keep: number = CRASH_DUMP_KEEP): number {
  let entries: Array<{ name: string; mtime: number }>;
  try {
    entries = fs
      .readdirSync(crashesDir)
      .map((name) => {
        const stat = fs.statSync(path.join(crashesDir, name));
        return { name, mtime: stat.mtimeMs };
      })
      .filter((entry) => entry.name.endsWith(".dmp"));
  } catch {
    return 0;
  }
  entries.sort((a, b) => a.mtime - b.mtime);
  let removed = 0;
  for (const entry of entries.slice(0, Math.max(0, entries.length - keep))) {
    try {
      fs.unlinkSync(path.join(crashesDir, entry.name));
      removed += 1;
    } catch {
      // best-effort
    }
  }
  return removed;
}

/** The privacy/contents note placed next to the logs (idempotent). */
export function logsReadmeText(): string {
  return [
    "WindowRunner desktop — diagnostics directory",
    "",
    "Contents:",
    "  server.log        combined stdout/stderr of the bundled server, with the",
    "                    auth token redacted.",
    "  crash-*.log       bounded, redacted records the desktop shell writes when",
    "                    something fails (uncaught exception, unhandled rejection,",
    "                    renderer loss, backend exit).",
    "  README.txt        this file.",
    "",
    "Sibling directory ../crashes/ holds Crashpad minidumps (memory snapshots the",
    "OS crash handler writes when a process dies hard).",
    "",
    "Privacy: nothing in either directory is ever uploaded. Minidumps can contain",
    "process memory, so treat them as sensitive; crash-*.log files are redacted",
    "(secrets replaced with [redacted]) and truncated. You can delete any file",
    "here at any time — the app recreates directories as needed and prunes old",
    "crash logs and dumps automatically.",
    "",
  ].join("\n");
}

/** Write logs/README.txt once (never overwritten — user edits survive). */
export function ensureLogsReadme(logsDir: string): void {
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    const readme = path.join(logsDir, "README.txt");
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(readme, logsReadmeText(), "utf8");
    }
  } catch {
    // best-effort
  }
}

/** Describe an unknown thrown value the way Node prints it, bounded. */
export function describeError(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  return String(value);
}
