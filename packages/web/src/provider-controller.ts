/**
 * Provider state coordinator (B2) — the ONE place that owns provider effects
 * (list/create/edit/test/activate/delete) for BOTH hosts: the main
 * three-column workspace (main.ts) and the /dashboard compatibility page
 * (providers/compatibility.ts). It owns state transitions, not DOM: rendering
 * stays in the view modules, and the host stays responsible for
 * authentication (a 401 is always handed back via `onAuthError`).
 *
 * The controller is a factory over injected effects (`getClient` / `get` /
 * `set`), so the same behaviors run against the app-state reducer in main.ts
 * and against the dashboard's plain mutable state object without duplicating
 * API logic. All error text is produced by `describeError` and is secret-free:
 * it never echoes form values, and the raw key exists only inside the
 * transient form field while the user types.
 */

import { ApiRequestError, type ApiClient, type DiscoverModelsInput } from "./api.js";
import type { ProviderFormState, ProviderUiState } from "./app-state.js";
import type { ProviderProfileView } from "./api.js";
import { describeError } from "./describe-error.js";
import {
  apiKeyToSend,
  isMaskedApiKey,
  providerFormIsDirty,
  toCreateProviderInput,
  toUpdateProviderInput,
  validateProviderForm,
  type ProviderFormBaseline,
} from "./provider-types.js";

export interface ProviderControllerDeps {
  /** The live client, or undefined while signed out (all effects then no-op). */
  getClient(): ApiClient | undefined;
  /** Current provider slice. */
  get(): ProviderUiState;
  /** Persist the next provider slice (the host re-renders). */
  set(next: ProviderUiState): void;
  /** A 401 means the token died; the host signs out and shows the token panel. */
  onAuthError(err: unknown): void;
  /** Confirmation dialog; defaults to window.confirm when present, else auto-confirm. */
  confirm?(message: string): boolean;
}

export interface ProviderController {
  /** Load (or reload with `force`) the profile list from GET /api/providers. */
  load(force?: boolean): Promise<void>;
  openCreateForm(): void;
  openEditForm(profile: ProviderProfileView): void;
  /** Close the form; asks for confirmation when unsaved values would be lost. */
  closeForm(): void;
  handleFieldChange(field: ProviderFormFieldName, value: string): void;
  submitForm(): Promise<void>;
  /**
   * One-shot model discovery from the CURRENT form values (B4.2). Never
   * saves, never activates, never reloads the list; exactly one request at a
   * time; clears stale results when kind/baseUrl/apiKey change.
   */
  discoverModels(): Promise<void>;
  activate(profileId: string): Promise<void>;
  /** Reachability test — never activates the profile. */
  test(profileId: string): Promise<void>;
  /** Explicit confirmation, disabled control while pending, reload after. */
  delete(profileId: string): Promise<void>;
  dismissNotice(): void;
  /** True when the open form holds unsaved input (drives navigation confirms). */
  isDirty(): boolean;
}

/** Field names the form can change. `profileId` is the server-required slug. */
export type ProviderFormFieldName = "profileId" | "label" | "kind" | "baseUrl" | "model" | "apiKey";

function defaultConfirm(message: string): boolean {
  if (typeof window !== "undefined" && typeof window.confirm === "function") return window.confirm(message);
  return true;
}

