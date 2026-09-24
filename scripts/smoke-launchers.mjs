#!/usr/bin/env node
/**
 * windows-runner — launcher smoke test for the double-click Windows path.
 *
 * `Setup-WindowRunner.cmd` and `Start-WindowRunner.cmd` are the beginner
 * install path: a user extracts the ZIP and double-clicks them. Everything
 * they run (`npm run setup`, `npm start`) is separately verified, but the
 * wrappers themselves — argument handling, the Node version gate, the exit
 * path a double-click sees — can only be exercised by actually running them
 * under cmd.exe on Windows. This script does exactly that, non-interactively
 * (`-NoPause`), which is how the `Platform (windows-latest)` CI leg covers the
 * wrappers instead of trusting the contract test alone.
 *
 * It asserts, in order:
 *   1. `Setup-WindowRunner.cmd -NoPause` exits 0 and prints the ready message
 *      (proving the Node gate passes and `npm run setup` is reached and
 *      succeeds end to end inside the wrapper);
 *   2. `Start-WindowRunner.cmd -NoPause` boots the app: the banner's ready line
 *      appears, the `ui:` address is printed, and /healthz answers 200;
 *   3. both children are torn down as process trees, so no orphaned
 *      node.exe/cmd.exe survives the run.
 *
 * Windows-only by nature: on any other platform it prints a skip note and
 * exits 0, so `npm test` and the Linux jobs stay green. Run it directly with
 * `npm run smoke:launchers`.
 */

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SETUP = "Setup-WindowRunner.cmd";
const START = "Start-WindowRunner.cmd";
const READY_RE = /windows-runner listening on (http:\/\/\S+)/;
/** Generous only because a cold start rebuilds dist/ when it is stale. */
const START_TIMEOUT_MS = 60_000;

function banner(text) {
  console.log(`\n${text}`);
}

function runSetup() {
  banner(`▸ ${SETUP} -NoPause (install + typecheck + build through the wrapper)`);
  const result = spawnSync("cmd.exe", ["/d", "/c", SETUP, "-NoPause"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, PORT: "0" },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const failures = [];
  if (result.error) failures.push(`could not spawn cmd.exe: ${result.error.message}`);
  if (result.status !== 0) failures.push(`exit code ${result.status} (expected 0)`);
  if (!/Setup finished - WindowRunner is ready to use\./.test(output)) {
    failures.push("the wrapper did not print its success banner");
  }
  if (!/Node\.js v\d+\.\d+\.\d+ is installed\. OK/.test(output)) {
    failures.push("the wrapper's Node.js check did not report the installed version");
  }
  return { failures, output };
}

/** Kill a cmd.exe child and everything it started (npm → node → server). */
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
}

async function runStart() {
  banner(`▸ ${START} -NoPause (start the app through the wrapper, then check /healthz)`);
  const child = spawn("cmd.exe", ["/d", "/c", START, "-NoPause"], {
    cwd: repoRoot,
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  const failures = [];
  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), START_TIMEOUT_MS);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = READY_RE.exec(output);
      if (match) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve(match[1]);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? null : `__exited:${code}`);
    });
  });

  try {
    if (ready === null) {
      failures.push(`the ready line never appeared within ${START_TIMEOUT_MS / 1000}s`);
    } else if (typeof ready === "string" && ready.startsWith("__exited:")) {
      failures.push(`the wrapper exited early (${ready.slice("__exited:".length)}) before the app was ready`);
    } else {
      if (!/ui:\s+http:\/\/\S+/.test(output)) failures.push("the banner did not print the ui: address");
      const response = await fetch(`${ready}/healthz`);
      if (response.status !== 200) failures.push(`/healthz answered ${response.status} (expected 200)`);
      else console.log(`  ✓ ${ready}/healthz answered 200 through ${START}`);
    }
  } finally {
    killTree(child);
    await new Promise((resolve) => setTimeout(resolve, 750)); // let taskkill finish
  }
  return { failures, output };
}

async function main() {
  console.log("windows-runner launcher smoke test");
  if (process.platform !== "win32") {
    console.log(`  skipped: the double-click launchers are Windows-only (running on ${process.platform}).`);
    console.log("  CI runs this in the Platform (windows-latest) leg.");
    return 0;
  }
  if (spawnSync("cmd.exe", ["/d", "/c", "exit", "0"]).status !== 0) {
    console.error("  cmd.exe is not available");
    return 1;
  }

  const failures = [];
  const setup = runSetup();
  if (setup.output.trim() !== "") console.log(setup.output.trimEnd());
  failures.push(...setup.failures);
  if (setup.failures.length === 0) console.log(`  ✓ ${SETUP} completed the full setup through the wrapper`);

  const start = await runStart();
  failures.push(...start.failures);
  if (start.failures.length === 0) console.log(`  ✓ ${START} started the app and shut down cleanly`);

  if (failures.length > 0) {
    console.error("\nLauncher smoke test FAILED:");
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    console.error("\nLast wrapper output:\n" + (start.output || setup.output).slice(-2000));
    return 1;
  }
  console.log("\nLauncher smoke test passed.");
  return 0;
}

process.exitCode = await main();
