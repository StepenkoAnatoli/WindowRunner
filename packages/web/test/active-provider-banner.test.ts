/**
 * Active-provider banner states (B2.2): active profile, no active profile,
 * loading, and the deleted/stale case where the server names an active id the
 * list no longer contains. Also pins the dashboard compatibility ids
 * (`dash-active`, `dash-active-kind`) the /dashboard E2E relies on.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { findActiveProfile, renderActiveProviderBanner } from "../src/providers/active-provider-banner.js";
import type { ProviderProfileView } from "../src/api.js";
import type { ProviderUiState } from "../src/app-state.js";
import { installDomStub, uninstallDomStub } from "./dom-stub.js";

const P1: ProviderProfileView = {
  id: "p1",
  label: "Alpha",
  kind: "mock",
  model: "mock-1",
  createdAt: 1,
  updatedAt: 2,
  active: false,
};

function state(overrides: Partial<ProviderUiState> = {}): ProviderUiState {
  return { status: "ready", activeProfileId: null, profiles: [], ...overrides };
}

describe("active provider banner", () => {
  beforeEach(() => {
    installDomStub();
  });
  afterEach(() => {
    uninstallDomStub();
  });

  it("shows the active profile: label · kind · model, plus the kind chip", () => {
    const banner = renderActiveProviderBanner(state({ profiles: [P1], activeProfileId: "p1" }));
    assert.ok(banner.getAttribute("data-testid") === "providers-active", "shared selector on the banner root");
    const detail = banner.querySelector('[data-testid="dash-active"]');
    assert.match(detail?.textContent ?? "", /Alpha · mock · mock-1/);
    assert.equal(banner.querySelector('[data-testid="dash-active-kind"]')?.textContent, "mock");
  });

  it("says so plainly when there is no active profile", () => {
    const banner = renderActiveProviderBanner(state({ profiles: [P1], activeProfileId: null, status: "ready" }));
    assert.match(banner.querySelector('[data-testid="dash-active"]')?.textContent ?? "", /no active profile/);
    assert.equal(banner.querySelector('[data-testid="dash-active-kind"]'), null);
  });

  it("shows a loading placeholder while idle or loading", () => {
    for (const status of ["idle", "loading"] as const) {
      const banner = renderActiveProviderBanner(state({ status }));
      assert.match(banner.querySelector('[data-testid="dash-active"]')?.textContent ?? "", /loading/);
    }
  });

  it("names the missing profile when the active id is not in the list (deleted elsewhere)", () => {
    const banner = renderActiveProviderBanner(state({ profiles: [P1], activeProfileId: "gone-id" }));
    const detail = banner.querySelector('[data-testid="dash-active"]');
    assert.match(detail?.textContent ?? "", /active profile “gone-id” is not in the list/);
    assert.match(detail?.textContent ?? "", /refresh to update/);
    assert.ok(detail?.getAttribute("class")?.includes("error"), "the stale case is visually an error");
    assert.equal(banner.querySelector('[data-testid="dash-active-kind"]'), null, "no chip for a profile that is not there");
  });

  it("findActiveProfile prefers the server id, then the active flag, then nothing", () => {
    const flagged: ProviderProfileView = { ...P1, id: "p2", active: true };
    assert.equal(findActiveProfile(state({ profiles: [P1, flagged], activeProfileId: "p2" }))?.id, "p2");
    assert.equal(findActiveProfile(state({ profiles: [P1, flagged], activeProfileId: null }))?.id, "p2", "falls back to the active flag");
    assert.equal(findActiveProfile(state({ profiles: [{ ...P1, active: false }], activeProfileId: null })), undefined);
  });
});
