#!/usr/bin/env node
/**
 * windows-runner — clone-path setup.
 *
 * One command for a fresh checkout: verify the toolchain, install dependencies
 * from the lockfile, build the workspaces, and print what is actually available
 * afterwards. Called by install.sh and install.ps1, and documented in README as
 * the "clone + npm run setup" path.
 *
 * This does not start anything: it prepares the checkout so that `npm start`
 * (packages/server/dist/index.js) runs immediately afterwards. The installers
 * decide whether to start the server; see docs/INSTALL.md for what the server
 * does and does not do in this checkout.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options = {}) {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
  if (result.error) {
    console.error(`  failed to run ${command}: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    console.error(`  ${command} exited with code ${result.status}`);
    return false;
  }
  return true;
}

function nodeIsSupported() {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const range = manifest.engines?.node ?? "";
  const match = />=\s*(\d+)\.(\d+)/.exec(range);
  if (!match) return true;
  const [major, minor] = process.version.replace(/^v/, "").split(".").map(Number);
  if (major !== Number(match[1])) return major > Number(match[1]);
  return minor >= Number(match[2]);
}

function main() {
  console.log("windows-runner setup");
  console.log(`  repository: ${repoRoot}`);
  console.log(`  node:       ${process.version}`);

  if (!nodeIsSupported()) {
    console.error("\nNode version is not supported; see package.json engines.node.");
    return 1;
  }

  // A lockfile means reproducible install; without one, fall back to a resolve.
  const useCi = existsSync(path.join(repoRoot, "package-lock.json"));
  const installArgs = useCi ? ["ci"] : ["install"];
  // The dependency layer does not need the hook re-verified: setup verifies the
  // tree itself by building it below, and re-running postinstall here would only
  // duplicate output on every installer invocation.
  const env = { ...process.env, WINDOWS_RUNNER_SKIP_POSTINSTALL: "1" };

  if (!run("npm", installArgs, { env })) return 1;
  if (!run("npm", ["run", "typecheck"], { env })) return 1;
  if (!run("npm", ["run", "build"], { env })) return 1;

  console.log("\nSetup complete.");
  console.log("  npm start         start the server on http://127.0.0.1:7634");
  console.log("  npm test          run the test suite");
  console.log("  npm run build     rebuild packages/*/dist");
  console.log("");
  console.log("The server runs with the offline mock provider and no tools in this");
  console.log("checkout. Read docs/INSTALL.md before relying on any install path.");
  return 0;
}

process.exitCode = main();
