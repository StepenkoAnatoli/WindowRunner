import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installDomStub, uninstallDomStub, type FakeElement } from "./dom-stub.js";
import { renderProviderForm, type ProviderFormField, type ProviderFormProps } from "../src/providers/provider-form.js";
import type { ProviderFormState } from "../src/app-state.js";

describe("provider form", () => {
  beforeEach(() => {
    installDomStub();
  });
  afterEach(() => {
    uninstallDomStub();
  });

  function form(overrides: Partial<ProviderFormState> = {}): ProviderFormState {
    return {
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
      ...overrides,
    };
  }

  function props(overrides: Partial<ProviderFormProps> = {}): ProviderFormProps & { calls: string[]; changes: Array<[ProviderFormField, string]> } {
    const calls: string[] = [];
    const changes: Array<[ProviderFormField, string]> = [];
    return {
      calls,
      changes,
      form: form(),
      onChange: (field, value) => {
        changes.push([field, value]);
        calls.push(`change:${field}`);
      },
      onSubmit: () => void calls.push("submit"),
      onCancel: () => void calls.push("cancel"),
      onDiscoverModels: () => void calls.push("discover"),
      ...overrides,
    };
  }

  function q(root: HTMLElement, sel: string): HTMLElement {
    const found = root.querySelector(sel);
    assert.ok(found, `missing ${sel}`);
    return found as HTMLElement;
  }

  function click(root: HTMLElement, testId: string): void {
    (q(root, `[data-testid="${testId}"]`) as unknown as FakeElement).click();
  }

  it("renders create fields: kind select, id, label, base URL, model, and a password key input", () => {
    const p = props();
    const root = renderProviderForm(p);
    assert.equal(root.getAttribute("data-testid"), "provider-form");
    const kind = q(root, '[data-testid="provider-kind"]');
    assert.equal(kind.tagName, "SELECT");
    assert.equal((kind as unknown as FakeElement).querySelectorAll("option").length, 3, "one option per server kind");
    q(root, '[data-testid="provider-id"]');
    q(root, '[data-testid="provider-label"]');
    q(root, '[data-testid="provider-base-url"]');
    q(root, '[data-testid="provider-model"]');
    const key = q(root, '[data-testid="provider-api-key"]');
    assert.equal(key.getAttribute("type"), "password");
    assert.equal(key.getAttribute("autocomplete"), "new-password", "create mode uses the safe autocomplete value");
    assert.equal(key.getAttribute("value"), "", "the key input is never pre-filled");
    q(root, '[data-testid="provider-submit"]');
    q(root, '[data-testid="provider-cancel"]');
  });

  it("hides the base-URL field for kinds that do not use one", () => {
    assert.equal(renderProviderForm(props({ form: form({ kind: "mock" }) })).querySelector('[data-testid="provider-base-url"]'), null);
    assert.equal(renderProviderForm(props({ form: form({ kind: "anthropic" }) })).querySelector('[data-testid="provider-base-url"]'), null);
    assert.ok(renderProviderForm(props({ form: form({ kind: "openai-compatible" }) })).querySelector('[data-testid="provider-base-url"]'));
  });

  it("renders edit fields: immutable kind/id as text, blank key with the keep-existing hint and mask text", () => {
    const root = renderProviderForm(
      props({ form: form({ mode: "edit", profileId: "omniroute", label: "Omni", kind: "openai-compatible", apiKeyMode: "unchanged" }), maskedApiKey: "****1234" })
    );
    assert.equal(root.querySelector('[data-testid="provider-kind"]'), null, "kind is not editable on edit");
    assert.equal(root.querySelector('[data-testid="provider-id"]'), null, "id is not editable on edit");
    assert.match(q(root, '[data-testid="provider-kind-fixed"]').textContent ?? "", /openai-compatible/);
    assert.match(q(root, '[data-testid="provider-key-hint"]').textContent ?? "", /Leave blank to keep the existing key/);
    assert.match(q(root, '[data-testid="provider-key-masked"]').textContent ?? "", /\*\*\*\*1234/);
    const key = q(root, '[data-testid="provider-api-key"]');
    assert.equal(key.getAttribute("type"), "password");
    assert.equal(key.getAttribute("value"), "", "the mask is explanatory text, never an input value");
    // The raw/masked key never appears as an input value anywhere in the form.
    for (const input of root.querySelectorAll("input")) {
      assert.equal(input.getAttribute("value")?.includes("*"), false, "no input carries the mask");
    }
  });

  it("shows per-field validation errors wired with aria-describedby and aria-invalid", () => {
    const f = form({ validationErrors: { label: "label is required", model: "model is required" } });
    const root = renderProviderForm(props({ form: f }));
    const errors = root.querySelectorAll('[data-testid="provider-field-error"]');
    assert.equal(errors.length, 2);
    for (const err of errors) {
      assert.ok(err.getAttribute("data-field"));
      assert.ok(err.getAttribute("id"), "errors need an id so inputs can point at them");
    }
    const label = q(root, '[data-testid="provider-label"]');
    assert.equal(label.getAttribute("aria-invalid"), "true");
    assert.equal(label.getAttribute("aria-describedby"), "provider-error-label");
    const model = q(root, '[data-testid="provider-model"]');
    assert.equal(model.getAttribute("aria-describedby"), "provider-error-model");
    // The untouched id field has no error wiring.
    const id = q(root, '[data-testid="provider-id"]');
    assert.equal(id.getAttribute("aria-invalid"), null);
  });

  it("submit and cancel call their callbacks; Escape counts as cancel", () => {
    const p = props();
    const root = renderProviderForm(p);
    // The dom stub has no implicit submission: firing the form's submit event
    // is the same path the browser takes when provider-submit is clicked.
    (root as unknown as FakeElement).submit();
    click(root, "provider-cancel");
    assert.deepEqual(p.calls, ["submit", "cancel"]);
    (root as unknown as FakeElement).fire("keydown", { key: "Escape" });
    assert.deepEqual(p.calls, ["submit", "cancel", "cancel"]);
  });

  it("typing pushes changes up through onChange (state is the source of truth)", () => {
    const p = props();
    const root = renderProviderForm(p);
    const label = q(root, '[data-testid="provider-label"]') as unknown as FakeElement;
    label.value = "Renamed";
    label.fire("input", { target: label });
    assert.deepEqual(p.changes, [["label", "Renamed"]]);
  });

  it("disables submit while pending and labels it Saving…", () => {
    const root = renderProviderForm(props({ form: form({ submitting: true }) }));
    const submit = q(root, '[data-testid="provider-submit"]');
    assert.equal(submit.getAttribute("disabled"), "true");
    assert.match(submit.textContent ?? "", /Saving…/);
    const open = renderProviderForm(props());
    assert.equal(open.querySelector('[data-testid="provider-submit"]')?.getAttribute("disabled"), null);
  });

  it("edit mode keeps autocomplete off on the key field", () => {
    const root = renderProviderForm(props({ form: form({ mode: "edit", profileId: "x" }) }));
    assert.equal(q(root, '[data-testid="provider-api-key"]').getAttribute("autocomplete"), "off");
  });
});


