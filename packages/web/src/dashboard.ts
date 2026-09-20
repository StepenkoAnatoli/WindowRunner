import { ApiClient, ApiRequestError, clearToken, loadToken, saveToken } from "./api.js";
import type { ProviderLastTest, ProviderProfileView, TurnUsageView } from "./api.js";

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
 */

// ---------------------------------------------------------------------------
// State

interface ChatState {
  sessionId?: string;
  cwd: string;
  busy: boolean;
  reply: string;
  status?: string;
  error?: string;
}

interface State {
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
}

const CWD_KEY = "windows-runner.dash.cwd";
const SESSION_KEY = "windows-runner.dash.session";

function storeGet(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function storeSet(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {}
}
function storeDel(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {}
}

let state: State = {
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
let client: ApiClient | undefined;
const root = document.getElementById("app")!;

// Presets pre-fill only known-stable fields. OmniRoute's base URL is a
// placeholder the user must fill in from their own dashboard — it is
// per-account and was never hard-coded.
const PRESETS: Record<string, { kind: string; label: string; baseUrl?: string; baseUrlPlaceholder?: string; modelPlaceholder?: string; note?: string; keyHint?: string }> = {
  omniroute: {
    kind: "openai-compatible",
    label: "OmniRoute",
    baseUrl: "",
    baseUrlPlaceholder: "https://your-omniroute-host/v1",
    modelPlaceholder: "model-id",
    note: "Enter the base URL from your OmniRoute dashboard (it differs per account, so it is not pre-filled).",
    keyHint: "OmniRoute API key (if the endpoint requires one)",
  },
  openai: {
    kind: "openai-compatible",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    modelPlaceholder: "gpt-4o-mini",
    keyHint: "sk-…",
  },
  anthropic: {
    kind: "anthropic",
    label: "Anthropic",
    modelPlaceholder: "claude-sonnet-4-5",
    keyHint: "sk-ant-… (base URL is the official Anthropic API)",
  },
  spark: {
    kind: "openai-compatible",
    label: "Spark (local Ollama)",
    baseUrl: "http://127.0.0.1:11434/v1",
    modelPlaceholder: "your-local-model",
    note: "Local model via Ollama's OpenAI-compatible endpoint; no API key needed.",
  },
  mock: {
    kind: "mock",
    label: "Mock (offline)",
    modelPlaceholder: "mock",
    note: "Offline; no model calls, no network. Replies are prefixed “[mock]”.",
    keyHint: "not needed",
  },
};

/** Attribute values for the form inputs; the render captures/restore trick keeps in-flight typing. */
const formDefaults: Record<string, string> = {
  preset: "omniroute",
  id: "",
  label: "OmniRoute",
  baseUrl: "",
  model: "",
  apiKey: "",
};

// ---------------------------------------------------------------------------
// Rendering

let renderScheduled = false;
function render(): void {
  if (renderScheduled) return;
  renderScheduled = true;
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb: () => void) => setTimeout(cb, 16);
  raf(() => {
    renderScheduled = false;
    doRender();
  });
}

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

function banner(active: ProviderProfileView | null): HTMLElement {
  return el(
    "div",
    { class: "panel banner-active", "data-testid": "dash-banner" },
    el("span", { class: "muted" }, "Currently using:"),
    active
      ? el("span", { "data-testid": "dash-active" }, el("strong", {}, active.label), " ", el("code", {}, active.model))
      : el("span", { "data-testid": "dash-active" }, state.profiles ? "no active profile" : "loading…"),
    active ? el("span", { class: "chip", "data-testid": "dash-active-kind" }, active.kind) : null
  );
}

function providersPanel(active: ProviderProfileView | null): HTMLElement {
  const cards = (state.profiles ?? []).map((p) => providerCard(p, p.id === active?.id));
  return el(
    "section",
    { class: "panel", "data-testid": "dash-providers" },
    el("h2", {}, "Providers"),
    state.profiles === null
      ? el("p", { class: "hint" }, "Loading…")
      : state.profiles.length === 0
        ? el("p", { class: "hint" }, "No profiles yet — add one below. The profile that matches the environment is registered as “default” on first boot.")
        : el("div", { class: "cards" }, ...cards)
  );
}

function providerCard(p: ProviderProfileView, isActive: boolean): HTMLElement {
  const lt: ProviderLastTest | undefined = p.lastTest;
  const dotState = lt ? (lt.ok ? "ok" : "fail") : "none";
  const dotTitle = lt ? (lt.ok ? `last test passed in ${lt.latencyMs ?? "?"}ms` : `last test failed: ${lt.code ?? "error"}`) : "not tested yet";
  return el(
    "div",
    {
      class: `card provider${isActive ? " active" : ""}`,
      "data-testid": "dash-card",
      "data-id": p.id,
      "data-active": isActive ? "true" : "false",
    },
    el(
      "div",
      { class: "p-head" },
      el("span", { class: `dot ${dotState}`, "data-testid": "dash-card-status", "data-ok": lt ? String(lt.ok) : "", title: dotTitle }),
      el("span", { "data-testid": "dash-card-label" }, p.label),
      isActive ? el("span", { class: "chip" }, "active") : null
    ),
    el("div", { class: "muted", "data-testid": "dash-card-model" }, `${p.kind} · ${p.model}`),
    p.baseUrl ? el("div", { class: "muted base" }, el("code", {}, p.baseUrl)) : null,
    el("div", { class: "muted", "data-testid": "dash-card-key" }, `key: ${p.apiKeyMasked ?? "—"}`),
    lt && !lt.ok ? el("div", { class: "error small", "data-testid": "dash-card-test-error" }, `${lt.code ?? "error"}: ${lt.message ?? ""}`) : null,
    el(
      "div",
      { class: "row" },
      button(`dash-activate`, state.activatingId === p.id ? "Switching…" : "Use this", () => void activate(p.id), "primary", isActive || state.activatingId === p.id),
      button("dash-test", state.testingId === p.id ? "Testing…" : "Test", () => void test(p.id), "secondary", state.testingId === p.id),
      button("dash-edit", "Edit", () => openEditForm(p), "secondary"),
      button("dash-delete", "Delete", () => void remove(p.id), "danger")
    )
  );
}

function formPanel(): HTMLElement {
  const editing = state.editingId;
  const preset = PRESETS[formDefaults.preset];
  const editingProfile = editing ? state.profiles?.find((x) => x.id === editing) : undefined;
  // In edit mode the kind is fixed, so the fields follow the profile's kind,
  // not the (hidden) preset select's value.
  const showBaseUrl = editing ? editingProfile?.kind === "openai-compatible" : preset?.kind === "openai-compatible";
  const note = editing ? undefined : preset?.note;
  const presetSelect = editing
    ? null
    : (() => {
        const s = el(
          "select",
          { "data-testid": "dash-preset" },
          ...Object.entries(PRESETS).map(([value, p]) => el("option", { value, ...(formDefaults.preset === value ? { selected: "true" } : {}) }, p.label))
        );
        s.addEventListener("change", onPresetChange);
        return s;
      })();
  const form = el(
    "form",
    { class: "panel", "data-testid": "dash-form" },
    el("h2", {}, editing ? `Edit “${editing}”` : "Add provider"),
    editing
      ? el("p", { class: "hint" }, `kind: ${state.profiles?.find((x) => x.id === editing)?.kind ?? "…"} (immutable — create a new profile to change it)`)
      : el("label", {}, "Preset", presetSelect!),
    el(
      "label",
      {},
      "Id (lowercase, hyphens)",
      el("input", { "data-testid": "dash-id", value: formDefaults.id, pattern: "[a-z0-9-]{1,64}", required: "true", ...(editing ? { disabled: "true" } : {}) })
    ),
    el("label", {}, "Label", el("input", { "data-testid": "dash-label", value: formDefaults.label, required: "true" })),
    showBaseUrl
      ? el(
          "label",
          {},
          "Base URL",
          el("input", { "data-testid": "dash-baseurl", value: formDefaults.baseUrl, placeholder: preset?.baseUrlPlaceholder ?? "https://…/v1", required: "true" })
        )
      : null,
    el(
      "label",
      {},
      "Model",
      el("input", { "data-testid": "dash-model", value: formDefaults.model, placeholder: preset?.modelPlaceholder ?? "model-id", required: "true" })
    ),
    el(
      "label",
      {},
      "API key",
      el("input", {
        type: "password",
        "data-testid": "dash-apikey",
        value: formDefaults.apiKey,
        placeholder: editing ? "leave blank to keep the current key" : preset?.keyHint ?? "sk-…",
        autocomplete: "off",
      })
    ),
    note ? el("p", { class: "hint", "data-testid": "dash-form-note" }, note) : null,
    el("p", { class: "hint" }, "The key is stored only in <data dir>/provider-profiles.json (mode 0600) and always shown masked (****last4)."),
    state.formError ? el("p", { class: "error", role: "alert", "data-testid": "dash-form-error" }, state.formError) : null,
    el(
      "div",
      { class: "row" },
      button("dash-save", state.formBusy ? "Saving…" : editing ? "Save changes" : "Create profile", undefined, "primary", state.formBusy),
      button("dash-form-cancel", "Cancel", closeForm, "secondary")
    )
  );
  form.addEventListener("submit", (e) => void submitForm(e));
  return form;
}

function usagePanel(): HTMLElement {
  const rows = (state.usage ?? []).map((rec) => {
    const profile = state.profiles?.find((p) => p.id === rec.providerId);
    return el(
      "tr",
      { "data-testid": "dash-usage-row", "data-status": rec.status, "data-provider": rec.providerId },
      el("td", {}, new Date(rec.at).toLocaleString()),
      el("td", { "data-testid": "dash-usage-provider" }, profile?.label ?? rec.providerId),
      el("td", {}, rec.model),
      el("td", {}, `${rec.inputTokens ?? "–"}/${rec.outputTokens ?? "–"}`),
      el("td", { "data-testid": "dash-usage-cost" }, rec.estCostUsd !== undefined ? `$${rec.estCostUsd.toFixed(4)}` : "—"),
      el("td", { class: rec.status === "completed" ? "ok" : rec.status === "failed" ? "error" : "muted" }, rec.status === "failed" && rec.code ? `${rec.status} (${rec.code})` : rec.status)
    );
  });
  return el(
    "section",
    { class: "panel", "data-testid": "dash-usage" },
    el("h2", {}, "Recent turns"),
    state.usage === null
      ? el("p", { class: "hint" }, "Loading…")
      : state.usage.length === 0
        ? el("p", { class: "hint" }, "No turns recorded yet. Send a message in the quick chat below.")
        : el(
            "table",
            { class: "usage" },
            el("thead", {}, el("tr", {}, ...["time", "provider", "model", "tokens (in/out)", "cost", "status"].map((h) => el("th", {}, h)))),
            el("tbody", {}, ...rows)
          ),
    el("p", { class: "hint" }, "Cost shows “—” unless a price table entry exists for the exact model id; numbers are never fabricated.")
  );
}

function chatPanel(active: ProviderProfileView | null): HTMLElement {
  const c = state.chat;
  const form = el(
    "form",
    { class: "panel", "data-testid": "dash-chat" },
    el("h2", {}, "Quick chat"),
    el("p", { class: "hint" }, "Sends one turn to ", el("strong", {}, active ? `${active.label} (${active.model})` : "the active provider"), ", streamed over the same SSE the main UI uses."),
    el(
      "label",
      {},
      "Project folder (absolute path inside an allowed root)",
      el("input", { "data-testid": "dash-cwd", value: c.cwd, placeholder: "/home/me/project", required: "true" })
    ),
    el("textarea", { "data-testid": "dash-message", rows: "2", placeholder: "Ask the agent…", ...(c.busy ? { disabled: "true" } : {}) }),
    el(
      "div",
      { class: "row" },
      button("dash-send", c.busy ? "Working…" : "Send", undefined, "primary", c.busy),
      c.sessionId ? button("dash-chat-reset", "Reset session", resetChatSession, "secondary") : null
    ),
    c.reply || c.busy ? el("div", { class: "chat-out", "data-testid": "dash-reply" }, c.reply || "…", c.busy ? el("span", { class: "cursor" }, "▍") : null) : null,
    c.status ? el("div", { class: "muted small", "data-testid": "dash-chat-status" }, c.status) : null,
    c.error ? el("p", { class: "error small", "data-testid": "dash-chat-error", role: "alert" }, c.error) : null
  );
  form.addEventListener("submit", onChatSubmit);
  return form;
}

function notice(): HTMLElement {
  return el("div", { class: "banner", role: "status", "data-testid": "dash-notice" }, state.notice!, " ", button("dash-notice-dismiss", "Dismiss", () => { state.notice = undefined; render(); }, "link"));
}

// ---------------------------------------------------------------------------
// Effects

async function connect(token: string): Promise<void> {
  const candidate = new ApiClient({ token });
  state.auth = "checking";
  render();
  try {
    await candidate.health();
    client = candidate;
    saveToken(token);
    state.auth = "ok";
    await refresh();
  } catch (err) {
    client = undefined;
    clearToken();
    state.auth = "invalid";
    state.authError = describeError(err);
  }
  render();
}

function signOut(): void {
  client = undefined;
  clearToken();
  state = { ...state, auth: "none", profiles: null, usage: null, activeProfileId: null, formOpen: false };
  render();
}

async function refresh(): Promise<void> {
  if (!client) return;
  try {
    const [providers, usage] = await Promise.all([client.listProviders(), client.usage(50)]);
    state.activeProfileId = providers.activeProfileId;
    state.profiles = providers.profiles;
    state.usage = usage.records;
  } catch (err) {
    if (err instanceof ApiRequestError && err.isAuth) {
      signOut();
      return;
    }
    state.notice = `refresh failed: ${describeError(err)}`;
  }
  render();
}

async function activate(id: string): Promise<void> {
  if (!client) return;
  state.activatingId = id;
  render();
  try {
    await client.activateProfile(id);
    await refresh();
  } catch (err) {
    reportError(err);
  }
  state.activatingId = undefined;
  render();
}

async function test(id: string): Promise<void> {
  if (!client) return;
  state.testingId = id;
  render();
  try {
    const result = await client.testProfile(id);
    if (result.ok) state.notice = `test passed: ${id} answered in ${result.latencyMs}ms`;
    else state.notice = `test failed: ${id} — ${result.code ?? "error"}: ${result.message ?? ""}`;
    await refresh();
  } catch (err) {
    reportError(err);
  }
  state.testingId = undefined;
  render();
}

async function remove(id: string): Promise<void> {
  if (!client) return;
  const profile = state.profiles?.find((p) => p.id === id);
  if (!window.confirm(`Delete profile "${profile?.label ?? id}" (${id})?`)) return;
  try {
    await client.deleteProfile(id);
    await refresh();
  } catch (err) {
    reportError(err);
  }
}

function openAddForm(): void {
  const preset = PRESETS["omniroute"];
  formDefaults.preset = "omniroute";
  formDefaults.id = "";
  formDefaults.label = preset.label;
  formDefaults.baseUrl = preset.baseUrl ?? "";
  formDefaults.model = "";
  formDefaults.apiKey = "";
  state.formOpen = true;
  state.editingId = undefined;
  state.formError = undefined;
  render();
  // Focus the id field for fast entry — after the rAF-deferred re-render.
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb: () => void) => setTimeout(cb, 16);
  raf(() => root.querySelector<HTMLInputElement>('[data-testid="dash-id"]')?.focus());
}

