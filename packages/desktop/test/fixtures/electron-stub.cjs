/**
 * Minimal Electron API stub for in-sandbox verification of the desktop main
 * process flow (test/main-flow.test.ts).
 *
 * The real `electron-smoke.ts` launches actual Electron and is the primary
 * shell check; this stub exists because sandboxed/offline environments cannot
 * download the Electron binary. It stands in ONLY for the `electron` module —
 * every other process (the bundled WindowRunner server, HTTP, health, process
 * tree) is real.
 *
 * Activated via `node --require ./electron-stub.cjs dist/main.cjs`. Observes
 * the main process by appending JSON lines to $ELECTRON_STUB_TRACE and, when
 * $ELECTRON_STUB_AUTOQUIT_MS is set, quits that many ms after the window URL
 * is loaded so the shutdown path runs end to end.
 */
"use strict";

const fs = require("node:fs");
const Module = require("node:module");

const traceFile = process.env.ELECTRON_STUB_TRACE;
const quitFile = process.env.ELECTRON_STUB_QUIT_FILE;
const trace = (event, data = {}) => {
  if (traceFile) fs.appendFileSync(traceFile, JSON.stringify({ event, ...data }) + "\n");
};

let quitHandlers = [];
let windowCount = 0;
const setPaths = new Map();

const app = {
  isPackaged: false,
  getVersion: () => "0.0.0-stub",
  getPath: (name) => {
    if (name === "userData") return process.env.WINDOWS_RUNNER_DESKTOP_DATA_DIR || "/tmp/wr-stub-userdata";
    if (setPaths.has(name)) return setPaths.get(name);
    return "/tmp";
  },
  setPath: (name, value) => {
    setPaths.set(name, value);
    trace("set-path", { name, value });
  },
  whenReady: () => Promise.resolve(),
  on: (event, handler) => {
    if (event === "before-quit") quitHandlers.push(handler);
    trace("app-on", { name: event });
  },
  quit: () => {
    const event = { defaultPrevented: false, preventDefault: () => (event.defaultPrevented = true) };
    for (const handler of [...quitHandlers]) handler(event);
    if (!event.defaultPrevented) {
      trace("quit");
      process.exit(0);
    }
  },
  exit: (code) => {
    trace("exit", { code });
    process.exit(code || 0);
  },
};

const crashReporter = {
  start: (options) => trace("crash-reporter-start", options),
};

class WebContents {
  constructor() {
    this.url = "";
  }
  on() {}
  setWindowOpenHandler() {}
  loadURL(url) {
    this.url = url;
    trace("load-url", { url });
  }
}

class BrowserWindow {
  constructor(options) {
    windowCount += 1;
    trace("window", {
      preload: options?.webPreferences?.preload,
      contextIsolation: options?.webPreferences?.contextIsolation,
      nodeIntegration: options?.webPreferences?.nodeIntegration,
      sandbox: options?.webPreferences?.sandbox,
    });
    this.webContents = new WebContents();
  }
  loadURL(url) {
    return Promise.resolve(this.webContents.loadURL(url));
  }
}

const ipcMain = {
  _syncHandlers: new Map(),
  _invokeHandlers: new Map(),
  on(channel, handler) {
    this._syncHandlers.set(channel, handler);
    trace("ipc-sync-registered", { channel });
  },
  handle(channel, handler) {
    this._invokeHandlers.set(channel, handler);
    trace("ipc-invoke-registered", { channel });
  },
};

const dialog = {
  showErrorBox: (title, message) => trace("error-box", { title, message }),
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
};

const session = {
  defaultSession: {
    setPermissionRequestHandler: () => trace("permission-handler-set"),
  },
};

const shell = { openPath: async () => "" };

const electronStub = { app, BrowserWindow, crashReporter, ipcMain, dialog, session, shell };

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return electronStub;
  return originalLoad.call(this, request, parent, isMain);
};

process.on("exit", () => trace("process-exit"));

// Test helper: once the window has loaded (so the sender check passes), answer
// the bootstrap channel through the same handler the preload would call, and
// record the reply.
let lastWindowUrl = "";
setInterval(() => {
  // Test-driven shutdown: the test drops a quit file when it is ready to
  // exercise the app's real before-quit/stopServer path.
  if (quitFile && fs.existsSync(quitFile)) app.quit();
  const handler = ipcMain._syncHandlers.get("window-runner:get-bootstrap");
  if (handler && lastWindowUrl && !globalThis.__stubBootstrapTaken) {
    const event = {
      senderFrame: { url: lastWindowUrl },
      returnValue: undefined,
    };
    handler(event);
    if (event.returnValue) {
      globalThis.__stubBootstrapTaken = true;
      trace("bootstrap-reply", { value: event.returnValue });
    }
  }
}, 25).unref();

const originalLoadURL = WebContents.prototype.loadURL;
WebContents.prototype.loadURL = function (url) {
  lastWindowUrl = url;
  return originalLoadURL.call(this, url);
};
