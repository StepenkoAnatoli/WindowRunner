import { defineConfig, devices } from "@playwright/test";
import { DASH_PORT } from "./e2e/fixture.js";

const port = Number(process.env.E2E_PORT ?? 7699);

/**
 * Local-debug override: point Playwright at an existing Chromium binary
 * (e.g. one extracted outside the usual CDN path) instead of the
 * ms-playwright-managed build. Unused in CI, which installs the managed
 * build via `npm run e2e:install`.
 */
const debugExecutable = process.env.E2E_CHROMIUM_EXECUTABLE;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...(debugExecutable
      ? {
          launchOptions: {
            executablePath: debugExecutable,
            chromiumSandbox: false,
            env: { ...process.env, LD_LIBRARY_PATH: process.env.E2E_CHROMIUM_LD_LIBRARY_PATH || "" },
          },
        }
      : {}),
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Two fixture servers: the scripted-provider UI server (with its proxy on
  // E2E_PORT) and the real-bootstrap dashboard server on DASH_PORT. Playwright
  // starts both, waits on both health endpoints, and stops both after the run.
  webServer: [
    {
      command: "npx tsx e2e/server.ts",
      url: `http://127.0.0.1:${port}/healthz`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "npx tsx e2e/dashboard-server.ts",
      url: `http://127.0.0.1:${DASH_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