function openEditForm(p: ProviderProfileView): void {
  formDefaults.preset = "omniroute";
  formDefaults.id = p.id;
  formDefaults.label = p.label;
  formDefaults.baseUrl = p.baseUrl ?? "";
  formDefaults.model = p.model;
  formDefaults.apiKey = "";
  state.formOpen = true;
  state.editingId = p.id;
  state.formError = undefined;
  render();
}

function closeForm(): void {
  state.formOpen = false;
  state.editingId = undefined;
  state.formError = undefined;
  render();
}

async function submitForm(e: Event): Promise<void> {
  e.preventDefault();
  if (!client) return;
  const val = (testid: string): string => root.querySelector<HTMLInputElement>(`[data-testid="${testid}"]`)?.value.trim() ?? "";
  const id = val("dash-id");
  const label = val("dash-label");
  const baseUrl = val("dash-baseurl");
  const model = val("dash-model");
  const apiKey = val("dash-apikey");

  state.formBusy = true;
  state.formError = undefined;
  render();
  try {
    if (state.editingId) {
      const patch: Record<string, unknown> = { label, model };
      if (state.profiles?.find((p) => p.id === state.editingId)?.kind === "openai-compatible") patch.baseUrl = baseUrl;
      if (apiKey) patch.apiKey = apiKey; // omitted = keep existing
      await client.updateProfile(state.editingId, patch);
    } else {
      const preset = PRESETS[formDefaults.preset];
      const body: Record<string, unknown> = { id, label, kind: preset.kind, model };
      if (preset.kind === "openai-compatible") body.baseUrl = baseUrl;
      if (apiKey) body.apiKey = apiKey;
      await client.createProfile(body);
    }
    closeForm();
    await refresh();
  } catch (err) {
    state.formError = describeError(err);
  }
  state.formBusy = false;
  render();
}

