/**
 * The add/edit provider form: the presets that pre-fill it, the panel itself,
 * and the submit/preset-change effects.
 *
 * `formDefaults` holds the values the builder renders into the inputs; the
 * render pass captures and restores whatever the user has typed since, so a
 * re-render triggered by a spinner or a refresh never wipes in-flight input.
 */
import type { ProviderProfileView } from "./api.js";
import { button, el } from "./dom.js";
import { nextFrame, render, root, state } from "./dashboard-state.js";
import { client, describeDashError, refresh } from "./dashboard-api.js";

// Presets pre-fill only known-stable fields. OmniRoute's base URL is a
// placeholder the user must fill in from their own dashboard — it is
// per-account and was never hard-coded.
export const PRESETS: Record<string, { kind: string; label: string; baseUrl?: string; baseUrlPlaceholder?: string; modelPlaceholder?: string; note?: string; keyHint?: string }> = {
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
export const formDefaults: Record<string, string> = {
  preset: "omniroute",
  id: "",
  label: "OmniRoute",
  baseUrl: "",
  model: "",
  apiKey: "",
};

export function formPanel(): HTMLElement {
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

export function openAddForm(): void {
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
  nextFrame(() => root.querySelector<HTMLInputElement>('[data-testid="dash-id"]')?.focus());
}

export function openEditForm(p: ProviderProfileView): void {
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

export function closeForm(): void {
  state.formOpen = false;
  state.editingId = undefined;
  state.formError = undefined;
  render();
}

export async function submitForm(e: Event): Promise<void> {
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
    state.formError = describeDashError(err);
  }
  state.formBusy = false;
  render();
}

export function onPresetChange(e: Event): void {
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
