/**
 * Installer packaging contract (PR A / A2).
 *
 * Text-level contract tests over electron-builder.yml + package.json: they pin
 * the parts of the installer config that src/main.ts and the CI job depend on,
 * and they fail if either side drifts (the extraResources <-> process.resources
 * Path geometry is asserted from BOTH files). No YAML dependency: the config is
 * small and these are exact-shape assertions, not parsing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => fs.readFileSync(path.join(desktopRoot, rel), "utf8");

describe("installer packaging contract (electron-builder.yml)", () => {
  const yml = read("electron-builder.yml");

  it("pins the app identity and the NSIS target", () => {
    assert.match(yml, /^appId: com\.stepenkoanatoli\.windowrunner$/m);
    assert.match(yml, /^productName: WindowRunner$/m);
    assert.match(yml, /win:\n {2}target:\n {4}- nsis\n/);
    assert.match(yml, /artifactName: "WindowRunner-Setup-\$\{version\}\.\$\{ext\}"/);
  });

  it("installs per-user without UAC and keeps user data on uninstall", () => {
    assert.match(yml, /oneClick: true/);
    assert.match(yml, /perMachine: false/);
    assert.match(yml, /deleteAppDataOnUninstall: false/);
  });

  it("packs only the compiled shell into the app archive", () => {
    assert.match(yml, /files:\n {2}- dist\/main\.cjs\n {2}- dist\/preload\.cjs\n/);
    // The staged payload must not be packed twice (it ships via extraResources).
    assert.doesNotMatch(yml, /asarUnpack/);
    assert.match(yml, /npmRebuild: false/);
  });

  it("places the staged payload at process.resourcesPath, matching main.ts", () => {
    assert.match(yml, /extraResources:\n {2}- from: dist\/resources\n {4}to: \.\n/);
    const mainTs = read("src/main.ts");
    assert.match(
      mainTs,
      /process\.resourcesPath,\s*"packages",\s*"server",\s*"dist",\s*"index\.cjs"/,
      "main.ts must resolve the bundled server under process.resourcesPath (keep in sync with electron-builder.yml extraResources)"
    );
  });

  it("package.json entry and scripts support the A2 flow", () => {
    const pkg = JSON.parse(read("package.json")) as {
      main?: string;
      author?: string;
      scripts?: Record<string, string>;
    };
    assert.equal(pkg.main, "dist/main.cjs");
    assert.equal(pkg.author, "StepenkoAnatoli");
    assert.match(pkg.scripts?.["package:win"] ?? "", /electron-builder --win nsis --config electron-builder\.yml/);
    assert.equal(pkg.scripts?.["e2e"], "playwright test");
  });

  it("ships the desktop e2e harness", () => {
    for (const rel of ["playwright.config.ts", "e2e/desktop.spec.ts", "e2e/launch.ts"]) {
      assert.ok(fs.existsSync(path.join(desktopRoot, rel)), `missing ${rel}`);
    }
  });
});
