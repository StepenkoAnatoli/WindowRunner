#!/usr/bin/env node
/**
 * windows-runner — test-environment guard (root `pretest`).
 *
 * Fails fast with an actionable message when the dev toolchain the test
 * scripts need is missing — the signature state after an interrupted or
 * corrupted `npm ci` (npm wipes node_modules before installing, so a failed
 * install leaves `tsx` unresolvable and the suite dies with an opaque
 * "tsx: not found" / exit 127).
 */

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(repoRoot, "package.json"));

const missing = [];
for (const tool of ["tsx", "typescript", "esbuild"]) {
  try {
    require.resolve(tool);
  } catch {
    missing.push(tool);
  }
}

if (missing.length > 0) {
  console.error(`windows-runner: test environment is broken — missing dev tool(s): ${missing.join(", ")}.`);
  console.error("  This usually means `npm ci` was interrupted or failed mid-install");
  console.error("  (npm removes node_modules before installing).");
  console.error("");
  console.error("Recover with a clean, lockfile-driven install:");
  console.error("  rm -rf node_modules && npm ci");
  process.exit(1);
}
