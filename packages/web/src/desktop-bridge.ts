/**
 * Browser-safe adapter over the Electron preload bridge (B1).
 *
 * This module must not import Electron: it only sniffs for the frozen
 * `window.windowRunnerDesktop` surface the sandboxed preload exposes (see
 * `packages/desktop/src/desktop-bridge.ts` for the allowlisted methods). In a
 * plain browser tab the bridge is absent and every helper here reports
 * "desktop unavailable", in which case the sidebar falls back to the
 * absolute-path input. There is deliberately no browser file-picker fallback:
 * the server needs a filesystem path string, not browser-uploaded files.
 *
 * The catalog methods validate in both directions: loaded data is parsed
 * leniently (malformed → null, the caller keeps its in-memory catalog) and
 * saved data is validated strictly before it crosses IPC (so a renderer bug
 * can never write a malformed file even if the main process also validates).
 */

import {
  emptyWorkspaceCatalog,
  parseWorkspaceCatalogLenient,
  validateWorkspaceCatalog,
  type WorkspaceCatalog,
} from "./workspace-catalog.js";

export interface DesktopCapabilities {
  chooseProjectFolder(): Promise<string | null>;
  openExternalEditor(path: string): Promise<void>;
  loadWorkspaceCatalog(): Promise<WorkspaceCatalog | null>;
  saveWorkspaceCatalog(catalog: WorkspaceCatalog): Promise<void>;
}

interface PreloadBridge {
  chooseProjectFolder?: () => Promise<unknown>;
  openExternalEditor?: (path: string) => Promise<unknown>;
  loadWorkspaceCatalog?: () => Promise<unknown>;
  saveWorkspaceCatalog?: (catalog: unknown) => Promise<unknown>;
}

function readBridge(): PreloadBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const candidate = (window as unknown as { windowRunnerDesktop?: PreloadBridge }).windowRunnerDesktop;
  if (!candidate || typeof candidate !== "object") return undefined;
  return candidate;
}

/** True when the page runs inside the desktop shell with a folder picker. */
export function isDesktopAvailable(): boolean {
  const bridge = readBridge();
  return typeof bridge?.chooseProjectFolder === "function";
}

function hasCatalogBridge(bridge: PreloadBridge): boolean {
  return typeof bridge.loadWorkspaceCatalog === "function" && typeof bridge.saveWorkspaceCatalog === "function";
}

/**
 * The desktop capabilities, or `undefined` in an ordinary browser tab (or
 * under Node tests). The folder picker is the minimum: without it this is
 * not a desktop shell. Catalog persistence additionally requires the catalog
 * IPC pair; shells predating B1 report folder picking only.
 */
export function getDesktopCapabilities(): DesktopCapabilities | undefined {
  const bridge = readBridge();
  if (!bridge || typeof bridge.chooseProjectFolder !== "function") return undefined;
  const chooseProjectFolder = bridge.chooseProjectFolder.bind(bridge);
  const openExternalEditor = typeof bridge.openExternalEditor === "function"
    ? bridge.openExternalEditor.bind(bridge)
    : async (_path: string): Promise<void> => {};
  if (!hasCatalogBridge(bridge)) {
    // Pre-B1 shell: folder picking works, catalog persistence is unavailable
    // (the caller falls back to localStorage).
    const memory = emptyWorkspaceCatalog();
    return {
      chooseProjectFolder: async () => {
        const value = await chooseProjectFolder();
        return typeof value === "string" && value.length > 0 ? value : null;
      },
      openExternalEditor: async (path: string) => void (await openExternalEditor(path)),
      loadWorkspaceCatalog: async () => parseWorkspaceCatalogLenient(memory),
      saveWorkspaceCatalog: async () => {},
    };
  }
  const load = (bridge.loadWorkspaceCatalog as () => Promise<unknown>).bind(bridge);
  const save = (bridge.saveWorkspaceCatalog as (catalog: unknown) => Promise<unknown>).bind(bridge);
  return {
    chooseProjectFolder: async () => {
      const value = await chooseProjectFolder();
      return typeof value === "string" && value.length > 0 ? value : null;
    },
    openExternalEditor: async (path: string) => void (await openExternalEditor(path)),
    loadWorkspaceCatalog: async () => {
      const value = await load();
      if (value === null || value === undefined) return null;
      return parseWorkspaceCatalogLenient(value);
    },
    saveWorkspaceCatalog: async (catalog: WorkspaceCatalog) => {
      void (await save(validateWorkspaceCatalog(catalog)));
    },
  };
}
