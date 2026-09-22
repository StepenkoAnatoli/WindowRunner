/**
 * The add/edit provider form (B2) — the shared form for the main workspace
 * and the /dashboard compatibility page.
 *
 * Rules that matter:
 * - the API key input is `type="password"` with autocomplete pinned to a safe
 *   value, and it is never pre-filled with the masked key (the mask renders
 *   as explanatory text next to it, not as an input value);
 * - the kind decides whether the base-URL field exists (openai-compatible
 *   requires it; mock needs neither);
 * - in create mode the server-required profile slug (`id`) is editable; in
 *   edit mode kind and id are immutable server-side, so they render as text;
 * - validation errors attach to their fields with `aria-describedby` +
 *   `aria-invalid`;
 * - Cancel/Escape go through `onCancel`, which the controller implements with
 *   a discard confirmation when the form is dirty.
 *
 * Inputs push every change up through `onChange`, so the form state (not the
 * DOM) is the source of truth and re-renders never lose typed values.
 */
import type { ProviderFormState } from "../app-state.js";
import { PROVIDER_KINDS, kindRequiresBaseUrl } from "../provider-types.js";
import { button, el } from "../dom.js";

export type ProviderFormField =
  | "profileId"
  | "label"
  | "kind"
  | "baseUrl"
  | "model"
  | "apiKey";

export interface ProviderFormProps {
  form: ProviderFormState;
  /** The current key's mask in edit mode (explanatory text, never an input value). */
  maskedApiKey?: string;
  onChange(field: ProviderFormField, value: string): void;
  onSubmit(): void;
  onCancel(): void;
  /** One-shot "Fetch models" (B4.3); the host wires it to the controller. */
  onDiscoverModels(): void;
}

const KIND_LABELS: Record<string, string> = {
  mock: "Mock — offline, no key, no network",
  "openai-compatible": "OpenAI-compatible — OpenAI, Ollama, gateways",
  anthropic: "Anthropic — official Messages API",
};

const KIND_HINTS: Record<string, string> = {
  mock: "Offline; no model calls, no network. Replies are prefixed “[mock]”.",
  "openai-compatible": "Works with OpenAI, OpenRouter, Gemini's OpenAI layer, local Ollama (http://127.0.0.1:11434/v1) and similar gateways. Base URL required.",
  anthropic: "Uses the official Anthropic API unless a custom base URL is entered.",
};

