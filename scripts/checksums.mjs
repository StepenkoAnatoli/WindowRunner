#!/usr/bin/env node
/**
 * windows-runner — SHA-256 checksums for release artifacts (B5.4).
 *
 * Writes a SHA256SUMS.txt sidecar (`<hex>  <filename>`, lowercase hex,
 * basename only, sorted) next to the artifacts it describes, in the format
 * `sha256sum -c` consumes on Linux/macOS and that Windows users can check
 * against `Get-FileHash` / `certutil -hashfile <file> SHA256`.
 *
 * Usage:
 *   node scripts/checksums.mjs --out <outputDir> <file> [<file> ...]
 *
 * Exits non-zero when a file is missing, when no files are given, or when a
 * name would collide in the sidecar (two files with the same basename).
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const SUMS_FILE = "SHA256SUMS.txt";

/** Format the sidecar content for absolute/relative file paths (sorted by name). */
export function formatSums(files) {
  const entries = files.map((file) => {
    const name = path.basename(file);
    const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
    return { name, digest };
  });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.name)) {
      throw new Error(`duplicate basename in checksum list: ${entry.name}`);
    }
    seen.add(entry.name);
  }
  return entries.map((e) => `${e.digest}  ${e.name}`).join("\n") + "\n";
}

export function main(argv = process.argv.slice(2)) {
  let outDir = null;
  const files = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") {
      outDir = argv[i + 1];
      i += 1;
    } else {
      files.push(argv[i]);
    }
  }
  if (!outDir || files.length === 0) {
    console.error("usage: node scripts/checksums.mjs --out <outputDir> <file> [<file> ...]");
    return 2;
  }
  const missing = files.filter((f) => !existsSync(f));
  if (missing.length > 0) {
    for (const file of missing) {
      console.error(`checksums: no such file: ${file}`);
    }
    return 1;
  }
  const content = formatSums(files);
  const outPath = path.join(outDir, SUMS_FILE);
  writeFileSync(outPath, content);
  process.stdout.write(content);
  console.error(`checksums: wrote ${outPath} (${files.length} file${files.length === 1 ? "" : "s"})`);
  return 0;
}

// Run only when invoked as a script (tests import the helpers instead).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
