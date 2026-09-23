#!/usr/bin/env node
/**
 * @windows-runner/desktop — `pretest` hook.
 *
 * The desktop tests boot the REAL built backend (`packages/server/dist/index.cjs`)
 * and the compiled shell (`dist/main.cjs`), so running them on a fresh
 * checkout without a build used to fail with a bare assertion
 * ("missing dist/main.cjs — run npm run build first"). This hook makes
 * `npm test` self-sufficient, mirroring the root `scripts/ensure-built.mjs`:
 *
 *   - root build outputs missing/stale -> run the root `npm run build`
 *   - desktop outputs missing/stale    -> run the desktop `npm run build`
 *   - up to date                       -> exit 0 silently
 *
 * It only ever *builds*; it never launches Electron.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const require = createRequire(path.join(repoRoot, "package.json"));

/** Root build outputs the desktop tests need (backend + shared). */
const ROOT_OUTPUTS = [
  "packages/shared/dist/index.js",
  "packages/server/dist/index.cjs",
];

/** Build outputs the desktop workspace's own tests load. */
const DESKTOP_OUTPUTS = [
  "dist/main.cjs",
  "dist/preload.cjs",
  "dist/renderer.js",
];

/** Source trees whose changes must invalidate the desktop outputs. */
const DESKTOP_SOURCES = ["src"];

const ROOT_SOURCES = [
  "packages/shared/src",
  "packages/server/src",
  "packages/web/src",
  "packages/web/public",
];

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

function runBuild(cwd, label) {
  console.log(`desktop pretest: building ${label}…`);
  const build = spawnSync("npm", ["run", "build"], {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (build.error) {
    console.error(`desktop pretest: could not run npm: ${build.error.message}`);
    return 1;
  }
  if (build.status !== 0) {
    console.error(`desktop pretest: ${label} build failed (exit ${build.status}); not running tests.`);
    return build.status ?? 1;
  }
  return 0;
}

function main() {
  // 1. Root outputs (shared + server bundle) — same contract as `npm start`.
  const missingRoot = ROOT_OUTPUTS.filter((o) => !existsSync(path.join(repoRoot, o)));
  const rootSourceDirs = ROOT_SOURCES.filter((s) => existsSync(path.join(repoRoot, s)));
  const rootStale =
    missingRoot.length > 0
      ? `missing root build output: ${missingRoot.join(", ")}`
      : rootSourceDirs.length > 0 &&
        Math.max(...rootSourceDirs.map((s) => newestMtime(path.join(repoRoot, s)))) >
          Math.min(...ROOT_OUTPUTS.map((o) => statSync(path.join(repoRoot, o)).mtimeMs))
        ? "root sources changed since the last build"
        : null;
  if (rootStale) {
    const status = runBuild(repoRoot, "server/web bundles");
    if (status !== 0) return status;
  }

  // 2. Desktop outputs.
  const missingDesktop = DESKTOP_OUTPUTS.filter((o) => !existsSync(path.join(desktopRoot, o)));
  const desktopStale =
    missingDesktop.length > 0
      ? `missing desktop build output: ${missingDesktop.join(", ")}`
      : Math.max(...DESKTOP_SOURCES.map((s) => newestMtime(path.join(desktopRoot, s)))) >
          Math.min(...DESKTOP_OUTPUTS.map((o) => statSync(path.join(desktopRoot, o)).mtimeMs))
        ? "desktop sources changed since the last build"
        : null;
  if (desktopStale) {
    const status = runBuild(desktopRoot, "desktop shell");
    if (status !== 0) return status;
  }

  return 0;
}

process.exit(main());
