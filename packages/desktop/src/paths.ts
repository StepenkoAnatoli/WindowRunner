/**
 * Platform-specific desktop paths.
 *
 * All mutable application data lives in the per-user application-data location
 * (`app.getPath("userData")` on Windows: `%APPDATA%\WindowRunner`) — never in
 * the installation directory (`Program Files`) and never beside the
 * executable. The bundled server is told to persist into the same directory
 * (`WINDOWS_RUNNER_DATA_DIR`), so `provider-profiles.json`, `usage.jsonl`,
 * `auth-token` and `sessions/` land there and `logs/` sits next to them.
 *
 * Pure functions plus one explicit mkdir helper, so tests can redirect every
 * path into a temporary directory (test/paths.test.ts).
 */

import * as os from "node:os";
import * as path from "node:path";

export interface DesktopPaths {
  /** Root per-user data directory (e.g. `%APPDATA%\WindowRunner`). */
  appDataDir: string;
  /** Persistence directory handed to the bundled server as WINDOWS_RUNNER_DATA_DIR. */
  serverDataDir: string;
  /** Directory for redacted server logs (`logs/server.log`). */
  logsDir: string;
  /** Optional per-user projects directory. Not created in A1. */
  userProjectsDir?: string;
}

export interface ResolveDesktopPathsOptions {
  /**
   * Explicit data root. Electron main passes `app.getPath("userData")`.
   * When omitted: `$WINDOWS_RUNNER_DESKTOP_DATA_DIR` (tests/redirects), then
   * the platform application-data location.
   */
  appDataDir?: string;
}

export const DATA_DIR_ENV = "WINDOWS_RUNNER_DESKTOP_DATA_DIR";

function defaultAppDataDir(env: NodeJS.ProcessEnv = process.env, homedir: string = os.homedir()): string {
  const override = env[DATA_DIR_ENV];
  if (override !== undefined && override.trim() !== "") {
    return path.resolve(override.trim());
  }
  if (process.platform === "win32") {
    const appData = env.APPDATA ?? path.join(homedir, "AppData", "Roaming");
    return path.join(appData, "WindowRunner");
  }
  if (process.platform === "darwin") {
    return path.join(homedir, "Library", "Application Support", "WindowRunner");
  }
  const configHome = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== ""
    ? env.XDG_CONFIG_HOME.trim()
    : path.join(homedir, ".config");
  return path.join(configHome, "WindowRunner");
}

/**
 * Resolve every desktop path. Deterministic: two calls with the same inputs
 * return identical results, and the install/executable location is never
 * consulted.
 */
export function resolveDesktopPaths(options: ResolveDesktopPathsOptions = {}): DesktopPaths {
  const appDataDir = path.resolve(options.appDataDir ?? defaultAppDataDir());
  return {
    appDataDir,
    // Same directory: the server drops provider-profiles.json, usage.jsonl,
    // auth-token and sessions/ directly under the app data root.
    serverDataDir: appDataDir,
    logsDir: path.join(appDataDir, "logs"),
    userProjectsDir: undefined,
  };
}

/** Create the mutable-data directories (idempotent). */
export async function ensureDesktopPaths(paths: DesktopPaths): Promise<void> {
  const fsp = await import("node:fs/promises");
  await fsp.mkdir(paths.appDataDir, { recursive: true });
  await fsp.mkdir(paths.logsDir, { recursive: true });
}
