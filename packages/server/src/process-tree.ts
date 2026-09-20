/**
 * Process-tree control for the terminal tool (RELEASE_CHECKLIST P1-05).
 *
 * A shell command routinely forks children (npm → node → esbuild …). Killing
 * only the shell leaves them running, still writing to the project and still
 * holding ports. So:
 *
 * - POSIX: the child is spawned `detached: true`, which makes it the leader of
 *   a new process group; `kill(-pid)` then signals the whole group. TERM first,
 *   KILL after a grace period.
 * - Windows: there are no process groups to signal, so `taskkill /T /F /PID`
 *   walks and kills the tree.
 *
 * `killTree` resolves once the signal has been *sent*; callers await the
 * child's `exit` event for confirmation, bounded by the deadline machinery.
 */
import { spawn, type ChildProcess } from "node:child_process";

export const IS_WINDOWS = process.platform === "win32";

export interface SpawnTreeOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** Spawn `command` through the platform shell as the root of a killable tree. */
export function spawnTree(command: string, opts: SpawnTreeOptions): ChildProcess {
  if (IS_WINDOWS) {
    const comspec = process.env.ComSpec || "cmd.exe";
    return spawn(comspec, ["/d", "/s", "/c", `"${command}"`], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  }
  return spawn("/bin/sh", ["-c", command], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group → kill(-pid) reaches every descendant
  });
}

export interface KillTreeOptions {
  /** ms between SIGTERM and SIGKILL on POSIX. Default 2000. Windows always force-kills. */
  graceMs?: number;
}

/**
 * Terminate `child` and everything it spawned. Returns a promise that resolves
 * when the child's exit has been observed, or after `graceMs` + a short margin
 * if it never exits (the caller decides what to report then).
 */
export async function killTree(child: ChildProcess, opts: KillTreeOptions = {}): Promise<{ exited: boolean; forced: boolean }> {
  const graceMs = opts.graceMs ?? 2000;
  if (child.exitCode !== null || child.signalCode !== null) return { exited: true, forced: false };
  const pid = child.pid;
  if (!pid) return { exited: true, forced: false };

  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
  });

  if (IS_WINDOWS) {
    await runTaskkill(pid);
    const ok = await withTimeout(exited, graceMs + 1000);
    return { exited: ok, forced: true };
  }

  signalGroup(pid, "SIGTERM");
  if (await withTimeout(exited, graceMs)) return { exited: true, forced: false };
  signalGroup(pid, "SIGKILL");
  const ok = await withTimeout(exited, 1000);
  return { exited: ok, forced: true };
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal); // whole group
  } catch {
    try {
      process.kill(pid, signal); // group already gone; try the leader alone
    } catch {}
  }
}

function runTaskkill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const tk = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    tk.once("exit", () => resolve());
    tk.once("error", () => resolve());
  });
}

function withTimeout(p: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    p.then(() => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

/** True when a pid still exists (used by tests to prove grandchildren died). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}
