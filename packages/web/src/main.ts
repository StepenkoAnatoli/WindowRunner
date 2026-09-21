import { ApiClient, ApiRequestError, clearToken, loadToken, saveToken } from "./api.js";
import { activeTurn, describeTurn, initialAppState, pendingApprovals, reduceApp, type AppAction, type AppState, type TurnView, previewApproval, type ApprovalPreview } from "./app-state.js";
import { describeError } from "./describe-error.js";
import { button, el } from "./dom.js";

/**
 * Windows Runner web UI — the smallest client that drives the whole lifecycle:
 * token → session → turn → streamed events (with reconnect) → approvals,
 * cancellation, trust prompts and errors. Plain DOM, no framework; every
 * element the E2E suite touches carries a stable `data-testid`.
 */

let state: AppState = initialAppState;
let client: ApiClient | undefined;
let streamAbort: AbortController | undefined;

const root = document.getElementById("app")!;

// Renders are coalesced to one per animation frame: with real providers a
// turn produces many text_delta events per second and each render rebuilds
// the DOM. (jsdom/Playwright still see every state change on the next frame.)
let renderScheduled = false;
function dispatch(action: AppAction): void {
  state = reduceApp(state, action);
  if (renderScheduled) return;
  renderScheduled = true;
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb: () => void) => setTimeout(cb, 16);
  raf(() => {
    renderScheduled = false;
    render();
  });
}

// ---------------------------------------------------------------------------
// Effects

async function connect(token: string): Promise<void> {
  const candidate = new ApiClient({ token });
  dispatch({ type: "auth_checking" });
  try {
    const health = await candidate.health();
    client = candidate;
    saveToken(token);
    dispatch({ type: "auth_ok", securityMode: health.security?.mode ?? "unknown", persistenceMode: health.persistence?.mode ?? "unknown" });
  } catch (err) {
    client = undefined;
    clearToken();
    dispatch({ type: "auth_invalid", message: describeError(err) });
  }
}

function signOut(): void {
  streamAbort?.abort();
  client = undefined;
  clearToken();
  dispatch({ type: "auth_cleared" });
}

async function createSession(sessionId: string, cwd: string): Promise<void> {
  if (!client) return;
  dispatch({ type: "busy", busy: true });
  try {
    const created = await client.createSession(sessionId, cwd);
    dispatch({ type: "session_created", sessionId: created.sessionId, root: created.root });
    await refreshTrust();
  } catch (err) {
    if (err instanceof ApiRequestError && err.code === "SESSION_ALREADY_EXISTS") {
      // Reattach to an existing session (e.g. after a page reload).
      try {
        const trust = await client.getTrust(sessionId);
        dispatch({ type: "session_created", sessionId, root: trust.canonicalRoot });
        dispatch({ type: "trust_loaded", grant: trust.grant });
      } catch (inner) {
        reportError(inner);
      }
    } else {
      reportError(err);
    }
  } finally {
    dispatch({ type: "busy", busy: false });
  }
}

async function deleteSession(): Promise<void> {
  if (!client || !state.session) return;
  streamAbort?.abort();
  try {
    await client.deleteSession(state.session.sessionId);
  } catch (err) {
    reportError(err);
  }
  dispatch({ type: "session_cleared" });
}

async function refreshTrust(): Promise<void> {
  if (!client || !state.session) return;
  try {
    const trust = await client.getTrust(state.session.sessionId);
    dispatch({ type: "trust_loaded", grant: trust.grant });
  } catch (err) {
    reportError(err);
  }
}

async function submitTurn(message: string): Promise<void> {
  if (!client || !state.session) return;
  dispatch({ type: "busy", busy: true });
  try {
    const { turnId } = await client.startTurn(state.session.sessionId, message);
    dispatch({ type: "turn_submitted", turnId, message });
    void followTurn(state.session.sessionId, turnId, 0);
  } catch (err) {
    reportError(err);
  } finally {
    dispatch({ type: "busy", busy: false });
  }
}

