/**
 * Electron main process (PR A / A1).
 *
 * Flow:
 *   app.whenReady()
 *     → create application data directories (per-user, never the install dir)
 *     → generate the internal auth token (in-memory; passed to the server via
 *       env and to the renderer only through the preload bridge)
 *     → spawn the bundled server on an OS-assigned loopback port (PORT=0)
 *     → wait for /healthz
 *     → create the BrowserWindow and load `http://127.0.0.1:<port>/desktop`
 *       (the renderer shell is served by the backend itself, so API and SSE
 *       calls are same-origin and the server's Origin policy is unchanged)
 *
 * Shutdown stops the backend process tree; startup failures show a native
 * error dialog and exit non-zero. Nothing disables authentication, and the
 * token never appears in URLs, logs, or storage.
 */

import { app, BrowserWindow, crashReporter, dialog, ipcMain, session, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import * as path from "node:path";
import { DESKTOP_CHANNELS, type DesktopAppInfo, type DesktopBootstrap } from "./desktop-bridge.js";
import {
  CRASH_DUMP_KEEP,
  CRASH_LOG_KEEP,
  describeError,
  ensureLogsReadme,
  pruneCrashDumps,
  pruneCrashLogs,
  writeCrashLog,
  type CrashKind,
  type CrashRecord,
} from "./crash-diagnostics.js";
import { ensureDesktopPaths, resolveDesktopPaths, type DesktopPaths } from "./paths.js";
import { defaultServerBundle, startServer, stopServer, waitForHealth, type DesktopServer } from "./server-process.js";
import { loadWorkspaceCatalogFile, saveWorkspaceCatalogFile } from "./workspace-catalog.js";

let server: DesktopServer | undefined;
let shuttingDown: Promise<void> | undefined;
let mainWindow: BrowserWindow | undefined;

// Crash diagnostics must be armed as early as possible — before anything else
// can fail. Minidumps go to <userData>/crashes and are never uploaded; the
// human-readable crash-*.log records are written by recordCrash() below.
const bootPaths = resolveDesktopPaths({ appDataDir: app.getPath("userData") });
app.setPath("crashDumps", bootPaths.crashesDir);
crashReporter.start({ uploadToServer: false, compress: true });

/**
 * Write a redacted crash record to logs/crash-*.log. Synchronous and
 * best-effort: called from paths where the process may be dying. Returns the
 * file path (for the fatal dialog) or undefined.
 */
function recordCrash(kind: CrashKind, details: string, extras?: Record<string, string | number>): string | undefined {
  const record: CrashRecord = {
    kind,
    writtenAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    platform: process.platform,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    pid: process.pid,
    details,
    extras,
  };
  // The bearer token is the one secret the main process holds; scrub it (and
  // any env-provided token) from every crash record.
  const scrub = [server?.token ?? "", process.env.WINDOWS_RUNNER_AUTH_TOKEN ?? ""].filter((s) => s.length > 0);
  return writeCrashLog(resolveDesktopPaths({ appDataDir: app.getPath("userData") }).logsDir, record, {
    scrub,
    keep: CRASH_LOG_KEEP,
  });
}

function resolveServerBundle(): string {
  if (app.isPackaged) {
    // A2's electron-builder config copies dist/resources/ verbatim into
    // process.resourcesPath, preserving the monorepo geometry the bundled
    // server uses to locate the UIs.
    return path.join(process.resourcesPath, "packages", "server", "dist", "index.cjs");
  }
  return defaultServerBundle();
}

/** Only the window loaded from our own server origin may use the IPC channels. */
function assertTrustedSender(event: Pick<IpcMainEvent, "senderFrame"> | Pick<IpcMainInvokeEvent, "senderFrame">): void {
  const url = event.senderFrame?.url ?? "";
  if (!server || !url.startsWith(server.url)) {
    throw new Error("untrusted IPC sender");
  }
}

function registerIpc(): void {
  ipcMain.on(DESKTOP_CHANNELS.bootstrap, (event) => {
    try {
      assertTrustedSender(event);
      const bootstrap: DesktopBootstrap = { baseUrl: server!.url, token: server!.token };
      event.returnValue = bootstrap;
    } catch {
      event.returnValue = null;
    }
  });

  ipcMain.handle(DESKTOP_CHANNELS.chooseFolder, async (event) => {
    assertTrustedSender(event);
    const result = await dialog.showOpenDialog({
      title: "Choose a project folder",
      properties: ["openDirectory"],
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  ipcMain.handle(DESKTOP_CHANNELS.openExternal, async (event, target: unknown) => {
    assertTrustedSender(event);
    if (typeof target !== "string" || target.length === 0) throw new Error("path required");
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
  });

  ipcMain.handle(DESKTOP_CHANNELS.appInfo, (event): DesktopAppInfo => {
    assertTrustedSender(event);
    return { version: app.getVersion(), platform: process.platform };
  });

  // B1 workspace catalog: fixed schema at a fixed path. The renderer passes
  // only the catalog value — never a path — and the main process validates
  // before every write (a malformed value rejects the invoke; nothing is
  // written). Reads of a missing/corrupt file resolve to null.
  ipcMain.handle(DESKTOP_CHANNELS.catalogLoad, async (event) => {
    assertTrustedSender(event);
    return loadWorkspaceCatalogFile(desktopPaths().workspaceCatalogFile);
  });

  ipcMain.handle(DESKTOP_CHANNELS.catalogSave, async (event, catalog: unknown) => {
    assertTrustedSender(event);
    await saveWorkspaceCatalogFile(desktopPaths().workspaceCatalogFile, catalog);
  });
}

let cachedPaths: DesktopPaths | undefined;

/** Per-user paths, resolved once the app module is ready to answer `getPath`. */
function desktopPaths(): DesktopPaths {
  if (!cachedPaths) {
    cachedPaths = resolveDesktopPaths({ appDataDir: app.getPath("userData") });
  }
  return cachedPaths;
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "WindowRunner",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });

  // Navigation lockdown: the window stays on the internal server origin.
  win.webContents.on("will-navigate", (event, url) => {
    if (!server || !url.startsWith(server.url)) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());

  void win.loadURL(`${server!.url}/desktop`);
  return win;
}

let rendererGoneStrikes = 0;

function fatal(title: string, message: string, kind: CrashKind = "uncaughtException"): never {
  // Record first (synchronously — we may be about to exit), then tell the
  // human, naming the file we just wrote.
  const crashFile = recordCrash(kind, message);
  const suffix = crashFile ? `\n\nA crash report was written to:\n${crashFile}` : "";
  dialog.showErrorBox(title, (message.length > 1500 ? `${message.slice(0, 1500)}…` : message) + suffix);
  if (server) {
    // Stop the backend before leaving; do not await — app.exit is immediate.
    void stopServer(server).finally(() => app.exit(1));
  } else {
    app.exit(1);
  }
  throw new Error(title); // unreachable for control flow; satisfies never
}

async function bootstrap(): Promise<void> {
  const paths = resolveDesktopPaths({ appDataDir: app.getPath("userData") });
  await ensureDesktopPaths(paths);
  // Crash diagnostics housekeeping: document the logs dir once, and bound how
  // much history survives (P1-03 retention).
  ensureLogsReadme(paths.logsDir);
  pruneCrashLogs(paths.logsDir, CRASH_LOG_KEEP);
  pruneCrashDumps(paths.crashesDir, CRASH_DUMP_KEEP);

  server = await startServer({
    dataDir: paths.serverDataDir,
    logFile: path.join(paths.logsDir, "server.log"),
    serverBundle: resolveServerBundle(),
  });
  server.process.on("exit", (code) => {
    if (!shuttingDown) {
      fatal(
        "WindowRunner backend stopped",
        `The bundled server exited unexpectedly (code ${code}). See ${path.join(paths.logsDir, "server.log")}`,
        "backend-exit"
      );
    }
  });

  await waitForHealth(server.url, 20_000);
  registerIpc();
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  mainWindow = createWindow();
  console.log(`window-runner desktop: backend ready on ${server.url}`);
}

app.whenReady().then(
  () => void bootstrap(),
  (err) => fatal("WindowRunner failed to start", describeError(err))
);

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = (server ? stopServer(server) : Promise.resolve()).then(
    () => undefined,
    () => undefined
  );
  void shuttingDown.then(() => app.quit());
});

// Renderer loss is recoverable once (reload); a second loss without a clean
// restart in between means the shell itself is unhealthy — fail loudly.
app.on("render-process-gone", (_event, _webContents, details) => {
  recordCrash("render-process-gone", `renderer gone: ${details.reason}`, {
    reason: details.reason,
    exitCode: details.exitCode,
  });
  rendererGoneStrikes += 1;
  if (rendererGoneStrikes > 1) {
    fatal("WindowRunner renderer kept crashing", `The window renderer crashed (${details.reason}) after a previous crash; the app will close.`);
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.reload();
  }
});

// Child processes (GPU, utilities) are restarted by Electron itself; record
// for diagnosis, keep running.
app.on("child-process-gone", (_event, details) => {
  recordCrash("child-process-gone", `${details.type} process gone: ${details.reason}`, {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
  });
});

// A rejected promise is a bug, not a reason to kill the user's session: the
// shell keeps running (and the app can be quit normally). The record makes it
// reportable instead of invisible.
process.on("unhandledRejection", (reason) => {
  recordCrash("unhandledRejection", describeError(reason));
});

process.on("uncaughtException", (err) => {
  fatal("WindowRunner crashed", describeError(err));
});
