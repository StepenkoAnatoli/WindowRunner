/**
 * The "currently using" banner and the provider cards: status dot from the
 * last test, Use this / Test / Edit / Delete, and the effects behind them.
 */
import type { ProviderLastTest, ProviderProfileView } from "./api.js";
import { button, el } from "./dom.js";
import { render, state } from "./dashboard-state.js";
import { client, refresh, reportError } from "./dashboard-api.js";
import { openEditForm } from "./dashboard-provider-form.js";

export function banner(active: ProviderProfileView | null): HTMLElement {
  return el(
    "div",
    { class: "panel banner-active", "data-testid": "dash-banner" },
    el("span", { class: "muted" }, "Currently using:"),
    active
      ? el("span", { "data-testid": "dash-active" }, el("strong", {}, active.label), " ", el("code", {}, active.model))
      : el("span", { "data-testid": "dash-active" }, state.profiles ? "no active profile" : "loading…"),
    active ? el("span", { class: "chip", "data-testid": "dash-active-kind" }, active.kind) : null
  );
}

export function providersPanel(active: ProviderProfileView | null): HTMLElement {
  const cards = (state.profiles ?? []).map((p) => providerCard(p, p.id === active?.id));
  return el(
    "section",
    { class: "panel", "data-testid": "dash-providers" },
    el("h2", {}, "Providers"),
    state.profiles === null
      ? el("p", { class: "hint" }, "Loading…")
      : state.profiles.length === 0
        ? el("p", { class: "hint" }, "No profiles yet — add one below. The profile that matches the environment is registered as “default” on first boot.")
        : el("div", { class: "cards" }, ...cards)
  );
}

function providerCard(p: ProviderProfileView, isActive: boolean): HTMLElement {
  const lt: ProviderLastTest | undefined = p.lastTest;
  const dotState = lt ? (lt.ok ? "ok" : "fail") : "none";
  const dotTitle = lt ? (lt.ok ? `last test passed in ${lt.latencyMs ?? "?"}ms` : `last test failed: ${lt.code ?? "error"}`) : "not tested yet";
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
    el("div", { class: "muted", "data-testid": "dash-card-key" }, `key: ${p.apiKeyMasked ?? "—"}`),
    lt && !lt.ok ? el("div", { class: "error small", "data-testid": "dash-card-test-error" }, `${lt.code ?? "error"}: ${lt.message ?? ""}`) : null,
    el(
      "div",
      { class: "row" },
      button(`dash-activate`, state.activatingId === p.id ? "Switching…" : "Use this", () => void activate(p.id), "primary", isActive || state.activatingId === p.id),
      button("dash-test", state.testingId === p.id ? "Testing…" : "Test", () => void test(p.id), "secondary", state.testingId === p.id),
      button("dash-edit", "Edit", () => openEditForm(p), "secondary"),
      button("dash-delete", "Delete", () => void remove(p.id), "danger")
    )
  );
}

async function activate(id: string): Promise<void> {
  if (!client) return;
  state.activatingId = id;
  render();
  try {
    await client.activateProfile(id);
    await refresh();
  } catch (err) {
    reportError(err);
  }
  state.activatingId = undefined;
  render();
}

async function test(id: string): Promise<void> {
  if (!client) return;
  state.testingId = id;
  render();
  try {
    const result = await client.testProfile(id);
    if (result.ok) state.notice = `test passed: ${id} answered in ${result.latencyMs}ms`;
    else state.notice = `test failed: ${id} — ${result.code ?? "error"}: ${result.message ?? ""}`;
    await refresh();
  } catch (err) {
    reportError(err);
  }
  state.testingId = undefined;
  render();
}

async function remove(id: string): Promise<void> {
  if (!client) return;
  const profile = state.profiles?.find((p) => p.id === id);
  if (!window.confirm(`Delete profile "${profile?.label ?? id}" (${id})?`)) return;
  try {
    await client.deleteProfile(id);
    await refresh();
  } catch (err) {
    reportError(err);
  }
}
