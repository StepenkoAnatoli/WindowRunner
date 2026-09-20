import * as os from "node:os";
import * as path from "node:path";

/**
 * Server configuration for the boot entry point (`src/index.ts`).
 *
 * Everything comes from environment variables; there is no config file yet.
 * Parsing is strict: a value that is set but not understood is a boot failure
 * with a message naming the variable, never a silent fallback to a default.
 * Defaults are the conservative ones documented in README ("Environment
 * variables") and docs/architecture/exploration-7-persistence/config-defaults.md:
 * loopback bind, in-memory persistence, project roots confined to the home
 * directory, offline mock provider.
 */

export type PersistenceMode = "memory" | "file";

export interface PersistenceConfig {
  mode: PersistenceMode;
  /** Absolute. Only used (and only created) in file mode. */
  dataDir: string;
  /** Await persistence before notifying SSE listeners. Default: true in file mode. */
  durableBeforeNotify: boolean;
  /** fsync every appended event. Default: false. */
  fsync: boolean;
}

export type AuthMode = "token" | "off";

export interface AuthConfig {
  /**
   * "token": every /api route requires `Authorization: Bearer <token>` (default).
   * "off": no authentication. Only permitted on a loopback bind; boot refuses
   * the combination of auth off and a non-loopback HOST regardless of
   * WINDOWS_RUNNER_ALLOW_REMOTE.
   */
  mode: AuthMode;
  /**
   * Explicit token from WINDOWS_RUNNER_AUTH_TOKEN. When undefined in token
   * mode, boot resolves one: the persisted `<dataDir>/auth-token` in file
   * mode, otherwise a token generated for this process (printed once).
   */
  token?: string;
  /**
   * Host header values accepted in addition to the loopback names and the
   * bind address. Compared case-insensitively, port ignored. Anything else is
   * refused with 403 HOST_NOT_ALLOWED (DNS-rebinding defence).
   */
  allowedHosts: string[];
  /**
   * Browser origins allowed to call the API. Empty means "any loopback
   * origin" (http(s)://localhost|127.x|[::1] on any port). Never a wildcard:
   * a request carrying an Origin outside this set is refused before auth,
   * and `Origin: null` is always refused.
   */
  allowedOrigins: string[];
}

export interface ServerConfig {
  host: string;
  port: number;
  /** Explicit opt-in required to bind anything but a loopback address. */
  allowRemote: boolean;
  auth: AuthConfig;
  /** Provider name; resolved against the registry in providers/index.ts at boot. */
  provider: string;
  persistence: PersistenceConfig;
  /** Absolute project roots a session may be pinned to. Never empty. */
  allowedRoots: string[];
  /** How long graceful shutdown waits for in-flight work before forcing sockets closed. */
  shutdownGraceMs: number;
}

export const DEFAULT_PORT = 7634;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PROVIDER = "mock";
export const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;
/** Shorter tokens are refused: they must survive an online guess. */
export const MIN_AUTH_TOKEN_LENGTH = 16;

/** Environment variables the boot path reads. Kept in one place so docs can be checked against it. */
export const ENV = {
  host: "HOST",
  port: "PORT",
  allowRemote: "WINDOWS_RUNNER_ALLOW_REMOTE",
  provider: "WINDOWS_RUNNER_PROVIDER",
  persistenceMode: "WINDOWS_RUNNER_PERSISTENCE_MODE",
  dataDir: "WINDOWS_RUNNER_DATA_DIR",
  durableBeforeNotify: "WINDOWS_RUNNER_DURABLE_BEFORE_NOTIFY",
  fsync: "WINDOWS_RUNNER_FSYNC",
  allowedRoots: "WINDOWS_RUNNER_ALLOWED_ROOTS",
  home: "WINDOWS_RUNNER_HOME",
  shutdownGraceMs: "WINDOWS_RUNNER_SHUTDOWN_GRACE_MS",
  auth: "WINDOWS_RUNNER_AUTH",
  authToken: "WINDOWS_RUNNER_AUTH_TOKEN",
  allowedHosts: "WINDOWS_RUNNER_ALLOWED_HOSTS",
  allowedOrigins: "WINDOWS_RUNNER_ALLOWED_ORIGINS",
} as const;

export class ConfigError extends Error {
  readonly variable?: string;

  constructor(message: string, variable?: string) {
    super(message);
    this.name = "ConfigError";
    this.variable = variable;
  }
}

