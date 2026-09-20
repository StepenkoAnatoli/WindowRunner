import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { ConfigError, isLoopbackHost, ENV, MIN_AUTH_TOKEN_LENGTH, type ServerConfig } from "./config.js";
import { generateAuthToken } from "./security.js";
import { ProjectTrustRegistry } from "./agent/project-trust.js";
import { TurnManager } from "./agent/turn-manager.js";
import { InMemoryTurnLogStore } from "./agent/turn-log-store.js";
import { FileTurnLogStore } from "./agent/file-turn-log-store.js";
import { FileSessionStore, type SessionBootDiagnostics } from "./agent/file-session-store.js";
import { ApprovalRegistry } from "./agent/approval-registry.js";
import { SessionManager } from "./agent/session-manager.js";
import { createProvider, UnknownProviderError } from "./providers/index.js";
import type { LLMProvider } from "./providers/types.js";
import type { ToolDefinition } from "./agent/tools/types.js";

/**
 * Server boot path.
 *
 *   loadServerConfig()  ->  createRuntime()  ->  startServer()  ->  close()
 *
 * `createRuntime` composes the dependencies `createApp()` needs and performs
 * restart recovery (TurnManager.boot + FileSessionStore.boot) in file mode.
 * `startServer` additionally binds the HTTP listener and returns a handle whose
 * `close()` drains the server: stop the validation timer, stop accepting
 * connections, abort in-flight turns (they record turn_cancelled), wait up to
 * the grace period for them to settle and for connections to end, then force
 * any remaining sockets closed.
 *
 * `src/index.ts` is the executable that calls this with process.env and wires
 * signals. Tests call it directly with port 0 and overrides.
 */

export interface RuntimeOverrides {
  /** Replace the configured provider (tests inject a scripted FakeProvider). */
  provider?: LLMProvider;
  /** Tools exposed to the agent loop. This checkout ships none, so the default is empty. */
  tools?: Map<string, ToolDefinition>;
  now?: () => number;
  /** Boot-time logger. Default: silent (index.ts passes console.log). */
  log?: (line: string) => void;
  /** Built web UI directory. Default: packages/web/dist/app next to this package, if it exists; `null` disables. */
  webDir?: string | null;
}

/**
 * Locate the built web UI relative to this file. Works from src/ (tsx) and
 * from the bundled dist/index.cjs: both are two levels below `packages/`, so
 * `../../web/dist/app` is the same directory either way.
 */
export function resolveWebDir(): string | undefined {
  let here: string | undefined;
  try {
    if (typeof __dirname === "string") here = __dirname;
  } catch {}
  if (!here) {
    try {
      const url = typeof import.meta !== "undefined" ? import.meta.url : undefined;
      if (url) here = path.dirname(fileURLToPath(url));
    } catch {}
  }
  if (!here) return undefined;
  const candidate = path.resolve(here, "..", "..", "web", "dist", "app");
  return existsSync(path.join(candidate, "index.html")) ? candidate : undefined;
}

export interface TurnBootDiagnostics {
  turnsLoaded: number;
  turnsWithRestart: number;
  diagnostics?: unknown;
}

export interface AuthBootDiagnostics {
  mode: "token" | "off";
  /** Where the effective token came from. Never the token itself. */
  tokenSource?: "env" | "file" | "generated";
  /** Path of the persisted token file (file persistence mode only). */
  tokenFile?: string;
}

export interface BootDiagnostics {
  startedAt: number;
  persistenceMode: ServerConfig["persistence"]["mode"];
  dataDir?: string;
  turns: TurnBootDiagnostics;
  sessions?: SessionBootDiagnostics;
  auth: AuthBootDiagnostics;
  trust?: { loaded: number; warnings: string[] };
}

export interface Runtime {
  config: ServerConfig;
  app: any;
  manager: TurnManager;
  approvals: ApprovalRegistry;
  sessionManager: SessionManager;
  provider: LLMProvider;
  tools: Map<string, ToolDefinition>;
  trust: ProjectTrustRegistry;
  boot: BootDiagnostics;
  /** Directory the web UI is served from, if any. */
  webDir?: string;
  /**
   * The bearer token clients must present (undefined when auth is off). Held
   * on the runtime so the entry point can print it once and tests can use it;
   * it is never part of BootDiagnostics or any HTTP response.
   */
  authToken?: string;
}

