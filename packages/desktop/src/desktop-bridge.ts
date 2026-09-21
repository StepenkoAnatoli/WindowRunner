/**
 * Typing and surface definition for the desktop preload bridge.
 *
 * This module is shared by three worlds and must stay dependency-free and
 * platform-free (no `node:*` imports, no DOM types): the Electron main process,
 * the sandboxed preload, and the browser-context renderer all compile against
 * it (see tsconfig.json vs tsconfig.renderer.json).
 *
 * Security contract (PR A / A1):
 * - The renderer gets exactly `BRIDGE_METHODS` — nothing else. No
 *   `child_process`, no raw `ipcRenderer`, no raw Electron objects, no
 *   arbitrary channel access.
 * - The token travels only through `getBootstrap()` and lives in renderer
 *   memory. It is never placed in a URL, storage, or logs.
 * - `createDesktopBridge` is transport-injected so the bridge surface can be
 *   unit-tested without Electron (test/preload.test.ts).
 */

export interface DesktopBootstrap {
  /** Internal server origin, e.g. `http://127.0.0.1:49213`. */
  baseUrl: string;
  /** Bearer token for `/api/*`. In-memory only. */
  token: string;
}

export interface DesktopAppInfo {
  version: string;
  platform: string;
}

export interface DesktopBridge {
  /** Synchronous one-shot handshake; the values are in-memory constants. */
  getBootstrap(): DesktopBootstrap;
  chooseProjectFolder(): Promise<string | null>;
  openExternalEditor(path: string): Promise<void>;
  getAppInfo(): Promise<DesktopAppInfo>;
}

/** The only IPC channel names main and preload may share. */
export const DESKTOP_CHANNELS = {
  bootstrap: "window-runner:get-bootstrap",
  chooseFolder: "window-runner:choose-folder",
  openExternal: "window-runner:open-external",
  appInfo: "window-runner:get-app-info",
} as const;

/** Exact method allowlist exposed on `window.windowRunnerDesktop`. */
export const BRIDGE_METHODS = ["getBootstrap", "chooseProjectFolder", "openExternalEditor", "getAppInfo"] as const;

/** Minimal IPC transport; the preload binds these to `ipcRenderer`. */
export interface BridgeTransport {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  sendSync(channel: string, ...args: unknown[]): unknown;
}

function isBootstrap(value: unknown): value is DesktopBootstrap {
  if (!value || typeof value !== "object") return false;
  const b = value as Partial<DesktopBootstrap>;
  return typeof b.baseUrl === "string" && typeof b.token === "string" && b.token.length > 0;
}

/**
 * Build the bridge object over a transport. Every path through this function
 * may only touch `DESKTOP_CHANNELS` values — see test/preload.test.ts, which
 * pins both the method surface and the channel allowlist.
 */
export function createDesktopBridge(transport: BridgeTransport): DesktopBridge {
  return {
    getBootstrap(): DesktopBootstrap {
      const value = transport.sendSync(DESKTOP_CHANNELS.bootstrap);
      if (!isBootstrap(value)) {
        throw new Error("desktop bootstrap unavailable");
      }
      return { baseUrl: value.baseUrl, token: value.token };
    },
    chooseProjectFolder(): Promise<string | null> {
      return transport.invoke(DESKTOP_CHANNELS.chooseFolder) as Promise<string | null>;
    },
    openExternalEditor(path: string): Promise<void> {
      return transport.invoke(DESKTOP_CHANNELS.openExternal, path) as Promise<void>;
    },
    getAppInfo(): Promise<DesktopAppInfo> {
      return transport.invoke(DESKTOP_CHANNELS.appInfo) as Promise<DesktopAppInfo>;
    },
  };
}
