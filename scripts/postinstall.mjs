#!/usr/bin/env node
/**
 * windows-runner — postinstall hook.
 *
 * What this does
 * --------------
 * Verifies that `npm install` / `npm ci` produced a usable workspace tree, and
 * prints the commands that actually work in the current repository state.
 *
 * What this deliberately does NOT do
 * ----------------------------------
 * It does not build. The historical version of this hook auto-built a bundled
 * server (`packages/server/dist/index.cjs`) and a Vite web bundle. Neither
 * bundler is a dependency of this repository any more, so an auto-build here
 * would fail on a clean clone of an installed package. Building is an explicit
 * step instead: `npm run build`, or implicitly via `npm start`, whose
 * `prestart` hook (scripts/ensure-built.mjs) builds when dist/ is missing or
 * stale. See docs/INSTALL.md, "Known packaging gaps".
 *
 * Contract
 * --------
 * - Exits 0 when the install is healthy, so a plain `npm ci` succeeds.
 * - Exits 1 with an actionable list when the tree is broken (this is the point
 *   of the hook: a green install must mean a usable install).
 * - Honors WINDOWS_RUNNER_SKIP_POSTINSTALL=1, the escape hatch already used by
 *   install.sh, install.ps1 and the Dockerfile dependency layer.
 */

import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(repoRoot, "package.json"));

/** True when the caller asked us to stay out of the way. */
function skipRequested() {
  const raw = process.env.WINDOWS_RUNNER_SKIP_POSTINSTALL;
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value !== "" && value !== "0" && value !== "false" && value !== "no";
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Minimal `engines.node` check for the only range this repo declares (>=X.Y). */
function satisfiesEngines(range, version) {
  const match = />=\s*(\d+)\.(\d+)/.exec(range || "");
  if (!match) return true; // No range we understand: do not block the install.
  const [, wantMajor, wantMinor] = match;
  const [major, minor] = version.replace(/^v/, "").split(".").map(Number);
  if (major !== Number(wantMajor)) return major > Number(wantMajor);
  return minor >= Number(wantMinor);
}

function main() {
  if (skipRequested()) {
    console.log("windows-runner: postinstall skipped (WINDOWS_RUNNER_SKIP_POSTINSTALL).");
    return 0;
  }

  const problems = [];
  const manifest = readJson(path.join(repoRoot, "package.json"));

  // 1. Node version. The repo needs >=20.10; CI pins an exact LTS.
  const range = manifest.engines?.node;
  if (range && !satisfiesEngines(range, process.version)) {
    problems.push(`Node ${process.version} does not satisfy engines.node "${range}".`);
  }

  // 2. Every declared workspace must exist on disk and be linked into
  //    node_modules, otherwise `npm run --workspace` and bare-specifier imports
  //    both fail in confusing ways later.
  const workspaces = manifest.workspaces ?? [];
  if (workspaces.length === 0) {
    problems.push("package.json declares no workspaces; the tree is not the expected monorepo.");
  }
  for (const ws of workspaces) {
    const wsManifestPath = path.join(repoRoot, ws, "package.json");
    if (!existsSync(wsManifestPath)) {
      problems.push(`Workspace "${ws}" has no package.json.`);
      continue;
    }
    const name = readJson(wsManifestPath).name;
    try {
      require.resolve(`${name}/package.json`);
    } catch {
      problems.push(`Workspace "${ws}" (${name}) is not linked into node_modules.`);
    }
  }

  // 3. Tooling the declared scripts depend on must be resolvable. Without these
  //    `npm run typecheck`, `npm test` and `npm run build` fail with a bare
  //    "command not found" that does not point at the real cause.
  for (const tool of ["tsx", "typescript"]) {
    try {
      require.resolve(tool);
    } catch {
      problems.push(`Required dev tool "${tool}" is not installed.`);
    }
  }

  // 4. Every `node scripts/*.mjs` target named by the manifest must exist. This
  //    is the exact defect that made a plain `npm ci` fail before this file was
  //    restored, so it is checked rather than assumed.
  for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
    for (const match of String(command).matchAll(/node\s+(scripts\/[\w.-]+\.mjs)/g)) {
      const target = path.join(repoRoot, match[1]);
      if (!existsSync(target)) {
        problems.push(`Script "${name}" references missing file ${match[1]}.`);
      }
    }
  }

  if (problems.length > 0) {
    console.error("windows-runner: postinstall verification FAILED.");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("");
    console.error("Recover with a clean, lockfile-driven install:");
    console.error("  rm -rf node_modules && npm ci");
    return 1;
  }

  console.log(`windows-runner: install verified (${workspaces.length} workspaces, Node ${process.version}).`);
  console.log("  npm start           start the server on http://127.0.0.1:7634 (builds first if needed)");
  console.log("  npm run typecheck   typecheck all workspaces");
  console.log("  npm test            run the test suite");
  console.log("  npm run build       emit packages/*/dist");
  console.log("  See docs/INSTALL.md for install-path status and known packaging gaps.");
  return 0;
}

process.exitCode = main();
