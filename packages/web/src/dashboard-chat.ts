/**
 * The quick chat box: one turn against the active provider, streamed over the
 * same SSE the main UI uses, plus Stop.
 *
 * Stop is a POST to the turn's cancel route — exactly what the main UI does.
 * Deliberately not an abort of the event stream: the server ends the turn with
 * a `turn_cancelled` event, and staying connected is how this panel learns the
 * cancellation landed (and how the usage table gets its row).
 */
import { ApiRequestError } from "./api.js";
import type { ProviderProfileView } from "./api.js";
import { button, el } from "./dom.js";
import { CWD_KEY, SESSION_KEY, render, root, state, storeDel, storeSet } from "./dashboard-state.js";
import { client, describeDashError, refresh, reportError, signOut } from "./dashboard-api.js";

export function chatPanel(active: ProviderProfileView | null): HTMLElement {
  const c = state.chat;
  const form = el(
    "form",
    { class: "panel", "data-testid": "dash-chat" },
    el("h2", {}, "Quick chat"),
    el("p", { class: "hint" }, "Sends one turn to ", el("strong", {}, active ? `${active.label} (${active.model})` : "the active provider"), ", streamed over the same SSE the main UI uses."),
    el(
      "label",
      {},
      "Project folder (absolute path inside an allowed root)",
      el("input", { "data-testid": "dash-cwd", value: c.cwd, placeholder: "/home/me/project", required: "true" })
    ),
    el("textarea", { "data-testid": "dash-message", rows: "2", placeholder: "Ask the agent…", ...(c.busy ? { disabled: "true" } : {}) }),
    el(
      "div",
      { class: "row" },
      button("dash-send", c.busy ? "Working…" : "Send", undefined, "primary", c.busy),
      // Stop is only meaningful once there is a turn id to cancel; before
      // startTurn answers there is nothing the server can be told to stop.
      c.busy && c.turnId ? button("dash-chat-stop", "Stop", () => void stopChat(), "danger") : null,
      c.sessionId ? button("dash-chat-reset", "Reset session", resetChatSession, "secondary") : null
    ),
    c.reply || c.busy ? el("div", { class: "chat-out", "data-testid": "dash-reply" }, c.reply || "…", c.busy ? el("span", { class: "cursor" }, "▍") : null) : null,
    c.status ? el("div", { class: "muted small", "data-testid": "dash-chat-status" }, c.status) : null,
    c.error ? el("p", { class: "error small", "data-testid": "dash-chat-error", role: "alert" }, c.error) : null
  );
  form.addEventListener("submit", onChatSubmit);
  return form;
}

function resetChatSession(): void {
  state.chat.sessionId = undefined;
  storeDel(SESSION_KEY);
  state.chat.status = undefined;
  state.chat.error = undefined;
  render();
}

function onChatSubmit(e: Event): void {
  e.preventDefault();
  const ta = root.querySelector<HTMLTextAreaElement>('[data-testid="dash-message"]');
  const cwdInput = root.querySelector<HTMLInputElement>('[data-testid="dash-cwd"]');
  if (!ta || !cwdInput) return;
  const message = ta.value.trim();
  const cwd = cwdInput.value.trim();
  if (!message || !cwd || state.chat.busy) return;
  storeSet(CWD_KEY, cwd);
  state.chat.cwd = cwd;
  ta.value = "";
  void sendChat(message, cwd);
}

async function sendChat(message: string, cwd: string): Promise<void> {
  if (!client) return;
  state.chat.busy = true;
  state.chat.reply = "";
  state.chat.error = undefined;
  state.chat.status = "starting…";
  state.chat.terminal = false;
  const sid = state.chat.sessionId ?? `dash-${Date.now().toString(36)}`;
  state.chat.sessionId = sid;
  storeSet(SESSION_KEY, sid);
  render();
  try {
    const { turnId } = await client.startTurn(sid, message, cwd);
    state.chat.turnId = turnId; // what the Stop button cancels
    const result = await client.streamTurn(
      sid,
      turnId,
      {
        onEvent: (event) => {
          switch (event.type) {
            case "text_delta":
              state.chat.reply += event.delta;
              render();
              break;
            case "turn_completed":
              state.chat.terminal = true;
              state.chat.status = `completed (seq ${event.seq})`;
              break;
            case "turn_failed":
              state.chat.terminal = true;
              state.chat.status = `failed (${event.code})`;
              state.chat.error = event.message;
              break;
            case "turn_cancelled":
              state.chat.terminal = true;
              state.chat.status = `cancelled: ${event.reason}`;
              break;
            default:
              break;
          }
        },
      },
      {}
    );
    if (result.reason === "gave_up" && !state.chat.status) {
      state.chat.error = state.chat.error ?? "lost the event stream; send the message again to retry";
    }
    await refresh(); // the usage table picks the finished turn up
  } catch (err) {
    if (err instanceof ApiRequestError && err.isAuth) {
      signOut();
      return;
    }
    state.chat.error = describeDashError(err);
  } finally {
    state.chat.busy = false;
    state.chat.turnId = undefined;
    render();
  }
}

/**
 * Stop the in-flight quick-chat turn.
 *
 * Same mechanism as the main UI's Stop: POST the turn's cancel route and let
 * the server finish the turn with a `turn_cancelled` event, which this panel
 * is still streaming and turns into the "cancelled: …" status line. The event
 * stream is deliberately NOT aborted here — staying connected is how the
 * cancellation is confirmed to the user and how the turn still lands in the
 * usage table.
 */
export async function stopChat(): Promise<void> {
  const sessionId = state.chat.sessionId;
  const turnId = state.chat.turnId;
  if (!client || !sessionId || !turnId) return;
  try {
    await client.cancelTurn(sessionId, turnId, "stopped from the dashboard");
    // The server's turn_cancelled event comes down the stream that is already
    // open, so it can land before this response completes. Writing
    // "cancelling…" unconditionally would then overwrite the terminal status
    // for good, leaving the panel stuck on "cancelling…" (this is what the
    // browser E2E caught and the Node-only probe did not).
    if (!state.chat.terminal) {
      state.chat.status = "cancelling…";
      render();
    }
  } catch (err) {
    // A 409 TURN_NOT_ACTIVE race means the turn finished first — the Stop
    // goal is already met and the terminal event has arrived on the stream.
    if (err instanceof ApiRequestError && err.code === "TURN_NOT_ACTIVE") return;
    reportError(err);
  }
}
