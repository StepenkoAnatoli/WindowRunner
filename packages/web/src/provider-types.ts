/**
 * Typed provider input contracts + the form-to-request adapters (B2).
 *
 * The server contract these must match (packages/server/src/provider-profiles.ts
 * and provider-service.ts):
 * - `POST /api/providers` requires `id` (`[a-z0-9-]{1,64}`), `label`, `kind`,
 *   `model`; `baseUrl` is required for `openai-compatible`; `apiKey` optional.
 * - `PATCH /api/providers/:id` accepts only `label` / `model` / `baseUrl` /
 *   `apiKey` — `id` and `kind` are immutable and rejected. `apiKey` omitted =
 *   keep the existing key, empty string = clear, string = replace. The B2 form
 *   uses blank = keep, so an edit request only ever carries `apiKey` when the
 *   user explicitly typed a replacement.
 *
 * Everything here is pure: no DOM, no fetch, no global state — the adapter
 * turns *validated form state* into the exact request body, and nothing else.
 */

import type { ProviderFormState } from "./app-state.js";

/**
 * The profile slug ids the server accepts (mirrors PROFILE_ID_RE server-side).
 * Exported for the form's pattern hint and the local validator.
 */
export const PROVIDER_PROFILE_ID_RE = /^[a-z0-9-]{1,64}$/;

/** Provider kinds the server registers (mirrors KINDS server-side). */
export const PROVIDER_KINDS: readonly string[] = ["mock", "openai-compatible", "anthropic"];

/** Only this kind needs a base URL; `mock` ignores it and `anthropic` defaults to the official API. */
export function kindRequiresBaseUrl(kind: string): boolean {
  return kind === "openai-compatible";
}

/**
 * The server's mask (`****last4`, see `maskKey` server-side) — and more
 * generally any `••••`/`****`-style placeholder — must never travel back to
 * the server as if it were a raw key.
 */
export function isMaskedApiKey(value: string): boolean {
  return /^\*{2,}/.test(value) || /^•{2,}/.test(value);
}

export interface CreateProviderInput {
  /**
   * The profile slug. Required by the existing server contract (the plan
   * sketch omitted it; see the plan appendix) — in the form it is bound to
   * `profileId` while creating.
   */
  id: string;
  label: string;
  kind: string;
  baseUrl?: string;
  model: string;
  apiKey?: string;
}

