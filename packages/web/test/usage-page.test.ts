/**
 * Usage page contract (B2.3): loading, empty, records table, bounded-history
 * honesty, error/retry, refresh, and the cost-never-fabricated footnote.
 *
 * Honesty rule under test: when the server reports `bounded: true`, the page
 * MUST say older turns are not shown — including when the visible table is
 * empty, so an empty bottom never reads as "nothing ever ran". Row-level ids
 * (`dash-usage-row`, `dash-usage-provider`, `dash-usage-cost`) are the
 * dashboard's originals shared by both hosts.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { renderUsagePage, type UsagePageProps } from "../src/usage/usage-page.js";
import type { TurnUsageView } from "../src/api.js";
import type { UsageUiState } from "../src/app-state.js";
import { installDomStub, uninstallDomStub, type FakeElement, type StubDocument } from "./dom-stub.js";

const REC: TurnUsageView = {
  at: 1700000000000,
  turnId: "t1",
  providerId: "p1",
  model: "model-x",
  status: "completed",
  inputTokens: 120,
  outputTokens: 34,
  estCostUsd: 0.0012,
};

const REC_NO_COST: TurnUsageView = {
  at: 1700000100000,
  turnId: "t2",
  providerId: "p2",
  model: "unknown-model",
  status: "failed",
  code: "MODEL_TIMEOUT",
};

function ready(records: TurnUsageView[], extra: Partial<UsageUiState> = {}): UsageUiState {
  return { status: "ready", records, ...extra };
}

describe("usage page", () => {
  let doc: StubDocument;

  beforeEach(() => {
    doc = installDomStub();
  });
  afterEach(() => {
    uninstallDomStub();
  });

  function mount(state: UsageUiState, opts: { resolve?: (id: string) => string } = {}): { page: FakeElement; calls: string[] } {
    const calls: string[] = [];
    const props: UsagePageProps = {
      state,
      limit: 50,
      onRefresh: () => void calls.push("refresh"),
      ...(opts.resolve ? { resolveProviderLabel: opts.resolve } : {}),
    };
    const page = renderUsagePage(props) as unknown as FakeElement;
    doc.body.append(page);
    return { page, calls };
  }

  it("loading shows the loading hint and disables Refresh", () => {
    const { page } = mount({ status: "loading", records: [] });
    assert.ok(page.querySelector('[data-testid="usage-loading"]'));
    assert.equal(page.querySelector('[data-testid="usage-refresh"]')?.getAttribute("disabled"), "true");
  });

  it("an empty table never claims nothing ever ran when history is bounded", () => {
    const { page } = mount(ready([], { bounded: true, retained: 200 }));
    assert.ok(page.querySelector('[data-testid="usage-empty"]'), "empty is stated plainly");
    assert.ok(
      page.querySelector('[data-testid="usage-bounded"]'),
      "and the bounded-history warning must accompany it — the empty bottom cannot read as 'nothing ever ran'"
    );
    assert.match(page.querySelector('[data-testid="usage-bounded"]')?.textContent ?? "", /rotated out/);
  });

  it("renders records with provider, model, timestamp, tokens, cost and status", () => {
    const { page } = mount(ready([REC, REC_NO_COST]), {
      resolve: (id) => (id === "p1" ? "Alpha Provider" : id),
    });
    const rows = page.querySelectorAll('[data-testid="dash-usage-row"]');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].getAttribute("data-status"), "completed");
    assert.equal(rows[0].getAttribute("data-provider"), "p1");

    // Timestamp (same formatting the page uses), resolved provider label, model.
    assert.match(rows[0].textContent ?? "", new RegExp(new Date(REC.at).toLocaleString().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(rows[0].querySelector('[data-testid="dash-usage-provider"]')?.textContent, "Alpha Provider");
    assert.match(rows[0].textContent ?? "", /model-x/);

    // Tokens (in/out) and estimated cost — formatted, never fabricated.
    assert.match(rows[0].textContent ?? "", /120\/34/);
    assert.equal(rows[0].querySelector('[data-testid="dash-usage-cost"]')?.textContent, "$0.0012");

    // Unpriced model: cost is an em-dash, not a number; failed status carries its code.
    assert.equal(rows[1].querySelector('[data-testid="dash-usage-cost"]')?.textContent, "—");
    assert.match(rows[1].textContent ?? "", /–\/–/, "missing token counts render as dashes");
    assert.match(rows[1].textContent ?? "", /failed \(MODEL_TIMEOUT\)/);
  });

  it("falls back to the raw provider id when no label resolves", () => {
    const { page } = mount(ready([REC]));
    assert.equal(page.querySelector('[data-testid="dash-usage-provider"]')?.textContent, "p1");
  });

  it("bounded history states what is missing, in both retained-aware and plain forms", () => {
    const withRetained = mount(ready([REC], { bounded: true, retained: 200 }));
    const text = withRetained.page.querySelector('[data-testid="usage-bounded"]')?.textContent ?? "";
    assert.match(text, /newest 1 of 200 retained turns/);
    assert.match(text, /older ones rotated out of usage\.jsonl and cannot be recovered here/);

    const plain = mount(ready([REC], { bounded: true }));
    assert.match(plain.page.querySelector('[data-testid="usage-bounded"]')?.textContent ?? "", /Older turns have rotated out of the retained history and are not shown/);

    const unbounded = mount(ready([REC], { bounded: false }));
    assert.equal(unbounded.page.querySelector('[data-testid="usage-bounded"]'), null, "no warning when the server did not bound the history");
  });

  it("errors are actionable and Refresh is wired; the limit is stated", () => {
    const { page, calls } = mount({ status: "error", records: [], error: { code: "USAGE_DOWN", message: "usage unavailable" } });
    const error = page.querySelector('[data-testid="usage-error"]');
    assert.match(error?.textContent ?? "", /USAGE_DOWN/);
    assert.match(error?.textContent ?? "", /usage unavailable/);
    (error?.querySelector('[data-testid="usage-retry"]') as FakeElement).click();
    (page.querySelector('[data-testid="usage-refresh"]') as FakeElement).click();
    assert.deepEqual(calls, ["refresh", "refresh"]);
    assert.match(page.textContent ?? "", /The 50 most recent turns, newest first\./);
  });

  it("the cost footnote promises no fabricated numbers — on every state", () => {
    for (const state of [ready([REC]), ready([]), { status: "loading", records: [] } as UsageUiState]) {
      const { page } = mount(state);
      assert.match(page.textContent ?? "", /numbers are never fabricated/);
    }
    // Table headers name the contract columns.
    const { page } = mount(ready([REC]));
    const headers = page.querySelectorAll("th").map((h) => h.textContent);
    assert.deepEqual(headers, ["time", "provider", "model", "tokens (in/out)", "cost", "status"]);
  });
});
