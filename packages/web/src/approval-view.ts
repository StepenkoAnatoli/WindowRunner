import { button, el } from "./dom.js";
import type { ApprovalPreview } from "./app-state.js";

/**
 * Shared approval rendering (B1).
 *
 * Pending approvals appear twice — once in the center conversation card and
 * once in the right inspector — but they are one state source with two views.
 * Both render through this module so the preview is byte-for-byte identical
 * in either place. The only difference is the `data-testid` namespace:
 * center cards keep the historical ids (`approval`, `approve`, `deny`,
 * `approval-preview`) while inspector cards use `inspector-*` ids so E2E
 * selectors never match two buttons at once.
 */
export function renderApprovalPreview(p: ApprovalPreview, testId = "approval-preview"): HTMLElement {
  switch (p.kind) {
    case "diff":
      return el(
        "div",
        { class: "preview", "data-testid": testId, "data-kind": "diff" },
        el("div", { class: "muted" }, el("code", {}, p.path), p.note ? ` — ${p.note}` : ""),
        el("pre", { class: "diff" }, ...p.lines.map((l) => el("span", { class: l.type === "-" ? "del" : l.type === "+" ? "add" : "ctx" }, `${l.type} ${l.text}\n`)))
      );
    case "command":
      return el(
        "div",
        { class: "preview", "data-testid": testId, "data-kind": "command" },
        el("pre", { class: "input" }, "$ " + p.command),
        p.note ? el("div", { class: "muted" }, p.note) : null
      );
    default:
      return el("pre", { class: "input", "data-testid": testId, "data-kind": "json" }, p.text);
  }
}

export interface ApprovalCardIds {
  card: string;
  approve: string;
  deny: string;
  preview: string;
}

export const CENTER_APPROVAL_IDS: ApprovalCardIds = {
  card: "approval",
  approve: "approve",
  deny: "deny",
  preview: "approval-preview",
};

export const INSPECTOR_APPROVAL_IDS: ApprovalCardIds = {
  card: "inspector-approval",
  approve: "inspector-approve",
  deny: "inspector-deny",
  preview: "inspector-approval-preview",
};

export function renderApprovalCard(
  toolName: string,
  reason: string,
  requestId: string,
  preview: ApprovalPreview,
  onDecide: (requestId: string, decision: "approve" | "deny") => void,
  ids: ApprovalCardIds
): HTMLElement {
  return el(
    "div",
    { class: "card approval", role: "alertdialog", "data-testid": ids.card, "data-request-id": requestId },
    el("strong", {}, "Approval required: ", el("code", {}, toolName)),
    el("p", {}, reason),
    renderApprovalPreview(preview, ids.preview),
    el(
      "div",
      { class: "row" },
      button(ids.approve, "Approve", () => onDecide(requestId, "approve"), "primary"),
      button(ids.deny, "Deny", () => onDecide(requestId, "deny"), "danger")
    )
  );
}