function onPresetChange(e: Event): void {
  const select = e.currentTarget as HTMLSelectElement;
  const preset = PRESETS[select.value];
  if (!preset) return;
  if (state.editingId) return; // kind (and its preset) is immutable on edit
  formDefaults.preset = select.value;
  // Pre-fill only fields the user has not typed into yet.
  const labelInput = root.querySelector<HTMLInputElement>('[data-testid="dash-label"]');
  if (labelInput && labelInput.value.trim() === "") labelInput.value = preset.label;
  formDefaults.label = labelInput?.value ?? preset.label;
  formDefaults.baseUrl = preset.baseUrl ?? "";
  const baseInput = root.querySelector<HTMLInputElement>('[data-testid="dash-baseurl"]');
  if (baseInput) baseInput.value = formDefaults.baseUrl;
  if (preset.kind === "mock") {
    const modelInput = root.querySelector<HTMLInputElement>('[data-testid="dash-model"]');
    if (modelInput && modelInput.value.trim() === "") modelInput.value = "mock";
  }
  render(); // rebuild so the baseUrl field's visibility follows the kind
}

function resetChatSession(): void {
  state.chat.sessionId = undefined;
  storeDel(SESSION_KEY);
  state.chat.status = undefined;
  state.chat.error = undefined;
  render();
}

