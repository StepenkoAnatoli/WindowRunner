import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDER_KINDS,
  ProviderFormInvalidError,
  isMaskedApiKey,
  kindRequiresBaseUrl,
  providerFormIsDirty,
  toCreateProviderInput,
  toUpdateProviderInput,
  validateProviderForm,
} from "../src/provider-types.js";
import type { ProviderFormState } from "../src/app-state.js";

function form(overrides: Partial<ProviderFormState> = {}): ProviderFormState {
  return {
    mode: "create",
    profileId: "my-provider",
    label: "My provider",
    kind: "openai-compatible",
    baseUrl: "https://example.com/v1",
    model: "model-x",
    apiKey: "",
    apiKeyMode: "empty",
    modelDiscovery: { status: "idle" },
    validationErrors: {},
    submitting: false,
    ...overrides,
  };
}

describe("provider form validation", () => {
  it("accepts a complete create form without errors", () => {
    assert.deepEqual(validateProviderForm(form()), {});
  });

  it("rejects empty required fields before any API request can be built", () => {
    const errors = validateProviderForm(form({ profileId: "", label: "  ", model: "", baseUrl: "" }));
    assert.ok(errors.profileId);
    assert.ok(errors.label);
    assert.ok(errors.model);
    assert.ok(errors.baseUrl, "base URL is required for openai-compatible");
    // The adapter refuses to build a request body for an invalid form.
    assert.throws(() => toCreateProviderInput(form({ profileId: "", label: " ", model: "" })), ProviderFormInvalidError);
  });

  it("enforces the server's id slug shape", () => {
    assert.ok(validateProviderForm(form({ profileId: "Bad_Id" })).profileId);
    assert.ok(validateProviderForm(form({ profileId: "has space" })).profileId);
    assert.ok(validateProviderForm(form({ profileId: "x".repeat(65) })).profileId);
    assert.equal(validateProviderForm(form({ profileId: "ok-id-9" })).profileId, undefined);
  });

  it("requires a well-formed base URL only for openai-compatible", () => {
    assert.ok(validateProviderForm(form({ baseUrl: "example.com/v1" })).baseUrl, "missing scheme");
    assert.equal(validateProviderForm(form({ kind: "mock", baseUrl: "" })).baseUrl, undefined);
    assert.equal(validateProviderForm(form({ kind: "anthropic", baseUrl: "" })).baseUrl, undefined);
    assert.equal(kindRequiresBaseUrl("openai-compatible"), true);
    assert.equal(kindRequiresBaseUrl("mock"), false);
    assert.equal(kindRequiresBaseUrl("anthropic"), false);
    assert.deepEqual([...PROVIDER_KINDS], ["mock", "openai-compatible", "anthropic"]);
  });

  it("flags a key with whitespace or non-ASCII, but treats a pasted mask as no-change, not an error", () => {
    assert.ok(validateProviderForm(form({ apiKey: "sk key" })).apiKey);
    assert.ok(validateProviderForm(form({ apiKey: "sk-\u2022key" })).apiKey);
    assert.equal(validateProviderForm(form({ apiKey: "****1234" })).apiKey, undefined);
    assert.equal(validateProviderForm(form({ apiKey: "••••••" })).apiKey, undefined);
    assert.equal(isMaskedApiKey("****abcd"), true);
    assert.equal(isMaskedApiKey("••••••"), true);
    assert.equal(isMaskedApiKey("sk-1234"), false);
  });
});

describe("toCreateProviderInput", () => {
  it("trims label, id, model, base URL and key", () => {
    const input = toCreateProviderInput(
      form({ profileId: "  my-provider  ", label: "  Label  ", model: " model-x ", baseUrl: " https://example.com/v1/ ", apiKey: "  sk-abc  " })
    );
    assert.deepEqual(input, {
      id: "my-provider",
      label: "Label",
      kind: "openai-compatible",
      baseUrl: "https://example.com/v1/",
      model: "model-x",
      apiKey: "sk-abc",
    });
  });

  it("omits the optional base URL when empty or when the kind does not use one", () => {
    const mock = toCreateProviderInput(form({ kind: "mock", baseUrl: "" }));
    assert.equal("baseUrl" in mock, false);
    const anthropic = toCreateProviderInput(form({ kind: "anthropic", baseUrl: "" }));
    assert.equal("baseUrl" in anthropic, false);
  });

  it("omits the API key when left empty", () => {
    const input = toCreateProviderInput(form({ apiKey: "" }));
    assert.equal("apiKey" in input, false);
  });
});

describe("toUpdateProviderInput", () => {
  it("sends label/model, omits the blank (kept) edit key, and never sends kind or id", () => {
    const patch = toUpdateProviderInput(form({ mode: "edit", profileId: "my-provider", apiKey: "", apiKeyMode: "unchanged" }));
    assert.deepEqual(patch, { label: "My provider", model: "model-x", baseUrl: "https://example.com/v1" });
    assert.equal("kind" in patch, false, "kind is immutable server-side");
    assert.equal("id" in patch, false);
    assert.equal("apiKey" in patch, false, "blank key = keep the existing key");
  });

  it("sends the key only when the user explicitly typed a replacement", () => {
    const patch = toUpdateProviderInput(form({ mode: "edit", apiKey: "sk-replacement", apiKeyMode: "replace" }));
    assert.equal(patch.apiKey, "sk-replacement");
  });

  it("never sends a masked key back to the server", () => {
    for (const mask of ["****1234", "••••••••"]) {
      const patch = toUpdateProviderInput(form({ mode: "edit", apiKey: mask, apiKeyMode: "unchanged" }));
      assert.equal("apiKey" in patch, false, `${mask} must be dropped`);
      const create = toCreateProviderInput(form({ apiKey: mask }));
      assert.equal("apiKey" in create, false, `${mask} must be dropped on create too`);
    }
  });

  it("omits an empty base URL (server keeps the existing one; empty string would be rejected)", () => {
    const patch = toUpdateProviderInput(form({ mode: "edit", kind: "anthropic", baseUrl: "" }));
    assert.equal("baseUrl" in patch, false);
  });
});

describe("providerFormIsDirty", () => {
  it("is dirty in create mode when anything was typed", () => {
    assert.equal(providerFormIsDirty(form()), true);
    assert.equal(
      providerFormIsDirty(form({ profileId: "", label: "", model: "", baseUrl: "", apiKey: "" })),
      false
    );
  });

  it("in edit mode is dirty only for changed fields or a typed key", () => {
    const baseline = { label: "My provider", model: "model-x", baseUrl: "https://example.com/v1" };
    assert.equal(providerFormIsDirty(form({ mode: "edit", apiKey: "", apiKeyMode: "unchanged" }), baseline), false);
    assert.equal(providerFormIsDirty(form({ mode: "edit", label: "Renamed", apiKey: "" }), baseline), true);
    assert.equal(providerFormIsDirty(form({ mode: "edit", model: "model-y", apiKey: "" }), baseline), true);
    assert.equal(providerFormIsDirty(form({ mode: "edit", apiKey: "sk-new" }), baseline), true);
    // Unknown baseline: assume dirty (safe side for the confirmation).
    assert.equal(providerFormIsDirty(form({ mode: "edit", apiKey: "" })), true);
  });
});

