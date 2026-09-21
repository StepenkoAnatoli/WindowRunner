import { previewApproval, type TurnView } from "./app-state.js";
import { el } from "./dom.js";

/**
 * Inspector activity list (B1): the selected turn's tool calls in call
 * order. Shows the tool name, lifecycle state, and failure detail; output
 * only when already exposed through `ToolEntry.result.output`. Raw tool
 * input is never shown here — for a pending approval the one-line summary
 * below is derived from `previewApproval()` only.
 *
 * Pure render: receives state + callbacks, never constructs ApiClient, calls
 * fetch, or mutates global state.
 */
export interface ToolTimelineProps {
  turn?: TurnView;
  selectedCallId?: string;
  onSelectTool(callId: string): void;
}

export function renderToolTimeline(props: ToolTimelineProps): HTMLElement {
  const turn = props.turn;
  if (!turn || turn.tools.length === 0) {
    return el(
      "div",
      { class: "tool-timeline empty", "data-testid": "tool-timeline" },
      el("p", { class: "hint", "data-testid": "inspector-empty" }, turn ? "No tool calls in this turn yet." : "Select a turn to see its tool activity.")
    );
  }
  return el(
    "ul",
    { class: "tool-timeline", "data-testid": "tool-timeline" },
    ...turn.tools.map((t) => {
      const item = el(
        "li",
        {
          class: `tool-activity${props.selectedCallId === t.callId ? " selected" : ""}`,
          "data-testid": "tool-activity-item",
          "data-call-id": t.callId,
        },
        el(
          "button",
          { type: "button", class: "tool-activity-name", "data-testid": `tool-activity-select-${t.callId}` },
          el("code", {}, t.toolName)
        ),
        " ",
        el("span", { "data-testid": "tool-activity-status" }, describeToolStatus(t.status, t.result)),
        t.result && !t.result.ok
          ? el("div", { class: "error tool-activity-error" }, `${t.result.code ?? "TOOL_FAILED"}: ${t.result.message ?? ""}`)
          : null,
        t.result?.ok && t.result.output ? el("pre", { class: "input tool-activity-output" }, truncate(t.result.output, 500)) : null,
        t.status !== "done" && t.input !== undefined ? el("div", { class: "muted tool-activity-preview" }, summarizePendingInput(t.toolName, t.input)) : null
      );
      const select = item.querySelector('[data-testid^="tool-activity-select-"]');
      select?.addEventListener("click", () => props.onSelectTool(t.callId));
      return item;
    })
  );
}

function describeToolStatus(status: string, result?: { ok: boolean }): string {
  if (status !== "done") return status === "running" ? "running" : "called";
  if (!result) return "done";
  return result.ok ? "done" : "failed";
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… ${text.length - max} more character(s)` : text;
}

/**
 * One-line pending-call summary derived from the approval preview only —
 * never from raw input. Mirrors what the approval card shows so the two
 * views cannot disagree.
 */
function summarizePendingInput(toolName: string, input: unknown): string {
  const preview = previewApproval(toolName, input);
  switch (preview.kind) {
    case "diff":
      return `awaits approval — diff: ${preview.path} (${preview.lines.length} line(s))`;
    case "command":
      return `awaits approval — $ ${preview.command}`;
    default:
      return `awaits approval — ${truncate(preview.text.replace(/\s+/g, " ").trim(), 120)}`;
  }
}