async function followTurn(sessionId: string, turnId: string, afterSeq: number): Promise<void> {
  if (!client) return;
  streamAbort?.abort();
  const abort = new AbortController();
  streamAbort = abort;
  dispatch({ type: "turn_connection", turnId, connection: "streaming" });
  try {
    const result = await client.streamTurn(
      sessionId,
      turnId,
      {
        onEvent: (event) => dispatch({ type: "turn_event", turnId, event }),
        onReconnect: (attempt) => dispatch({ type: "turn_connection", turnId, connection: "reconnecting", attempt }),
      },
      { afterSeq, signal: abort.signal }
    );
    if (result.reason === "gave_up") dispatch({ type: "turn_stream_error", turnId, message: `lost the event stream after ${result.seq} event(s); reload to resume` });
    else if (result.terminal || result.reason === "aborted") dispatch({ type: "turn_connection", turnId, connection: "closed" });
  } catch (err) {
    if (err instanceof ApiRequestError && err.isAuth) {
      signOut();
      dispatch({ type: "auth_invalid", message: "the server rejected the token while streaming; sign in again" });
      return;
    }
    dispatch({ type: "turn_stream_error", turnId, message: describeError(err) });
  }
}

async function cancelActive(): Promise<void> {
  const turn = activeTurn(state);
  if (!client || !state.session || !turn) return;
  try {
    await client.cancelTurn(state.session.sessionId, turn.turnId, "stopped from the web UI");
  } catch (err) {
    reportError(err);
  }
}

async function decide(requestId: string, decision: "approve" | "deny"): Promise<void> {
  if (!client || !state.session) return;
  try {
    await client.approve(state.session.sessionId, requestId, decision);
  } catch (err) {
    reportError(err);
  }
}

async function grantTrust(): Promise<void> {
  if (!client || !state.session || !state.trustPrompt) return;
  try {
    await client.grantTrust(state.session.sessionId, state.trustPrompt.configHash, state.trustPrompt.source);
    dispatch({ type: "trust_prompt_cleared" });
    await refreshTrust();
  } catch (err) {
    reportError(err);
  }
}

async function revokeTrust(): Promise<void> {
  if (!client || !state.session) return;
  try {
    await client.revokeTrust(state.session.sessionId);
    await refreshTrust();
  } catch (err) {
    reportError(err);
  }
}

function reportError(err: unknown): void {
  if (err instanceof ApiRequestError && err.isAuth) {
    signOut();
    dispatch({ type: "auth_invalid", message: "the server rejected the token; sign in again" });
    return;
  }
  const code = err instanceof ApiRequestError ? err.code : "CLIENT_ERROR";
  dispatch({ type: "error", code, message: describeError(err) });
}

// ---------------------------------------------------------------------------
// Rendering. Rebuilds the DOM from state; small enough that diffing is not worth it.
// Input values are preserved across renders by keeping the inputs' current
// values when the same element is rebuilt.

