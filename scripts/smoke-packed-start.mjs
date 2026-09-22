#!/usr/bin/env node
/**
 * windows-runner — packed-tarball smoke test for `npm start`.
 *
 * Packs the root package into a tarball as `npm publish` would, unpacks it into
 * a clean temporary directory completely outside the repository tree, and runs
 * `npm start` to prove that the packaged artifact can boot and serve health
 * requests without repository-only symlinks or dependencies.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { removeTempPathSync } from "./temp-path.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const READY_RE = /^windows-runner listening on (http:\/\/\S+)$/m;
const READY_TIMEOUT_MS = 20_000;
const EXIT_TIMEOUT_MS = 10_000;
const IS_WINDOWS = process.platform === "win32";

class SmokeFailure extends Error {}

function assert(condition, message) {
  if (!condition) throw new SmokeFailure(message);
}

function step(message) {
  console.log(`  ✓ ${message}`);
}

function ensureBuilt() {
  const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "ensure-built.mjs")], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  return result.status === 0;
}

function packTarball(destDir) {
  const pack = spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", destDir], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: IS_WINDOWS,
  });
  assert(pack.status === 0, `npm pack failed: ${pack.stderr || pack.stdout}`);
  const parsed = JSON.parse(pack.stdout);
  const tarballName = (Array.isArray(parsed) ? parsed[0] : parsed).filename;
  const tarballPath = path.join(destDir, tarballName);
  assert(existsSync(tarballPath), `tarball ${tarballName} not found at ${tarballPath}`);
  return tarballPath;
}

async function main() {
  console.log("windows-runner packed-tarball npm start smoke test");

  if (!ensureBuilt()) {
    console.error("\nBuild failed; cannot smoke-test packed tarball.");
    return 1;
  }

  const tmp = mkdtempSync(path.join(os.tmpdir(), "wr-smoke-packed-start-"));
  let child = null;

  try {
    const tarballPath = packTarball(tmp);
    step(`packed tarball: ${path.basename(tarballPath)}`);

    // Extract by relative name with cwd=tmp: absolute Windows paths (C:\…)
    // make bsdtar parse the drive letter as a remote host ("Cannot connect
    // to C: resolve failed"). The tarball is inside tmp (pack-destination),
    // so the bare filename suffices on every OS.
    const unpack = spawnSync("tar", ["-xzf", path.basename(tarballPath)], {
      cwd: tmp,
      shell: IS_WINDOWS,
      encoding: "utf8",
    });
    assert(unpack.status === 0, `tar -xzf failed: ${unpack.stderr}`);

    // npm pack puts everything in 'package/' inside the tarball
    const pkgDir = path.join(tmp, "package");
    assert(existsSync(path.join(pkgDir, "package.json")), "package.json missing from unpacked tarball");
    assert(existsSync(path.join(pkgDir, "packages", "server", "dist", "index.cjs")), "index.cjs missing from unpacked tarball");
    step("unpacked tarball into isolated temporary directory");

    // Spawn npm start in pkgDir
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === "PORT" || k === "HOST" || k.startsWith("WINDOWS_RUNNER_")) continue;
      env[k] = v;
    }
    env.PORT = "0";
    env.HOST = "127.0.0.1";
    env.WINDOWS_RUNNER_PERSISTENCE_MODE = "memory";
    env.WINDOWS_RUNNER_AUTH_TOKEN = "smoke-packed-token-0123456789abcdef";

    child = spawn("npm", ["start"], {
      cwd: pkgDir,
      env,
      detached: !IS_WINDOWS,
      stdio: ["ignore", "pipe", "pipe"],
      shell: IS_WINDOWS,
    });

    const output = { stdout: "", stderr: "" };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => (output.stdout += chunk));
    child.stderr?.on("data", (chunk) => (output.stderr += chunk));

    const exited = new Promise((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });

    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new SmokeFailure(`server did not print the ready line within ${READY_TIMEOUT_MS}ms\nStdout:\n${output.stdout}\nStderr:\n${output.stderr}`));
      }, READY_TIMEOUT_MS);

      const check = () => {
        const match = READY_RE.exec(output.stdout);
        if (match) {
          clearTimeout(timer);
          child.stdout?.off("data", check);
          resolve(match[1]);
        }
      };
      child.stdout?.on("data", check);
      exited.then(({ code, signal }) => {
        clearTimeout(timer);
        reject(new SmokeFailure(`server exited before ready (code ${code}, signal ${signal})\nStdout:\n${output.stdout}\nStderr:\n${output.stderr}`));
      });
    });

    const baseUrl = await ready;
    step(`server ready in packed tarball: ${baseUrl}`);

    // Probe /healthz
    const res = await fetch(`${baseUrl}/healthz`);
    assert(res.status === 200, `/healthz returned ${res.status}`);
    const body = await res.json();
    assert(body.status === "ok", `/healthz returned status ${body.status}`);
    step("/healthz responds ok");

    // Probe /api/health
    const unauth = await fetch(`${baseUrl}/api/health`);
    assert(unauth.status === 401, `/api/health without a token returned ${unauth.status}, expected 401`);
    const healthRes = await fetch(`${baseUrl}/api/health`, { headers: { authorization: `Bearer ${env.WINDOWS_RUNNER_AUTH_TOKEN}` } });
    assert(healthRes.status === 200, `/api/health returned ${healthRes.status}`);
    step("/api/health responds ok with the bearer token (401 without)");

    // The web UI ships in the tarball (packages/web/dist/app) and is served
    // at / without a token; the token is only required under /api.
    const ui = await fetch(`${baseUrl}/`);
    assert(ui.status === 200, `/ returned ${ui.status}, expected 200 (web UI missing from tarball?)`);
    assert(/text\/html/.test(ui.headers.get("content-type") ?? ""), `/ content-type ${ui.headers.get("content-type")}`);
    assert(ui.headers.get("cache-control") === "no-store", `/ cache-control ${ui.headers.get("cache-control")}`);
    assert(/app\.js/.test(await ui.text()), "/ did not reference app.js");
    const js = await fetch(`${baseUrl}/app.js`);
    assert(js.status === 200, `/app.js returned ${js.status}`);
    step("web UI served at / (index.html + app.js) from the packed tarball");

    // Shutdown gracefully. On Windows shell:true wraps npm in cmd.exe, so plain
    // child.kill() only terminates cmd and leaves node running as an orphan —
    // which keeps serving and locks the temp dir (EBUSY on cleanup). taskkill
    // /T kills the whole tree (cmd + npm + node).
    if (IS_WINDOWS) {
      const kill = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { encoding: "utf8" });
      if (kill.status !== 0) child.kill();
    } else {
      process.kill(-child.pid, "SIGTERM");
    }

    const { code, signal } = await Promise.race([
      exited,
      new Promise((_, reject) =>
        setTimeout(() => reject(new SmokeFailure(`server did not exit within ${EXIT_TIMEOUT_MS}ms`)), EXIT_TIMEOUT_MS)
      ),
    ]);
    assert(code === 0 || signal === "SIGTERM" || signal === null, `expected exit on SIGTERM, got code ${code} signal ${signal}`);
    step("server stopped gracefully");

    child = null;
    console.log("\nPacked-tarball smoke test passed.");
    return 0;
  } catch (err) {
    console.error(`\nPacked-tarball smoke test FAILED: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    if (child && child.exitCode === null) {
      try {
        if (IS_WINDOWS) {
          const kill = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
          if (kill.status !== 0) child.kill();
        } else process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    removeTempPathSync(tmp);
  }
}

process.exitCode = await main();
