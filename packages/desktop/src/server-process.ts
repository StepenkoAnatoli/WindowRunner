/**
 * Backend lifecycle management for the desktop shell.
 *
 * Owns everything about the bundled WindowRunner server process:
 *
 *  - spawn `packages/server/dist/index.cjs` with `process.execPath` (inside
 *    Electron that is the Electron binary with `ELECTRON_RUN_AS_NODE=1`, so
 *    installed users need no Node.js); the bundle is self-contained;
 *  - loopback-only bind, ephemeral port (`PORT=0` — the OS picks a free port,
 *    so a second WindowRunner instance never collides), randomly generated
 *    bearer token passed via `WINDOWS_RUNNER_AUTH_TOKEN` (never in a URL);
 *  - file persistence into the per-user data directory;
 *  - parse the ready line (`windows-runner listening on <url>`) to learn the
 *    real port; reject startup if the process exits first;
 *  - capture stdout/stderr (and tee to a log file) with the token redacted;
 *  - stop the whole process tree on shutdown (POSIX process group /
 *    `taskkill /T` on Windows — same contract as
 *    packages/server/src/process-tree.ts; kept as a small local mirror so the
 *    desktop package does not import server internals).
 *
 * No provider, session or tool logic lives here — the server remains the sole
 * owner of that.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface DesktopServer {
  url: string;
  token: string;
  process: ChildProcess;
  stop(): Promise<void>;
  /** Captured stdout/stderr with the token redacted. For diagnostics and tests. */
  output(): string;
}

export interface StartServerOptions {
  /** Persistence directory (WINDOWS_RUNNER_DATA_DIR). Created if missing. */
  dataDir: string;
  /** Bind port. Default 0 = OS-assigned ephemeral (multi-instance safe). */
  port?: number;
  /** Absolute path to the server bundle. Default: packages/server/dist/index.cjs. */
  serverBundle?: string;
  /** File the redacted combined output is appended to (e.g. logs/server.log). */
  logFile?: string;
  /** How long to wait for the ready line. Default 30s. */
  readyTimeoutMs?: number;
  /** Executable used to run the bundle. Default: process.execPath. */
  execPath?: string;
  /** Pin the bearer token (tests). Default: 32 random bytes, hex. */
  token?: string;
  /** Extra environment for the server process (after the standard keys). */
  extraEnv?: Record<string, string>;
}

export const READY_LINE = /^windows-runner listening on (https?:\/\/\S+)$/m;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 5_000;

function here(): string {
  try {
    if (typeof __dirname === "string") return __dirname;
  } catch {}
  return path.dirname(fileURLToPath(import.meta.url));
}

/** Default bundle location in the monorepo (src/ and dist/ are both two levels under packages/). */
export function defaultServerBundle(): string {
  return path.resolve(here(), "..", "..", "server", "dist", "index.cjs");
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function redact(text: string, token: string): string {
  return token ? text.split(token).join("[redacted]") : text;
}

/** Mirror of packages/server/src/process-tree.ts: kill a whole spawned tree. */
function killTree(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  if (process.platform === "win32") {
    // No process groups on Windows: taskkill walks and kills the tree.
    try {
      spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true, stdio: "ignore" });
    } catch {}
    return;
  }
  // POSIX: spawned `detached`, so the child leads its own process group and
  // -pid reaches every descendant (npm → node → …).
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startServer(options: StartServerOptions): Promise<DesktopServer> {
  const bundle = path.resolve(options.serverBundle ?? defaultServerBundle());
  if (!fs.existsSync(bundle)) {
    throw new Error(`bundled server not found at ${bundle}; run \`npm run build\` first (packages/server/dist/index.cjs)`);
  }

  const token = options.token ?? generateToken();
  const port = options.port ?? 0;
  await fsp.mkdir(options.dataDir, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    WINDOWS_RUNNER_AUTH: "token",
    WINDOWS_RUNNER_AUTH_TOKEN: token,
    WINDOWS_RUNNER_PERSISTENCE_MODE: "file",
    WINDOWS_RUNNER_DATA_DIR: options.dataDir,
    ...options.extraEnv,
  };
  // Inside Electron, run the bundle on Electron's own Node runtime.
  if (process.versions.electron && !options.execPath) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }

  const child = spawn(options.execPath ?? process.execPath, [bundle], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });

  let captured = "";
  const logStream = options.logFile ? fs.createWriteStream(options.logFile, { flags: "a" }) : undefined;
  const capture = (chunk: Buffer | string) => {
    const text = redact(String(chunk), token);
    captured += text;
    if (captured.length > 256 * 1024) captured = captured.slice(-256 * 1024);
    logStream?.write(text);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  let exited = false;
  let exitInfo = "";
  const exitPromise = new Promise<void>((resolve) => {
    child.on("exit", (code, signal) => {
      exited = true;
      exitInfo = `exit code ${code}${signal ? ` (signal ${signal})` : ""}`;
      logStream?.end();
      resolve();
    });
    child.on("error", (err) => {
      exited = true;
      exitInfo = `spawn error: ${err.message}`;
      logStream?.end();
      resolve();
    });
  });

  const output = () => captured;

  // Wait for the ready line to learn the real (ephemeral) port.
  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      killTree(child.pid ?? 0, "SIGKILL");
      reject(new Error(`server did not become ready within ${options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS}ms\n${redact(captured, token)}`));
    }, options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);

    const check = () => {
      if (exited) {
        clearTimeout(timeout);
        reject(new Error(`server process exited before ready (${exitInfo})\n${redact(captured, token)}`));
        return;
      }
      const match = READY_LINE.exec(captured);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    };
    child.stdout?.on("data", check);
    child.stderr?.on("data", check);
    child.on("exit", check);
    check();
  });

  let stopPromise: Promise<void> | undefined;
  const server: DesktopServer = {
    url,
    token,
    process: child,
    output,
    stop(): Promise<void> {
      if (!stopPromise) stopPromise = stopServer(server);
      return stopPromise;
    },
  };
  // Keep the exit promise referenced so cleanup always observes it.
  void exitPromise;
  return server;
}

/** Poll `/healthz` until it answers `{status:"ok"}` or the timeout expires. */
export async function waitForHealth(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/healthz`);
      if (res.status === 200) {
        const body = (await res.json()) as { status?: string };
        if (body.status === "ok") return;
        lastError = `unexpected health body: ${JSON.stringify(body)}`;
      } else {
        lastError = `healthz returned ${res.status}`;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(250);
  }
  throw new Error(`server at ${url} did not pass /healthz within ${timeoutMs}ms: ${lastError}`);
}

/**
 * Graceful stop: SIGTERM the whole tree, wait for exit within the grace
 * period, then SIGKILL the tree. Idempotent via `server.stop()`; calling this
 * function twice on the same server is safe because the second call observes
 * the already-exited process.
 */
export async function stopServer(server: DesktopServer): Promise<void> {
  const child = server.process;
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const exit = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });

  killTree(pid, "SIGTERM");
  const settled = await Promise.race([exit.then(() => true), sleep(STOP_GRACE_MS).then(() => false)]);
  if (!settled) {
    killTree(pid, "SIGKILL");
    await Promise.race([exit, sleep(2_000)]);
  }
}
