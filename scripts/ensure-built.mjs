#!/usr/bin/env node
/**
 * windows-runner — `prestart` hook.
 *
 * `npm start` runs the compiled server entry, packages/server/dist/index.js.
 * This hook makes that command work on a fresh checkout without a separate
 * build step, and refuses to start stale code after `src/` changes:
 *
 *   - build outputs missing            -> run `npm run build`
 *   - any src/**\/*.ts newer than dist  -> run `npm run build`
 *   - up to date                       -> exit 0 silently
 *
 * It only ever *builds*; it never starts anything. In an installed package
 * (no src/, no TypeScript) a missing dist/ is reported as an error instead of
 * attempting a build that cannot succeed.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(repoRoot, "package.json"));

/** Build outputs `npm start` needs, in dependency order. */
const OUTPUTS = [
  "packages/shared/dist/index.js",
  "packages/server/dist/index.js",
  "packages/server/dist/index.cjs",
];

/** Source trees whose changes must invalidate the outputs above. */
const SOURCES = ["packages/shared/src", "packages/server/src"];

function newestMtime(dir) {
  let newest = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (/\.[cm]?ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
        const mtime = statSync(full).mtimeMs;
        if (mtime > newest) newest = mtime;
      }
    }
  }
  return newest;
}

function reason() {
  const missing = OUTPUTS.filter((o) => !existsSync(path.join(repoRoot, o)));
  if (missing.length > 0) return `build output missing: ${missing.join(", ")}`;

  const sourceDirs = SOURCES.filter((s) => existsSync(path.join(repoRoot, s)));
  if (sourceDirs.length === 0) return null; // installed package: nothing to compare against

  const newestSource = Math.max(...sourceDirs.map((s) => newestMtime(path.join(repoRoot, s))));
  const oldestOutput = Math.min(...OUTPUTS.map((o) => statSync(path.join(repoRoot, o)).mtimeMs));
  if (newestSource > oldestOutput) return "sources changed since the last build";
  return null;
}

function canBuild() {
  for (const tool of ["typescript", "esbuild"]) {
    try {
      require.resolve(tool);
    } catch {
      return false;
    }
  }
  return true;
}

function main() {
  const why = reason();
  if (why === null) return 0;

  if (!canBuild()) {
    console.error(`windows-runner: ${why}, and no TypeScript toolchain is installed to rebuild.`);
    console.error("  In a source checkout run `npm ci` first. In an installed package this means");
    console.error("  the artifact is incomplete — see docs/INSTALL.md, \"Known packaging gaps\".");
    return 1;
  }

  console.log(`windows-runner: ${why}; running npm run build…`);
  const build = spawnSync("npm", ["run", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (build.error) {
    console.error(`windows-runner: could not run npm: ${build.error.message}`);
    return 1;
  }
  if (build.status !== 0) {
    console.error(`windows-runner: build failed (exit ${build.status}); not starting.`);
    return build.status ?? 1;
  }
  return 0;
}

process.exitCode = main();
