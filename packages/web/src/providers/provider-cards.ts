/**
 * Provider cards (B2) — adapted from the dashboard's provider list.
 *
 * The existing dashboard E2E selectors are deliberately preserved on the
 * cards (`dash-card`, `dash-card-label`, `dash-card-model`, `dash-card-key`,
 * `dash-card-status`, `dash-activate`, `dash-test`, `dash-edit`,
 * `dash-delete`) so `/dashboard` compatibility tests keep their handles; the
 * shared list container carries the new `providers-list` id. A card shows the
 * masked key only — a raw key never reaches this module because the server
 * never sends one (`apiKeyMasked` is display-only).
 */
import type { ProviderLastTest, ProviderProfileView } from "../api.js";
import { button, el } from "../dom.js";

export interface ProviderCardsProps {
  profiles: ProviderProfileView[];
  activeProfileId: string | null;
  testingProfileId?: string;
  deletingProfileId?: string;
  activatingProfileId?: string;
  onEdit(profile: ProviderProfileView): void;
  onTest(profile: ProviderProfileView): void;
  onActivate(profile: ProviderProfileView): void;
  onDelete(profile: ProviderProfileView): void;
}

export function renderProviderCards(props: ProviderCardsProps): HTMLElement {
  const cards = props.profiles.map((p) => providerCard(p, p.id === props.activeProfileId || p.active === true, props));
  return el("div", { class: "cards", "data-testid": "providers-list" }, ...cards);
}

/** Accessible name is the action plus the profile label — never a key, masked or raw. */
function namedAction(node: HTMLElement, name: string): HTMLElement {
  node.setAttribute("aria-label", name);
  return node;
}

function providerCard(p: ProviderProfileView, isActive: boolean, props: ProviderCardsProps): HTMLElement {
  const lt: ProviderLastTest | undefined = p.lastTest;
  const dotState = lt ? (lt.ok ? "ok" : "fail") : "none";
  const dotTitle = lt ? (lt.ok ? `last test passed in ${lt.latencyMs ?? "?"}ms` : `last test failed: ${lt.code ?? "error"}`) : "not tested yet";
  const testing = props.testingProfileId === p.id;
  const deleting = props.deletingProfileId === p.id;
  const activating = props.activatingProfileId === p.id;
  return el(
    "div",
    {
      class: `card provider${isActive ? " active" : ""}`,
      "data-testid": "dash-card",
      "data-id": p.id,
      "data-active": isActive ? "true" : "false",
    },
    el(
      "div",
      { class: "p-head" },
      el("span", { class: `dot ${dotState}`, "data-testid": "dash-card-status", "data-ok": lt ? String(lt.ok) : "", title: dotTitle }),
      el("span", { "data-testid": "dash-card-label" }, p.label),
      isActive ? el("span", { class: "chip" }, "active") : null
    ),
    el("div", { class: "muted", "data-testid": "dash-card-model" }, `${p.kind} · ${p.model}`),
    p.baseUrl ? el("div", { class: "muted base" }, el("code", {}, p.baseUrl)) : null,
    // Masked only: `apiKeyMasked` is display-only and is never editable here.
    el("div", { class: "muted", "data-testid": "dash-card-key" }, `key: ${p.apiKeyMasked ?? "—"}`),
    lt && !lt.ok ? el("div", { class: "error small", "data-testid": "dash-card-test-error" }, `${lt.code ?? "error"}: ${lt.message ?? ""}`) : null,
    el(
      "div",
      { class: "row" },
      namedAction(button("dash-activate", activating ? "Switching…" : "Use this", () => props.onActivate(p), "primary", isActive || activating), `Use this provider: ${p.label}`),
      namedAction(button("dash-test", testing ? "Testing…" : "Test", () => props.onTest(p), "secondary", testing), `Test provider: ${p.label}`),
      namedAction(button("dash-edit", "Edit", () => props.onEdit(p), "secondary"), `Edit provider: ${p.label}`),
      namedAction(button("dash-delete", deleting ? "Deleting…" : "Delete", () => props.onDelete(p), "danger", deleting), `Delete provider: ${p.label}`)
    )
  );
}