export interface LoadConfigOptions {
  /** Home directory used for defaults. Default: os.homedir(). */
  homedir?: string;
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env, options: LoadConfigOptions = {}): ServerConfig {
  const homedir = options.homedir ?? os.homedir();

  const host = parseHost(env[ENV.host]);
  const port = parsePort(env[ENV.port]);
  const allowRemote = parseBoolean(ENV.allowRemote, env[ENV.allowRemote], false);
  const provider = parseProviderName(env[ENV.provider]);

  const mode = parsePersistenceMode(env[ENV.persistenceMode]);
  const dataDir = parseDataDir(env[ENV.dataDir], homedir);
  const durableBeforeNotify = parseBoolean(ENV.durableBeforeNotify, env[ENV.durableBeforeNotify], mode === "file");
  const fsync = parseBoolean(ENV.fsync, env[ENV.fsync], false);

  const allowedRoots = parseAllowedRoots(env[ENV.allowedRoots], env[ENV.home], homedir);
  const shutdownGraceMs = parseNonNegativeInteger(ENV.shutdownGraceMs, env[ENV.shutdownGraceMs], DEFAULT_SHUTDOWN_GRACE_MS);

  const auth: AuthConfig = {
    mode: parseAuthMode(env[ENV.auth]),
    token: parseAuthToken(env[ENV.authToken]),
    allowedHosts: parseHostList(ENV.allowedHosts, env[ENV.allowedHosts]),
    allowedOrigins: parseOriginList(ENV.allowedOrigins, env[ENV.allowedOrigins]),
  };
  if (auth.mode === "off" && auth.token !== undefined) {
    throw new ConfigError(`${ENV.authToken} is set but ${ENV.auth}=off disables authentication; unset one of them.`, ENV.auth);
  }
  if (auth.mode === "off" && !isLoopbackHost(host)) {
    throw new ConfigError(
      `${ENV.auth}=off is only permitted on a loopback ${ENV.host}; ${host} is reachable from the network. ` +
        `Remove ${ENV.auth}=off (bearer-token auth is the default) or bind a loopback address.`,
      ENV.auth
    );
  }

  return {
    host,
    port,
    allowRemote,
    auth,
    provider,
    persistence: { mode, dataDir, durableBeforeNotify, fsync },
    allowedRoots,
    shutdownGraceMs,
  };
}