export interface CloseOptions {
  /** Overrides config.shutdownGraceMs. */
  graceMs?: number;
  /** Reason recorded on turns that are aborted by the shutdown. */
  reason?: string;
}

export interface CloseResult {
  /** Turns that were still running when close() began. */
  abortedTurns: number;
  /** True when the grace period expired and sockets were forced closed. */
  forced: boolean;
}

export interface StartedServer extends Runtime {
  server: http.Server;
  host: string;
  port: number;
  /** http://host:port, with IPv6 hosts bracketed. */
  url: string;
  close(options?: CloseOptions): Promise<CloseResult>;
}

export class BindRefusedError extends ConfigError {
  constructor(host: string, reason: "opt-in" | "auth-off") {
    super(
      reason === "auth-off"
        ? `refusing to bind ${host} with ${ENV.auth}=off: an unauthenticated agent that can read and edit files under ` +
            `the allowed roots would be exposed to anyone who can reach the port. Remove ${ENV.auth}=off (bearer-token ` +
            `auth is the default) or bind a loopback HOST.`
        : `refusing to bind ${host}: a non-loopback bind exposes the agent API — and every project under the allowed ` +
            `roots — to the network, protected only by the bearer token over plain HTTP. Use a loopback HOST (default ` +
            `127.0.0.1), or set ${ENV.allowRemote}=1 to accept that explicitly (put TLS in front; see docs/INSTALL.md, "Remote access").`,
      ENV.host
    );
    this.name = "BindRefusedError";
  }
}

/**
 * Resolve the bearer token for token mode, in this order:
 *   1. WINDOWS_RUNNER_AUTH_TOKEN (config.auth.token);
 *   2. file mode: `<dataDir>/auth-token`, created (0600) on first boot so the
 *      token survives restarts and other local tools can read it;
 *   3. memory mode: a fresh token for this process.
 */
async function resolveAuthToken(config: ServerConfig): Promise<{ token: string; source: "env" | "file" | "generated"; file?: string }> {
  if (config.auth.token !== undefined) return { token: config.auth.token, source: "env" };
  if (config.persistence.mode === "file") {
    const file = path.join(config.persistence.dataDir, "auth-token");
    try {
      const existing = (await fs.readFile(file, "utf8")).trim();
      if (existing.length >= MIN_AUTH_TOKEN_LENGTH && !/\s/.test(existing)) return { token: existing, source: "file", file };
      throw new ConfigError(
        `${file} does not contain a usable token (need >= ${MIN_AUTH_TOKEN_LENGTH} non-whitespace characters). ` +
          `Delete the file to generate a new one, or set ${ENV.authToken}.`,
        ENV.authToken
      );
    } catch (err: any) {
      if (err instanceof ConfigError) throw err;
      if (err?.code !== "ENOENT") {
        throw new ConfigError(`cannot read ${file} (${err?.code ?? err?.message}); set ${ENV.authToken} or fix the file's permissions.`, ENV.authToken);
      }
    }
    const token = generateAuthToken();
    try {
      await fs.writeFile(file, token + "\n", { mode: 0o600, flag: "wx" });
    } catch (err: any) {
      if (err?.code === "EEXIST") return resolveAuthToken(config); // another boot raced us; read theirs
      throw new ConfigError(`cannot write ${file} (${err?.code ?? err?.message}); set ${ENV.authToken} or make the data dir writable.`, ENV.authToken);
    }
    return { token, source: "generated", file };
  }
  return { token: generateAuthToken(), source: "generated" };
}