export interface UpdateProviderInput {
  label?: string;
  /**
   * Present for typing parity with the wire format, but the adapter NEVER
   * emits it: the server treats `kind` as immutable and rejects the request.
   */
  kind?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

/** Thrown by the adapters when the form still fails validation — nothing is sent. */
export class ProviderFormInvalidError extends Error {
  readonly errors: Record<string, string>;
  constructor(errors: Record<string, string>) {
    super("the provider form has unresolved validation errors");
    this.name = "ProviderFormInvalidError";
    this.errors = errors;
  }
}

function printableAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.codePointAt(i)!;
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/**
 * Local mirror of the server's `validateProfile`, phrased per field so the
 * form can attach errors to inputs (`provider-field-error`). Returns an empty
 * record when the form is ready to submit. The API key is never required
 * (local/Ollama-style endpoints and the mock need none), but a typed key must
 * be transmit-safe — and a pasted *mask* is not an error, it is "no change".
 */
export function validateProviderForm(form: ProviderFormState): Record<string, string> {
  const errors: Record<string, string> = {};
  const label = form.label.trim();
  const model = form.model.trim();
  const baseUrl = form.baseUrl.trim();
  const apiKey = form.apiKey.trim();

  if (form.mode === "create") {
    const id = (form.profileId ?? "").trim();
    if (!id) errors.profileId = "id is required (lowercase letters, digits, hyphens)";
    else if (!PROVIDER_PROFILE_ID_RE.test(id)) errors.profileId = "id must be lowercase alphanumeric/hyphen, 1-64 chars";
  }
  if (!label) errors.label = "label is required";
  else if (label.length > 128) errors.label = "label must be at most 128 characters";
  if (!model) errors.model = "model is required";
  else if (model.length > 256) errors.model = "model must be at most 256 characters";
  if (kindRequiresBaseUrl(form.kind)) {
    if (!baseUrl) errors.baseUrl = "base URL is required for openai-compatible providers";
    else if (!/^https?:\/\//i.test(baseUrl)) errors.baseUrl = "base URL must start with http:// or https://";
    else if (!printableAscii(baseUrl)) errors.baseUrl = "base URL must contain only printable ASCII characters";
  } else if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
    errors.baseUrl = "base URL must start with http:// or https://";
  }
  if (apiKey) {
    if (isMaskedApiKey(apiKey)) {
      // A mask pasted into the field means "no change", not a key — the
      // adapter drops it, so it is not a validation failure.
    } else if (/\s/.test(apiKey)) errors.apiKey = "API key must not contain whitespace";
    else if (!printableAscii(apiKey)) errors.apiKey = "API key must contain only printable ASCII characters";
  }
  return errors;
}

/** Baseline values a form was opened with (edit mode), for dirty checks. */
export interface ProviderFormBaseline {
  label: string;
  model: string;
  baseUrl: string;
}

/**
 * True when closing the form would lose user input: any typed value in create
 * mode; in edit mode a changed field or a typed replacement key. Used for the
 * "discard unsaved changes?" confirmation — the form itself stays in memory
 * across route changes, so navigating away never silently destroys it.
 */
export function providerFormIsDirty(form: ProviderFormState, baseline?: ProviderFormBaseline): boolean {
  if (form.mode === "create") {
    return [form.profileId ?? "", form.label, form.model, form.baseUrl, form.apiKey].some((v) => v.trim() !== "");
  }
  if (form.apiKey.trim() !== "") return true;
  if (!baseline) return true; // original profile unknown: assume dirty (safe)
  return form.label !== baseline.label || form.model !== baseline.model || form.baseUrl !== baseline.baseUrl;
}

function assertValid(form: ProviderFormState): void {
  const errors = validateProviderForm(form);
  if (Object.keys(errors).length > 0) throw new ProviderFormInvalidError(errors);
}

/** The trimmed key to send, or undefined for "no key" (empty, or a pasted mask). */
export function apiKeyToSend(form: ProviderFormState): string | undefined {
  const key = form.apiKey.trim();
  if (!key || isMaskedApiKey(key)) return undefined;
  return key;
}

/**
 * Build the `POST /api/providers` body from the form. Trims every text field,
 * omits `baseUrl` for kinds that do not use it (and when left empty), and
 * rejects (throws) instead of returning a partial body when required fields
 * are empty — the caller never sends a request that the server must refuse.
 */
export function toCreateProviderInput(form: ProviderFormState): CreateProviderInput {
  assertValid(form);
  const input: CreateProviderInput = {
    id: (form.profileId ?? "").trim(),
    label: form.label.trim(),
    kind: form.kind,
    model: form.model.trim(),
  };
  const baseUrl = form.baseUrl.trim();
  if (baseUrl) input.baseUrl = baseUrl;
  const apiKey = apiKeyToSend(form);
  if (apiKey) input.apiKey = apiKey;
  return input;
}

/**
 * Build the `PATCH /api/providers/:id` body from the form. `kind` and the id
 * are immutable server-side and never sent; `apiKey` is sent ONLY when the
 * user typed a replacement (a blank field or a pasted mask means "keep the
 * existing key"), so the mask can never travel to the server.
 */
export function toUpdateProviderInput(form: ProviderFormState): UpdateProviderInput {
  assertValid(form);
  const patch: UpdateProviderInput = {
    label: form.label.trim(),
    model: form.model.trim(),
  };
  // Omitted when empty: the server keeps the existing URL (sending "" would
  // fail its http(s) prefix validation). openai-compatible can never get here
  // with an empty URL — the validator requires it — so this only affects
  // kinds where the URL is optional.
  const baseUrl = form.baseUrl.trim();
  if (baseUrl) patch.baseUrl = baseUrl;
  const apiKey = apiKeyToSend(form);
  if (apiKey) patch.apiKey = apiKey;
  return patch;
}
