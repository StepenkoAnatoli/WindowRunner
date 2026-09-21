import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installDomStub, uninstallDomStub } from "./dom-stub.js";
import {
  initialAppState,
  previewApproval,
  reduceApp,
  type AppState,
  type TurnView,
} from "../src/app-state.js";
import { CENTER_APPROVAL_IDS, INSPECTOR_APPROVAL_IDS, renderApprovalPreview } from "../src/approval-view.js";
import { CHANGES_EMPTY_TEXT, renderInspector, type InspectorProps } from "../src/inspector.js";
import type { InspectorTab } from "../src/workspace-catalog.js";

function ev(seq: number, type: string, extra: Record<string, unknown> = {}): any {
  return { seq, at: seq * 10, sessionId: "s", turnId: "t1", type, ...extra };
}

function approvalRequest(toolName: string, input: unknown, requestId = "apr_1") {
  return {
    requestId,
    providerCallId: "c1",
    turnId: "t1",
    sessionId: "s",
    toolName,
    input,
    reason: `run ${toolName}`,
    expiresAt: 9999,
    createdAt: 10,
  };
}

function stateWithTurn(build: (s: AppState) => AppState): AppState {
  let s = reduceApp(initialAppState, { type: "auth_ok", securityMode: "token", persistenceMode: "memory" });
  s = reduceApp(s, { type: "session_created", sessionId: "s", root: "/p" });
  s = reduceApp(s, { type: "turn_submitted", turnId: "t1", message: "do it" });
  s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(1, "turn_started", { limits: {}, message: "do it", root: "/p" }) });
  return build(s);
}

function turnWaitingApproval(toolName: string, input: unknown): TurnView {
  const s = stateWithTurn((s0) => {
    let s = reduceApp(s0, { type: "turn_event", turnId: "t1", event: ev(2, "tool_call", { callId: "c1", toolName, input }) });
    return reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(3, "turn_waiting_for_approval", { request: approvalRequest(toolName, input) }) });
  });
  return s.turns[0];
}

function props(overrides: Partial<InspectorProps> = {}): InspectorProps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    tab: "approvals",
    selection: { kind: "none" },
    turns: [],
    onSelectTab: (tab: InspectorTab) => void calls.push(`tab:${tab}`),
    onSelectTool: (turnId: string, callId: string) => void calls.push(`tool:${turnId}:${callId}`),
    onDecide: (requestId: string, decision: string) => void calls.push(`decide:${requestId}:${decision}`),
    onRevokeTrust: () => void calls.push("revoke"),
    ...overrides,
  };
}

