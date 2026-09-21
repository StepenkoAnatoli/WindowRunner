/**
 * Provider controller contract (B2.2) — the ONE state machine both hosts
 * share (the workspace Providers route in `main.ts` and the /dashboard
 * compatibility page): load / create / edit / update / test / activate /
 * delete / notices / errors, with auth failures always handed back to the host.
 *
 * The "raw key never reaches the display model" section moved here from
 * provider-types.test.ts — controller behavior belongs to this module;
 * provider-types.test.ts keeps the pure form-type and conversion contracts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createProviderController, type ProviderController } from "../src/provider-controller.js";
import { ApiClient, ApiRequestError } from "../src/api.js";
import type { ProviderProfileView } from "../src/api.js";
import { initialProviderUiState, type ProviderUiState } from "../src/app-state.js";

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

// ---------------------------------------------------------------------------
// State-machine coverage (B2.2 gap fill): load lifecycle, request shapes,
// confirmations, pending flags, notices, and auth failures on every effect.

const P1: ProviderProfileView = {
  id: "p1",
  label: "Alpha",
  kind: "openai-compatible",
  baseUrl: "https://example.com/v1",
  model: "model-x",
  apiKeyMasked: "****1234",
  createdAt: 1,
  updatedAt: 2,
  active: false,
};
const P2: ProviderProfileView = { ...P1, id: "p2", label: "Beta", model: "model-y", apiKeyMasked: "****9876", active: true };

interface Recorded {
  method: string;
  url: string;
  body?: unknown;
}

type Reply = { status: number; body: unknown };

interface Harness {
  controller: ProviderController;
  state(): ProviderUiState;
  transitions: ProviderUiState[];
  calls: Recorded[];
  confirms: string[];
  authErrors: number;
  setResponder(fn: (call: Recorded) => Reply | Promise<Reply>): void;
  setConfirmAnswer(value: boolean): void;
  setSignedOut(value: boolean): void;
}

function makeHarness(initial: Partial<ProviderUiState> = {}): Harness {
  let state: ProviderUiState = {
    ...initialProviderUiState,
    status: "ready",
    profiles: [P1, P2],
    activeProfileId: "p2",
    ...initial,
  };
  const transitions: ProviderUiState[] = [];
  const calls: Recorded[] = [];
  const confirms: string[] = [];
  const harness: Partial<Harness> = { transitions, calls, confirms, authErrors: 0 };
  let responder: (call: Recorded) => Reply | Promise<Reply> = () => ({ status: 200, body: { activeProfileId: "p2", profiles: [P1, P2] } });
  let confirmAnswer = true;
  let signedOut = false;

  const fetchImpl = (async (url: unknown, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const call: Recorded = { method, url: String(url), body: init?.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const result = await responder(call);
    return new Response(JSON.stringify(result.body), { status: result.status });
  }) as unknown as typeof fetch;
  const client = new ApiClient({ token: "tok", fetch: fetchImpl });

  const controller = createProviderController({
    getClient: () => (signedOut ? undefined : client),
    get: () => state,
    set: (next) => {
      state = next;
      transitions.push(next);
    },
    onAuthError: () => {
      harness.authErrors = (harness.authErrors ?? 0) + 1;
    },
    confirm: (message: string) => {
      confirms.push(message);
      return confirmAnswer;
    },
  });

  harness.controller = controller;
  harness.state = () => state;
  harness.setResponder = (fn) => {
    responder = fn;
  };
  harness.setConfirmAnswer = (value) => {
    confirmAnswer = value;
  };
  harness.setSignedOut = (value) => {
    signedOut = value;
  };
  return harness as Harness;
}

describe("provider controller: load", () => {
  it("moves idle → loading → ready and adopts the server's active id", async () => {
    const h = makeHarness({ status: "idle", profiles: [], activeProfileId: null });
    h.setResponder(() => ({ status: 200, body: { activeProfileId: "p1", profiles: [P1, P2] } }));
    await h.controller.load();
    assert.equal(h.transitions[0].status, "loading");
    assert.equal(h.state().status, "ready");
    assert.equal(h.state().activeProfileId, "p1", "activeProfileId comes from the server, never guessed");
    assert.deepEqual(h.state().profiles, [P1, P2]);
  });

  it("a failed load lands in the error slice with an actionable message", async () => {
    const h = makeHarness({ status: "idle", profiles: [] });
    h.setResponder(() => ({ status: 500, body: { error: "providers unavailable", code: "PROVIDER_DOWN" } }));
    await h.controller.load();
    assert.equal(h.state().status, "error");
    assert.equal(h.state().error?.code, "PROVIDER_DOWN");
    assert.match(h.state().error?.message ?? "", /providers unavailable/);
  });

  it("a second load while one is in flight is ignored; load(true) forces a reload", async () => {
    const h = makeHarness({ status: "idle", profiles: [] });
    let release: ((reply: Reply) => void) | undefined;
    h.setResponder(() => new Promise<Reply>((resolve) => {
      release = resolve;
    }));
    const first = h.controller.load();
    await new Promise((resolve) => setImmediate(resolve));
    await h.controller.load();
    assert.equal(h.calls.length, 1, "concurrent load is deduplicated");
    release?.({ status: 200, body: { activeProfileId: null, profiles: [P1] } });
    await first;
    assert.equal(h.state().status, "ready");

    // Ready data still reloads on plain load() (caching lives in the route
    // host); force bypasses the in-flight guard too.
    h.setResponder(() => ({ status: 200, body: { activeProfileId: null, profiles: [P1] } }));
    await h.controller.load(true);
    assert.equal(h.calls.length, 2);
  });

  it("every network effect is a no-op while signed out", async () => {
    const h = makeHarness();
    h.setSignedOut(true);
    await h.controller.load();
    await h.controller.submitForm();
    await h.controller.activate("p1");
    await h.controller.test("p1");
    await h.controller.delete("p1");
    assert.equal(h.calls.length, 0);
    assert.deepEqual(h.transitions, [], "no state churn while signed out");
  });
});

describe("provider controller: create", () => {
  it("validation runs before any network call", async () => {
    const h = makeHarness();
    h.controller.openCreateForm();
    h.controller.handleFieldChange("label", "Only a label");
    await h.controller.submitForm();
    assert.equal(h.calls.length, 0, "an invalid form never reaches the network");
    assert.ok(h.state().form?.validationErrors.profileId);
    assert.ok(h.state().form?.validationErrors.model);
  });

  it("a successful create notices with the label only, then reloads the list", async () => {
    const h = makeHarness();
    h.setResponder((call) => {
      if (call.method === "POST") return { status: 201, body: { ...P1, id: "new-id" } };
      return { status: 200, body: { activeProfileId: "p2", profiles: [P1, P2] } };
    });
    h.controller.openCreateForm();
    h.controller.handleFieldChange("profileId", "new-id");
    h.controller.handleFieldChange("label", "Fresh");
    h.controller.handleFieldChange("model", "m1");
    h.controller.handleFieldChange("kind", "mock");
    await h.controller.submitForm();
    assert.equal(h.state().form, undefined);
    assert.match(h.state().notice?.text ?? "", /provider “Fresh” created/);
    assert.equal(h.state().notice?.tone, "success");
    assert.equal(h.calls.filter((c) => c.method === "GET").length, 1, "list reloaded after create");
  });
});

describe("provider controller: edit and update", () => {
  it("openEditForm baselines the profile: blank key means unchanged", () => {
    const h = makeHarness();
    h.controller.openEditForm(P1);
    const form = h.state().form;
    assert.equal(form?.mode, "edit");
    assert.equal(form?.apiKey, "", "the key field starts blank — the mask is display text only");
    assert.equal(form?.apiKeyMode, "unchanged");
    assert.equal(h.controller.isDirty(), false, "an untouched edit form is clean");
  });

  it("update omits an unchanged key and never sends id or kind", async () => {
    const h = makeHarness();
    h.setResponder(() => ({ status: 200, body: { activeProfileId: "p2", profiles: [P1, P2] } }));
    h.controller.openEditForm(P1);
    h.controller.handleFieldChange("label", "Renamed");
    await h.controller.submitForm();
    const patch = h.calls.find((c) => c.method === "PATCH");
    assert.ok(patch, "a PATCH is sent");
    assert.equal(patch.url.endsWith("/api/providers/p1"), true);
    const body = patch.body as Record<string, unknown>;
    assert.ok(!("apiKey" in body), "an unchanged (blank) key is omitted");
    assert.ok(!("id" in body), "id is immutable and never sent");
    assert.ok(!("kind" in body), "kind is immutable and never sent");
    assert.equal(body.label, "Renamed");
    assert.match(h.state().notice?.text ?? "", /provider “Renamed” updated/);
  });

  it("a pasted mask is treated as unchanged and never sent back as a replacement", async () => {
    const h = makeHarness();
    h.setResponder(() => ({ status: 200, body: { activeProfileId: "p2", profiles: [P1, P2] } }));
    h.controller.openEditForm(P1);
    h.controller.handleFieldChange("apiKey", "****1234");
    assert.equal(h.state().form?.apiKeyMode, "unchanged");
    await h.controller.submitForm();
    const patch = h.calls.find((c) => c.method === "PATCH");
    assert.ok(!("apiKey" in (patch?.body as Record<string, unknown>)), "a masked key is never submitted as a replacement");
  });

  it("an explicitly typed replacement key is sent (trimmed)", async () => {
    const h = makeHarness();
    h.setResponder(() => ({ status: 200, body: { activeProfileId: "p2", profiles: [P1, P2] } }));
    h.controller.openEditForm(P1);
    h.controller.handleFieldChange("apiKey", "  sk-new-123  ");
    assert.equal(h.state().form?.apiKeyMode, "replace");
    await h.controller.submitForm();
    const body = h.calls.find((c) => c.method === "PATCH")?.body as Record<string, unknown>;
    assert.equal(body.apiKey, "sk-new-123");
  });

  it("a rejected update keeps the form open for fixing", async () => {
    const h = makeHarness();
    h.setResponder(() => ({ status: 400, body: { error: "profile is invalid", code: "PROFILE_INVALID" } }));
    h.controller.openEditForm(P1);
    h.controller.handleFieldChange("label", "Renamed");
    await h.controller.submitForm();
    assert.ok(h.state().form, "the form stays open after a rejection");
    assert.equal(h.state().form?.submitting, false, "and is submittable again");
    assert.match(h.state().notice?.text ?? "", /could not save the provider/);
  });
});

describe("provider controller: form lifecycle", () => {
  it("closeForm closes a clean form silently and confirms before discarding typed values", () => {
    const h = makeHarness();
    h.controller.openCreateForm();
    h.controller.closeForm();
    assert.equal(h.state().form, undefined);
    assert.equal(h.confirms.length, 0, "a clean close needs no confirmation");

    h.controller.openCreateForm();
    h.controller.handleFieldChange("label", "Draft");
    h.setConfirmAnswer(false);
    h.controller.closeForm();
    assert.ok(h.state().form, "declining keeps the form");
    assert.match(h.confirms[0], /Discard this new provider/);
    h.setConfirmAnswer(true);
    h.controller.closeForm();
    assert.equal(h.state().form, undefined);

    h.controller.openEditForm(P1);
    h.controller.handleFieldChange("label", "Draft edit");
    h.setConfirmAnswer(true);
    h.controller.closeForm();
    assert.match(h.confirms[2], /Discard unsaved changes to this provider/);
  });

  it("key field changes track empty / replace / unchanged from what is typed", () => {
    const h = makeHarness();
    h.controller.openCreateForm();
    assert.equal(h.state().form?.apiKeyMode, "empty");
    h.controller.handleFieldChange("apiKey", "sk-typed");
    assert.equal(h.state().form?.apiKeyMode, "replace");
    h.controller.handleFieldChange("apiKey", "");
    assert.equal(h.state().form?.apiKeyMode, "empty");

    h.controller.openEditForm(P1);
    assert.equal(h.state().form?.apiKeyMode, "unchanged");
    h.controller.handleFieldChange("apiKey", "••••••ab");
    assert.equal(h.state().form?.apiKeyMode, "unchanged", "a pasted mask is a no-change, in edit and create alike");
  });

  it("field changes are ignored while a submit is in flight", async () => {
    const h = makeHarness();
    h.setResponder((call) => {
      if (call.method === "POST") {
        // The controller guards form edits while submitting.
        h.controller.handleFieldChange("label", "Raced");
        return { status: 201, body: { ...P1, id: "new-id" } };
      }
      return { status: 200, body: { activeProfileId: "p2", profiles: [P1, P2] } };
    });
    h.controller.openCreateForm();
    h.controller.handleFieldChange("profileId", "new-id");
    h.controller.handleFieldChange("label", "Typed");
    h.controller.handleFieldChange("model", "m");
    h.controller.handleFieldChange("kind", "mock");
    await h.controller.submitForm();
    assert.equal(h.state().form, undefined, "submit succeeded with the values as typed");
  });

  it("validation errors stay quiet while typing, then recompute after the first failed submit", () => {
    const h = makeHarness();
    h.controller.openCreateForm();
    h.controller.handleFieldChange("label", "Hi");
    assert.deepEqual(h.state().form?.validationErrors, {}, "no premature required-field shouting");

    void h.controller.submitForm(); // invalid: model etc. missing
    assert.ok(h.state().form?.validationErrors.model);
    h.controller.handleFieldChange("model", "m");
    assert.equal(h.state().form?.validationErrors.model, undefined, "fixed fields clear on revalidation");
    assert.ok(h.state().form?.validationErrors.profileId, "unfixed fields keep their errors");
  });

  it("isDirty reflects typed values against the edit baseline", () => {
    const h = makeHarness();
    assert.equal(h.controller.isDirty(), false, "no form is not dirty");
    h.controller.openEditForm(P1);
    h.controller.handleFieldChange("label", "Temp");
    assert.equal(h.controller.isDirty(), true);
    h.controller.handleFieldChange("label", P1.label);
    assert.equal(h.controller.isDirty(), false, "reverting to the baseline is clean again");
    h.controller.handleFieldChange("apiKey", "sk-secret");
    assert.equal(h.controller.isDirty(), true, "a typed key always dirties the form");
  });
});

describe("provider controller: test (never activates)", () => {
  it("posts /test, notices success with the latency, reloads, and never activates", async () => {
    const h = makeHarness();
    h.setResponder((call) => {
      if (call.url.endsWith("/test")) {
        assert.equal(h.state().testingProfileId, "p1", "pending flag is set while in flight");
        return { status: 200, body: { ok: true, latencyMs: 12, reply: "[mock] pong" } };
      }
      return { status: 200, body: { activeProfileId: "p2", profiles: [P1, P2] } };
    });
    await h.controller.test("p1");
    assert.ok(h.calls.some((c) => c.method === "POST" && c.url.endsWith("/api/providers/p1/test")));
    assert.ok(!h.calls.some((c) => c.url.endsWith("/activate")), "testing never activates");
    assert.match(h.state().notice?.text ?? "", /test passed: Alpha answered in 12ms/);
    assert.equal(h.state().notice?.tone, "success");
    assert.equal(h.state().testingProfileId, undefined, "pending flag clears");
    assert.equal(h.calls.filter((c) => c.method === "GET").length, 1, "list reloaded so the card's last-test dot updates");
  });

  it("an unsuccessful test (ok:false) is an error notice and never activates", async () => {
    const h = makeHarness();
    h.setResponder(() => ({ status: 200, body: { ok: false, latencyMs: 5, code: "ECONNREFUSED", message: "nothing listening" } }));
    await h.controller.test("p1");
    assert.ok(!h.calls.some((c) => c.url.endsWith("/activate")));
    assert.match(h.state().notice?.text ?? "", /test failed: Alpha — ECONNREFUSED: nothing listening/);
    assert.equal(h.state().notice?.tone, "error");
  });

  it("a test request failure notices with the profile label", async () => {
    const h = makeHarness();
    h.setResponder(() => ({ status: 500, body: { error: "upstream exploded", code: "PROVIDER_UPSTREAM" } }));
    await h.controller.test("p2");
    assert.match(h.state().notice?.text ?? "", /test failed: Beta —/);
  });
});

describe("provider controller: activate", () => {
  it("activation failure notices and clears the pending flag", async () => {
    const h = makeHarness();
    h.setResponder((call) => {
      if (call.url.endsWith("/activate")) {
        assert.equal(h.state().activatingProfileId, "p1", "pending flag is set while in flight");
        return { status: 500, body: { error: "cannot switch now", code: "ACTIVATE_FAILED" } };
      }
      return { status: 200, body: { activeProfileId: "p2", profiles: [P1, P2] } };
    });
    await h.controller.activate("p1");
    assert.match(h.state().notice?.text ?? "", /could not activate: /);
    assert.equal(h.state().activatingProfileId, undefined);
    assert.equal(h.state().activeProfileId, "p2", "a failed activation never moves the active id");
  });

  it("a successful activation notices with the server-named label", async () => {
    const h = makeHarness();
    h.setResponder((call) => {
      if (call.url.endsWith("/activate")) return { status: 200, body: { activeProfileId: "p1", profile: { ...P1, active: true } } };
      return { status: 200, body: { activeProfileId: "p1", profiles: [{ ...P1, active: true }, { ...P2, active: false }] } };
    });
    await h.controller.activate("p1");
    assert.match(h.state().notice?.text ?? "", /switched to “Alpha”/);
    assert.equal(h.state().activeProfileId, "p1");
  });
});

describe("provider controller: delete", () => {
  it("asks for confirmation first; declining sends nothing", async () => {
    const h = makeHarness();
    h.setConfirmAnswer(false);
    await h.controller.delete("p1");
    assert.equal(h.calls.length, 0);
    assert.match(h.confirms[0], /Delete profile “Alpha” \(p1\)\?/);
    assert.ok(!h.confirms[0].includes("ACTIVE"), "a non-active profile needs no active warning");
  });

  it("the confirmation warns when the target is the active profile", async () => {
    const h = makeHarness();
    h.setConfirmAnswer(false);
    await h.controller.delete("p2");
    assert.match(h.confirms[0], /It is the ACTIVE provider/, "deleting the active profile is called out");
  });

  it("a successful delete notices and reloads the list", async () => {
    const h = makeHarness();
    h.setResponder((call) => {
      if (call.method === "DELETE") {
        assert.equal(h.state().deletingProfileId, "p1", "pending flag is set while in flight");
        return { status: 204, body: undefined };
      }
      return { status: 200, body: { activeProfileId: "p2", profiles: [P2] } };
    });
    await h.controller.delete("p1");
    assert.match(h.state().notice?.text ?? "", /profile “Alpha” deleted/);
    assert.equal(h.state().deletingProfileId, undefined);
    assert.equal(h.state().profiles.length, 1, "list reloaded after delete");
  });

  it("the server's refusal to delete the active profile is an actionable notice", async () => {
    const h = makeHarness();
    h.setResponder(() => ({ status: 409, body: { error: "cannot delete the active provider", code: "PROVIDER_ACTIVE" } }));
    await h.controller.delete("p2");
    assert.match(h.state().notice?.text ?? "", /could not delete: /);
    assert.match(h.state().notice?.text ?? "", /cannot delete the active provider/);
    assert.equal(h.state().deletingProfileId, undefined);
  });
});

describe("provider controller: notices and auth failures on every effect", () => {
  it("dismissNotice clears the banner", async () => {
    const h = makeHarness();
    h.setResponder(() => ({ status: 200, body: { ok: true, latencyMs: 1 } }));
    await h.controller.test("p1");
    assert.ok(h.state().notice);
    h.controller.dismissNotice();
    assert.equal(h.state().notice, undefined);
  });

  it("a 401 on submit, activate, test, and delete hands control to the host and stores nothing", async () => {
    for (const effect of ["submit", "activate", "test", "delete"] as const) {
      const h = makeHarness();
      h.setResponder(() => ({ status: 401, body: { error: "bad token", code: "AUTH_INVALID" } }));
      if (effect === "submit") {
        h.controller.openEditForm(P1);
        h.controller.handleFieldChange("label", "Renamed");
      }
      if (effect === "submit") await h.controller.submitForm();
      if (effect === "activate") await h.controller.activate("p1");
      if (effect === "test") await h.controller.test("p1");
      if (effect === "delete") await h.controller.delete("p1");
      assert.equal(h.authErrors, 1, `${effect}: 401 goes to onAuthError`);
      assert.equal(h.state().notice, undefined, `${effect}: no error notice is stored on auth failure`);
    }
  });
});
