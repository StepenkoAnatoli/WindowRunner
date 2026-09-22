import {
  describeTurn,
  pendingApprovals,
  previewApproval,
  type AppState,
  type TrustPrompt,
  type TurnView,
} from "./app-state.js";
import { CENTER_APPROVAL_IDS, renderApprovalCard } from "./approval-view.js";
import { button, el } from "./dom.js";

/**
 * Center conversation workspace (B1).
 *
 * Replaces the old `conversationPanel()` composition while preserving its
 * behavior: the same turn cards, composer, Stop, trust prompt, and approval
 * cards with the same `data-testid`s. Turn cards are additionally selectable
 * (drives the inspector), but selection clicks never interfere with Approve,
 * Deny, Send, Stop, or form controls.
 *
 * Pure render: receives state + callbacks, never constructs ApiClient, calls
 * fetch, or mutates global state.
 */
export interface ConversationWorkspaceProps {
  session?: AppState["session"];
  turns: TurnView[];
  activeTurn?: TurnView;
  busy: boolean;
  trustPrompt?: TrustPrompt;
  selectedTurnId?: string;
  onSubmit(message: string): void;
  onCancel(): void;
  onDecide(requestId: string, decision: "approve" | "deny"): void;
  onGrantTrust(): void;
  onDismissTrust(): void;
  onSelectTurn(turnId: string): void;
  onSelectApproval(turnId: string, requestId: string): void;
}

export function renderConversationWorkspace(props: ConversationWorkspaceProps): HTMLElement {
  if (!props.session) {
    return el(
      "main",
      { class: "conversation-workspace", "data-testid": "conversation-workspace" },
      el("p", { class: "hint", "data-testid": "no-session" }, "Create or open a session to start.")
    );
  }
  const form = el(
    "form",
    { class: "composer", "data-testid": "turn-form" },
    el(
      "label",
      { class: "hint" },
      "Message",
      el("textarea", {
        "data-testid": "message-input",
        rows: "3",
        placeholder: "Ask the agent…",
        required: "true",
        ...(props.activeTurn ? { disabled: "true" } : {}),
      })
    ),
    el(
      "div",
      { class: "row" },
      button("send", props.busy ? "Sending…" : "Send", undefined, "primary", Boolean(props.activeTurn) || props.busy),
      props.activeTurn ? button("cancel", "Stop", props.onCancel, "danger") : null
    )
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const ta = form.querySelector<HTMLTextAreaElement>('[data-testid="message-input"]')!;
    const message = ta.value.trim();
    if (message) {
      ta.value = "";
      props.onSubmit(message);
    }
  });
  return el(
    "main",
    { class: "conversation-workspace", "data-testid": "conversation-workspace" },
    el(
      "section",
      { class: "conversation", "data-testid": "conversation" },
      props.trustPrompt ? renderTrustPrompt(props.trustPrompt, props) : null,
      el("div", { class: "turns", "data-testid": "turns" }, ...props.turns.map((t) => renderTurnCard(t, props))),
      form
    )
  );
}

function renderTrustPrompt(p: TrustPrompt, props: ConversationWorkspaceProps): HTMLElement {
  return el(
    "div",
    { class: "card warn", role: "alert", "data-testid": "trust-prompt" },
    el("strong", {}, p.staleConfigHash ? "Project configuration changed" : "Project not trusted"),
    el("p", {}, `The tool `, el("code", {}, p.toolName), ` wants to run configuration from `, el("code", {}, p.source), ` in `, el("code", {}, p.realRoot), `.`),
    p.staleConfigHash
      ? el("p", { class: "muted" }, `Previously trusted ${p.staleConfigHash.slice(0, 19)}…; now ${p.configHash.slice(0, 19)}…`)
      : el("p", { class: "muted" }, `configHash ${p.configHash}`),
    el("p", { class: "hint" }, "Trusting lets this project's configuration execute on your machine for future turns until revoked. Approving a single call never grants this."),
    el(
      "div",
      { class: "row" },
      button("grant-trust", "Trust this project", props.onGrantTrust, "primary"),
      button("dismiss-trust", "Not now", props.onDismissTrust, "secondary")
    )
  );
}

function renderTurnCard(view: TurnView, props: ConversationWorkspaceProps): HTMLElement {
  const status = describeTurn(view);
  const approvals = pendingApprovals(view);
  const selected = props.selectedTurnId === view.turnId;
  const card = el(
    "article",
    {
      class: `card turn status-${view.state.status}${selected ? " selected" : ""}`,
      "data-testid": "turn",
      "data-turn-id": view.turnId,
      "data-status": view.state.status,
      ...(selected ? { "data-selected": "true" } : {}),
    },
    el("div", { class: "user" }, el("span", { class: "muted" }, "you "), el("span", { "data-testid": "turn-message" }, view.message)),
    el(
      "div",
      { class: "assistant" },
      el("span", { class: "muted" }, "agent "),
      el("span", { "data-testid": "turn-text" }, view.state.textAccumulated),
      view.state.isTerminal ? null : el("span", { class: "cursor" }, "▍")
    ),
    view.tools.length > 0
      ? el(
          "ul",
          { class: "tools", "data-testid": "tools" },
          ...view.tools.map((t) =>
            el(
              "li",
              { "data-testid": "tool", "data-status": t.status },
              el("code", {}, t.toolName),
              " ",
              t.status,
              t.result && !t.result.ok ? el("span", { class: "error" }, ` — ${t.result.code}: ${t.result.message}`) : null
            )
          )
        )
      : null,
    ...approvals.map((req) => {
      const node = renderApprovalCard(req.toolName, req.reason, req.requestId, previewApproval(req.toolName, req.input), props.onDecide, CENTER_APPROVAL_IDS);
      // Clicking the card body (not the buttons) focuses it in the inspector.
      node.addEventListener("click", () => props.onSelectApproval(view.turnId, req.requestId));
      return node;
    }),
    el(
      "footer",
      { class: `status ${view.streamError || view.state.status === "failed" ? "error" : ""}`, "data-testid": "turn-status" },
      status,
      " ",
      el("span", { class: "muted" }, `seq ${view.state.seq}`)
    )
  );
  // Card selection must never swallow control clicks: any click that starts
  // inside a button, input, textarea, select, link, or approval card keeps
  // its own behavior (the approval card wires itself above).
  card.addEventListener("click", (e) => {
    const target = e.target as HTMLElement | null;
    if (target && typeof target.closest === "function") {
      if (target.closest('button, input, textarea, select, a, [data-testid="approval"]')) return;
    }
    props.onSelectTurn(view.turnId);
  });
  return card;
}
