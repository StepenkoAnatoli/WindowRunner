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
import { spawnSync } from "node:child_process";
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
    it("declares the three packages the root scripts fan out to", () => {
      assert.deepEqual(workspaces, ["packages/shared", "packages/server", "packages/web"]);
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

    it("does not declare a bin whose target is missing", () => {
      if (root.bin === undefined) return; // No CLI shipped; documented as gap G-01.
      const targets = typeof root.bin === "string" ? [root.bin] : Object.values(root.bin);
      for (const target of targets) {
        assert.ok(exists(target.replace(/^\.\//, "")), `bin target ${target} does not exist`);
      }
    });

    it("every files[] entry exists or is a declared build output", () => {
      const buildOutputs = workspaces.map((ws) => `${ws}/dist/`);
      const runtimeOutput = "packages/server/dist/index.cjs";
      for (const entry of root.files ?? []) {
        if (buildOutputs.includes(entry)) {
          // A workspace dist/ entry is produced by `npm run build`, which the
          // workspace must declare. The runtime package intentionally ships a
          // single bundled entry instead of all development dist/ modules.
          const ws = entry.replace(/\/dist\/$/, "");
          assert.ok(
            readManifest(path.join(ws, "package.json")).scripts?.build,
            `${entry} is listed in files[] but ${ws} has no build script`
          );
          continue;
        }
        if (entry === runtimeOutput) {
          assert.ok(
            readManifest("packages/server/package.json").scripts?.build,
            `${entry} is listed in files[] but the server has no build script`
          );
          continue;
        }
        assert.ok(exists(entry), `files[] lists "${entry}", which does not exist`);
      }
      assert.ok(root.files?.includes(runtimeOutput), `files[] must include the bundled runtime ${runtimeOutput}`);
      assert.ok(!root.files?.includes("packages/server/dist/"), "files[] must not publish the unbundled server dist tree");
    });

    it("`npm start` runs the server workspace's compiled entry and pre-checks the build", () => {
      // The boot entry point is packages/server/src/index.ts; `start` must run
      // its compiled output, and `prestart` must be the ensure-built hook so a
      // fresh checkout and a stale checkout both start the right code.
      assert.equal(root.scripts?.start, "node packages/server/dist/index.cjs");
      assert.equal(root.scripts?.prestart, "node scripts/ensure-built.mjs");
      assert.ok(exists("packages/server/src/index.ts"), "server boot entry packages/server/src/index.ts is missing");

      const server = readManifest("packages/server/package.json");
      assert.equal(server.scripts?.start, "node dist/index.cjs", "server workspace must declare a start script for its bundled dist");
      assert.match(server.scripts?.dev ?? "", /src\/index\.ts/, "server dev script must run the boot entry, not the app factory");
    });

    it("makes the bundled CJS entry the documented runtime contract", () => {
      const server = readManifest("packages/server/package.json");
      assert.match(server.scripts?.build ?? "", /bundle-server\.mjs/, "server build must emit the self-contained bundle");
      assert.ok(exists("scripts/bundle-server.mjs"), "bundle build script is missing");
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

    it("declares packed-content, installed-runtime and checkout startup smoke tests", () => {
      assert.equal(root.scripts?.["smoke:start"], "node scripts/smoke-start.mjs");
      assert.equal(root.scripts?.["smoke:packed"], "node scripts/smoke-packed.mjs");
      assert.equal(root.scripts?.["smoke:runtime"], "node scripts/smoke-runtime.mjs");
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

    it("runs typecheck, test, build, the packed-artifact smoke test and the startup smoke test", () => {
      const text = fs.readFileSync(path.join(repoRoot, workflowPath), "utf8");
      for (const command of ["npm run typecheck", "npm test", "npm run build", "npm run smoke:packed", "npm run smoke:runtime", "npm run smoke:start"]) {
        assert.match(text, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `CI does not run \`${command}\``);
      }
    });

    it("runs the startup smoke test after the build it depends on", () => {
      const text = fs.readFileSync(path.join(repoRoot, workflowPath), "utf8");
      const build = text.indexOf("npm run build");
      const packed = text.indexOf("npm run smoke:packed");
      const runtime = text.indexOf("npm run smoke:runtime");
      const start = text.indexOf("npm run smoke:start");
      assert.ok(
        build >= 0 && packed >= 0 && runtime >= 0 && start >= 0 && build < packed && build < runtime && build < start,
        "all artifact/startup smoke tests must come after the build step"
      );
    });
  });
});
