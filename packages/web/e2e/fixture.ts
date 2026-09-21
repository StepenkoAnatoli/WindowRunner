/** Constants shared by the E2E fixture server and the specs. No side effects. */
import * as os from "node:os";
import * as path from "node:path";
import { computeConfigHash } from "../../server/src/agent/project-trust.js";

export const E2E_PORT = Number(process.env.E2E_PORT ?? 7699);
/**
 * The provider-dashboard fixture server (e2e/dashboard-server.ts) listens on
 * its own port: it runs the REAL provider bootstrap (no ScriptedProvider
 * override), which the scripted server above cannot do because its scripted
 * provider is frozen at boot while the dashboard hot-swaps profiles.
 */
export const DASH_PORT = Number(process.env.DASH_PORT ?? 7701);
/**
 * A second dashboard fixture (e2e/dashboard-stop-server.ts) for the quick
 * chat's Stop button. It exists because Stop can only be clicked while a turn
 * is in flight, and a turn is only slow enough to click on if the provider
 * streams with a delay — which is a property of the *injected* provider, and
 * any "Use this" replaces it with a profile-built mock that has no delay. So
 * this server must never have a profile activated on it, which the shared
 * DASH_PORT server cannot promise (dashboard.spec.ts activates one there).
 */
export const DASH_STOP_PORT = Number(process.env.DASH_STOP_PORT ?? 7702);
/**
 * B2 fixture (e2e/providers-server.ts): the workspace provider/usage/settings
 * flows on their own port. Like DASH_PORT it runs the real provider bootstrap
 * (its own provider-profiles.json in a per-run temp data dir) — but it must be
 * a SEPARATE server from E2E_PORT because the B2 flow activates a profile,
 * which hot-swaps the active provider; the scripted-provider specs (ui.spec,
 * workspace.spec) share E2E_PORT and would lose their scripted replies.
 */
export const PROVIDERS_PORT = Number(process.env.PROVIDERS_PORT ?? 7703);
export const E2E_TOKEN = "e2e-fixed-token-0123456789abcdef";
export const MCP_CONFIG = { command: "npx", args: ["-y", "example-mcp"], env: { EXAMPLE: "1" } };
export const MCP_CONFIG_HASH = computeConfigHash(MCP_CONFIG);
/** Fixed so the spec files can compute it without parsing server output. */
export const E2E_PROJECT = path.join(os.tmpdir(), "wr-e2e-project");
