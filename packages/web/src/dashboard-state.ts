/**
 * Dashboard state, its sessionStorage helpers, and the render scheduler —
 * the parts every compatibility-page module touches.
 *
 * B2: the provider/usage slices use the SAME shapes as the main workspace
 * (`ProviderUiState` / `UsageUiState` from app-state.ts), and all provider
 * behavior runs through the shared provider controller. What remains
 * dashboard-specific is the quick-chat state and the plain mutable-state +
 * coalesced-render loop (no framework): `state` is a plain object, `render()`
 * coalesces redraws to one per animation frame, and the entry point
 * (providers/compatibility.ts) installs the function that rebuilds the DOM.
 * View modules import state; this module imports nothing from them, which is
 * what keeps the split cycle-free.
 */
import type { ProviderUiState, UsageUiState } from "./app-state.js";
import { initialProviderUiState, initialUsageUiState } from "./app-state.js";

export interface ChatState {
  sessionId?: string;
  cwd: string;
  busy: boolean;
  reply: string;
  status?: string;
  error?: string;
  /**
   * Id of the turn currently being streamed, if any. This is what makes the
   * Stop button possible: cancelling is a POST against the turn, and without
   * remembering the id the quick chat could only wait a request out.
   */
  turnId?: string;
  /**
   * True once a terminal event (completed / failed / cancelled) has been
   * applied to this turn. It guards Stop's optimistic "cancelling…" write:
   * the cancellation event travels down the already-open event stream and can
   * reach the panel BEFORE the cancel POST's own response does, and without
   * this flag the optimistic text overwrites the terminal status permanently.
   */
  terminal?: boolean;
}

export interface State {
  auth: "none" | "checking" | "ok" | "invalid";
  authError?: string;
  /** Provider slice — same shape as the workspace's (masked data + transient form). */
  providers: ProviderUiState;
  /** Usage slice for the recent-turns table. */
  usage: UsageUiState;
  chat: ChatState;
  /** Page-level notice (non-secret operation outcomes). */
  notice?: string;
}

export const CWD_KEY = "windows-runner.dash.cwd";
export const SESSION_KEY = "windows-runner.dash.session";

export function storeGet(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storeSet(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {}
}

export function storeDel(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {}
}

/**
 * The single mutable dashboard state. `const`, not `let`: modules mutate
 * fields rather than replacing the object, so a Sign out goes through
 * `resetForSignOut()` instead of a reassignment that would leave imported
 * references pointing at a dead object.
 */
export const state: State = {
  auth: "none",
  providers: initialProviderUiState,
  usage: initialUsageUiState,
  chat: {
    sessionId: storeGet(SESSION_KEY) ?? undefined,
    cwd: storeGet(CWD_KEY) ?? "",
    busy: false,
    reply: "",
  },
};

/**
 * Drop everything that came from the server (Sign out, or a 401 on any
 * request). The quick-chat session id and cwd are kept: they are the user's
 * own input, and the token panel is the only thing that should change.
 */
export function resetForSignOut(): void {
  state.auth = "none";
  state.authError = undefined;
  state.providers = initialProviderUiState;
  state.usage = initialUsageUiState;
  state.notice = undefined;
}

export const root: HTMLElement = document.getElementById("app")!;

// ---------------------------------------------------------------------------
// Rendering: coalesced to one redraw per animation frame, because a streaming
// turn produces many text_delta events per second and each render rebuilds
// the DOM. `setRenderer` is how the entry point installs the rebuild without
// this module importing any view code.

let renderer: () => void = () => {};

export function setRenderer(fn: () => void): void {
  renderer = fn;
}

/** requestAnimationFrame where it exists, a 16ms timer where it does not. */
export function nextFrame(cb: () => void): void {
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn: () => void) => setTimeout(fn, 16);
  raf(cb);
}

let renderScheduled = false;

export function render(): void {
  if (renderScheduled) return;
  renderScheduled = true;
  nextFrame(() => {
    renderScheduled = false;
    renderer();
  });
}
