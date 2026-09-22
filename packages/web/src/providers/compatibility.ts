/**
 * The /dashboard compatibility page (B2).
 *
 * The dashboard is no longer its own app: it composes the SAME provider
 * components the workspace's Providers route uses (provider-page.ts + the
 * shared provider controller), plus the two panels that remain
 * dashboard-only — the recent-turns usage table (usage-page.ts, shared) and
 * the quick chat (dashboard-chat.ts). It must stay independently loadable: it
 * never imports B1 workspace state, and its token flow is the shared
 * fragment/sessionStorage one (loadToken/saveToken from api.ts).
 *
 * Selectors the existing dashboard E2E relies on are preserved where they
 * live on this page (dash-token-*, dash-notice, dash-chat*, dash-sign-out);
 * the provider cards' dash-* ids and the usage rows' dash-usage-* ids live in
 * the shared components by design. The URL stays /dashboard — no redirect.
 */
import type { ProviderProfileView } from "../api.js";
import type { ProviderFormField } from "./provider-form.js";
import { renderProviderPage } from "./provider-page.js";
import { createProviderController, type ProviderController } from "../provider-controller.js";
import { renderUsagePage } from "../usage/usage-page.js";
import { loadToken } from "../api.js";
import { button, el } from "../dom.js";
import { render, root, setRenderer, state } from "../dashboard-state.js";
import { client, connect, refresh, signOut } from "../dashboard-api.js";
import { chatPanel } from "../dashboard-chat.js";

export interface ProviderCompatibilityOptions {
  mode: "dashboard" | "workspace";
  token?: string | null;
}

/**
 * The shared provider controller, wired to the dashboard's plain state
 * object. `client` is a live ES-module binding from dashboard-api.ts, so the
 * controller always sees the current connection.
 */
const controller: ProviderController = createProviderController({
  getClient: () => client,
  get: () => state.providers,
  set: (providers) => {
    state.providers = providers;
    render();
  },
  onAuthError: () => signOut(),
});

function activeProfile(): ProviderProfileView | null {
  return state.providers.profiles.find((p) => p.active || p.id === state.providers.activeProfileId) ?? null;
}

function doRender(): void {
  // Capture in-flight input values so a re-render (spinner, refresh) does not wipe them.
  const captured = new Map<string, string>();
  root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select").forEach((el) => {
    const id = el.getAttribute("data-testid");
    if (id) captured.set(id, el.value);
  });
  // Keep keyboard focus and selection across the rebuild. Renders are
  // coalesced to the next animation frame, and input tooling (Playwright's
  // keyboard.insertText in particular) delivers text as a separate step after
  // its prepare call: if this rebuild drops the focused field, that text lands
  // on <body> and vanishes without an input event — a silently lost
  // keystroke. Re-focusing the same field (by test id) closes that window.
  const active = document.activeElement as HTMLInputElement | null;
  const activeId = active && typeof active.getAttribute === "function" ? active.getAttribute("data-testid") : null;
  const hasSelection = active != null && typeof active.selectionStart === "number";
  const selStart = hasSelection ? (active as HTMLInputElement).selectionStart : null;
  const selEnd = hasSelection ? (active as HTMLInputElement).selectionEnd : null;

  root.replaceChildren(...[header(), state.auth !== "ok" ? tokenPanel() : pageBody(), noticeElement()].filter((n): n is HTMLElement => n !== null));

  captured.forEach((value, id) => {
    const el = root.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[data-testid="${id}"]`);
    const input = el as unknown as HTMLInputElement | undefined;
    // Disabled inputs always show the builder-provided value; restoring a
    // stale captured one would be wrong.
    if (el && input && !input.disabled && input.value === input.defaultValue) input.value = value;
  });

  if (activeId) {
    const el = root.querySelector<HTMLInputElement>(`[data-testid="${activeId}"]`);
    if (el && !el.disabled && typeof el.focus === "function") {
      el.focus();
      if (selStart !== null && selEnd !== null && typeof el.setSelectionRange === "function") {
        try {
          el.setSelectionRange(selStart, selEnd);
        } catch {
          // Selection is unsupported on some input types (number, date…).
        }
      }
    }
  }
}

function header(): HTMLElement {
  return el(
    "header",
    {},
    el("h1", {}, "Windows Runner — Providers"),
    el("a", { href: "/", class: "muted", "data-testid": "dash-main-link" }, "main UI"),
    state.auth === "ok" ? button("dash-sign-out", "Sign out", signOut, "secondary") : null
  );
}

function tokenPanel(): HTMLElement {
  const form = el(
    "form",
    { class: "panel", "data-testid": "dash-token-form" },
    el("h2", {}, "API token"),
    el("p", { class: "hint" }, "Same token as the main UI: the server banner (memory mode) or <data dir>/auth-token (file mode)."),
    el("input", { type: "password", "data-testid": "dash-token-input", placeholder: "Bearer token", autocomplete: "off", required: "true" }),
    button("dash-token-submit", state.auth === "checking" ? "Checking…" : "Connect", undefined, "primary", state.auth === "checking"),
    state.auth === "invalid" ? el("p", { class: "error", role: "alert", "data-testid": "dash-auth-error" }, state.authError ?? "invalid token") : null
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = form.querySelector<HTMLInputElement>('[data-testid="dash-token-input"]')!;
    const token = input.value.trim();
    if (token) void connect(token);
  });
  return form;
}

function pageBody(): HTMLElement {
  return el(
    "div",
    { class: "main" },
    renderProviderPage({
      state: state.providers,
      onAdd: () => controller.openCreateForm(),
      onEdit: (profileId) => {
        const profile = state.providers.profiles.find((p) => p.id === profileId);
        if (profile) controller.openEditForm(profile);
      },
      onTest: (profileId) => void controller.test(profileId),
      onActivate: (profileId) => void controller.activate(profileId),
      onDelete: (profileId) => void controller.delete(profileId),
      onSubmit: () => void controller.submitForm(),
      onCancelForm: () => controller.closeForm(),
      onFieldChange: (field: ProviderFormField, value: string) => controller.handleFieldChange(field, value),
      onDiscoverModels: () => void controller.discoverModels(),
      onDismissNotice: () => controller.dismissNotice(),
      onRefresh: () => void refresh(),
      onBackToWorkspace: () => {
        // From the standalone dashboard, "back to workspace" is a real
        // navigation to the main UI document.
        window.location.assign("/");
      },
    }),
    renderUsagePage({
      state: state.usage,
      limit: 50,
      onRefresh: () => void refresh(),
      resolveProviderLabel: (providerId) => state.providers.profiles.find((p) => p.id === providerId)?.label ?? providerId,
    }),
    chatPanel(activeProfile())
  );
}

function noticeElement(): HTMLElement | null {
  // Page-level notices only (chat/refresh failures via reportError). Provider
  // action notices render inside the shared provider page (`providers-notice`).
  if (!state.notice) return null;
  return el(
    "div",
    { class: "banner", role: "status", "data-testid": "dash-notice" },
    state.notice,
    " ",
    button("dash-notice-dismiss", "Dismiss", () => {
      state.notice = undefined;
      render();
    }, "link")
  );
}

/**
 * Mount the compatibility page into `#app`. `mode: "dashboard"` is the
 * /dashboard entry (the only mode in B2); `token` is the shared token picked
 * up from the fragment/sessionStorage flow.
 */
export function mountProviderCompatibilityPage(options: ProviderCompatibilityOptions): void {
  void options.mode; // B2 ships the dashboard mode; the workspace host mounts its own route.
  setRenderer(doRender);
  if (options.token) void connect(options.token);
  render();
}
