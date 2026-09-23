#!/usr/bin/env node
/**
 * windows-runner — build-freshness hook for `npm start` and the desktop tests.
 *
 * Default mode (`prestart`): `npm start` runs the self-contained server bundle,
 * packages/server/dist/index.cjs. This hook makes that command work on a fresh
 * checkout without a separate build step, and refuses to start stale code after
 * `src/` changes:
 *
 *   - build outputs missing            -> run `npm run build`
 *   - any src/**\/*.ts newer than dist  -> run `npm run build`
 *   - up to date                       -> exit 0 silently
 *
 * `--desktop` (the desktop workspace's `pretest`): the same check for the root
 * outputs the desktop tests boot (shared + the server bundle), then for the
 * desktop shell under packages/desktop that they load.
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
const withDesktop = process.argv.includes("--desktop");

/** Build outputs `npm start` needs, in dependency order. */
const OUTPUTS = [
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

/** Source trees whose changes must invalidate the outputs above. */
const SOURCES = [
  "packages/shared/src",
  "packages/server/src",
  "packages/web/src",
  "packages/web/public",
];

/** The desktop shell its own tests load (paths below packages/desktop). */
const DESKTOP_OUTPUTS = ["dist/main.cjs", "dist/preload.cjs", "dist/renderer.js"];
const DESKTOP_SOURCES = ["src"];

function isTrackedSource(filename) {
  if (/\.[cm]?[jt]sx?$/.test(filename) && !/\.d\.ts$/.test(filename)) return true;
  if (/\.(html|css)$/.test(filename)) return true;
  return false;
}

function newestMtime(dir) {
  let newest = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (isTrackedSource(entry.name)) {
        const mtime = statSync(full).mtimeMs;
        if (mtime > newest) newest = mtime;
      }
    }
  }
  return newest;
}

/**
 * Why `root`'s outputs are stale, or null when they are current. A tree with no
 * source directory (an installed package) has nothing to compare against, so its
 * outputs are reported as current.
 */
function reason(root, outputs, sources) {
  const missing = outputs.filter((o) => !existsSync(path.join(root, o)));
  if (missing.length > 0) return `build output missing: ${missing.join(", ")}`;

  const sourceDirs = sources.filter((s) => existsSync(path.join(root, s)));
  if (sourceDirs.length === 0) return null;

  const newestSource = Math.max(...sourceDirs.map((s) => newestMtime(path.join(root, s))));
  const oldestOutput = Math.min(...outputs.map((o) => statSync(path.join(root, o)).mtimeMs));
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

/** `npm run build` in `cwd`; returns the exit code the hook should use. */
function runBuild(cwd, label) {
  const build = spawnSync("npm", ["run", "build"], {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (build.error) {
    console.error(`${label}: could not run npm: ${build.error.message}`);
    return 1;
  }
  if (build.status !== 0) {
    console.error(`${label}: build failed (exit ${build.status}); not starting.`);
    return build.status ?? 1;
  }
  return 0;
}

function main() {
  /** Root first: the desktop build consumes the server bundle the root build emits. */
  const targets = [
    { root: repoRoot, outputs: OUTPUTS, sources: SOURCES, label: "windows-runner" },
    ...(withDesktop
      ? [{ root: path.join(repoRoot, "packages", "desktop"), outputs: DESKTOP_OUTPUTS, sources: DESKTOP_SOURCES, label: "windows-runner desktop" }]
      : []),
  ];

  for (const target of targets) {
    const why = reason(target.root, target.outputs, target.sources);
    if (why === null) continue;

    if (!canBuild()) {
      console.error(`${target.label}: ${why}, and no TypeScript toolchain is installed to rebuild.`);
      console.error("  In a source checkout run `npm ci` first. In an installed package this means");
      console.error("  the artifact is incomplete — see docs/INSTALL.md, \"Known packaging gaps\".");
      return 1;
    }

    console.log(`${target.label}: ${why}; running npm run build…`);
    const status = runBuild(target.root, target.label);
    if (status !== 0) return status;
  }

  return 0;
}

process.exitCode = main();
