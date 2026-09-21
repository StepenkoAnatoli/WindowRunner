import {
  describeTurn,
  pendingApprovals,
  previewApproval,
  type AppState,
  type TurnView,
} from "./app-state.js";
import { INSPECTOR_APPROVAL_IDS, renderApprovalCard, renderApprovalPreview } from "./approval-view.js";
import { button, el } from "./dom.js";
import { renderToolTimeline } from "./tool-timeline.js";
import type { InspectorSelection, InspectorTab } from "./workspace-catalog.js";

/**
 * Right context panel (B1).
 *
 * Tabs:
 * - approvals: pending approvals for the selected/current turn, rendered
 *   with the same safe previews and Approve/Deny actions as the center;
 * - activity: tool timeline + turn status (no terminal emulator);
 * - context: session id, project root, trust status, selected turn status
 *   (no file-tree browser);
 * - changes: pending `edit_file`/`write_file` approval previews only — B1
 *   has no completed-file-change event or diff endpoint, so the empty state
 *   says exactly that instead of implying history exists.
 *
 * Pure render: receives state + callbacks, never constructs ApiClient, calls
 * fetch, or mutates global state.
 */
export interface InspectorProps {
  tab: InspectorTab;
  selection: InspectorSelection;
  session?: AppState["session"];
  turn?: TurnView;
  turns: TurnView[];
  onSelectTab(tab: InspectorTab): void;
  onSelectTool(turnId: string, callId: string): void;
  onDecide(requestId: string, decision: "approve" | "deny"): void;
  onRevokeTrust(): void;
}

export const INSPECTOR_TABS: InspectorTab[] = ["approvals", "activity", "context", "changes"];

const TAB_LABELS: Record<InspectorTab, string> = {
  approvals: "Approvals",
  activity: "Activity",
  context: "Context",
  changes: "Changes",
};

export const CHANGES_EMPTY_TEXT = "No pending file change preview. Completed file-change history is not available in this release.";

export function renderInspector(props: InspectorProps): HTMLElement {
  const tabs = el(
    "div",
    { class: "inspector-tabs", role: "tablist" },
    ...INSPECTOR_TABS.map((tab) => {
      const pending = tab === "approvals" ? pendingApprovals(props.turn).length : 0;
      const label = pending > 0 ? `${TAB_LABELS[tab]} (${pending})` : TAB_LABELS[tab];
      const btn = el(
        "button",
        {
          type: "button",
          role: "tab",
          class: `inspector-tab${props.tab === tab ? " selected" : ""}`,
          "data-testid": `inspector-tab-${tab}`,
          ...(props.tab === tab ? { "aria-selected": "true" } : { "aria-selected": "false" }),
        },
        label
      );
      btn.addEventListener("click", () => props.onSelectTab(tab));
      return btn;
    })
  );
  return el(
    "aside",
    { class: "context-inspector", "data-testid": "context-inspector" },
    tabs,
    el("div", { class: "inspector-body" }, renderTabBody(props))
  );
}

function renderTabBody(props: InspectorProps): HTMLElement {
  switch (props.tab) {
    case "approvals":
      return renderApprovalsTab(props);
    case "activity":
      return renderActivityTab(props);
    case "context":
      return renderContextTab(props);
    case "changes":
      return renderChangesTab(props);
  }
}

function renderApprovalsTab(props: InspectorProps): HTMLElement {
  const approvals = pendingApprovals(props.turn);
  if (!props.turn) {
    return el("p", { class: "hint", "data-testid": "inspector-empty" }, "Select a turn to review its approvals.");
  }
  if (approvals.length === 0) {
    return el("p", { class: "hint", "data-testid": "inspector-empty" }, "No pending approvals for this turn.");
  }
  return el(
    "div",
    { class: "inspector-approvals" },
    ...approvals.map((req) =>
      renderApprovalCard(req.toolName, req.reason, req.requestId, previewApproval(req.toolName, req.input), props.onDecide, INSPECTOR_APPROVAL_IDS)
    )
  );
}

function renderActivityTab(props: InspectorProps): HTMLElement {
  const turn = props.turn;
  const selectedCallId = props.selection.kind === "tool" && props.selection.turnId === turn?.turnId ? props.selection.callId : undefined;
  return el(
    "div",
    { class: "inspector-activity" },
    turn
      ? el("p", { class: "muted", "data-testid": "inspector-turn-status" }, describeTurn(turn), " ", el("span", { class: "muted" }, `seq ${turn.state.seq}`))
      : null,
    renderToolTimeline({
      turn,
      selectedCallId,
      onSelectTool: (callId) => {
        if (turn) props.onSelectTool(turn.turnId, callId);
      },
    })
  );
}

function renderContextTab(props: InspectorProps): HTMLElement {
  const session = props.session;
  const trust = session?.trust;
  return el(
    "div",
    { class: "inspector-context" },
    session
      ? el("dl", { class: "context-list" },
          el("dt", {}, "Session"),
          el("dd", {}, el("code", { "data-testid": "inspector-session-id" }, session.sessionId)),
          el("dt", {}, "Project root"),
          el("dd", {}, el("code", { "data-testid": "inspector-session-root" }, session.root)))
      : el("p", { class: "hint", "data-testid": "inspector-empty" }, "No session attached."),
    el("div", { "data-testid": "trust-status" },
      trust === undefined
        ? el("span", { class: "muted" }, "trust: …")
        : trust === null
          ? el("span", { class: "muted" }, "trust: project not trusted to run project-supplied configuration")
          : el(
              "span",
              {},
              el("span", { class: "ok" }, "trusted "),
              el("code", {}, trust.source ?? "configuration"),
              " ",
              el("code", { class: "muted" }, trust.configHash.slice(0, 19) + "…"),
              " ",
              button("revoke-trust", "Revoke", props.onRevokeTrust, "link")
            )),
    props.turn
      ? el("p", { class: "muted", "data-testid": "inspector-selected-turn" }, `turn ${props.turn.turnId}: ${describeTurn(props.turn)}`)
      : null
  );
}

function renderChangesTab(props: InspectorProps): HTMLElement {
  const changes = pendingApprovals(props.turn).filter((req) => req.toolName === "edit_file" || req.toolName === "write_file");
  if (changes.length === 0) {
    return el("p", { class: "hint", "data-testid": "inspector-empty" }, CHANGES_EMPTY_TEXT);
  }
  return el(
    "div",
    { class: "inspector-changes" },
    ...changes.map((req) =>
      el(
        "div",
        { class: "card", "data-testid": "inspector-change-preview", "data-request-id": req.requestId },
        el("strong", {}, el("code", {}, req.toolName), " — pending approval"),
        renderApprovalPreview(previewApproval(req.toolName, req.input), "inspector-change-preview-body")
      )
    )
  );
}