function onChatSubmit(e: Event): void {
  e.preventDefault();
  const ta = root.querySelector<HTMLTextAreaElement>('[data-testid="dash-message"]');
  const cwdInput = root.querySelector<HTMLInputElement>('[data-testid="dash-cwd"]');
  if (!ta || !cwdInput) return;
  const message = ta.value.trim();
  const cwd = cwdInput.value.trim();
  if (!message || !cwd || state.chat.busy) return;
  storeSet(CWD_KEY, cwd);
  state.chat.cwd = cwd;
  ta.value = "";
  void sendChat(message, cwd);
}

async function sendChat(message: string, cwd: string): Promise<void> {
  if (!client) return;
  state.chat.busy = true;
  state.chat.reply = "";
  state.chat.error = undefined;
  state.chat.status = "starting…";
  const sid = state.chat.sessionId ?? `dash-${Date.now().toString(36)}`;
  state.chat.sessionId = sid;
  storeSet(SESSION_KEY, sid);
  render();
  try {
    const { turnId } = await client.startTurn(sid, message, cwd);
    const result = await client.streamTurn(
      sid,
      turnId,
      {
        onEvent: (event) => {
          switch (event.type) {
            case "text_delta":
              state.chat.reply += event.delta;
              render();
              break;
            case "turn_completed":
              state.chat.status = `completed (seq ${event.seq})`;
              break;
            case "turn_failed":
              state.chat.status = `failed (${event.code})`;
              state.chat.error = event.message;
              break;
            case "turn_cancelled":
              state.chat.status = `cancelled: ${event.reason}`;
              break;
            default:
              break;
          }
        },
      },
      {}
    );
    if (result.reason === "gave_up" && !state.chat.status) {
      state.chat.error = state.chat.error ?? "lost the event stream; send the message again to retry";
    }
    await refresh(); // the usage table picks the finished turn up
  } catch (err) {
    if (err instanceof ApiRequestError && err.isAuth) {
      signOut();
      return;
    }
    state.chat.error = describeError(err);
  } finally {
    state.chat.busy = false;
    render();
  }
}

