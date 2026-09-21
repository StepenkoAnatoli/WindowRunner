/**
 * Settings → Security (B2): a READ-ONLY view of the server's health summary
 * and what the security model means. B2 adds no settings mutations here.
 *
 * Displayed values come from GET /api/health (`HealthSummary`): security
 * mode, boot auth diagnostics, and (when the server exposes them) the Origin
 * policy note. The trust/approval explanations are fixed copy describing how
 * the server behaves — they never render tokens: the summary carries a token
 * *source* label, never a token value, and this page renders only that label.
 */
import type { HealthSummary } from "../api.js";
import { el } from "../dom.js";

export interface SecurityPageProps {
  health?: HealthSummary;
  /** Fallback when health has not been fetched: the modes from the banner. */
  server?: { securityMode: string; persistenceMode: string };
}

export function renderSecurityPage(props: SecurityPageProps): HTMLElement {
  const health = props.health;
  const securityMode = health?.security?.mode ?? props.server?.securityMode ?? "unknown";
  const auth = health?.diagnostics?.boot?.auth;
  const originNote = (health?.security as Record<string, unknown> | undefined)?.note;
  const allowedOrigins = (health?.security as Record<string, unknown> | undefined)?.allowedOrigins;

  return el(
    "div",
    { class: "settings-section", "data-testid": "security-page" },
    el("h3", {}, "Security"),
    el(
      "dl",
      { class: "context-list" },
      el("dt", {}, "Security mode"),
      el("dd", { "data-testid": "security-mode" }, securityMode),
      el("dt", {}, "Authentication"),
      el(
        "dd",
        { "data-testid": "security-auth" },
        auth?.mode
          ? `every /api request requires a bearer token (mode: ${auth.mode}${auth.tokenSource ? `, token source: ${auth.tokenSource}` : ""})`
          : "every /api request requires a bearer token; the token lives in this tab (browser) or in desktop memory only"
      ),
      allowedOrigins !== undefined ? el("dt", {}, "Allowed origins") : null,
      allowedOrigins !== undefined ? el("dd", {}, String(allowedOrigins)) : null,
      originNote ? el("dt", {}, "Server note") : null,
      originNote ? el("dd", {}, String(originNote)) : null
    ),
    el("h3", {}, "Project trust"),
    el(
      "p",
      { class: "hint" },
      "Tools supplied by a project's own configuration (for example .mcp.json servers) run only after you trust that project. Trusting binds the project's configuration hash on this machine and lasts until you revoke it; approving a single tool call never grants trust."
    ),
    el("h3", {}, "Approvals"),
    el(
      "p",
      { class: "hint" },
      "Risky tools (terminal commands, file writes and edits) pause the turn and wait for an explicit approve/deny decision. A denial is reported back to the model; nothing runs without a decision."
    ),
    el("h3", {}, "Local access"),
    el(
      "p",
      { class: "hint", "data-testid": "security-local-warning" },
      "The server binds to loopback (127.0.0.1) and refuses requests with unexpected Host/Origin headers. If you expose it beyond your machine (a reverse proxy or a remote-access tunnel), anyone holding the token can run tools on your machine — keep the token secret and prefer the desktop app."
    )
  );
}
