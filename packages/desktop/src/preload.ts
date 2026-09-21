/**
 * Sandboxed preload bridge.
 *
 * Runs with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
 * (see main.ts) — so this file may use exactly `contextBridge` and
 * `ipcRenderer`, and the page sees only the frozen method surface defined in
 * desktop-bridge.ts. No raw Electron objects, no filesystem, no shell, no
 * arbitrary channels ever cross the bridge.
 */

import { contextBridge, ipcRenderer } from "electron";
import { createDesktopBridge } from "./desktop-bridge.js";

const bridge = createDesktopBridge({
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  sendSync: (channel, ...args) => ipcRenderer.sendSync(channel, ...args),
});

contextBridge.exposeInMainWorld("windowRunnerDesktop", bridge);
