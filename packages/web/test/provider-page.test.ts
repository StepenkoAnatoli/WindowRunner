/**
 * Unified provider page composition (B2.2): the page is the contract surface
 * both hosts render — header, active banner, list, add/edit form, notice and
 * error states — with the required stable selectors. Component internals are
 * covered by provider-cards.test.ts / provider-form.test.ts /
 * active-provider-banner.test.ts; this pins their composition and the
 * page-level callback wiring.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { renderProviderPage, type ProviderPageProps } from "../src/providers/provider-page.js";
import type { ProviderProfileView } from "../src/api.js";
import type { ProviderFormState, ProviderUiState } from "../src/app-state.js";
import { installDomStub, uninstallDomStub, type FakeElement, type StubDocument } from "./dom-stub.js";

const P1: ProviderProfileView = {
  id: "p1",
  label: "Alpha",
  kind: "openai-compatible",
  baseUrl: "https://example.com/v1",
  model: "model-x",
  apiKeyMasked: "****1234",
  createdAt: 1,
  updatedAt: 2,
  active: true,
};

const EDIT_FORM: ProviderFormState = {
  mode: "edit",
  profileId: "p1",
  label: "Alpha",
  kind: "openai-compatible",
  baseUrl: "https://example.com/v1",
  model: "model-x",
  apiKey: "",
  apiKeyMode: "unchanged",
  modelDiscovery: { status: "idle" },
  validationErrors: {},
  submitting: false,
};

interface Recorder {
  props: ProviderPageProps;
  called: string[];
}

function makeProps(state: ProviderUiState): Recorder {
  const called: string[] = [];
  const props: ProviderPageProps = {
    state,
    onAdd: () => void called.push("add"),
    onEdit: (id) => void called.push(`edit:${id}`),
    onTest: (id) => void called.push(`test:${id}`),
    onActivate: (id) => void called.push(`activate:${id}`),
    onDelete: (id) => void called.push(`delete:${id}`),
    onSubmit: () => void called.push("submit"),
    onCancelForm: () => void called.push("cancel"),
    onFieldChange: (field, value) => void called.push(`field:${field}=${value}`),
    onDiscoverModels: () => void called.push("discover"),
    onDismissNotice: () => void called.push("dismiss"),
    onRefresh: () => void called.push("refresh"),
    onBackToWorkspace: () => void called.push("back"),
  };
  return { props, called };
}

function readyState(overrides: Partial<ProviderUiState> = {}): ProviderUiState {
  return { status: "ready", activeProfileId: "p1", profiles: [P1], ...overrides };
}

describe("provider page composition", () => {
  let doc: StubDocument;

  beforeEach(() => {
    doc = installDomStub();
  });
  afterEach(() => {
    uninstallDomStub();
  });

  function mount(state: ProviderUiState): { page: FakeElement; called: string[] } {
    const { props, called } = makeProps(state);
    const page = renderProviderPage(props) as unknown as FakeElement;
    doc.body.append(page);
    return { page, called };
  }

  it("composes header, banner, list and form with the required selectors", () => {
    const { page } = mount(readyState({ form: EDIT_FORM }));
    // The root carries its own selector (querySelector never matches self).
    assert.equal(page.getAttribute("data-testid"), "providers-page");
    for (const selector of [
      '[data-testid="providers-active"]',
      '[data-testid="providers-list"]',
      '[data-testid="providers-add"]',
      '[data-testid="provider-form"]',
      '[data-testid="provider-submit"]',
      '[data-testid="provider-cancel"]',
    ]) {
      assert.ok(page.querySelector(selector), `missing required selector ${selector}`);
    }
    assert.match(page.textContent, /Providers/, "page header");
    assert.equal(page.querySelectorAll('[data-testid="dash-card"]').length, 1, "one card per profile");
  });

  it("notice and error states render with their selectors and callbacks", () => {
    const { page, called } = mount(
      readyState({
        notice: { tone: "success", text: "provider “Alpha” created" },
        error: { code: "PROVIDER_DOWN", message: "providers unavailable" },
      })
    );
    const notice = page.querySelector('[data-testid="providers-notice"]');
    assert.match(notice?.textContent ?? "", /provider “Alpha” created/);
    assert.equal(notice?.getAttribute("data-tone"), "success");
    (notice?.querySelector('[data-testid="providers-notice-dismiss"]') as FakeElement).click();
    assert.ok(called.includes("dismiss"));

    const error = page.querySelector('[data-testid="providers-error"]');
    assert.match(error?.textContent ?? "", /PROVIDER_DOWN/);
    assert.match(error?.textContent ?? "", /providers unavailable/);
    (error?.querySelector('[data-testid="providers-retry"]') as FakeElement).click();
    assert.ok(called.includes("refresh"), "retry re-runs the load through onRefresh");
  });

  it("empty and loading states are explicit", () => {
    const empty = mount(readyState({ profiles: [], activeProfileId: null }));
    assert.ok(empty.page.querySelector('[data-testid="providers-empty"]'));
    assert.equal(empty.page.querySelector('[data-testid="providers-list"]'), null);

    const loading = mount({ status: "loading", activeProfileId: null, profiles: [] });
    assert.ok(loading.page.querySelector('[data-testid="providers-loading"]'));
  });

  it("Add and Refresh are wired and disabled in the right states", () => {
    const { page, called } = mount(readyState());
    (page.querySelector('[data-testid="providers-add"]') as FakeElement).click();
    (page.querySelector('[data-testid="providers-refresh"]') as FakeElement).click();
    assert.deepEqual(called, ["add", "refresh"]);

    const withForm = mount(readyState({ form: EDIT_FORM, status: "loading" }));
    assert.equal(withForm.page.querySelector('[data-testid="providers-add"]')?.getAttribute("disabled"), "true", "add is disabled while the form is open");
    assert.equal(withForm.page.querySelector('[data-testid="providers-refresh"]')?.getAttribute("disabled"), "true", "refresh is disabled while loading");
  });

  it("the form's cancel button calls the page-level onCancelForm", () => {
    const { page, called } = mount(readyState({ form: EDIT_FORM }));
    (page.querySelector('[data-testid="provider-cancel"]') as FakeElement).click();
    assert.deepEqual(called, ["cancel"]);
  });

  it("in edit mode the form shows the editing profile's masked key — never a raw one", () => {
    const { page } = mount(readyState({ form: EDIT_FORM }));
    const masked = page.querySelector('[data-testid="provider-key-masked"]');
    assert.equal(masked?.textContent, "****1234");
    assert.equal(page.querySelectorAll('input[value^="sk-"]').length, 0, "no input ever carries key material");
  });

  it("the back link intercepts plain left clicks and lets modified clicks through", () => {
    const { page, called } = mount(readyState());
    const link = page.querySelector('[data-testid="providers-main-link"]') as FakeElement;
    assert.equal(link.getAttribute("href"), "/", "a real href keeps open-in-new-tab working");

    link.fire("click", { button: 0 });
    assert.deepEqual(called, ["back"], "a plain left click navigates in-app");

    link.fire("click", { button: 0, metaKey: true });
    link.fire("click", { button: 0, ctrlKey: true });
    link.fire("click", { button: 2 });
    assert.deepEqual(called, ["back"], "modified clicks are not intercepted");
  });

  it("card buttons route to the page-level callbacks with the profile id", () => {
    const { page, called } = mount(readyState({ profiles: [{ ...P1, active: false }], activeProfileId: null }));
    (page.querySelector('[data-testid="dash-test"]') as FakeElement).click();
    (page.querySelector('[data-testid="dash-activate"]') as FakeElement).click();
    (page.querySelector('[data-testid="dash-edit"]') as FakeElement).click();
    (page.querySelector('[data-testid="dash-delete"]') as FakeElement).click();
    assert.deepEqual(called, ["test:p1", "activate:p1", "edit:p1", "delete:p1"]);
  });
});