function reportError(err: unknown): void {
  if (err instanceof ApiRequestError && err.isAuth) {
    signOut();
    return;
  }
  state.notice = describeError(err);
  render();
}

function describeError(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.status === 401) return "the server rejected the token";
    const details = (err.details ?? {}) as { errors?: unknown; details?: { errors?: unknown } };
    const list = Array.isArray(details.errors) ? details.errors : Array.isArray(details.details?.errors) ? details.details!.errors : [];
    if (list.length > 0) return `${err.message}: ${list.join("; ")}`;
    return `${err.message} (${err.status} ${err.code})`;
  }
  if (err instanceof TypeError) return `cannot reach the server: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Tiny DOM helpers (same conventions as main.ts)

type Child = Node | string | null | undefined;

function el(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "disabled" && v !== "true") continue;
    node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function button(testId: string, label: string, onClick: (() => void) | undefined, kind: "primary" | "secondary" | "danger" | "link", disabled = false): HTMLElement {
  const b = el("button", { type: onClick ? "button" : "submit", class: `btn ${kind}`, "data-testid": testId, ...(disabled ? { disabled: "true" } : {}) }, label);
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

// ---------------------------------------------------------------------------
// Boot: pick up the shared token (same sessionStorage key as the main UI),
// then render. Handlers live on the elements built in the render pass.

const initialToken = loadToken();
if (initialToken) void connect(initialToken);
render();
