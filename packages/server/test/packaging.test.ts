/**
 * Packaging contract.
 *
 * Every failure mode in here was real: the root manifest declared a `bin` that
 * did not exist, fanned `build`/`test`/`typecheck` out to workspaces that did
 * not declare those scripts, listed `files[]` entries that could not be
 * produced, referenced `scripts/*.mjs` that were absent (which made a plain
 * `npm ci` fail with MODULE_NOT_FOUND), and CI had to install with
 * `--ignore-scripts` to get past it.
 *
 * These tests pin the contract so the manifests cannot drift away from the
 * repository again without a red suite. See docs/INSTALL.md.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

interface Manifest {
  name?: string;
  bin?: string | Record<string, string>;
  files?: string[];
  workspaces?: string[];
  scripts?: Record<string, string>;
  engines?: { node?: string };
  devDependencies?: Record<string, string>;
}

function readManifest(relative: string): Manifest {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relative), "utf8")) as Manifest;
}

function exists(relative: string): boolean {
  return fs.existsSync(path.join(repoRoot, relative));
}

/** Scripts the root manifest fans out to, per workspace. */
const FANOUT_SCRIPTS = ["build", "test", "typecheck"] as const;

describe("Packaging contract", () => {
  const root = readManifest("package.json");
  const workspaces = root.workspaces ?? [];

  describe("workspaces", () => {
    it("declares the complete workspace list", () => {
      // packages/desktop joins the workspaces in PR A. The root build/test/
      // typecheck fan-out deliberately stays on the three server-side packages
      // until the desktop suite is proven stable on Linux CI (plan item 11);
      // every workspace must still declare those scripts (next test).
      assert.deepEqual(workspaces, ["packages/shared", "packages/server", "packages/web", "packages/desktop"]);
    });

    it("every workspace exists and declares each fan-out script", () => {
      for (const ws of workspaces) {
        assert.ok(exists(path.join(ws, "package.json")), `${ws}/package.json is missing`);
        const manifest = readManifest(path.join(ws, "package.json"));
        for (const script of FANOUT_SCRIPTS) {
          assert.ok(
            manifest.scripts?.[script],
            `${ws} declares no "${script}" script, so root \`npm run ${script}\` fails`
          );
        }
      }
    });

    it("each workspace build compiles a source-only tsconfig", () => {
      for (const ws of workspaces) {
        const buildCommand = readManifest(path.join(ws, "package.json")).scripts?.build ?? "";
        const match = /-p\s+(\S+\.json)/.exec(buildCommand);
        assert.ok(match, `${ws} build does not name a tsconfig: "${buildCommand}"`);

        const configPath = path.join(ws, match![1]);
        assert.ok(fs.existsSync(path.join(repoRoot, configPath)), `${configPath} is missing`);

        const config = JSON.parse(fs.readFileSync(path.join(repoRoot, configPath), "utf8"));
        // Shipping tests inside dist/ is how the previous build leaked
        // dist/server/test/** into the package.
        assert.ok(
          Array.isArray(config.include) && config.include.every((entry: string) => entry !== "test"),
          `${configPath} must not include "test"`
        );
        assert.equal(
          config.compilerOptions?.rootDir,
          "src",
          `${configPath} must pin rootDir so dist/ stays flat`
        );
      }
    });
  });

  describe("root manifest paths", () => {
    it("every `node scripts/*.mjs` target exists", () => {
      for (const [name, command] of Object.entries(root.scripts ?? {})) {
        for (const match of String(command).matchAll(/node\s+(scripts\/[\w.-]+\.mjs)/g)) {
          assert.ok(exists(match[1]), `script "${name}" references missing ${match[1]}`);
        }
      }
    });

    it("every --workspace target exists", () => {
      for (const [name, command] of Object.entries(root.scripts ?? {})) {
        for (const match of String(command).matchAll(/--workspace\s+(?:=)?([\w./-]+)/g)) {
          const target = match[1];
          if (target.startsWith("packages/")) {
            assert.ok(exists(target), `script "${name}" targets missing workspace ${target}`);
          }
        }
      }
    });

    it("declares executable CLI entry points that exist on disk and in files[]", () => {
      assert.ok(root.bin, "root package.json must declare bin");
      const targets = typeof root.bin === "string" ? [root.bin] : Object.values(root.bin);
      for (const target of targets) {
        assert.ok(exists(target.replace(/^\.\//, "")), `bin target ${target} does not exist`);
      }
      assert.ok(root.files?.includes("bin/"), "files[] must include bin/");
    });

    it("every files[] entry exists or is a declared build output", () => {
      const buildOutputs = workspaces.map((ws) => `${ws}/dist/`);
      for (const entry of root.files ?? []) {
        if (buildOutputs.includes(entry)) {
          // dist/ is produced by `npm run build`, which the workspace must declare.
          const ws = entry.replace(/\/dist\/$/, "");
          assert.ok(
            readManifest(path.join(ws, "package.json")).scripts?.build,
            `${entry} is listed in files[] but ${ws} has no build script`
          );
          continue;
        }
        assert.ok(exists(entry), `files[] lists "${entry}", which does not exist`);
      }
    });

    it("`npm start` runs the server workspace's compiled entry and pre-checks the build", () => {
      // The boot entry point is packages/server/src/index.ts; `start` must run
      // its compiled output, and `prestart` must be the ensure-built hook so a
      // fresh checkout and a stale checkout both start the right code.
      assert.equal(root.scripts?.start, "node packages/server/dist/index.cjs");
      assert.equal(root.scripts?.prestart, "node scripts/ensure-built.mjs");
      assert.ok(exists("packages/server/src/index.ts"), "server boot entry packages/server/src/index.ts is missing");

      const server = readManifest("packages/server/package.json");
      assert.equal(server.scripts?.start, "node dist/index.cjs", "server workspace must declare a start script for its own dist");
      assert.match(server.scripts?.dev ?? "", /src\/index\.ts/, "server dev script must run the boot entry, not the app factory");
    });

    it("ships the prestart hook alongside postinstall in files[]", () => {
      // Every scripts/*.mjs that a lifecycle script of the *published* package
      // can invoke must be in the tarball, or `npm start` in an installed
      // package dies with MODULE_NOT_FOUND — the same defect class as the
      // missing postinstall hook.
      for (const hook of ["scripts/postinstall.mjs", "scripts/ensure-built.mjs"]) {
        assert.ok(root.files?.includes(hook), `files[] must include ${hook}`);
      }
    });

    it("declares the startup and packed smoke tests", () => {
      assert.equal(root.scripts?.["smoke:start"], "node scripts/smoke-start.mjs");
      assert.equal(root.scripts?.["smoke:packed"], "node scripts/smoke-packed.mjs");
      assert.equal(root.scripts?.["smoke:packed:start"], "node scripts/smoke-packed-start.mjs");
    });

    it("does not depend on tooling no script uses", () => {
      const declared = Object.keys(root.devDependencies ?? {});
      const allScripts = Object.values(root.scripts ?? {}).join(" ");
      for (const dependency of declared) {
        assert.ok(
          allScripts.includes(dependency),
          `devDependency "${dependency}" is not referenced by any root script`
        );
      }
    });
  });

  describe("postinstall lifecycle", () => {
    const script = path.join(repoRoot, "scripts", "postinstall.mjs");

    it("exists, so a plain `npm ci` can run the lifecycle", () => {
      assert.ok(fs.existsSync(script), "scripts/postinstall.mjs is missing");
    });

    it("verifies this checkout and exits 0", () => {
      const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
      assert.equal(result.status, 0, `postinstall failed:\n${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /install verified/);
    });

    it("honors WINDOWS_RUNNER_SKIP_POSTINSTALL", () => {
      const result = spawnSync(process.execPath, [script], {
        encoding: "utf8",
        env: { ...process.env, WINDOWS_RUNNER_SKIP_POSTINSTALL: "1" },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /skipped/);
    });

    it("treats a falsy skip value as 'do verify'", () => {
      const result = spawnSync(process.execPath, [script], {
        encoding: "utf8",
        env: { ...process.env, WINDOWS_RUNNER_SKIP_POSTINSTALL: "0" },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /install verified/);
    });

    it("fails loudly when the install contract is broken", async () => {
      const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "wr-postinstall-"));
      try {
        await fsp.mkdir(path.join(tmp, "scripts"), { recursive: true });
        await fsp.copyFile(script, path.join(tmp, "scripts", "postinstall.mjs"));
        // A manifest that references a script that is not there and declares no
        // workspaces: exactly the shape that broke `npm ci` on main.
        await fsp.writeFile(
          path.join(tmp, "package.json"),
          JSON.stringify({
            name: "broken",
            engines: { node: ">=20.10" },
            workspaces: [],
            scripts: { setup: "node scripts/does-not-exist.mjs" },
          })
        );

        const result = spawnSync(process.execPath, [path.join(tmp, "scripts", "postinstall.mjs")], {
          encoding: "utf8",
          env: { ...process.env, WINDOWS_RUNNER_SKIP_POSTINSTALL: "" },
        });
        assert.equal(result.status, 1, "postinstall should reject a broken tree");
        assert.match(result.stderr, /does-not-exist\.mjs/);
        assert.match(result.stderr, /no workspaces/);
      } finally {
        await fsp.rm(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("documentation references", () => {
    /**
     * Docs that install surfaces mention precisely in order to say they are
     * absent. The second test in this block asserts each one really is missing,
     * so this list cannot quietly go stale in either direction: add the file and
     * the test tells you to remove it from here.
     */
    const KNOWN_ABSENT = ["docs/THREAT_MODEL.md"];

    it("docs referenced by the installers and Dockerfile exist", () => {
      const surfaces = ["Dockerfile", "install.sh", "install.ps1", "README.md"];
      for (const surface of surfaces) {
        assert.ok(exists(surface), `${surface} is missing`);
        const text = fs.readFileSync(path.join(repoRoot, surface), "utf8");
        for (const match of text.matchAll(/docs\/[\w./-]+\.md/g)) {
          if (KNOWN_ABSENT.includes(match[0])) continue;
          assert.ok(exists(match[0]), `${surface} references missing ${match[0]}`);
        }
      }
    });

    it("docs listed as absent are still absent", () => {
      for (const doc of KNOWN_ABSENT) {
        assert.ok(
          !exists(doc),
          `${doc} now exists — remove it from KNOWN_ABSENT and restore the references that were rewritten around it`
        );
      }
    });

    it("docs/INSTALL.md records the packaging gaps the manifests no longer claim", () => {
      const text = fs.readFileSync(path.join(repoRoot, "docs", "INSTALL.md"), "utf8");
      for (const gap of ["G-01", "G-02", "G-03", "G-04", "G-05", "G-06"]) {
        assert.match(text, new RegExp(gap), `docs/INSTALL.md must document ${gap}`);
      }
    });
  });

  describe("installer scripts", () => {
    it("install.ps1 starts with a UTF-8 BOM so Windows PowerShell parses it", () => {
      // Windows PowerShell 5.1 reads a BOM-less script as Windows-1252, which
      // decodes this file's box-drawing/checkmark characters into bytes that
      // include U+201C/U+201D smart quotes — and 5.1 tokenizes those as string
      // delimiters, producing "Missing closing '}'" cascades. The BOM makes 5.1
      // decode UTF-8. This broke silently once already (Linux and macOS never
      // execute the script, and the failure is a parse error), so pin the BOM.
      const bytes = fs.readFileSync(path.join(repoRoot, "install.ps1"));
      assert.ok(
        bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
        "install.ps1 must start with the UTF-8 BOM (EF BB BF)"
      );
    });
  });

  describe("CI exercises the install lifecycle", () => {
    const workflowPath = ".github/workflows/ci.yml";

    it("has a workflow", () => {
      assert.ok(exists(workflowPath), `${workflowPath} is missing`);
    });

    it("installs without --ignore-scripts, so postinstall is validated", () => {
      const text = fs.readFileSync(path.join(repoRoot, workflowPath), "utf8");
      const installSteps = text
        .split("\n")
        .filter((line) => /^\s*run:\s*npm ci/.test(line));
      assert.ok(installSteps.length > 0, "CI has no `npm ci` step");
      for (const step of installSteps) {
        assert.ok(
          !step.includes("--ignore-scripts"),
          `CI still skips lifecycle scripts: ${step.trim()}`
        );
      }
    });

    it("runs typecheck, test, build, the packed-artifact smoke test, packed-tarball start test, the startup smoke test, the Docker compose stack and the Windows/macOS platform matrix", () => {
      const text = fs.readFileSync(path.join(repoRoot, workflowPath), "utf8");
      for (const command of [
        "npm run typecheck",
        "npm test",
        "npm run build",
        "npm run smoke:packed",
        "npm run smoke:packed:start",
        "npm run smoke:start",
        "docker compose up --build -d",
        "windows-latest",
        "macos-latest",
        "install.sh --no-start",
        "install.ps1 -NoStart",
      ]) {
        assert.match(text, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `CI does not run \`${command}\``);
      }
    });

    it("runs the startup smoke test after the build it depends on", () => {
      const text = fs.readFileSync(path.join(repoRoot, workflowPath), "utf8");
      const build = text.indexOf("npm run build");
      const smoke = text.indexOf("npm run smoke:start");
      assert.ok(build >= 0 && smoke >= 0 && build < smoke, "smoke:start must come after the build step");
    });
  });

  describe("clean-install artifact execution", () => {
    it("runs the self-contained bundle in an isolated directory outside the source tree", async () => {
      const bundleSource = path.join(repoRoot, "packages", "server", "dist", "index.cjs");
      assert.ok(fs.existsSync(bundleSource), "packages/server/dist/index.cjs must exist (run build first)");

      const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "wr-clean-install-"));
      try {
        const artifactPath = path.join(tmp, "index.cjs");
        await fsp.copyFile(bundleSource, artifactPath);

        // Verify no node_modules or package.json exist in this isolated dir
        assert.ok(!fs.existsSync(path.join(tmp, "node_modules")));
        assert.ok(!fs.existsSync(path.join(tmp, "package.json")));

        const child = spawn(process.execPath, [artifactPath], {
          cwd: tmp,
          env: {
            PATH: process.env.PATH,
            HOST: "127.0.0.1",
            PORT: "0",
            WINDOWS_RUNNER_PERSISTENCE_MODE: "memory",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => (stdout += chunk));

        const readyUrl = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`Timeout waiting for clean-install server ready.\nOutput: ${stdout}`)),
            15000
          );
          const check = () => {
            const match = /^windows-runner listening on (http:\/\/\S+)$/m.exec(stdout);
            if (match) {
              clearTimeout(timer);
              resolve(match[1]);
            }
          };
          child.stdout?.on("data", check);
          child.on("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`Server exited prematurely with code ${code}`));
          });
        });

        // Test health endpoint
        const res = await fetch(`${readyUrl}/healthz`);
        assert.equal(res.status, 200);
        const data = (await res.json()) as { status: string };
        assert.equal(data.status, "ok");

        // Stop gracefully. Windows has no SIGTERM delivery: the kill terminates
        // the process but the exit code is not the graceful-shutdown 0, so
        // there (as in boot.test.ts and smoke-start.mjs) the exit event itself
        // is the whole assertion.
        child.kill("SIGTERM");
        const exitCode = await new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
        if (process.platform !== "win32") {
          assert.equal(exitCode, 0);
        }
      } finally {
        await fsp.rm(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("ensure-built prestart hook", () => {
    const script = path.join(repoRoot, "scripts", "ensure-built.mjs");

    it("handles fresh/stale detection for web, dashboard, and public assets", async () => {
      const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "wr-ensure-built-"));
      try {
        await fsp.mkdir(path.join(tmp, "scripts"), { recursive: true });
        await fsp.copyFile(script, path.join(tmp, "scripts", "ensure-built.mjs"));

        // Symlink node_modules so canBuild() finds typescript and esbuild
        await fsp.symlink(path.join(repoRoot, "node_modules"), path.join(tmp, "node_modules"), "dir");

        await fsp.writeFile(
          path.join(tmp, "package.json"),
          JSON.stringify({
            name: "mock-runner",
            workspaces: ["packages/shared", "packages/server", "packages/web"],
            scripts: {
              build: "node -e 'process.stdout.write(\"mock-build-ran\\n\")'",
            },
          })
        );

        for (const dir of [
          "packages/shared/src",
          "packages/server/src",
          "packages/web/src",
          "packages/web/public",
          "packages/shared/dist",
          "packages/server/dist",
          "packages/web/dist/app",
          "packages/web/dist/dashboard",
        ]) {
          await fsp.mkdir(path.join(tmp, dir), { recursive: true });
        }

        const outputs = [
          "packages/shared/dist/index.js",
          "packages/server/dist/index.js",
          "packages/server/dist/index.cjs",
          "packages/web/dist/app/app.js",
          "packages/web/dist/app/index.html",
          "packages/web/dist/app/app.css",
          "packages/web/dist/dashboard/dashboard.js",
          "packages/web/dist/dashboard/dashboard.html",
          "packages/web/dist/dashboard/dashboard.css",
        ];
        for (const out of outputs) {
          await fsp.writeFile(path.join(tmp, out), "output-content");
        }

        const baseTime = Date.now();
        const oldTime = new Date(baseTime - 10000);
        const newTime = new Date(baseTime + 10000);

        await fsp.writeFile(path.join(tmp, "packages/web/src/main.ts"), "main");
        await fsp.writeFile(path.join(tmp, "packages/web/src/dashboard.ts"), "dash");
        await fsp.writeFile(path.join(tmp, "packages/web/public/app.css"), "css");

        fs.utimesSync(path.join(tmp, "packages/web/src/main.ts"), oldTime, oldTime);
        fs.utimesSync(path.join(tmp, "packages/web/src/dashboard.ts"), oldTime, oldTime);
        fs.utimesSync(path.join(tmp, "packages/web/public/app.css"), oldTime, oldTime);
        for (const out of outputs) {
          fs.utimesSync(path.join(tmp, out), new Date(baseTime), new Date(baseTime));
        }

        const runHook = () =>
          spawnSync(process.execPath, [path.join(tmp, "scripts", "ensure-built.mjs")], {
            cwd: tmp,
            encoding: "utf8",
          });

        // 1. Fully current outputs -> no rebuild
        const resCurrent = runHook();
        assert.equal(resCurrent.status, 0);
        assert.equal(resCurrent.stdout, "");

        // 2. Changed main.ts -> rebuilds
        fs.utimesSync(path.join(tmp, "packages/web/src/main.ts"), newTime, newTime);
        const resMain = runHook();
        assert.equal(resMain.status, 0);
        assert.match(resMain.stdout, /sources changed since the last build/);
        assert.match(resMain.stdout, /mock-build-ran/);
        fs.utimesSync(path.join(tmp, "packages/web/src/main.ts"), oldTime, oldTime);

        // 3. Changed dashboard.ts -> rebuilds
        fs.utimesSync(path.join(tmp, "packages/web/src/dashboard.ts"), newTime, newTime);
        const resDash = runHook();
        assert.equal(resDash.status, 0);
        assert.match(resDash.stdout, /sources changed since the last build/);
        assert.match(resDash.stdout, /mock-build-ran/);
        fs.utimesSync(path.join(tmp, "packages/web/src/dashboard.ts"), oldTime, oldTime);

        // 4. Changed app.css -> rebuilds
        fs.utimesSync(path.join(tmp, "packages/web/public/app.css"), newTime, newTime);
        const resCss = runHook();
        assert.equal(resCss.status, 0);
        assert.match(resCss.stdout, /sources changed since the last build/);
        assert.match(resCss.stdout, /mock-build-ran/);
        fs.utimesSync(path.join(tmp, "packages/web/public/app.css"), oldTime, oldTime);

        // 5. Missing dashboard bundle -> rebuilds
        await fsp.rm(path.join(tmp, "packages/web/dist/dashboard/dashboard.js"));
        const resMissing = runHook();
        assert.equal(resMissing.status, 0);
        assert.match(resMissing.stdout, /build output missing: packages\/web\/dist\/dashboard\/dashboard\.js/);
        assert.match(resMissing.stdout, /mock-build-ran/);
      } finally {
        await fsp.rm(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("standalone workspace builds", () => {
    // Deletes packages/shared/dist on purpose, so each workspace build has to
    // resolve @windows-runner/shared without it.
    //
    // This passes because the workspace link is the supported fallback when
    // shared/dist is absent: node_modules/@windows-runner/shared is a link to
    // packages/shared, whose "main" is src/index.ts, so tsc and esbuild resolve
    // shared from source even though tsconfig.build.json maps the import to
    // ../shared/dist/index.d.ts. Do not "fix" this test by adding a shared
    // prebuild hook to the workspace scripts — the fallback is the contract
    // being pinned here, and a redundant prebuild would hide its regressions.
    it("builds server and web packages independently from clean state without prior shared/dist", () => {
      const runWorkspaceBuild = (ws: string) =>
        spawnSync("npm", ["run", "build", "--workspace", ws], {
          cwd: repoRoot,
          encoding: "utf8",
          shell: process.platform === "win32",
        });

      // 1. Build server when shared/dist is absent
      const sharedDist = path.join(repoRoot, "packages", "shared", "dist");
      fs.rmSync(sharedDist, { recursive: true, force: true });
      assert.ok(!fs.existsSync(sharedDist), "packages/shared/dist should be deleted");

      const resServer = runWorkspaceBuild("packages/server");
      assert.equal(
        resServer.status,
        0,
        `npm run build --workspace packages/server failed from clean state:\n${resServer.stdout}\n${resServer.stderr}`
      );
      assert.ok(fs.existsSync(path.join(repoRoot, "packages", "server", "dist", "index.cjs")));

      // 2. Build web when shared/dist is absent
      fs.rmSync(sharedDist, { recursive: true, force: true });
      assert.ok(!fs.existsSync(sharedDist), "packages/shared/dist should be deleted");

      const resWeb = runWorkspaceBuild("packages/web");
      assert.equal(
        resWeb.status,
        0,
        `npm run build --workspace packages/web failed from clean state:\n${resWeb.stdout}\n${resWeb.stderr}`
      );
      assert.ok(fs.existsSync(path.join(repoRoot, "packages", "web", "dist", "app", "app.js")));
      assert.ok(fs.existsSync(path.join(repoRoot, "packages", "web", "dist", "dashboard", "dashboard.js")));
    });
  });
});
