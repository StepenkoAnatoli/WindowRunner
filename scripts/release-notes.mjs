#!/usr/bin/env node
/**
 * windows-runner — release notes from CHANGELOG.md (B5.7).
 *
 * Extracts the section of a released version and prints it as the markdown
 * body for a GitHub Release. The changelog is the source of truth
 * (enforced by check-release.mjs): if the version has no section, this exits
 * non-zero — a release may never ship notes that were never written.
 *
 * Usage:
 *   node scripts/release-notes.mjs <vX.Y.Z | X.Y.Z> [--out <file>]
 */

import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Extract the release notes markdown for `version` (with or without a
 * leading "v"). Returns the body (title line + section content) or null when
 * the changelog has no section for that version.
 */
export function extractReleaseNotes(changelog, version) {
  const clean = version.replace(/^v/, "");
  const heading = new RegExp(`^## \\[${clean.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\](?: - (\\S+))?\\s*$`, "m");
  const match = heading.exec(changelog);
  if (!match) return null;
  const after = changelog.slice(match.index + match[0].length);
  const next = after.indexOf("\n## ");
  const body = (next === -1 ? after : after.slice(0, next)).trim();
  const date = match[1] ? ` (${match[1]})` : "";
  return `# WindowRunner v${clean}${date}\n\n${body}`;
}

export function main(argv = process.argv.slice(2)) {
  let version = null;
  let outPath = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") {
      outPath = argv[i + 1];
      i += 1;
    } else if (!version) {
      version = argv[i];
    } else {
      console.error(`release-notes: unexpected argument ${argv[i]}`);
      return 2;
    }
  }
  if (!version || !/^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    console.error("usage: node scripts/release-notes.mjs <vX.Y.Z | X.Y.Z> [--out <file>]");
    return 2;
  }
  const changelog = readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");
  const notes = extractReleaseNotes(changelog, version);
  if (notes === null) {
    console.error(`release-notes: CHANGELOG.md has no section for [${version.replace(/^v/, "")}] — write the notes before tagging`);
    return 1;
  }
  if (outPath) {
    writeFileSync(outPath, `${notes}\n`, "utf8");
    console.error(`release-notes: wrote ${outPath}`);
  } else {
    process.stdout.write(`${notes}\n`);
  }
  return 0;
}

// Run only when invoked as a script (tests import the helpers instead).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