/** True for addresses that only the local machine can reach. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

/** One-line, secret-free rendering for the boot banner. */
export function describeConfig(config: ServerConfig): string[] {
  const bindNote = isLoopbackHost(config.host)
    ? " (loopback only)"
    : config.allowRemote
      ? " (non-loopback; remote access explicitly enabled)"
      : " (non-loopback; requires " + ENV.allowRemote + "=1)";
  // The auth line is printed by boot.ts once the token source is known.
  const lines = [
    `bind:        ${config.host}:${config.port}${bindNote}`,
    `provider:    ${config.provider}${config.provider === "mock" ? " (offline; no model calls are made)" : ""}`,
    `persistence: ${config.persistence.mode}${config.persistence.mode === "memory" ? " (sessions and turns are lost on restart)" : ""}`,
  ];
  if (config.persistence.mode === "file") {
    lines.push(`data dir:    ${config.persistence.dataDir}`);
    lines.push(`durability:  durableBeforeNotify=${config.persistence.durableBeforeNotify} fsync=${config.persistence.fsync}`);
  }
  lines.push(`roots:       ${config.allowedRoots.join(", ")}`);
  if (config.auth.allowedHosts.length > 0) lines.push(`hosts:       loopback + ${config.auth.allowedHosts.join(", ")}`);
  lines.push(`origins:     ${config.auth.allowedOrigins.length > 0 ? config.auth.allowedOrigins.join(", ") : "any loopback origin"}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Parsers. Each one: unset or blank -> default; anything else must be valid.
// ---------------------------------------------------------------------------

function isBlank(raw: string | undefined): raw is undefined | "" {
  return raw === undefined || raw.trim() === "";
}

function parseHost(raw: string | undefined): string {
  if (isBlank(raw)) return DEFAULT_HOST;
  const host = raw.trim();
  if (/\s/.test(host)) {
    throw new ConfigError(`${ENV.host} must be a hostname or IP address, got "${raw}".`, ENV.host);
  }
  return host;
}

function parsePort(raw: string | undefined): number {
  if (isBlank(raw)) return DEFAULT_PORT;
  const value = raw.trim();
  if (!/^\d+$/.test(value)) {
    throw new ConfigError(`${ENV.port} must be an integer between 0 and 65535, got "${raw}".`, ENV.port);
  }
  const port = Number(value);
  if (port > 65535) {
    throw new ConfigError(`${ENV.port} must be an integer between 0 and 65535, got "${raw}".`, ENV.port);
  }
  return port;
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export function parseBoolean(variable: string, raw: string | undefined, fallback: boolean): boolean {
  if (isBlank(raw)) return fallback;
  const value = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  throw new ConfigError(`${variable} must be one of 1/true/yes/on or 0/false/no/off, got "${raw}".`, variable);
}

function parseNonNegativeInteger(variable: string, raw: string | undefined, fallback: number): number {
  if (isBlank(raw)) return fallback;
  const value = raw.trim();
  if (!/^\d+$/.test(value)) {
    throw new ConfigError(`${variable} must be a non-negative integer (milliseconds), got "${raw}".`, variable);
  }
  return Number(value);
}

function parseProviderName(raw: string | undefined): string {
  if (isBlank(raw)) return DEFAULT_PROVIDER;
  // Availability is checked against the registry at boot; here we only
  // normalise. Keeping the two concerns apart means config parsing stays pure.
  return raw.trim().toLowerCase();
}

function parsePersistenceMode(raw: string | undefined): PersistenceMode {
  if (isBlank(raw)) return "memory";
  const value = raw.trim().toLowerCase();
  if (value === "memory" || value === "file") return value;
  throw new ConfigError(`${ENV.persistenceMode} must be "memory" or "file", got "${raw}".`, ENV.persistenceMode);
}

function expandHome(p: string, homedir: string): string {
  if (p === "~") return homedir;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(homedir, p.slice(2));
  return p;
}

function parseDataDir(raw: string | undefined, homedir: string): string {
  if (isBlank(raw)) return path.join(homedir, ".windows-runner");
  const expanded = expandHome(raw.trim(), homedir);
  if (!path.isAbsolute(expanded)) {
    throw new ConfigError(
      `${ENV.dataDir} must be an absolute path (a relative data directory would depend on the working directory), got "${raw}".`,
      ENV.dataDir
    );
  }
  return path.resolve(expanded);
}

function parseAllowedRoots(raw: string | undefined, homeOverride: string | undefined, homedir: string): string[] {
  if (!isBlank(raw)) {
    const roots: string[] = [];
    for (const entry of raw.split(",")) {
      const trimmed = entry.trim();
      if (trimmed === "") continue;
      const expanded = expandHome(trimmed, homedir);
      if (!path.isAbsolute(expanded)) {
        throw new ConfigError(
          `${ENV.allowedRoots} entries must be absolute paths (comma-separated), got "${trimmed}".`,
          ENV.allowedRoots
        );
      }
      const resolved = path.resolve(expanded);
      if (!roots.includes(resolved)) roots.push(resolved);
    }
    if (roots.length === 0) {
      throw new ConfigError(`${ENV.allowedRoots} is set but contains no paths.`, ENV.allowedRoots);
    }
    return roots;
  }

  // Default: the user's home directory (README, "Safety rails"). WINDOWS_RUNNER_HOME
  // overrides it for tests and containers.
  if (!isBlank(homeOverride)) {
    const expanded = expandHome(homeOverride.trim(), homedir);
    if (!path.isAbsolute(expanded)) {
      throw new ConfigError(`${ENV.home} must be an absolute path, got "${homeOverride}".`, ENV.home);
    }
    return [path.resolve(expanded)];
  }
  return [path.resolve(homedir)];
}

function parseAuthMode(raw: string | undefined): AuthMode {
  if (isBlank(raw)) return "token";
  const value = raw.trim().toLowerCase();
  if (value === "token" || value === "off") return value;
  throw new ConfigError(`${ENV.auth} must be "token" or "off", got "${raw}".`, ENV.auth);
}

function parseAuthToken(raw: string | undefined): string | undefined {
  if (isBlank(raw)) return undefined;
  const token = raw.trim();
  if (/\s/.test(token)) {
    throw new ConfigError(`${ENV.authToken} must not contain whitespace.`, ENV.authToken);
  }
  if (token.length < MIN_AUTH_TOKEN_LENGTH) {
    throw new ConfigError(
      `${ENV.authToken} must be at least ${MIN_AUTH_TOKEN_LENGTH} characters (got ${token.length}); ` +
        `unset it to let the server generate one.`,
      ENV.authToken
    );
  }
  return token;
}

function parseHostList(variable: string, raw: string | undefined): string[] {
  if (isBlank(raw)) return [];
  const out: string[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim().toLowerCase();
    if (trimmed === "") continue;
    if (trimmed === "*" || /[\s/]/.test(trimmed)) {
      throw new ConfigError(`${variable} entries must be hostnames or IP addresses (no wildcard, scheme or path), got "${entry.trim()}".`, variable);
    }
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function parseOriginList(variable: string, raw: string | undefined): string[] {
  if (isBlank(raw)) return [];
  const out: string[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    if (trimmed === "*" || trimmed.toLowerCase() === "null") {
      throw new ConfigError(`${variable} must list explicit origins; "${trimmed}" is not allowed.`, variable);
    }
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new ConfigError(`${variable} entries must be origins like http://localhost:5173, got "${trimmed}".`, variable);
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username || url.password) {
      throw new ConfigError(`${variable} entries must be bare http(s) origins (scheme://host[:port]), got "${trimmed}".`, variable);
    }
    const origin = url.origin.toLowerCase();
    if (!out.includes(origin)) out.push(origin);
  }
  return out;
}
