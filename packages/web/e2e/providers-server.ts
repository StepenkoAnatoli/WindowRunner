/**
 * E2E fixture server for the B2 workspace provider flows.
 *
 * Boots the real server on PROVIDERS_PORT with the same fixed token as the
 * other fixtures, WITHOUT a provider override: the workspace flow under test
 * (add profile → edit → test → activate → delete → usage → settings) must go
 * through the real profile bootstrap and hot-swap. It is deliberately NOT the
 * E2E_PORT server: activating a profile swaps the active provider for the
 * whole process, which would break the scripted-provider specs that share
 * that server. Sessions and provider-profiles.json live in a per-run temp
 * data dir, so every run starts from first-boot state.
 *
 * Playwright starts this via a `webServer` entry in playwright.config.ts;
 * `npm run e2e` runs it.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startServer } from "../../server/src/boot.js";
import { PROVIDERS_PORT, E2E_PROJECT, E2E_TOKEN } from "./fixture.js";

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wr-providers-e2e-"));
  await fs.mkdir(E2E_PROJECT, { recursive: true });
  const handle = await startServer({
    host: "127.0.0.1",
    port: PROVIDERS_PORT,
    allowRemote: false,
    provider: "mock",
    model: { baseUrl: "https://api.openai.com/v1", maxRetries: 0, maxSteps: 10, callTimeoutMs: 30_000 },
    tools: { enabled: false, terminalTimeoutMs: 60_000, terminalOutputLimit: 65_536 },
    auth: { mode: "token", token: E2E_TOKEN, allowedHosts: [], allowedOrigins: [] },
    persistence: { mode: "file", dataDir, durableBeforeNotify: false, fsync: false },
    allowedRoots: [E2E_PROJECT],
    shutdownGraceMs: 2000,
  });
  if (!handle.webDir || !handle.dashboardDir) {
    console.error("e2e providers server: the web UI is not built (packages/web/dist/{app,dashboard} missing) — run npm run build first");
    process.exit(1);
  }
  console.log(`e2e providers server listening on ${handle.url} (dataDir ${dataDir})`);
  const stop = async () => {
    await handle.close().catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