export function createProviderController(deps: ProviderControllerDeps): ProviderController {
  const confirm = deps.confirm ?? defaultConfirm;

  function notice(tone: "success" | "error" | "info", text: string): void {
    deps.set({ ...deps.get(), notice: { tone, text } });
  }

  function describeFailure(err: unknown): string {
    // Non-secret by construction: describeError formats API error messages
    // (the server scrubs keys from its own error text) and never includes
    // form input.
    return describeError(err, { fieldErrors: true });
  }

  function isAuthFailure(err: unknown): boolean {
    return err instanceof ApiRequestError && err.isAuth;
  }

  /** Baseline the open edit form is compared against for dirty checks. */
  function baseline(form: ProviderFormState): ProviderFormBaseline | undefined {
    if (form.mode !== "edit") return undefined;
    const profile = deps.get().profiles.find((p) => p.id === form.profileId);
    return profile ? { label: profile.label, model: profile.model, baseUrl: profile.baseUrl ?? "" } : undefined;
  }

  async function load(force = false): Promise<void> {
    const client = deps.getClient();
    const current = deps.get();
    if (!client) return;
    if (!force && current.status === "loading") return;
    deps.set({ ...deps.get(), status: "loading", error: undefined });
    try {
      const result = await client.listProviders();
      // activeProfileId comes from the server, never from local guessing.
      deps.set({ ...deps.get(), status: "ready", profiles: result.profiles, activeProfileId: result.activeProfileId });
    } catch (err) {
      if (isAuthFailure(err)) {
        deps.onAuthError(err);
        return;
      }
      deps.set({ ...deps.get(), status: "error", error: { code: err instanceof ApiRequestError ? err.code : "CLIENT_ERROR", message: describeFailure(err) } });
    }
  }

  function openCreateForm(): void {
    deps.set({
      ...deps.get(),
      form: {
        mode: "create",
        profileId: "",
        label: "",
        kind: "openai-compatible",
        baseUrl: "",
        model: "",
        apiKey: "",
        apiKeyMode: "empty",
        modelDiscovery: { status: "idle" },
        validationErrors: {},
        submitting: false,
      },
      error: undefined,
    });
  }

  function openEditForm(profile: ProviderProfileView): void {
    deps.set({
      ...deps.get(),
      form: {
        mode: "edit",
        profileId: profile.id,
        label: profile.label,
        kind: profile.kind,
        baseUrl: profile.baseUrl ?? "",
        model: profile.model,
        // Blank = keep the existing key; the mask is explanatory text below
        // the field, never an input value.
        apiKey: "",
        apiKeyMode: "unchanged",
        modelDiscovery: { status: "idle" },
        validationErrors: {},
        submitting: false,
      },
      error: undefined,
    });
  }

  function closeForm(): void {
    const form = deps.get().form;
    if (!form) return;
    if (providerFormIsDirty(form, baseline(form))) {
      const message =
        form.mode === "create"
          ? "Discard this new provider? The values you typed have not been saved."
          : "Discard unsaved changes to this provider?";
      if (!confirm(message)) return;
    }
    deps.set({ ...deps.get(), form: undefined });
  }

  function handleFieldChange(field: ProviderFormFieldName, value: string): void {
    const form = deps.get().form;
    if (!form || form.submitting) return;
    const next: ProviderFormState = { ...form, [field]: value };
    // apiKeyMode distinguishes the three server-meaningful states: create
    // without a key ("empty"), edit keeping the key ("unchanged" — blank OR a
    // pasted mask, which the adapter drops), and an explicitly typed
    // replacement ("replace").
    const typed = next.apiKey.trim();
    next.apiKeyMode = typed === "" || isMaskedApiKey(typed) ? (next.mode === "edit" ? "unchanged" : "empty") : "replace";
    // Discovered models belong to the kind/baseUrl/key they were fetched
    // for: any material change clears them instead of showing results that
    // no longer match the form. Changing the model field itself keeps them.
    if (field === "kind" || field === "baseUrl" || field === "apiKey") {
      next.modelDiscovery = { status: "idle" };
    }
    // Only re-validate once the first submit attempt flagged something, so
    // the form does not shout "required" while the user is still typing.
    next.validationErrors = Object.keys(form.validationErrors).length > 0 ? validateProviderForm(next) : form.validationErrors;
    deps.set({ ...deps.get(), form: next });
  }

  /**
   * One-shot model discovery (B4.2). Reads the CURRENT form values — kind,
   * trimmed base URL, and the typed key via the same rule the save adapters
   * use (blank or a pasted mask sends nothing). The result only ever lands in
   * the transient `modelDiscovery` slice: nothing is saved, nothing is
   * activated, the list is not reloaded, and the typed model text is not
   * touched — picking a discovered model is a separate, explicit user action.
   */
  async function discoverModels(): Promise<void> {
    const client = deps.getClient();
    const form = deps.get().form;
    if (!client || !form || form.submitting) return;
    // Exactly one discovery request at a time.
    if (form.modelDiscovery.status === "loading") return;
    const input: DiscoverModelsInput = { kind: form.kind };
    const baseUrl = form.baseUrl.trim();
    if (baseUrl) input.baseUrl = baseUrl;
    const apiKey = apiKeyToSend(form);
    if (apiKey) input.apiKey = apiKey;
    deps.set({ ...deps.get(), form: { ...form, modelDiscovery: { status: "loading" } } });
    try {
      const result = await client.discoverModels(input);
      const current = deps.get().form;
      if (current) deps.set({ ...deps.get(), form: { ...current, modelDiscovery: { status: "ready", models: result.models } } });
    } catch (err) {
      if (isAuthFailure(err)) {
        deps.onAuthError(err);
        return;
      }
      // describeError output is secret-free by construction (the server
      // scrubs keys from its own messages and never echoes input).
      const message = describeFailure(err);
      const current = deps.get().form;
      if (current) deps.set({ ...deps.get(), form: { ...current, modelDiscovery: { status: "error", message } } });
    }
  }

  /**
   * Map the server's per-field `errors` list ("baseUrl required for
   * openai-compatible") onto form fields; unmatched text becomes a
   * form-level error notice. The list is server wording and secret-free.
   */
  function serverFieldErrors(err: unknown): { errors: Record<string, string>; leftover?: string } {
    const errors: Record<string, string> = {};
    if (!(err instanceof ApiRequestError)) return { errors };
    const details = (err.details ?? {}) as { errors?: unknown };
    const list = Array.isArray(details.errors) ? details.errors : [];
    for (const raw of list) {
      const text = String(raw);
      if (/^id\b/i.test(text)) errors.profileId = text;
      else if (/^label\b/i.test(text)) errors.label = text;
      else if (/^model\b/i.test(text)) errors.model = text;
      else if (/^baseUrl\b/i.test(text)) errors.baseUrl = text;
      else if (/^apiKey\b/i.test(text)) errors.apiKey = text;
      else return { errors, leftover: text };
    }
    return { errors };
  }

  async function submitForm(): Promise<void> {
    const client = deps.getClient();
    const form = deps.get().form;
    if (!client || !form || form.submitting) return;
    // Local validation runs BEFORE any request: the adapter also refuses to
    // build a body with empty required fields, so a broken form never reaches
    // the network.
    const localErrors = validateProviderForm(form);
    if (Object.keys(localErrors).length > 0) {
      deps.set({ ...deps.get(), form: { ...form, validationErrors: localErrors } });
      return;
    }
    const label = form.label.trim();
    deps.set({ ...deps.get(), form: { ...form, submitting: true, validationErrors: {} } });
    try {
      if (form.mode === "create") {
        await client.createProfile(toCreateProviderInput(form));
        // The form (and with it the typed raw key) is dropped first; the
        // notice names the label only — never a key value.
        deps.set({ ...deps.get(), form: undefined });
        notice("success", `provider “${label}” created`);
      } else {
        await client.updateProfile(form.profileId!, toUpdateProviderInput(form));
        deps.set({ ...deps.get(), form: undefined });
        notice("success", `provider “${label}” updated`);
      }
      await load(true);
    } catch (err) {
      if (isAuthFailure(err)) {
        deps.onAuthError(err);
        return;
      }
      const { errors, leftover } = serverFieldErrors(err);
      const text = leftover ? describeFailure(err) : "";
      const current = deps.get();
      deps.set({
        ...current,
        form: current.form ? { ...current.form, submitting: false, validationErrors: errors } : undefined,
        notice: text ? { tone: "error", text } : current.notice,
      });
      if (!leftover) notice("error", `could not save the provider: ${describeFailure(err)}`);
    }
  }

  async function activate(profileId: string): Promise<void> {
    const client = deps.getClient();
    if (!client || deps.get().activatingProfileId) return;
    deps.set({ ...deps.get(), activatingProfileId: profileId });
    try {
      const result = await client.activateProfile(profileId);
      // Update from the SERVER response, then reload the list so the `active`
      // flags come from the server too — never guessed locally.
      deps.set({ ...deps.get(), activeProfileId: result.activeProfileId });
      notice("success", `switched to “${result.profile.label}”`);
      await load(true);
    } catch (err) {
      if (isAuthFailure(err)) {
        deps.onAuthError(err);
        return;
      }
      notice("error", `could not activate: ${describeFailure(err)}`);
    } finally {
      deps.set({ ...deps.get(), activatingProfileId: undefined });
    }
  }

  async function test(profileId: string): Promise<void> {
    const client = deps.getClient();
    if (!client || deps.get().testingProfileId) return;
    const label = deps.get().profiles.find((p) => p.id === profileId)?.label ?? profileId;
    deps.set({ ...deps.get(), testingProfileId: profileId });
    try {
      const result = await client.testProfile(profileId);
      if (result.ok) notice("success", `test passed: ${label} answered in ${result.latencyMs}ms`);
      else notice("error", `test failed: ${label} — ${result.code ?? "error"}: ${result.message ?? ""}`);
      // The server recorded lastTest on the profile; reload so the card's
      // status dot reflects it. A test never activates the profile.
      await load(true);
    } catch (err) {
      if (isAuthFailure(err)) {
        deps.onAuthError(err);
        return;
      }
      notice("error", `test failed: ${label} — ${describeFailure(err)}`);
    } finally {
      deps.set({ ...deps.get(), testingProfileId: undefined });
    }
  }

  async function remove(profileId: string): Promise<void> {
    const client = deps.getClient();
    if (!client || deps.get().deletingProfileId) return;
    const profile = deps.get().profiles.find((p) => p.id === profileId);
    const isActive = deps.get().activeProfileId === profileId || profile?.active === true;
    const warning = isActive
      ? " It is the ACTIVE provider — the server refuses to delete the active provider; activate another one first."
      : "";
    if (!confirm(`Delete profile “${profile?.label ?? profileId}” (${profileId})?${warning}`)) return;
    deps.set({ ...deps.get(), deletingProfileId: profileId });
    try {
      await client.deleteProfile(profileId);
      notice("success", `profile “${profile?.label ?? profileId}” deleted`);
      // Reload: the banner then shows the server's resulting active state
      // (and the server's refusal for the active profile lands as a notice).
      await load(true);
    } catch (err) {
      if (isAuthFailure(err)) {
        deps.onAuthError(err);
        return;
      }
      notice("error", `could not delete: ${describeFailure(err)}`);
    } finally {
      deps.set({ ...deps.get(), deletingProfileId: undefined });
    }
  }

  return {
    load,
    openCreateForm,
    openEditForm,
    closeForm,
    handleFieldChange,
    submitForm,
    discoverModels,
    activate,
    test,
    delete: remove,
    dismissNotice: () => deps.set({ ...deps.get(), notice: undefined }),
    isDirty(): boolean {
      const form = deps.get().form;
      return form !== undefined && providerFormIsDirty(form, baseline(form));
    },
  };
}
