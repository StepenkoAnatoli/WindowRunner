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
import { initialProviderUiState, type ProviderFormState, type ProviderUiState } from "../src/app-state.js";
import { createProviderController } from "../src/provider-controller.js";
import { ApiClient, ApiRequestError } from "../src/api.js";

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

/**
 * End-to-end through the controller with a fake client: the RAW key submitted
 * in a create request never appears anywhere in the stored UI state (the
 * display model) — only the server's mask does.
 */
describe("raw key never reaches the display model", () => {
  const RAW_KEY = "sk-raw-secret-1234";
  const REDACTED = {
    id: "my-provider",
    label: "My provider",
    kind: "openai-compatible",
    baseUrl: "https://example.com/v1",
    model: "model-x",
    apiKeyMasked: "****1234",
    createdAt: 1,
    updatedAt: 2,
    active: true,
  };

  function harness(response: unknown, status = 200) {
    let state = { ...initialProviderUiState };
    const bodies: unknown[] = [];
    const fetchImpl = (async (url: any, init: any) => {
      const method = init?.method ?? "GET";
      if (init?.body) bodies.push(JSON.parse(init.body));
      if (status >= 400) {
        return new Response(JSON.stringify({ error: "profile is invalid", code: "PROFILE_INVALID" }), { status });
      }
      // The list reload after a mutation gets a proper list payload.
      if (method === "GET" && String(url).endsWith("/api/providers")) {
        return new Response(JSON.stringify({ activeProfileId: (response as any).active ?? null, profiles: [response] }), { status: 200 });
      }
      return new Response(JSON.stringify(response), { status: status === 201 ? 201 : 200 });
    }) as unknown as typeof fetch;
    const client = new ApiClient({ token: "tok", fetch: fetchImpl });
    const controller = createProviderController({
      getClient: () => client,
      get: () => state,
      set: (next) => {
        state = next;
      },
      onAuthError: () => {},
      confirm: () => true,
    });
    return { controller, bodies, get: () => state };
  }

  it("after a successful create, the slice holds only the masked view", async () => {
    const { controller, get } = harness(REDACTED, 201);
    controller.openCreateForm();
    controller.handleFieldChange("profileId", "my-provider");
    controller.handleFieldChange("label", "My provider");
    controller.handleFieldChange("baseUrl", "https://example.com/v1");
    controller.handleFieldChange("model", "model-x");
    controller.handleFieldChange("apiKey", RAW_KEY);
    await controller.submitForm();
    const slice = get();
    assert.equal(slice.form, undefined, "the form (and the typed key) is dropped after success");
    assert.equal(JSON.stringify(slice).includes(RAW_KEY), false, "raw key must not leak into the UI state");
    assert.deepEqual(slice.profiles, [REDACTED]);
  });

  it("a rejected create keeps the form for fixing, with the server's per-field errors attached", async () => {
    let state = { ...initialProviderUiState };
    // A locally-valid form (anthropic needs no base URL) the SERVER rejects:
    // its per-field `errors` list must land on the matching fields.
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "profile is invalid", code: "PROFILE_INVALID", errors: ["model must be at most 256 chars", "something unstructured"] }), {
        status: 400,
      })) as unknown as typeof fetch;
    const client = new ApiClient({ token: "tok", fetch: fetchImpl });
    const controller = createProviderController({
      getClient: () => client,
      get: () => state,
      set: (next) => {
        state = next;
      },
      onAuthError: () => {},
      confirm: () => true,
    });
    controller.openCreateForm();
    controller.handleFieldChange("kind", "anthropic");
    controller.handleFieldChange("profileId", "p");
    controller.handleFieldChange("label", "L");
    controller.handleFieldChange("model", "m");
    await controller.submitForm();
    assert.ok(state.form, "form stays open after a rejection");
    assert.equal(state.form?.submitting, false);
    assert.match(state.form?.validationErrors.model ?? "", /model must be at most 256/);
    assert.ok(state.notice?.text.includes("something unstructured"), "unmatched server text surfaces as a notice");
  });

  it("a 401 anywhere hands control back to the host (sign-out) instead of storing an error", async () => {
    let state = { ...initialProviderUiState };
    let signedOut = false;
    const fetchImpl = (async () => new Response(JSON.stringify({ error: "bad token", code: "AUTH_INVALID" }), { status: 401 })) as unknown as typeof fetch;
    const client = new ApiClient({ token: "tok", fetch: fetchImpl });
    const controller = createProviderController({
      getClient: () => client,
      get: () => state,
      set: (next) => {
        state = next;
      },
      onAuthError: () => {
        signedOut = true;
      },
      confirm: () => true,
    });
    await controller.load();
    assert.equal(signedOut, true);
  });

  it("activate updates from the server response and reloads the list; test never activates", async () => {
    const active = { ...REDACTED, id: "other", active: true };
    const responses: unknown[] = [{ activeProfileId: "other", profile: active }, { activeProfileId: "other", profiles: [REDACTED, active] }];
    const calls: Array<{ method?: string; url: string }> = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push({ method: init?.method, url: String(url) });
      const body = responses.shift() ?? { activeProfileId: "other", profiles: [REDACTED, active] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    let state: ProviderUiState = { ...initialProviderUiState, status: "ready", profiles: [REDACTED, { ...active, active: false }], activeProfileId: null };
    const client = new ApiClient({ token: "tok", fetch: fetchImpl });
    const controller = createProviderController({
      getClient: () => client,
      get: () => state,
      set: (next) => {
        state = next;
      },
      onAuthError: () => {},
      confirm: () => true,
    });
    await controller.activate("other");
    assert.equal(state.activeProfileId, "other", "activeProfileId comes from the server response");
    assert.equal(state.profiles.find((p) => p.id === "other")?.active, true);
    assert.ok(calls.some((c) => c.method === "POST" && c.url.endsWith("/api/providers/other/activate")));
    assert.ok(calls.some((c) => c.method === "GET" && c.url.endsWith("/api/providers")), "list is reloaded after activation");
    assert.ok(!state.notice || !state.notice.text.includes(RAW_KEY));
    await assert.rejects(
      async () => {
        // Sanity: the API error type used by the controller's auth path.
        throw new ApiRequestError(401, "AUTH_INVALID", "bad token");
      },
      (err: unknown) => err instanceof ApiRequestError && err.isAuth
    );
  });
});
