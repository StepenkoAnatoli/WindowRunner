/**
 * The "currently using" banner for the provider page (B2).
 *
 * States: an active profile (label · kind · model), no active profile,
 * loading, and the post-deletion case where the server still names an active
 * profile id that is no longer in the list. The dashboard's inner ids
 * (`dash-active`, `dash-active-kind`) are preserved so the compatibility
 * page's E2E keeps its handles; the banner itself carries the shared
 * `providers-active` id.
 */
import type { ProviderProfileView } from "../api.js";
import type { ProviderUiState } from "../app-state.js";
import { el } from "../dom.js";

export function findActiveProfile(state: ProviderUiState): ProviderProfileView | undefined {
  return state.profiles.find((p) => p.id === state.activeProfileId) ?? state.profiles.find((p) => p.active === true);
}

export function renderActiveProviderBanner(state: ProviderUiState): HTMLElement {
  const active = findActiveProfile(state);
  let detail: HTMLElement;
  if (state.status === "loading" || state.status === "idle") {
    detail = el("span", { "data-testid": "dash-active" }, "loading…");
  } else if (active) {
    detail = el(
      "span",
      { "data-testid": "dash-active" },
      el("strong", {}, active.label),
      ` · ${active.kind} · ${active.model}`
    );
  } else if (state.activeProfileId) {
    // The server names an active profile the list does not contain (deleted
    // elsewhere, or a stale id): say so instead of silently showing "none".
    detail = el(
      "span",
      { "data-testid": "dash-active", class: "error" },
      `active profile “${state.activeProfileId}” is not in the list — refresh to update`
    );
  } else {
    detail = el("span", { "data-testid": "dash-active" }, "no active profile — add one below and choose “Use this”");
  }
  return el(
    "div",
    { class: "panel banner-active", "data-testid": "providers-active" },
    el("span", { class: "muted" }, "Currently using:"),
    detail,
    active ? el("span", { class: "chip", "data-testid": "dash-active-kind" }, active.kind) : null
  );
}