/**
 * B4.3 — the model-discovery region inside the provider form: all required
 * selectors, every state, select-copies-into-field, the exact empty copy,
 * secret-free errors, the anthropic fallback, and a manual input that is
 * available and enabled in EVERY state (discovery is never required).
 */
describe("provider form: model discovery region (B4.3)", () => {
  const { installDomStub: install, uninstallDomStub: uninstall } = { installDomStub, uninstallDomStub };
  beforeEach(install);
  afterEach(uninstall);

  function form(overrides: Partial<ProviderFormState> = {}): ProviderFormState {
    return {
      mode: "create",
      profileId: "",
      label: "",
      kind: "openai-compatible",
      baseUrl: "https://prov.example/v1",
      model: "",
      apiKey: "",
      apiKeyMode: "empty",
      modelDiscovery: { status: "idle" },
      validationErrors: {},
      submitting: false,
      ...overrides,
    };
  }

  function props(overrides: Partial<ProviderFormProps> = {}): ProviderFormProps & { calls: string[]; changes: Array<[ProviderFormField, string]> } {
    const calls: string[] = [];
    const changes: Array<[ProviderFormField, string]> = [];
    return {
      calls,
      changes,
      form: form(),
      onChange: (field, value) => {
        changes.push([field, value]);
        calls.push(`change:${field}`);
      },
      onSubmit: () => void calls.push("submit"),
      onCancel: () => void calls.push("cancel"),
      onDiscoverModels: () => void calls.push("discover"),
      ...overrides,
    };
  }

  function q(root: HTMLElement, sel: string): HTMLElement {
    const found = root.querySelector(sel);
    assert.ok(found, `missing ${sel}`);
    return found as HTMLElement;
  }

  function click(root: HTMLElement, testId: string): void {
    (q(root, `[data-testid="${testId}"]`) as unknown as FakeElement).click();
  }

  it("renders every required selector in the ready state", () => {
    const p = props({ form: form({ modelDiscovery: { status: "ready", models: ["alpha", "zeta"] } }) });
    const root = renderProviderForm(p);
    q(root, '[data-testid="provider-model-manual"]');
    q(root, '[data-testid="provider-discover-models"]');
    const region = q(root, '[data-testid="provider-model-discovery"]');
    const select = q(region, '[data-testid="provider-model-select"]');
    const options = (select as unknown as FakeElement).querySelectorAll("option");
    assert.equal(options.length, 3, "placeholder + one option per discovered model");
    assert.equal(options[0].textContent, "Select a model…");
    assert.equal(options[1].getAttribute("value"), "alpha");
    assert.equal(options[2].getAttribute("value"), "zeta");
  });

  it("choosing a discovered model copies the id into the model field via onChange", () => {
    const p = props({ form: form({ modelDiscovery: { status: "ready", models: ["alpha", "zeta"] } }) });
    const root = renderProviderForm(p);
    const select = q(root, '[data-testid="provider-model-select"]') as unknown as FakeElement;
    select.value = "zeta"; // what the (real) select would report after a user choice
    select.fire("change");
    assert.deepEqual(p.changes, [["model", "zeta"]], "selection goes through onChange, not direct DOM writes");
  });

  it("loading disables the button and shows the loading indicator", () => {
    const root = renderProviderForm(props({ form: form({ modelDiscovery: { status: "loading" } }) }));
    const b = q(root, '[data-testid="provider-discover-models"]');
    assert.equal(b.getAttribute("disabled"), "true");
    q(root, '[data-testid="provider-model-discovery-loading"]');
    assert.equal(root.querySelector('[data-testid="provider-model-select"]'), null);
  });

  it("empty results show the exact guidance copy", () => {
    const root = renderProviderForm(props({ form: form({ modelDiscovery: { status: "ready", models: [] } }) }));
    const empty = q(root, '[data-testid="provider-model-discovery-empty"]');
    assert.equal(empty.textContent, "No models were returned. Enter the model id manually.");
    assert.equal(root.querySelector('[data-testid="provider-model-select"]'), null);
  });

  it("errors render as a secret-free alert; the button stays usable for a retry", () => {
    const root = renderProviderForm(props({ form: form({ modelDiscovery: { status: "error", message: "model discovery: the provider answered HTTP 500" } }) }));
    const err = q(root, '[data-testid="provider-model-discovery-error"]');
    assert.equal(err.getAttribute("role"), "alert");
    assert.ok(!err.textContent.includes("sk-"));
    q(root, '[data-testid="provider-discover-models"]');
    const retry = q(root, '[data-testid="provider-discover-models"]') as unknown as FakeElement;
    assert.equal(retry.hasAttribute("disabled"), false, "the button stays enabled for a retry");
  });

  it("the manual model input stays enabled and outside the discovery region in every state", () => {
    const states: ProviderFormState["modelDiscovery"][] = [
      { status: "idle" },
      { status: "loading" },
      { status: "ready", models: ["a"] },
      { status: "ready", models: [] },
      { status: "error", message: "x" },
    ];
    for (const modelDiscovery of states) {
      const root = renderProviderForm(props({ form: form({ modelDiscovery }) }));
      const manual = q(root, '[data-testid="provider-model-manual"]');
      const input = manual.querySelector('input[data-testid="provider-model"]') as unknown as FakeElement;
      assert.ok(input, `manual input present in ${modelDiscovery.status}`);
      assert.equal(input.hasAttribute("disabled"), false, `manual input enabled in ${modelDiscovery.status}`);
    }
  });

  it("anthropic shows the documented fallback instead of a fetch button", () => {
    const root = renderProviderForm(props({ form: form({ kind: "anthropic", baseUrl: "" }) }));
    const fallback = q(root, '[data-testid="provider-model-discovery-fallback"]');
    assert.equal(fallback.textContent, "model discovery unavailable for this provider");
    assert.equal(root.querySelector('[data-testid="provider-discover-models"]'), null, "no button that can only fail");
    const input = root.querySelector('input[data-testid="provider-model"]') as unknown as FakeElement;
    assert.equal(input.hasAttribute("disabled"), false, "manual entry still available");
  });

  it("mock keeps the fetch button (its offline list is real data); idle shows the manual hint", () => {
    const root = renderProviderForm(props({ form: form({ kind: "mock", baseUrl: "" }) }));
    q(root, '[data-testid="provider-discover-models"]');
    assert.ok(root.textContent.includes("or enter the model id manually"));
  });

  it("clicking Fetch models calls onDiscoverModels exactly once per click", () => {
    const p = props();
    const root = renderProviderForm(p);
    click(root, "provider-discover-models");
    click(root, "provider-discover-models");
    assert.equal(p.calls.filter((c) => c === "discover").length, 2);
  });
});
