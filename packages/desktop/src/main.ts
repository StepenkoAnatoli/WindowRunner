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

import { app, BrowserWindow, dialog, ipcMain, session, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import * as path from "node:path";
import { DESKTOP_CHANNELS, type DesktopAppInfo, type DesktopBootstrap } from "./desktop-bridge.js";
import { ensureDesktopPaths, resolveDesktopPaths } from "./paths.js";
import { defaultServerBundle, startServer, stopServer, waitForHealth, type DesktopServer } from "./server-process.js";

let server: DesktopServer | undefined;
let shuttingDown: Promise<void> | undefined;

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

function fatal(title: string, message: string): never {
  dialog.showErrorBox(title, message.length > 1500 ? `${message.slice(0, 1500)}…` : message);
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

  server = await startServer({
    dataDir: paths.serverDataDir,
    logFile: path.join(paths.logsDir, "server.log"),
    serverBundle: resolveServerBundle(),
  });
  server.process.on("exit", (code) => {
    if (!shuttingDown) {
      fatal("WindowRunner backend stopped", `The bundled server exited unexpectedly (code ${code}). See ${path.join(paths.logsDir, "server.log")}`);
    }
  });

  await waitForHealth(server.url, 20_000);
  registerIpc();
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  createWindow();
  console.log(`window-runner desktop: backend ready on ${server.url}`);
}

app.whenReady().then(
  () => void bootstrap(),
  (err) => fatal("WindowRunner failed to start", err instanceof Error ? (err.stack ?? err.message) : String(err))
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

process.on("uncaughtException", (err) => {
  fatal("WindowRunner crashed", err.stack ?? err.message);
});
