/** Constants shared by the E2E fixture server and the specs. No side effects. */
import * as os from "node:os";
import * as path from "node:path";
import { computeConfigHash } from "../../server/src/agent/project-trust.js";

export const E2E_PORT = Number(process.env.E2E_PORT ?? 7699);
export const E2E_TOKEN = "e2e-fixed-token-0123456789abcdef";
export const MCP_CONFIG = { command: "npx", args: ["-y", "example-mcp"], env: { EXAMPLE: "1" } };
export const MCP_CONFIG_HASH = computeConfigHash(MCP_CONFIG);
/** Fixed so the spec files can compute it without parsing server output. */
export const E2E_PROJECT = path.join(os.tmpdir(), "wr-e2e-project");
