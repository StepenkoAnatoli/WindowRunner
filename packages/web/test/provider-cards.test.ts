import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installDomStub, uninstallDomStub, type FakeElement } from "./dom-stub.js";
import { renderProviderCards, type ProviderCardsProps } from "../src/providers/provider-cards.js";
import type { ProviderProfileView } from "../src/api.js";

describe("provider cards", () => {
  beforeEach(() => {
    installDomStub();
  });
  afterEach(() => {
    uninstallDomStub();
  });

  const PROFILE: ProviderProfileView = {
    id: "omniroute",
    label: "OmniRoute",
    kind: "openai-compatible",
    baseUrl: "https://omni.example/v1",
    model: "model-x",
    apiKeyMasked: "****abcd",
    createdAt: 1,
    updatedAt: 2,
  };

  function props(overrides: Partial<ProviderCardsProps> = {}): ProviderCardsProps & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      profiles: [PROFILE],
      activeProfileId: null,
      onEdit: (p) => void calls.push(`edit:${p.id}`),
      onTest: (p) => void calls.push(`test:${p.id}`),
      onActivate: (p) => void calls.push(`activate:${p.id}`),
      onDelete: (p) => void calls.push(`delete:${p.id}`),
      ...overrides,
    };
  }

  function q(root: HTMLElement, sel: string): HTMLElement {
    const found = root.querySelector(sel);
    assert.ok(found, `missing ${sel}`);
    return found as HTMLElement;
  }

  function clickCard(root: HTMLElement, cardId: string, testId: string): void {
    const card = q(root, `[data-testid="dash-card"][data-id="${cardId}"]`) as unknown as FakeElement;
    (card.querySelector(`[data-testid="${testId}"]`) as unknown as FakeElement).click();
  }

  it("renders the list container and one card per profile with label/kind/model/baseUrl", () => {
    const root = renderProviderCards(props({ profiles: [PROFILE, { ...PROFILE, id: "spark", kind: "mock", baseUrl: undefined }] }));
    assert.equal(root.getAttribute("data-testid"), "providers-list");
    const cards = root.querySelectorAll('[data-testid="dash-card"]');
    assert.equal(cards.length, 2);
    const first = cards[0];
    assert.equal(first.getAttribute("data-id"), "omniroute");
    assert.match((first.querySelector('[data-testid="dash-card-label"]') as HTMLElement).textContent ?? "", /OmniRoute/);
    assert.match((first.querySelector('[data-testid="dash-card-model"]') as HTMLElement).textContent ?? "", /openai-compatible · model-x/);
    assert.ok((first.querySelector(".base code") as HTMLElement | null), "base URL shown when present");
    const second = cards[1];
    assert.equal(second.querySelector(".base"), null, "no base URL row when the profile has none");
  });

  it("marks the active card (attribute + chip) from the server-provided active state", () => {
    const root = renderProviderCards(props({ activeProfileId: "omniroute" }));
    const card = q(root, '[data-testid="dash-card"][data-id="omniroute"]');
    assert.equal(card.getAttribute("data-active"), "true");
    assert.match(card.textContent ?? "", /active/);
    const inactive = renderProviderCards(props()).querySelector('[data-testid="dash-card"]');
    assert.equal(inactive?.getAttribute("data-active"), "false");
  });

  it("renders the masked key only — never a raw key field", () => {
    const root = renderProviderCards(props());
    assert.match((q(root, '[data-testid="dash-card-key"]').textContent ?? ""), /key: \*\*\*\*abcd/);
    // A profile without a key renders the em-dash placeholder, not an empty mask.
    const none = renderProviderCards(props({ profiles: [{ ...PROFILE, apiKeyMasked: undefined }] }));
    assert.match((none.querySelector('[data-testid="dash-card-key"]') as HTMLElement).textContent ?? "", /key: —/);
  });

  it("reflects the last test: green/red dot, tooltip, and the failure text", () => {
    const ok = renderProviderCards(props({ profiles: [{ ...PROFILE, lastTest: { at: 5, ok: true, latencyMs: 42 } }] }));
    assert.equal(ok.querySelector('[data-testid="dash-card-status"]')?.getAttribute("data-ok"), "true");
    assert.equal(ok.querySelector('[data-testid="dash-card-test-error"]'), null);

    const fail = renderProviderCards(props({ profiles: [{ ...PROFILE, lastTest: { at: 5, ok: false, code: "TEST_TIMEOUT", message: "probe timed out" } }] }));
    assert.equal(fail.querySelector('[data-testid="dash-card-status"]')?.getAttribute("data-ok"), "false");
    assert.match((fail.querySelector('[data-testid="dash-card-test-error"]') as HTMLElement).textContent ?? "", /TEST_TIMEOUT/);

    const untested = renderProviderCards(props());
    assert.equal(untested.querySelector('[data-testid="dash-card-status"]')?.getAttribute("data-ok"), "");
  });

  it("wires Use this / Test / Edit / Delete back to their callbacks", () => {
    const p = props();
    const root = renderProviderCards(p);
    clickCard(root, "omniroute", "dash-activate");
    clickCard(root, "omniroute", "dash-test");
    clickCard(root, "omniroute", "dash-edit");
    clickCard(root, "omniroute", "dash-delete");
    assert.deepEqual(p.calls, ["activate:omniroute", "test:omniroute", "edit:omniroute", "delete:omniroute"]);
  });

  it("shows per-card pending states: Use this disabled while active or switching, Testing…/Deleting… labels", () => {
    const active = renderProviderCards(props({ activeProfileId: "omniroute" }));
    const activeCard = q(active, '[data-testid="dash-card"]');
    assert.equal((activeCard.querySelector('[data-testid="dash-activate"]') as HTMLElement).getAttribute("disabled"), "true");

    const switching = renderProviderCards(props({ activatingProfileId: "omniroute" }));
    const swCard = q(switching, '[data-testid="dash-card"]');
    const swBtn = swCard.querySelector('[data-testid="dash-activate"]') as HTMLElement;
    assert.equal(swBtn.getAttribute("disabled"), "true");
    assert.match(swBtn.textContent ?? "", /Switching…/);

    const testing = renderProviderCards(props({ testingProfileId: "omniroute" }));
    const tBtn = q(testing, '[data-testid="dash-card"]').querySelector('[data-testid="dash-test"]') as HTMLElement;
    assert.equal(tBtn.getAttribute("disabled"), "true");
    assert.match(tBtn.textContent ?? "", /Testing…/);

    const deleting = renderProviderCards(props({ deletingProfileId: "omniroute" }));
    const dBtn = q(deleting, '[data-testid="dash-card"]').querySelector('[data-testid="dash-delete"]') as HTMLElement;
    assert.equal(dBtn.getAttribute("disabled"), "true");
    assert.match(dBtn.textContent ?? "", /Deleting…/);
  });

  it("the delete control is the confirmation entry point: it triggers the host's onDelete (confirm handled there)", () => {
    const p = props();
    const root = renderProviderCards(p);
    clickCard(root, "omniroute", "dash-delete");
    assert.deepEqual(p.calls, ["delete:omniroute"], "the card defers confirmation to the controller");
  });
});
