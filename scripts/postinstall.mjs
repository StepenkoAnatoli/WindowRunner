#!/usr/bin/env node
/**
 * windows-runner — postinstall hook.
 *
 * What this does
 * --------------
 * Verifies that `npm install` / `npm ci` produced either a usable workspace
 * checkout or a usable installed runtime artifact, and prints the commands that
 * actually work in that form.
 *
 * What this deliberately does NOT do
 * ----------------------------------
 * It does not build. A source checkout is built explicitly with `npm run build`,
 * or implicitly via `npm start`, whose `prestart` hook
 * (scripts/ensure-built.mjs) rebuilds when the bundle is missing or stale. A
 * packed install already contains the self-contained bundle and needs no
 * TypeScript workspace or dev toolchain. See docs/INSTALL.md.
 *
 * Contract
 * --------
 * - Exits 0 when the install is healthy, so a plain `npm ci` succeeds.
 * - Exits 1 with an actionable list when the tree is broken.
 * - Honors WINDOWS_RUNNER_SKIP_POSTINSTALL=1, the escape hatch used by
 *   install.ps1 and the Dockerfile dependency layer.
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
  if (!match) return true;
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
  const workspaces = manifest.workspaces ?? [];
  const runtimeEntry = path.join(repoRoot, "packages", "server", "dist", "index.cjs");
  const hasSourceCheckout = existsSync(path.join(repoRoot, "packages", "server", "src"));
  const isPackedRuntime = !hasSourceCheckout && existsSync(runtimeEntry);

  // 1. Node version. The repo needs >=22.0.0; CI pins an exact LTS.
  const range = manifest.engines?.node;
  if (range && !satisfiesEngines(range, process.version)) {
    problems.push(`Node ${process.version} does not satisfy engines.node "${range}".`);
  }

  // 2. Lifecycle scripts: in a packed install, verify only scripts npm can invoke
  // as lifecycle hooks; in a checkout, verify every script.
  for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
    if (isPackedRuntime && !new Set(["preinstall", "install", "postinstall", "prestart"]).has(name)) continue;
    for (const match of String(command).matchAll(/node\s+(scripts\/[\w.-]+\.mjs)/g)) {
      const target = path.join(repoRoot, match[1]);
      if (!existsSync(target)) {
        problems.push(`Script "${name}" references missing file ${match[1]}.`);
      }
    }
  }

  if (isPackedRuntime) {
    // In a packed/installed runtime tarball, workspace packages and dev tools
    // are not present. Only the bundled entry and hooks are required.
    if (problems.length === 0) {
      console.log(`windows-runner: runtime artifact verified (Node ${process.version}).`);
      console.log("  npm start           start the self-contained server on http://127.0.0.1:7634");
    }
  } else {
    // In a source checkout:
    // 3. Every declared workspace must exist on disk and be linked into node_modules.
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

    // 4. Tooling the declared scripts depend on must be resolvable.
    for (const tool of ["tsx", "typescript", "esbuild"]) {
      try {
        require.resolve(tool);
      } catch {
        problems.push(`Required dev tool "${tool}" is not installed.`);
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

  if (!isPackedRuntime) {
    console.log(`windows-runner: install verified (${workspaces.length} workspaces, Node ${process.version}).`);
    console.log("  npm start           start the server on http://127.0.0.1:7634 (builds first if needed)");
    console.log("  npm run typecheck   typecheck all workspaces");
    console.log("  npm test            run the test suite");
    console.log("  npm run build       emit packages/*/dist and the bundled server entry");
  }
  console.log("  See docs/INSTALL.md for install-path status and known packaging gaps.");
  return 0;
}

process.exitCode = main();
