/**
 * The "recent turns" table fed by GET /api/usage, and the line that says what
 * the table is not: a capped ring over a bounded tail of usage.jsonl, so an
 * empty bottom of the list means "older turns are not retained", not "nothing
 * ever ran".
 */
import { el } from "./dom.js";
import { state } from "./dashboard-state.js";

export function usagePanel(): HTMLElement {
  const rows = (state.usage ?? []).map((rec) => {
    const profile = state.profiles?.find((p) => p.id === rec.providerId);
    return el(
      "tr",
      { "data-testid": "dash-usage-row", "data-status": rec.status, "data-provider": rec.providerId },
      el("td", {}, new Date(rec.at).toLocaleString()),
      el("td", { "data-testid": "dash-usage-provider" }, profile?.label ?? rec.providerId),
      el("td", {}, rec.model),
      el("td", {}, `${rec.inputTokens ?? "–"}/${rec.outputTokens ?? "–"}`),
      el("td", { "data-testid": "dash-usage-cost" }, rec.estCostUsd !== undefined ? `$${rec.estCostUsd.toFixed(4)}` : "—"),
      el("td", { class: rec.status === "completed" ? "ok" : rec.status === "failed" ? "error" : "muted" }, rec.status === "failed" && rec.code ? `${rec.status} (${rec.code})` : rec.status)
    );
  });
  return el(
    "section",
    { class: "panel", "data-testid": "dash-usage" },
    el("h2", {}, "Recent turns"),
    state.usage === null
      ? el("p", { class: "hint" }, "Loading…")
      : state.usage.length === 0
        ? el("p", { class: "hint" }, "No turns recorded yet. Send a message in the quick chat below.")
        : el(
            "table",
            { class: "usage" },
            el("thead", {}, el("tr", {}, ...["time", "provider", "model", "tokens (in/out)", "cost", "status"].map((h) => el("th", {}, h)))),
            el("tbody", {}, ...rows)
          ),
    // The history is a capped ring over a bounded tail of a rotating
    // usage.jsonl, so state what is missing rather than implying this is all
    // of it: an empty bottom of the table must not read as "nothing ran".
    state.usageMeta?.bounded
      ? el(
          "p",
          { class: "hint", "data-testid": "dash-usage-bounded" },
          state.usageMeta.retained !== undefined
            ? `Showing the newest ${state.usage?.length ?? 0} of ${state.usageMeta.retained} retained turns; older ones rotated out of usage.jsonl and cannot be recovered here.`
            : "Older turns have rotated out of the retained history and are not shown."
        )
      : null,
    el("p", { class: "hint" }, "Cost shows “—” unless a price table entry exists for the exact model id; numbers are never fabricated.")
  );
}