export function renderProviderForm(props: ProviderFormProps): HTMLElement {
  const form = props.form;
  const editing = form.mode === "edit";
  const showBaseUrl = kindRequiresBaseUrl(form.kind);
  const errorId = (field: string): string => `provider-error-${field}`;
  const describedBy = (field: string): string | undefined => (form.validationErrors[field] ? errorId(field) : undefined);

  const input = (testId: string, field: ProviderFormField, attrs: Record<string, string> = {}): HTMLElement => {
    const node = el("input", {
      "data-testid": testId,
      value: field === "apiKey" ? "" : String((form as unknown as Record<string, string>)[field] ?? ""),
      autocomplete: "off",
      ...(form.validationErrors[field] ? { "aria-invalid": "true" } : {}),
      ...(describedBy(field) ? { "aria-describedby": describedBy(field)! } : {}),
      ...attrs,
    });
    node.addEventListener("input", () => props.onChange(field, (node as unknown as HTMLInputElement).value));
    return node;
  };

  const kindSelect = el(
    "select",
    { "data-testid": "provider-kind", ...(form.validationErrors.kind ? { "aria-invalid": "true" } : {}) },
    ...PROVIDER_KINDS.map((kind) =>
      el("option", { value: kind, ...(form.kind === kind ? { selected: "true" } : {}) }, KIND_LABELS[kind] ?? kind)
    )
  );
  kindSelect.addEventListener("change", () => props.onChange("kind", (kindSelect as unknown as HTMLSelectElement).value));

  const fieldError = (field: string): HTMLElement | null =>
    form.validationErrors[field]
      ? el(
          "p",
          { class: "error small field-error", "data-testid": "provider-field-error", "data-field": field, id: errorId(field), role: "alert" },
          form.validationErrors[field]
        )
      : null;

  /**
   * B4.3 model-discovery region. Discovery is never required: the manual
   * model input above stays visible and enabled in EVERY state. The region
   * shows the one-shot button (openai-compatible + mock; mock answers its
   * offline list honestly), the loading indicator, the discovered-model
   * select, the exact empty-state copy, or a secret-free error. Anthropic
   * has no live listing yet, so the region says so up front instead of
   * offering a click that can only fail — and never presents a static list
   * as live provider data.
   */
  const discovery = form.modelDiscovery ?? { status: "idle" as const };
  const discoverySupported = form.kind === "openai-compatible" || form.kind === "mock";
  const discoveryBusy = discovery.status === "loading" || form.submitting;
  const discoveryRegion = el(
    "div",
    { class: "provider-discovery", "data-testid": "provider-model-discovery" },
    discoverySupported
      ? el(
          "div",
          { class: "row" },
          button("provider-discover-models", discovery.status === "loading" ? "Fetching models…" : "Fetch models", props.onDiscoverModels, "secondary", discoveryBusy),
          discovery.status === "idle" ? el("span", { class: "hint" }, "optional — or enter the model id manually") : null
        )
      : el("span", { class: "hint", "data-testid": "provider-model-discovery-fallback" }, "model discovery unavailable for this provider"),
    discovery.status === "loading" ? el("p", { class: "hint", "data-testid": "provider-model-discovery-loading" }, "Fetching models…") : null,
    discovery.status === "ready" && discovery.models.length > 0
      ? (() => {
          const select = el(
            "select",
            { "data-testid": "provider-model-select", "aria-label": "Discovered models" },
            el("option", { value: "" }, "Select a model…"),
            ...discovery.models.map((m) => el("option", { value: m }, m))
          );
          // Choosing an option copies the id into the model field; the select
          // itself is rebuilt from state on the next render, so it returns to
          // the placeholder and the text field stays the source of truth.
          select.addEventListener("change", () => {
            const value = (select as unknown as HTMLSelectElement).value;
            if (value) props.onChange("model", value);
          });
          return select;
        })()
      : null,
    discovery.status === "ready" && discovery.models.length === 0
      ? el("p", { class: "hint", "data-testid": "provider-model-discovery-empty" }, "No models were returned. Enter the model id manually.")
      : null,
    discovery.status === "error"
      ? el("p", { class: "error small", "data-testid": "provider-model-discovery-error", role: "alert" }, discovery.message)
      : null
  );

  const form2 = el(
    "form",
    { class: "panel provider-form", "data-testid": "provider-form", novalidate: "true" },
    el("h2", {}, editing ? `Edit “${form.profileId}”` : "Add provider"),
    editing
      ? el("p", { class: "hint", "data-testid": "provider-kind-fixed" }, `kind: ${form.kind} (immutable — create a new profile to change it)`)
      : el("label", {}, "Kind", kindSelect, el("span", { class: "hint" }, KIND_HINTS[form.kind] ?? "")),
    editing
      ? el("p", { class: "hint" }, "id: ", el("code", {}, form.profileId ?? ""))
      : el(
          "label",
          {},
          "Id (lowercase letters, digits, hyphens)",
          input("provider-id", "profileId", { placeholder: "my-provider" }),
          fieldError("profileId")
        ),
    el("label", {}, "Label", input("provider-label", "label", { placeholder: "My provider" }), fieldError("label")),
    showBaseUrl
      ? el(
          "label",
          {},
          "Base URL",
          input("provider-base-url", "baseUrl", { placeholder: "https://…/v1" }),
          fieldError("baseUrl")
        )
      : null,
    el(
      "label",
      { "data-testid": "provider-model-manual" },
      "Model",
      input("provider-model", "model", { placeholder: "model-id" }),
      fieldError("model")
    ),
    discoveryRegion,
    el(
      "label",
      {},
      "API key",
      input("provider-api-key", "apiKey", {
        type: "password",
        // "new-password" keeps browsers from autofilling saved credentials
        // into this field; edit mode never accepts a saved value anyway.
        autocomplete: editing ? "off" : "new-password",
        placeholder: editing ? "leave blank to keep the current key" : "only if the endpoint requires one",
      }),
      editing
        ? el(
            "span",
            { class: "hint", "data-testid": "provider-key-hint" },
            "Leave blank to keep the existing key",
            props.maskedApiKey
              ? el("span", {}, " (current key: ", el("code", { "data-testid": "provider-key-masked" }, props.maskedApiKey), ")")
              : null
          )
        : el("span", { class: "hint" }, "Stored only server-side; shown masked (****last4) afterwards. Never persisted by this page."),
      fieldError("apiKey")
    ),
    el(
      "div",
      { class: "row" },
      button("provider-submit", form.submitting ? "Saving…" : editing ? "Save changes" : "Create profile", undefined, "primary", form.submitting),
      button("provider-cancel", "Cancel", props.onCancel, "secondary")
    )
  );
  form2.addEventListener("submit", (e) => {
    e.preventDefault();
    props.onSubmit();
  });
  // Escape counts as Cancel; the host decides whether a confirmation is
  // needed (dirty form) before actually closing.
  form2.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Escape") {
      e.preventDefault();
      props.onCancel();
    }
  });
  return form2;
}
