import { defineConfig } from "@playwright/test";

/**
 * Desktop e2e (PR A / A2). Unlike the web e2e there is no webServer block:
 * the app boots its own bundled backend. One worker, serial specs — the
 * journey is a single app lifecycle (boot -> ... -> quit).
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  // `github` reporter: failures become check-run annotations (same setup as
  // the web e2e), so a red Desktop job is diagnosable from the Checks API.
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }], ["github"]] : "list",
});
