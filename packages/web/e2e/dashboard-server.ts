/**
 * E2E fixture server for the provider dashboard.
 *
 * Boots the real server on DASH_PORT with the same fixed token as the main
 * UI fixture, but WITHOUT a provider override: the dashboard flow under test
 * (add profile → test → activate → quick chat → usage row) must go through
 * the real profile bootstrap and hot-swap, which the scripted provider in
 * server.ts cannot do. Sessions and the provider-profiles.json file live in
 * a per-run temp data dir, so every run starts from first-boot state.
 *
 * Playwright starts this via the second `webServer` entry in
 * playwright.config.ts; `npm run e2e` runs it.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startServer } from "../../server/src/boot.js";
import { MockProvider } from "../../server/src/providers/mock.js";
import { DASH_PORT, E2E_PROJECT, E2E_TOKEN } from "./fixture.js";

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wr-dash-e2e-"));
  await fs.mkdir(E2E_PROJECT, { recursive: true });
  const handle = await startServer({
    host: "127.0.0.1",
    port: DASH_PORT,
    allowRemote: false,
    provider: "mock",
    model: { baseUrl: "https://api.openai.com/v1", maxRetries: 0, maxSteps: 10, callTimeoutMs: 30_000 },
    tools: { enabled: false, terminalTimeoutMs: 60_000, terminalOutputLimit: 65_536 },
    auth: { mode: "token", token: E2E_TOKEN, allowedHosts: [], allowedOrigins: [] },
    persistence: { mode: "file", dataDir, durableBeforeNotify: false, fsync: false },
    allowedRoots: [E2E_PROJECT],
    shutdownGraceMs: 2000,
  }, {
    // The same offline mock the server would build, but with a per-chunk delay
    // so a turn streams for a few seconds. The quick chat's Stop button only
    // exists while a turn is in flight, and without this the turn is over
    // before a click can land. Replies are unchanged ("[mock] …"), so the
    // other assertions in dashboard.spec.ts are unaffected.
    provider: new MockProvider({ delayMs: 120 }),
  });
  if (!handle.dashboardDir) {
    console.error("e2e dashboard server: the dashboard is not built (packages/web/dist/dashboard missing) — run npm run build first");
    process.exit(1);
  }
  console.log(`e2e dashboard server listening on ${handle.url} (dataDir ${dataDir})`);
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
