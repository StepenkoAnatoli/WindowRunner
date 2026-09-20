#!/usr/bin/env node
/**
 * windows-runner — packed-artifact smoke test.
 *
 * Packs the root package exactly as `npm publish` would (same `files` allowlist,
 * same prepack contract) and asserts the tarball is what the manifest claims.
 *
 * Scope note, because this script is easy to over-read: it validates tarball
 * *contents*. It does NOT prove an installable CLI works — this package declares
 * no `bin`, and the packed `dist/` is not self-contained (the emitted server and
 * web modules still import the bare specifier `@windows-runner/shared`, which
 * resolves through a workspace symlink that a published tarball does not have).
 * Those blockers are listed in docs/INSTALL.md, "Known packaging gaps".
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Paths that must be in the tarball for it to be worth publishing. */
// `npm pack --dry-run --json` reports paths relative to the package root, with
// no leading "package/" segment (that prefix only appears in the real tarball).
const REQUIRED = [
  "package.json",
  "README.md",
  "LICENSE",
  "NOTICE",
  "docs/INSTALL.md",
  "scripts/postinstall.mjs",
  "packages/shared/dist/index.js",
  "packages/server/dist/app.js",
  "packages/web/dist/turn-state.js",
];

/**
 * Patterns that must NOT be in the tarball: sources, tests, build config and
 * dependency trees. Shipping these means `files` is wrong.
 */
const FORBIDDEN = [
  { re: /\/src\//, why: "compiled packages must ship dist/, not src/" },
  { re: /(^|\/)test\//, why: "tests are not part of the published artifact" },
  { re: /\.test\.[cm]?[jt]sx?$/, why: "tests are not part of the published artifact" },
  { re: /node_modules/, why: "dependencies are installed by the consumer" },
  { re: /tsconfig.*\.json$/, why: "build config is not part of the published artifact" },
  { re: /\.tsbuildinfo$/, why: "incremental build state is not publishable" },
];

/** Raw `.ts` sources cannot run for a consumer; `.d.ts` declarations are fine. */
function isRawTypeScript(entry) {
  return /\.tsx?$/.test(entry) && !/\.d\.ts$/.test(entry);
}

function ensureBuilt() {
  const outputs = [
    "packages/shared/dist/index.js",
    "packages/server/dist/app.js",
    "packages/web/dist/turn-state.js",
  ];
  const missing = outputs.filter((o) => !existsSync(path.join(repoRoot, o)));
  if (missing.length === 0) return true;

  console.log(`Build outputs missing (${missing.join(", ")}); running npm run build…`);
  const build = spawnSync("npm", ["run", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return build.status === 0;
}

function pack() {
  // --ignore-scripts: `prepack` would rebuild, and ensureBuilt() already did.
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    console.error(result.stderr || `npm pack exited with code ${result.status}`);
    return null;
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed[0] : parsed;
  } catch (error) {
    console.error(`Could not parse npm pack --json output: ${error.message}`);
    return null;
  }
}

function main() {
  console.log("windows-runner packed-artifact smoke test");

  if (!ensureBuilt()) {
    console.error("\nBuild failed; cannot smoke-test the packed artifact.");
    return 1;
  }

  const packed = pack();
  if (!packed) return 1;

  const entries = (packed.files ?? []).map((f) => f.path);
  const present = new Set(entries);
  const failures = [];

  console.log(`  tarball:  ${packed.filename}`);
  console.log(`  entries:  ${entries.length}`);
  console.log(`  unpacked: ${packed.unpackedSize} bytes`);

  for (const required of REQUIRED) {
    if (!present.has(required)) failures.push(`missing required entry: ${required}`);
  }

  for (const entry of entries) {
    for (const rule of FORBIDDEN) {
      if (rule.re.test(entry)) failures.push(`forbidden entry: ${entry} (${rule.why})`);
    }
    if (isRawTypeScript(entry)) {
      failures.push(`forbidden entry: ${entry} (raw TypeScript source; consumers cannot run it)`);
    }
  }

  // The manifest must not advertise an executable it does not ship. This is the
  // regression that made `npx windows-runner` / `wr` unreachable claims.
  const manifestPath = path.join(repoRoot, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.bin) {
    const targets = Object.values(manifest.bin);
    for (const target of targets) {
      const relative = String(target).replace(/^\.\//, "");
      if (!existsSync(path.join(repoRoot, relative))) {
        failures.push(`package.json bin "${relative}" does not exist on disk`);
      }
      if (!present.has(relative)) {
        failures.push(`package.json bin "${relative}" is not included in the tarball`);
      }
    }
  } else {
    console.log("  bin:      none declared (no CLI is shipped — see docs/INSTALL.md)");
  }

  if (failures.length > 0) {
    console.error("\nSmoke test FAILED:");
    for (const failure of [...new Set(failures)]) console.error(`  - ${failure}`);
    return 1;
  }

  console.log("\nSmoke test passed: tarball matches the manifest contract.");
  console.log("Note: this validates contents only. Publishing remains blocked — see");
  console.log("docs/INSTALL.md, \"Known packaging gaps\".");
  return 0;
}

process.exitCode = main();
