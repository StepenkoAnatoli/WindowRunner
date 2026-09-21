/**
 * Recent-turn usage page (B2) — the dashboard's usage table extracted so the
 * main workspace's Usage route and the /dashboard compatibility page share
 * one component.
 *
 * Honesty rule: when the server reports `bounded: true`, the page says older
 * turns are NOT shown (rotated out of usage.jsonl / trimmed ring). An empty
 * bottom of the table must never read as "nothing ever ran", and the page
 * must never claim completeness the server did not state.
 *
 * Row-level ids (`dash-usage-row`, `dash-usage-provider`, `dash-usage-cost`)
 * are the dashboard's originals, kept so both suites share the component.
 */
import type { ProviderProfileView } from "../api.js";
import type { UsageUiState } from "../app-state.js";
import { button, el } from "../dom.js";

export interface UsagePageProps {
  state: UsageUiState;
  limit: number;
  onRefresh(): void;
  /** Resolve a provider label for display; falls back to the raw id. */
  resolveProviderLabel?(providerId: string): string;
}

export function renderUsagePage(props: UsagePageProps): HTMLElement {
  const state = props.state;
  const label = (id: string): string => {
    const resolved = props.resolveProviderLabel?.(id);
    return resolved ?? id;
  };
  const rows = state.records.map((rec) =>
    el(
      "tr",
      { "data-testid": "dash-usage-row", "data-status": rec.status, "data-provider": rec.providerId },
      el("td", {}, new Date(rec.at).toLocaleString()),
      el("td", { "data-testid": "dash-usage-provider" }, label(rec.providerId)),
      el("td", {}, rec.model),
      el("td", {}, `${rec.inputTokens ?? "–"}/${rec.outputTokens ?? "–"}`),
      el("td", { "data-testid": "dash-usage-cost" }, rec.estCostUsd !== undefined ? `$${rec.estCostUsd.toFixed(4)}` : "—"),
      el("td", { class: rec.status === "completed" ? "ok" : rec.status === "failed" ? "error" : "muted" }, rec.status === "failed" && rec.code ? `${rec.status} (${rec.code})` : rec.status)
    )
  );
  return el(
    "section",
    { class: "usage-page", "data-testid": "usage-page" },
    el(
      "div",
      { class: "page-head" },
      el("h2", {}, "Usage"),
      el("p", { class: "hint" }, `The ${props.limit} most recent turns, newest first.`),
      button("usage-refresh", "Refresh", props.onRefresh, "secondary", state.status === "loading")
    ),
    state.status === "loading" && state.records.length === 0 ? el("p", { class: "hint", "data-testid": "usage-loading" }, "Loading usage…") : null,
    state.error
      ? el(
          "div",
          { class: "banner error", role: "alert", "data-testid": "usage-error" },
          el("strong", {}, state.error.code),
          " ",
          state.error.message,
          " ",
          button("usage-retry", "Retry", props.onRefresh, "link")
        )
      : null,
    state.status === "ready" && state.records.length === 0
      ? el("p", { class: "hint", "data-testid": "usage-empty" }, "No turns recorded yet. Send a message in the workspace.")
      : el(
          "table",
          { class: "usage", "data-testid": "usage-table" },
          el("thead", {}, el("tr", {}, ...["time", "provider", "model", "tokens (in/out)", "cost", "status"].map((h) => el("th", {}, h)))),
          el("tbody", {}, ...rows)
        ),
    state.bounded
      ? el(
          "p",
          { class: "hint", "data-testid": "usage-bounded" },
          state.retained !== undefined
            ? `Showing the newest ${state.records.length} of ${state.retained} retained turns; older ones rotated out of usage.jsonl and cannot be recovered here.`
            : "Older turns have rotated out of the retained history and are not shown."
        )
      : null,
    el("p", { class: "hint" }, "Cost shows “—” unless a price table entry exists for the exact model id; numbers are never fabricated.")
  );
}
