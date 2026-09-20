/**
 * Dashboard state, its sessionStorage persistence, and the render scheduler —
 * the parts every other dashboard module touches. Split out of dashboard.ts so
 * a view module (cards, form, usage, chat) can be read and changed on its own
 * instead of inside one 700-line file.
 *
 * There is no framework here: `state` is a plain mutable object, `render()`
 * coalesces redraws to one per animation frame, and the entry point
 * (dashboard.ts) registers the function that actually rebuilds the DOM. That
 * keeps this module free of any view imports, which is what stops the split
 * turning into a cycle (views import state; state imports nothing from them).
 */
import type { ProviderProfileView, TurnUsageView } from "./api.js";

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
}

export interface State {
  auth: "none" | "checking" | "ok" | "invalid";
  authError?: string;
  activeProfileId: string | null;
  profiles: ProviderProfileView[] | null;
  usage: TurnUsageView[] | null;
  formOpen: boolean;
  editingId?: string;
  formError?: string;
  formBusy: boolean;
  testingId?: string;
  activatingId?: string;
  chat: ChatState;
  notice?: string;
  /** What GET /api/usage reported about the completeness of `usage`. */
  usageMeta?: UsageMeta;
}

/**
 * What GET /api/usage says about the completeness of the history it returned:
 * `retained` is how many records the server holds in memory, `bounded` is its
 * flag for "older records exist but are no longer available" (the ring trimmed
 * them, the boot tail window skipped them, or usage.jsonl rotated them away).
 * The usage panel shows this instead of implying the table is everything.
 */
export interface UsageMeta {
  retained?: number;
  bounded: boolean;
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
  activeProfileId: null,
  profiles: null,
  usage: null,
  formOpen: false,
  formBusy: false,
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
  state.activeProfileId = null;
  state.profiles = null;
  state.usage = null;
  state.usageMeta = undefined;
  state.formOpen = false;
  state.editingId = undefined;
  state.formError = undefined;
  state.testingId = undefined;
  state.activatingId = undefined;
}

export const root: HTMLElement = document.getElementById("app")!;

// ---------------------------------------------------------------------------
// Rendering: coalesced to one redraw per animation frame, because a streaming
// turn produces many text_delta events per second and each render rebuilds the
// DOM. `setRenderer` is how dashboard.ts installs the rebuild without this
// module importing any view code.

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
