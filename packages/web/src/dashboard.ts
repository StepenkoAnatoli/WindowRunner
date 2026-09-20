import { loadToken } from "./api.js";
import { button, el } from "./dom.js";
import { render, root, setRenderer, state } from "./dashboard-state.js";
import { connect, signOut } from "./dashboard-api.js";
import { banner, providersPanel } from "./dashboard-provider-cards.js";
import { formPanel, openAddForm } from "./dashboard-provider-form.js";
import { usagePanel } from "./dashboard-usage.js";
import { chatPanel } from "./dashboard-chat.js";

/**
 * Provider dashboard — served at /dashboard.
 *
 * One page, plain DOM, no framework (same conventions as main.ts): provider
 * cards with a status dot (last test) and Use this / Test / Edit / Delete,
 * an add-profile form with presets (OmniRoute, OpenAI, Anthropic, local
 * Spark via Ollama, mock), the "currently using" banner, the recent-turns
 * table from GET /api/usage, and a quick chat box that reuses
 * ApiClient.startTurn + streamTurn so the reply streams in with the active
 * provider. The token is shared with the main UI (same sessionStorage key).
 * Every element the E2E suite touches carries a stable `data-testid`.
 *
 * This file is now only the entry point: state and the render scheduler live
 * in dashboard-state.ts, the connection in dashboard-api.ts, and each panel
 * in its own module. What stays here is the assembly — which panels exist, in
 * what order, and the DOM rebuild that puts them on the page.
 */

function doRender(): void {
  // Capture in-flight input values so a re-render (spinner, refresh) does not wipe them.
  const captured = new Map<string, string>();
  root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select").forEach((el) => {
    const id = el.getAttribute("data-testid");
    if (id) captured.set(id, el.value);
  });

  root.replaceChildren(
    ...[header(), state.auth !== "ok" ? tokenPanel() : dashboardBody(), state.notice ? notice() : null].filter((n): n is HTMLElement => n !== null)
  );

  captured.forEach((value, id) => {
    const el = root.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[data-testid="${id}"]`);
    // All three element kinds expose value; defaultValue is the attribute value.
    const input = el as unknown as HTMLInputElement;
    // Disabled inputs (e.g. the id field in edit mode) always show the
    // builder-provided value; restoring a stale captured one would be wrong.
    if (el && !input.disabled && input.value === input.defaultValue) input.value = value;
  });
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

function dashboardBody(): HTMLElement {
  const active = state.profiles?.find((p) => p.active) ?? null;
  return el(
    "div",
    { class: "main" },
    banner(active),
    providersPanel(active),
    state.formOpen ? formPanel() : el("div", { class: "row" }, button("dash-add", "Add provider", openAddForm, "primary")),
    usagePanel(),
    chatPanel(active)
  );
}

function notice(): HTMLElement {
  return el("div", { class: "banner", role: "status", "data-testid": "dash-notice" }, state.notice!, " ", button("dash-notice-dismiss", "Dismiss", () => { state.notice = undefined; render(); }, "link"));
}

// ---------------------------------------------------------------------------
// Boot: register the renderer, pick up the shared token (same sessionStorage
// key as the main UI), then render. Handlers live on the elements built in the
// render pass.

setRenderer(doRender);

const initialToken = loadToken();
if (initialToken) void connect(initialToken);
render();