export async function createRuntime(config: ServerConfig, overrides: RuntimeOverrides = {}): Promise<Runtime> {
  const now = overrides.now ?? (() => Date.now());
  const log = overrides.log ?? (() => {});

  // Fail on an unknown provider before touching the filesystem.
  let provider: LLMProvider;
  try {
    provider = overrides.provider ?? createProvider(config.provider);
  } catch (err) {
    if (err instanceof UnknownProviderError) throw new ConfigError(err.message, ENV.provider);
    throw err;
  }

  const tools = overrides.tools ?? new Map<string, ToolDefinition>();
  const approvals = new ApprovalRegistry({ now });

  let manager: TurnManager;
  let sessionStore: FileSessionStore | undefined;
  const boot: BootDiagnostics = {
    startedAt: now(),
    persistenceMode: config.persistence.mode,
    turns: { turnsLoaded: 0, turnsWithRestart: 0 },
    auth: { mode: config.auth.mode },
  };

  let trust: ProjectTrustRegistry;
  if (config.persistence.mode === "file") {
    const { dataDir, fsync, durableBeforeNotify } = config.persistence;
    await ensureDataDir(dataDir);
    boot.dataDir = dataDir;
    trust = new ProjectTrustRegistry({ now, dataDir });
    boot.trust = await trust.boot();

    const turnStore = new FileTurnLogStore({ dataDir, fsync, now });
    sessionStore = new FileSessionStore({ dataDir, now });
    manager = new TurnManager({ store: turnStore, now, durableBeforeNotify });

    // Restart recovery. Order matters: turns first so a RESTART is recorded for
    // anything left non-terminal, then sessions, which are re-validated against
    // the *current* allowed roots (persisted roots never authorize by themselves).
    boot.turns = await manager.boot();
    boot.sessions = await sessionStore.boot(config.allowedRoots, now);

    // The configuration banner (describeConfig) already names the mode and data
    // dir; the runtime only reports what recovery actually did.
    log(`recovered:   ${boot.turns.turnsLoaded} turn(s), ${boot.turns.turnsWithRestart} marked RESTART; ` +
      `${boot.sessions.sessionsLoaded} session(s) loaded, ${boot.sessions.sessionsSkipped} skipped`);
    for (const warning of collectWarnings(boot)) log(`warning:     ${warning}`);
  } else {
    manager = new TurnManager({ store: new InMemoryTurnLogStore(), now, durableBeforeNotify: config.persistence.durableBeforeNotify });
    trust = new ProjectTrustRegistry({ now });
  }

  // Authentication. Resolved after the data dir exists (the token may live
  // there) and before the app is built, so the middleware never sees a
  // half-configured policy.
  let authToken: string | undefined;
  if (config.auth.mode === "token") {
    const resolved = await resolveAuthToken(config);
    authToken = resolved.token;
    boot.auth.tokenSource = resolved.source;
    boot.auth.tokenFile = resolved.file;
    log(`auth:        bearer token ${resolved.source === "env" ? `from ${ENV.authToken}` : resolved.source === "file" ? `from ${resolved.file}` : "generated for this process"}`);
  } else {
    log(`auth:        off — every local process can drive the agent (loopback bind only)`);
  }
  if (boot.trust && boot.trust.loaded > 0) log(`trust:       ${boot.trust.loaded} trusted project(s) loaded`);

  const sessionManager = new SessionManager({
    now,
    isTurnTerminal: (turnId) => {
      const turnLog = manager.getLog(turnId);
      return turnLog ? turnLog.state.isTerminal : true;
    },
    sessionStore,
  });

  const webDir = overrides.webDir === null ? undefined : overrides.webDir ?? resolveWebDir();

  const app = createApp({
    webDir,
    manager,
    provider,
    tools,
    approvals,
    sessionManager,
    allowedRoots: config.allowedRoots,
    now,
    getBootDiagnostics: () => boot,
    trust,
    security: {
      mode: config.auth.mode,
      token: authToken,
      bindHost: config.host,
      allowedHosts: config.auth.allowedHosts,
      allowedOrigins: config.auth.allowedOrigins,
    },
  });

  return { config, app, manager, approvals, sessionManager, provider, tools, trust, boot, authToken, webDir };
}

