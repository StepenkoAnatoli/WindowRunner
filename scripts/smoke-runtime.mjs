#!/usr/bin/env node
/**
 * windows-runner — installed runtime smoke test.
 *
 * Builds the self-contained server bundle, packs the root package, installs the
 * tarball into a clean temporary consumer with lifecycle scripts enabled, and
 * runs `npm start` from the installed package directory. This is deliberately
 * separate from smoke:start: that script proves the compiled checkout entry,
 * while this one proves the distribution has no source-tree or workspace
 * dependency at runtime.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const isWindows = process.platform === "win32";
const READY_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 10_000;

class SmokeFailure extends Error {}

function assert(condition, message) {
  if (!condition) throw new SmokeFailure(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
    shell: isWindows,
    ...options,
  });
  if (result.error) throw new SmokeFailure(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new SmokeFailure(
      `${command} ${args.join(" ")} exited ${result.status}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`
    );
  }
  return result;
}

function packTarball() {
  const result = run(npmCommand, ["pack", "--json", "--ignore-scripts", "--no-audit", "--no-fund"]);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new SmokeFailure(`could not parse npm pack output: ${error.message}\n${result.stdout}`);
  }
  const metadata = Array.isArray(parsed) ? parsed[0] : parsed;
  assert(metadata?.filename, "npm pack returned no tarball filename");
  const tarball = path.resolve(repoRoot, metadata.filename);
  assert(existsSync(tarball), `npm pack did not write ${tarball}`);
  return tarball;
}

function waitForExit(exited, timeoutMs) {
  return Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new SmokeFailure(`process did not exit within ${timeoutMs}ms`)), timeoutMs)),
  ]);
}

function startInstalledServer(installed, env) {
  const child = spawn(npmCommand, ["start"], {
    cwd: installed,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: isWindows,
    detached: !isWindows,
  });
  const output = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output.stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output.stderr += chunk;
  });
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new SmokeFailure(`installed server did not print a ready line within ${READY_TIMEOUT_MS}ms`)), READY_TIMEOUT_MS);
    const check = () => {
      const match = /windows-runner listening on (http:\/\/\S+)/.exec(output.stdout);
      if (!match) return;
      clearTimeout(timer);
      child.stdout.off("data", check);
      resolve(match[1]);
    };
    child.stdout.on("data", check);
    exited.then(({ code, signal }) => {
      clearTimeout(timer);
      reject(new SmokeFailure(`installed server exited before ready (code ${code}, signal ${signal})`));
    });
  });
  ready.catch(() => {});

  return { child, output, exited, ready };
}

function stopInstalledServer(handle) {
  if (handle.child.exitCode !== null) return waitForExit(handle.exited, EXIT_TIMEOUT_MS);
  if (isWindows) {
    handle.child.kill();
  } else {
    // Send SIGTERM to the node process that `npm start` launched, rather than
    // to npm's wrapper. The wrapper can otherwise report signal termination
    // even when the server itself drained and exited 0.
    const match = /windows-runner v[^\n]*pid (\d+)/.exec(handle.output.stdout);
    try {
      if (match) process.kill(Number(match[1]), "SIGTERM");
      else process.kill(-handle.child.pid, "SIGTERM");
    } catch {
      handle.child.kill("SIGTERM");
    }
  }
  return waitForExit(handle.exited, EXIT_TIMEOUT_MS);
}

async function readSse(url) {
  const response = await fetch(url);
  assert(response.status === 200, `SSE returned ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text
    .split("\n\n")
    .map((block) => block.split("\n").find((line) => line.startsWith("data: ")))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

async function main() {
  console.log("windows-runner installed-runtime smoke test");
  const runtimeEntry = path.join(repoRoot, "packages", "server", "dist", "index.cjs");
  if (!existsSync(runtimeEntry)) {
    console.log("  bundled runtime is missing; running npm run build…");
    run(npmCommand, ["run", "build"]);
  }

  const temp = mkdtempSync(path.join(tmpdir(), "wr-runtime-"));
  const consumer = path.join(temp, "consumer");
  const project = path.join(temp, "project");
  const dataDir = path.join(temp, "data");
  mkdirSync(consumer, { recursive: true });
  mkdirSync(project, { recursive: true });
  let tarball;
  let handle;

  try {
    tarball = packTarball();
    console.log(`  tarball: ${path.basename(tarball)}`);

    // Lifecycle scripts are intentionally enabled: postinstall must recognize
    // a packed runtime artifact without demanding source workspaces or dev tools.
    run(npmCommand, ["install", "--no-audit", "--no-fund", tarball], { cwd: consumer });
    const installed = path.join(consumer, "node_modules", "windows-runner");
    assert(existsSync(path.join(installed, "packages", "server", "dist", "index.cjs")), "installed tarball has no runtime bundle");
    assert(!existsSync(path.join(installed, "packages", "server", "src")), "installed tarball unexpectedly contains server sources");
    assert(!existsSync(path.join(installed, "node_modules")), "installed runtime unexpectedly carries a nested node_modules tree");
    console.log("  clean install: lifecycle passed outside the source tree (no nested runtime dependencies)");

    const env = {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "0",
      WINDOWS_RUNNER_HOME: project,
      WINDOWS_RUNNER_ALLOWED_ROOTS: project,
      WINDOWS_RUNNER_PERSISTENCE_MODE: "file",
      WINDOWS_RUNNER_DATA_DIR: dataDir,
      WINDOWS_RUNNER_SHUTDOWN_GRACE_MS: "3000",
    };
    handle = startInstalledServer(installed, env);
    const base = await handle.ready;
    console.log(`  npm start: ${base}`);

    const health = await fetch(`${base}/healthz`);
    assert(health.status === 200, `installed /healthz returned ${health.status}`);
    assert((await health.json()).status === "ok", "installed /healthz did not return ok");

    const started = await fetch(`${base}/api/sessions/packed/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: project, message: "packed runtime smoke" }),
    });
    if (started.status !== 202) {
      throw new SmokeFailure(`installed POST /turns returned ${started.status}: ${await started.text()}`);
    }
    const { turnId } = await started.json();
    const events = await readSse(`${base}/api/sessions/packed/turns/${turnId}/events`);
    assert(events.length > 0 && events[events.length - 1].type === "turn_completed", "installed turn did not complete");
    assert(events.some((event) => event.type === "text_delta"), "installed turn emitted no text_delta");
    console.log(`  turn ${turnId}: bundled server completed a mock turn over SSE`);

    const result = await stopInstalledServer(handle);
    assert(isWindows || (result.code === 0 && result.signal === null), `installed npm start did not exit cleanly: code ${result.code}, signal ${result.signal}`);
    if (!isWindows) assert(handle.output.stdout.includes("windows-runner: stopped"), "installed shutdown did not log stopped");
    console.log(isWindows ? "  shutdown: process terminated (Windows graceful signal not asserted)" : "  shutdown: SIGTERM -> exit 0");
    handle = null;

    console.log("\nInstalled-runtime smoke test passed.");
    return 0;
  } catch (error) {
    console.error(`\nInstalled-runtime smoke test FAILED: ${error instanceof Error ? error.message : String(error)}`);
    if (handle) {
      console.error("\n--- installed stdout ---\n" + handle.output.stdout);
      console.error("--- installed stderr ---\n" + handle.output.stderr);
    }
    return 1;
  } finally {
    if (handle && handle.child.exitCode === null) {
      if (isWindows) handle.child.kill();
      else {
        try {
          process.kill(-handle.child.pid, "SIGKILL");
        } catch {
          handle.child.kill("SIGKILL");
        }
      }
      await handle.exited.catch(() => {});
    }
    if (tarball) rmSync(tarball, { force: true });
    rmSync(temp, { recursive: true, force: true });
  }
}

process.exitCode = await main();
