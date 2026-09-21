/**
 * E2E fixture server for the dashboard quick chat's Stop button.
 *
 * Why a second dashboard server: Stop can only be clicked while a turn is in
 * flight, so the turn has to last long enough to click on. The only mock that
 * streams slowly is one built with `new MockProvider({ delayMs })`, and that
 * delay is NOT reachable through a profile — `createProviderFromProfile` builds
 * a mock profile with a plain `new MockProvider()` (no delay). An injected
 * provider therefore only serves turns until the first activation replaces it.
 *
 * So this server injects the slow mock and must never have a profile activated
 * on it; the shared DASH_PORT fixture cannot promise that, because
 * dashboard.spec.ts activates a profile there. Separate port, separate temp
 * data dir, one spec that only sends a message and stops it.
 *
 * Playwright starts this via the third `webServer` entry in
 * playwright.config.ts; `npm run e2e` runs it.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startServer } from "../../server/src/boot.js";
import { MockProvider } from "../../server/src/providers/mock.js";
import { DASH_STOP_PORT, E2E_PROJECT, E2E_TOKEN } from "./fixture.js";

/** Per-chunk delay; ~30 chunks per mock reply, so a turn streams for ~3.5s. */
const MOCK_DELAY_MS = 120;

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wr-dash-stop-e2e-"));
  await fs.mkdir(E2E_PROJECT, { recursive: true });
  const handle = await startServer(
    {
      host: "127.0.0.1",
      port: DASH_STOP_PORT,
      allowRemote: false,
      provider: "mock",
      model: { baseUrl: "https://api.openai.com/v1", maxRetries: 0, maxSteps: 10, callTimeoutMs: 30_000 },
      tools: { enabled: false, terminalTimeoutMs: 60_000, terminalOutputLimit: 65_536 },
      auth: { mode: "token", token: E2E_TOKEN, allowedHosts: [], allowedOrigins: [] },
      persistence: { mode: "file", dataDir, durableBeforeNotify: false, fsync: false },
      allowedRoots: [E2E_PROJECT],
      shutdownGraceMs: 2000,
    },
    {
      // Replies are otherwise identical to the plain mock ("[mock] …"), so the
      // dashboard renders exactly as it does on the other fixture.
      provider: new MockProvider({ delayMs: MOCK_DELAY_MS }),
    }
  );
  if (!handle.dashboardDir) {
    console.error("e2e dashboard-stop server: the dashboard is not built (packages/web/dist/dashboard missing) — run npm run build first");
    process.exit(1);
  }
  console.log(`e2e dashboard-stop server listening on ${handle.url} (dataDir ${dataDir}, mock delay ${MOCK_DELAY_MS}ms)`);
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