export async function startServer(config: ServerConfig, overrides: RuntimeOverrides = {}): Promise<StartedServer> {
  if (!isLoopbackHost(config.host)) {
    // Auth off is never acceptable off loopback, and cannot be opted into.
    if (config.auth.mode === "off") throw new BindRefusedError(config.host, "auth-off");
    if (!config.allowRemote) throw new BindRefusedError(config.host, "opt-in");
  }

  const runtime = await createRuntime(config, overrides);
  const server = http.createServer(runtime.app);

  try {
    await listen(server, config.port, config.host);
  } catch (err) {
    runtime.app.close();
    throw err;
  }

  const address = server.address() as AddressInfo;
  const host = address.address;
  const port = address.port;
  const url = formatUrl(host, port);

  let closing: Promise<CloseResult> | undefined;
  const close = (options: CloseOptions = {}): Promise<CloseResult> => {
    if (!closing) closing = drain(runtime, server, options.graceMs ?? config.shutdownGraceMs, options.reason);
    return closing;
  };

  return { ...runtime, server, host, port, url, close };
}

// ---------------------------------------------------------------------------

async function ensureDataDir(dataDir: string): Promise<void> {
  try {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.access(dataDir, fsConstants.W_OK);
  } catch (err: any) {
    throw new ConfigError(
      `${ENV.dataDir}: cannot use data directory ${dataDir} (${err?.code ?? err?.message ?? err}). ` +
        `Create it with write permission for this user, or point ${ENV.dataDir} elsewhere.`,
      ENV.dataDir
    );
  }
}

function collectWarnings(boot: BootDiagnostics): string[] {
  const out: string[] = [];
  const turnDiag: any = boot.turns.diagnostics;
  if (turnDiag && Array.isArray(turnDiag.warnings)) out.push(...turnDiag.warnings.map(String));
  if (turnDiag && Array.isArray(turnDiag.quarantinedFiles) && turnDiag.quarantinedFiles.length > 0) {
    out.push(`quarantined ${turnDiag.quarantinedFiles.length} turn file(s): ${turnDiag.quarantinedFiles.join(", ")}`);
  }
  if (boot.sessions) out.push(...boot.sessions.warnings);
  return out;
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      if (err.code === "EADDRINUSE") {
        reject(new ConfigError(`${host}:${port} is already in use. Stop the other process or set ${ENV.port} to a free port.`, ENV.port));
      } else if (err.code === "EACCES") {
        reject(new ConfigError(`binding ${host}:${port} was denied (EACCES). Ports below 1024 need elevated privileges; set ${ENV.port} to a higher port.`, ENV.port));
      } else if (err.code === "EADDRNOTAVAIL" || err.code === "ENOTFOUND") {
        reject(new ConfigError(`${ENV.host}=${host} is not an address of this machine (${err.code}).`, ENV.host));
      } else {
        reject(err);
      }
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export function formatUrl(host: string, port: number): string {
  const h = host.includes(":") ? `[${host}]` : host;
  return `http://${h}:${port}`;
}

async function drain(runtime: Runtime, server: http.Server, graceMs: number, reason?: string): Promise<CloseResult> {
  // 1. Stop periodic validation.
  runtime.app.close();

  // 2. Stop accepting connections; existing ones may finish.
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();

  // 3. Abort in-flight turns so they settle as turn_cancelled (durably, in file mode).
  const abortedTurns: number = runtime.app.abortActiveTurns(reason ?? "server shutting down");

  // 4. Wait for active turns to reach a terminal state, then for connections to
  //    end — but never longer than the grace period.
  const deadline = Date.now() + graceMs;
  await waitUntil(() => runtime.manager.getActiveTurnCount() === 0, deadline);
  const forced = !(await settleWithin(closed, deadline));
  if (forced) {
    server.closeAllConnections();
    await closed;
  }

  return { abortedTurns, forced };
}

async function waitUntil(predicate: () => boolean, deadline: number): Promise<boolean> {
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  return true;
}

/** Resolves true if `promise` settles before `deadline`, false otherwise (never rejects). */
function settleWithin(promise: Promise<unknown>, deadline: number): Promise<boolean> {
  const remaining = Math.max(0, deadline - Date.now());
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), remaining);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      }
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
