/**
 * Electron launch helper for the desktop e2e (PR A / A2).
 *
 * Two launch targets share one contract (the same one test/electron-smoke.ts
 * implements):
 *
 *  - WR_ELECTRON_EXECUTABLE set -> the installed/packaged WindowRunner.exe.
 *    The A2 windows-installer CI job points it at the per-user install. No app
 *    path argument: the executable IS the application.
 *  - otherwise -> the real Electron binary from node_modules with
 *    dist/main.cjs as the app script (the unpacked dev/test layout).
 *
 * On a Linux box without a display the window runs on Chromium's ozone
 * headless platform (the flags are Linux-only — never pass them on Windows or
 * macOS runners, which have no DISPLAY variable but do have a desktop).
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication } from "playwright-core";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
export const desktopRoot = path.resolve(here, "..");
const mainCjs = path.join(desktopRoot, "dist", "main.cjs");

export interface LaunchTarget {
  executablePath: string;
  args: string[];
}

export function resolveLaunch(): LaunchTarget {
  const headless: string[] = ["--no-sandbox"];
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    headless.push("--ozone-platform=headless", "--disable-gpu");
  }

  const installed = process.env.WR_ELECTRON_EXECUTABLE?.trim();
  if (installed) {
    const exe = path.resolve(installed);
    if (!fs.existsSync(exe)) {
      throw new Error(`WR_ELECTRON_EXECUTABLE points at a missing file: ${exe}`);
    }
    return { executablePath: exe, args: headless };
  }

  const electronPath: string = require("electron");
  if (typeof electronPath !== "string" || !fs.existsSync(electronPath)) {
    throw new Error(
      "the Electron binary is not installed (electron/dist/electron missing). " +
        "Run `node node_modules/electron/install.js` where GitHub release downloads are allowed."
    );
  }
  return { executablePath: electronPath, args: [...headless, mainCjs] };
}

export interface LaunchOptions {
  /** WINDOWS_RUNNER_DESKTOP_DATA_DIR: per-run app data (sessions, logs). */
  dataDir: string;
  /** Absolute project roots the server will accept sessions in (comma-joined). */
  allowedRoots: string[];
  extraEnv?: Record<string, string>;
}

export async function launchDesktopApp(options: LaunchOptions): Promise<ElectronApplication> {
  const { executablePath, args } = resolveLaunch();
  return electron.launch({
    executablePath,
    args,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SANDBOX: "1",
      WINDOWS_RUNNER_DESKTOP_DATA_DIR: options.dataDir,
      WINDOWS_RUNNER_ALLOWED_ROOTS: options.allowedRoots.join(","),
      // The offline mock provider is the server default; pin it so the journey
      // is explicit and immune to future default changes.
      WINDOWS_RUNNER_PROVIDER: "mock",
      ...options.extraEnv,
    },
  });
}
