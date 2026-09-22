#!/usr/bin/env node
/**
 * windows-runner — release consistency gate (B5.1).
 *
 * The root package.json `version` is the single source of truth a human
 * edits. This script fails the build when anything disagrees with it:
 *
 *   1. the root version must be valid semver (MAJOR.MINOR.PATCH, optional
 *      prerelease; no build metadata — artifacts embed the version and the
 *      NSIS artifactName/upgrade story wants clean, sortable tags);
 *   2. every workspace package.json must carry the same version (the desktop
 *      installer embeds the workspace version into the packaged app, and the
 *      web bundle injects the ROOT version at build time — a drift means the
 *      About page and the installed exe disagree);
 *   3. with --require-version vX.Y.Z (release workflow): the tag must match
 *      the tree, so a release can never be cut from a version the changelog
 *      and the manifests do not agree on.
 *
 * Changelog validation (B5.2) lives here too — see checkChangelog().
 *
 * Run: `npm run check:release` (CI runs it on every push and pull request).
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** MAJOR.MINOR.PATCH with optional dash-prerelease. No build metadata. */
export const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Changelog section names allowed under a version heading (Keep a Changelog). */
export const CHANGELOG_SECTIONS = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];

const VERSION_HEADING_RE = /^## \[([0-9A-Za-z.-]+|Unreleased)\](?: - (.+))?$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Compare two semver strings parsed as triples; prerelease sorts below release. */
function compareSemver(a, b) {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  const preA = a.includes("-");
  const preB = b.includes("-");
  if (preA !== preB) return preA ? -1 : 1; // 1.0.0 > 1.0.0-rc.1
  return a === b ? 0 : a < b ? -1 : 1;
}

function isValidIsoDate(value) {
  if (!ISO_DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Validate a Keep-a-Changelog document against the repository version.
 * Returns a list of human-readable problems; empty means the contract holds.
 */
export function checkChangelog(text, rootVersion) {
  const problems = [];
  const lines = text.split("\n");
  const first = lines.find((l) => l.trim() !== "");
  if (!first || !/^# .+/.test(first)) {
    return ["CHANGELOG.md must start with a `# Changelog` heading"];
  }

  const headings = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = VERSION_HEADING_RE.exec(lines[i]);
    if (match) {
      headings.push({ line: i + 1, version: match[1], date: match[2] ?? null });
    } else if (/^## /.test(lines[i]) && !/^### /.test(lines[i])) {
      problems.push(`CHANGELOG.md line ${i + 1}: heading must be \`## [x.y.z] - YYYY-MM-DD\` or \`## [Unreleased]\`, got \`${lines[i]}\``);
    } else if (/^### /.test(lines[i])) {
      const name = lines[i].slice(4).trim();
      if (!CHANGELOG_SECTIONS.includes(name)) {
        problems.push(`CHANGELOG.md line ${i + 1}: section \`### ${name}\` is not one of ${CHANGELOG_SECTIONS.join(", ")}`);
      }
    }
  }

  if (headings.length === 0) {
    problems.push("CHANGELOG.md has no version sections (`## [x.y.z] - YYYY-MM-DD`)");
    return problems;
  }

  const seen = new Set();
  for (const heading of headings) {
    if (seen.has(heading.version)) {
      problems.push(`CHANGELOG.md: duplicate section for [${heading.version}]`);
    }
    seen.add(heading.version);
    if (heading.version === "Unreleased") {
      if (heading.date !== null) {
        problems.push("CHANGELOG.md: [Unreleased] must not carry a date");
      }
    } else {
      if (!SEMVER_RE.test(heading.version)) {
        problems.push(`CHANGELOG.md: [${heading.version}] is not valid semver`);
      }
      if (heading.date === null) {
        problems.push(`CHANGELOG.md: [${heading.version}] is missing its \` - YYYY-MM-DD\` date`);
      } else if (!isValidIsoDate(heading.date)) {
        problems.push(`CHANGELOG.md: [${heading.version}] date \`${heading.date}\` is not a valid ISO date`);
      }
    }
  }

  // [Unreleased], when present, must come first.
  const unreleasedIndex = headings.findIndex((h) => h.version === "Unreleased");
  if (unreleasedIndex > 0) {
    problems.push("CHANGELOG.md: [Unreleased] must be the first section");
  }

  // Versions must be ordered newest-first.
  const versions = headings.filter((h) => h.version !== "Unreleased").map((h) => h.version);
  for (let i = 1; i < versions.length; i += 1) {
    if (SEMVER_RE.test(versions[i]) && SEMVER_RE.test(versions[i - 1]) && compareSemver(versions[i], versions[i - 1]) >= 0) {
      problems.push(`CHANGELOG.md: versions must be newest-first — [${versions[i]}] appears after [${versions[i - 1]}]`);
    }
  }

  // The newest version section must document exactly the root version.
  if (versions.length > 0 && versions[0] !== rootVersion) {
    problems.push(`CHANGELOG.md: newest version section is [${versions[0]}] but package.json says ${rootVersion} — document the version you ship`);
  }

  return problems;
}

export function readVersion(pkgPath) {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error(`${pkgPath}: no version field`);
  }
  return pkg.version;
}

/**
 * Version-consistency problems for the repository at `root`.
 * Returns a list of human-readable strings; empty means consistent.
 */
export function collectVersionProblems(root = repoRoot) {
  const problems = [];
  const rootPkgPath = path.join(root, "package.json");
  const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8"));
  const version = rootPkg.version;
  if (typeof version !== "string" || !SEMVER_RE.test(version)) {
    problems.push(`package.json version ${JSON.stringify(version)} is not valid semver (MAJOR.MINOR.PATCH[-prerelease])`);
    return problems;
  }
  const workspaces = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : [];
  for (const ws of workspaces) {
    const pkgPath = path.join(root, ws, "package.json");
    let wsVersion;
    try {
      wsVersion = readVersion(pkgPath);
    } catch (err) {
      problems.push(`${ws}: ${err.message}`);
      continue;
    }
    if (wsVersion !== version) {
      problems.push(`${ws}/package.json version ${wsVersion} != root version ${version}`);
    }
  }
  return problems;
}

function usage() {
  return "usage: node scripts/check-release.mjs [--require-version vX.Y.Z]";
}

export function main(argv = process.argv.slice(2)) {
  const problems = [];
  let requireVersion;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--require-version") {
      requireVersion = argv[i + 1];
      i += 1;
      if (!requireVersion || !requireVersion.startsWith("v") || !SEMVER_RE.test(requireVersion.slice(1))) {
        console.error(`check-release: --require-version expects vX.Y.Z, got ${JSON.stringify(requireVersion ?? "(missing)")}`);
        return 2;
      }
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      return 0;
    } else {
      console.error(`check-release: unknown argument ${arg}\n${usage()}`);
      return 2;
    }
  }

  problems.push(...collectVersionProblems(repoRoot));

  const version = readVersion(path.join(repoRoot, "package.json"));
  try {
    const changelog = readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");
    problems.push(...checkChangelog(changelog, version));
  } catch {
    problems.push("CHANGELOG.md is missing (Keep a Changelog format; newest section must match the package version)");
  }

  if (requireVersion && requireVersion.slice(1) !== version) {
    problems.push(`--require-version ${requireVersion} does not match package.json version ${version}`);
  }

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`check-release: ${problem}`);
    }
    console.error("check-release: FAILED");
    return 1;
  }
  console.log(`check-release: OK (version ${version}${requireVersion ? `, tag ${requireVersion}` : ""})`);
  return 0;
}

// Run only when invoked as a script (tests import the helpers instead).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