describe("inspector", () => {
  beforeEach(() => {
    installDomStub();
  });
  afterEach(() => {
    uninstallDomStub();
  });

  function q(root: HTMLElement, sel: string): HTMLElement {
    const found = root.querySelector(sel);
    assert.ok(found, `missing ${sel}`);
    return found as HTMLElement;
  }

  it("renders the four tabs and switches on click", () => {
    const p = props({ tab: "context" });
    const inspector = renderInspector(p);
    for (const tab of ["approvals", "activity", "context", "changes"]) {
      assert.ok(inspector.querySelector(`[data-testid="inspector-tab-${tab}"]`), tab);
    }
    q(inspector, '[data-testid="inspector-tab-activity"]').click();
    assert.deepEqual(p.calls, ["tab:activity"]);
  });

  it("shows pending approvals with the same preview the center card uses", () => {
    const input = { path: "src/a.ts", oldText: "a\nb", newText: "c" };
    const turn = turnWaitingApproval("edit_file", input);
    const p = props({ tab: "approvals", turn, turns: [turn] });
    const inspector = renderInspector(p);
    const card = inspector.querySelector('[data-testid="inspector-approval"]')! as HTMLElement;
    assert.equal(card.getAttribute("data-request-id"), "apr_1");
    assert.match(card.textContent, /edit_file/);

    // Byte-for-byte the same previewApproval() output as the center card:
    // identical text and identical diff structure, only the test-id differs.
    const preview = previewApproval("edit_file", input);
    const center = renderApprovalPreview(preview, CENTER_APPROVAL_IDS.preview);
    const side = renderApprovalPreview(preview, INSPECTOR_APPROVAL_IDS.preview);
    assert.equal(side.textContent, center.textContent);
    assert.equal(side.querySelectorAll(".del").length, center.querySelectorAll(".del").length);
    assert.equal(side.querySelectorAll(".add").length, center.querySelectorAll(".add").length);
    assert.ok(side.querySelectorAll(".del").length > 0, "the compared preview must actually be a diff");

    const shown = inspector.querySelector('[data-testid="inspector-approval-preview"]')!;
    assert.equal(shown.textContent, center.textContent);

    q(card, '[data-testid="inspector-approve"]').click();
    assert.deepEqual(p.calls, ["decide:apr_1:approve"]);
  });

  it("badges the approvals tab with the pending count and empties cleanly", () => {
    const turn = turnWaitingApproval("run_terminal", { command: "ls" });
    const withPending = renderInspector(props({ tab: "context", turn, turns: [turn] }));
    assert.match(withPending.querySelector('[data-testid="inspector-tab-approvals"]')!.textContent, /Approvals \(1\)/);

    const quiet = stateWithTurn((s) => s).turns[0];
    const empty = renderInspector(props({ tab: "approvals", turn: quiet, turns: [quiet] }));
    assert.match(empty.querySelector('[data-testid="inspector-empty"]')!.textContent, /No pending approvals/);

    const noTurn = renderInspector(props({ tab: "approvals" }));
    assert.match(noTurn.querySelector('[data-testid="inspector-empty"]')!.textContent, /Select a turn/);
  });

  it("activity tab shows the tool timeline with status and failure detail", () => {
    const s = stateWithTurn((s0) => {
      let s = reduceApp(s0, { type: "turn_event", turnId: "t1", event: ev(2, "tool_call", { callId: "c1", toolName: "read_file", input: { path: "x" } }) });
      s = reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(3, "tool_started", { callId: "c1", toolName: "read_file" }) });
      return reduceApp(s, { type: "turn_event", turnId: "t1", event: ev(4, "tool_completed", { callId: "c1", toolName: "read_file", result: { ok: false, code: "PATH_NOT_FOUND", message: "nope", retryable: true } }) });
    });
    const turn = s.turns[0];
    const p = props({ tab: "activity", turn, turns: [turn] });
    const inspector = renderInspector(p);
    const item = inspector.querySelector('[data-testid="tool-activity-item"]')!;
    assert.match(item.textContent, /read_file/);
    assert.match(item.querySelector('[data-testid="tool-activity-status"]')!.textContent, /failed/);
    assert.match(item.textContent, /PATH_NOT_FOUND/);
    assert.ok(inspector.querySelector('[data-testid="inspector-turn-status"]'));
    q(inspector, '[data-testid="tool-activity-select-c1"]').click();
    assert.deepEqual(p.calls, ["tool:t1:c1"]);
  });

  it("context tab shows session, trust, and selected turn status", () => {
    const session = { sessionId: "s", root: "/p", trust: null as null };
    const untrusted = renderInspector(props({ tab: "context", session }));
    assert.equal(untrusted.querySelector('[data-testid="inspector-session-id"]')!.textContent, "s");
    assert.match(untrusted.querySelector('[data-testid="trust-status"]')!.textContent, /not trusted/);

    const trusted = renderInspector(
      props({ tab: "context", session: { sessionId: "s", root: "/p", trust: { configHash: "sha256:abc", source: ".mcp.json" } } })
    );
    assert.match(trusted.querySelector('[data-testid="trust-status"]')!.textContent, /trusted/);
    const p = props({ tab: "context", session: { sessionId: "s", root: "/p", trust: { configHash: "sha256:abc" } } });
    q(renderInspector(p), '[data-testid="revoke-trust"]').click();
    assert.deepEqual(p.calls, ["revoke"]);

    const loading = renderInspector(props({ tab: "context", session: { sessionId: "s", root: "/p", trust: undefined } }));
    assert.match(loading.querySelector('[data-testid="trust-status"]')!.textContent, /trust: …/);
  });

  it("changes tab lists only pending write/edit approvals and never claims completed diffs", () => {
    const edit = turnWaitingApproval("edit_file", { path: "a", oldText: "x", newText: "y" });
    const changes = renderInspector(props({ tab: "changes", turn: edit, turns: [edit] }));
    assert.equal(changes.querySelectorAll('[data-testid="inspector-change-preview"]').length, 1);

    const cmd = turnWaitingApproval("run_terminal", { command: "ls" });
    const noneForCommand = renderInspector(props({ tab: "changes", turn: cmd, turns: [cmd] }));
    assert.equal(noneForCommand.querySelectorAll('[data-testid="inspector-change-preview"]').length, 0);
    assert.equal(noneForCommand.querySelector('[data-testid="inspector-empty"]')!.textContent, CHANGES_EMPTY_TEXT);

    // The empty state must not imply history exists anywhere on disk.
    assert.match(CHANGES_EMPTY_TEXT, /not available in this release/);
    assert.ok(!/committed|on disk|history of/i.test(CHANGES_EMPTY_TEXT.replace("history is not available", "")));
  });
});