function render(): void {
  const focused = document.activeElement as HTMLElement | null;
  const focusId = focused?.getAttribute("data-testid") ?? undefined;
  const inputValues = new Map<string, string>();
  root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea").forEach((el) => {
    const id = el.getAttribute("data-testid");
    if (id) inputValues.set(id, el.value);
  });

  root.replaceChildren(
    ...([
      header(),
      state.auth !== "ok" ? tokenPanel() : el("div", { class: "main" }, sessionPanel(), state.session ? conversationPanel() : el("p", { class: "hint", "data-testid": "no-session" }, "Create or open a session to start.")),
      state.error ? errorBanner() : null,
    ].filter((n): n is HTMLElement => n !== null))
  );

  inputValues.forEach((value, id) => {
    const el = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-testid="${id}"]`);
    if (el && el.value === el.defaultValue) el.value = value;
  });
  if (focusId) root.querySelector<HTMLElement>(`[data-testid="${focusId}"]`)?.focus();
}

function header(): HTMLElement {
  const server = state.server ? `auth ${state.server.securityMode} · persistence ${state.server.persistenceMode}` : "";
  return el(
    "header",
    {},
    el("h1", {}, "Windows Runner"),
    el("span", { class: "muted", "data-testid": "server-info" }, server),
    state.auth === "ok" ? button("sign-out", "Sign out", signOut, "secondary") : null
  );
}

function tokenPanel(): HTMLElement {
  const form = el(
    "form",
    { class: "panel", "data-testid": "token-form" },
    el("h2", {}, "API token"),
    el("p", { class: "hint" }, "The server prints the token in its banner (memory mode) or stores it at <data dir>/auth-token (file mode). It is kept in this tab only."),
    el("input", { type: "password", "data-testid": "token-input", placeholder: "Bearer token", autocomplete: "off", required: "true" }),
    button("token-submit", state.auth === "checking" ? "Checking…" : "Connect", undefined, "primary", state.auth === "checking"),
    state.auth === "invalid" ? el("p", { class: "error", role: "alert", "data-testid": "auth-error" }, state.authError ?? "invalid token") : null
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = form.querySelector<HTMLInputElement>('[data-testid="token-input"]')!;
    const token = input.value.trim();
    if (token) void connect(token);
  });
  return form;
}

function sessionPanel(): HTMLElement {
  if (state.session) {
    const s = state.session;
    return el(
      "section",
      { class: "panel", "data-testid": "session-panel" },
      el("h2", {}, "Session ", el("code", { "data-testid": "session-id" }, s.sessionId)),
      el("p", {}, el("span", { class: "muted" }, "root "), el("code", { "data-testid": "session-root" }, s.root)),
      trustLine(),
      button("delete-session", "Delete session", () => void deleteSession(), "secondary")
    );
  }
  const form = el(
    "form",
    { class: "panel", "data-testid": "session-form" },
    el("h2", {}, "New session"),
    el("label", {}, "Session id", el("input", { "data-testid": "session-id-input", value: `s-${Date.now().toString(36)}`, pattern: "[A-Za-z0-9_-]{1,128}", required: "true" })),
    el("label", {}, "Project folder (absolute path inside an allowed root)", el("input", { "data-testid": "cwd-input", placeholder: "/home/me/project", required: "true" })),
    button("create-session", state.busy ? "Creating…" : "Create session", undefined, "primary", state.busy)
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const id = form.querySelector<HTMLInputElement>('[data-testid="session-id-input"]')!.value.trim();
    const cwd = form.querySelector<HTMLInputElement>('[data-testid="cwd-input"]')!.value.trim();
    if (id && cwd) void createSession(id, cwd);
  });
  return form;
}

function trustLine(): HTMLElement {
  const trust = state.session?.trust;
  if (trust === undefined) return el("p", { class: "muted", "data-testid": "trust-status" }, "trust: …");
  if (trust === null) return el("p", { class: "muted", "data-testid": "trust-status" }, "trust: project not trusted to run project-supplied configuration");
  return el(
    "p",
    { "data-testid": "trust-status" },
    el("span", { class: "ok" }, "trusted "),
    el("code", {}, trust.source ?? "configuration"),
    " ",
    el("code", { class: "muted" }, trust.configHash.slice(0, 19) + "…"),
    " ",
    button("revoke-trust", "Revoke", () => void revokeTrust(), "link")
  );
}

function conversationPanel(): HTMLElement {
  const active = activeTurn(state);
  const form = el(
    "form",
    { class: "composer", "data-testid": "turn-form" },
    el("textarea", { "data-testid": "message-input", rows: "3", placeholder: "Ask the agent…", required: "true", ...(active ? { disabled: "true" } : {}) }),
    el(
      "div",
      { class: "row" },
      button("send", state.busy ? "Sending…" : "Send", undefined, "primary", Boolean(active) || state.busy),
      active ? button("cancel", "Stop", () => void cancelActive(), "danger") : null
    )
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const ta = form.querySelector<HTMLTextAreaElement>('[data-testid="message-input"]')!;
    const message = ta.value.trim();
    if (message) {
      ta.value = "";
      void submitTurn(message);
    }
  });
  return el(
    "section",
    { class: "conversation", "data-testid": "conversation" },
    state.trustPrompt ? trustPrompt() : null,
    el("div", { class: "turns", "data-testid": "turns" }, ...state.turns.map(turnCard)),
    form
  );
}

function trustPrompt(): HTMLElement {
  const p = state.trustPrompt!;
  return el(
    "div",
    { class: "card warn", role: "alert", "data-testid": "trust-prompt" },
    el("strong", {}, p.staleConfigHash ? "Project configuration changed" : "Project not trusted"),
    el("p", {}, `The tool `, el("code", {}, p.toolName), ` wants to run configuration from `, el("code", {}, p.source), ` in `, el("code", {}, p.realRoot), `.`),
    p.staleConfigHash ? el("p", { class: "muted" }, `Previously trusted ${p.staleConfigHash.slice(0, 19)}…; now ${p.configHash.slice(0, 19)}…`) : el("p", { class: "muted" }, `configHash ${p.configHash}`),
    el("p", { class: "hint" }, "Trusting lets this project's configuration execute on your machine for future turns until revoked. Approving a single call never grants this."),
    el("div", { class: "row" }, button("grant-trust", "Trust this project", () => void grantTrust(), "primary"), button("dismiss-trust", "Not now", () => dispatch({ type: "trust_prompt_cleared" }), "secondary"))
  );
}

function turnCard(view: TurnView): HTMLElement {
  const status = describeTurn(view);
  const approvals = pendingApprovals(view);
  return el(
    "article",
    { class: `card turn status-${view.state.status}`, "data-testid": "turn", "data-turn-id": view.turnId, "data-status": view.state.status },
    el("div", { class: "user" }, el("span", { class: "muted" }, "you "), el("span", { "data-testid": "turn-message" }, view.message)),
    el("div", { class: "assistant" }, el("span", { class: "muted" }, "agent "), el("span", { "data-testid": "turn-text" }, view.state.textAccumulated), view.state.isTerminal ? null : el("span", { class: "cursor" }, "▍")),
    view.tools.length > 0 ? el("ul", { class: "tools", "data-testid": "tools" }, ...view.tools.map((t) => el("li", { "data-testid": "tool", "data-status": t.status }, el("code", {}, t.toolName), " ", t.status, t.result && !t.result.ok ? el("span", { class: "error" }, ` — ${t.result.code}: ${t.result.message}`) : null))) : null,
    ...approvals.map((req) =>
      el(
        "div",
        { class: "card approval", role: "alertdialog", "data-testid": "approval", "data-request-id": req.requestId },
        el("strong", {}, "Approval required: ", el("code", {}, req.toolName)),
        el("p", {}, req.reason),
        renderPreview(previewApproval(req.toolName, req.input)),
        el("div", { class: "row" }, button("approve", "Approve", () => void decide(req.requestId, "approve"), "primary"), button("deny", "Deny", () => void decide(req.requestId, "deny"), "danger"))
      )
    ),
    el("footer", { class: `status ${view.streamError || view.state.status === "failed" ? "error" : ""}`, "data-testid": "turn-status" }, status, " ", el("span", { class: "muted" }, `seq ${view.state.seq}`))
  );
}

function renderPreview(p: ApprovalPreview): HTMLElement {
  switch (p.kind) {
    case "diff":
      return el(
        "div",
        { class: "preview", "data-testid": "approval-preview", "data-kind": "diff" },
        el("div", { class: "muted" }, el("code", {}, p.path), p.note ? ` — ${p.note}` : ""),
        el("pre", { class: "diff" }, ...p.lines.map((l) => el("span", { class: l.type === "-" ? "del" : l.type === "+" ? "add" : "ctx" }, `${l.type} ${l.text}\n`)))
      );
    case "command":
      return el(
        "div",
        { class: "preview", "data-testid": "approval-preview", "data-kind": "command" },
        el("pre", { class: "input" }, "$ " + p.command),
        p.note ? el("div", { class: "muted" }, p.note) : null
      );
    default:
      return el("pre", { class: "input", "data-testid": "approval-preview", "data-kind": "json" }, p.text);
  }
}

function errorBanner(): HTMLElement {
  return el("div", { class: "banner error", role: "alert", "data-testid": "error-banner" }, el("strong", {}, state.error!.code), " ", state.error!.message, " ", button("dismiss-error", "Dismiss", () => dispatch({ type: "error_cleared" }), "link"));
}

// ---------------------------------------------------------------------------

const initialToken = loadToken();
render();
if (initialToken) void connect(initialToken);
