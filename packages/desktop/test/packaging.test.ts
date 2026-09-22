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
// Normalize CRLF: Windows checkouts can materialize LF files as CRLF, and the
// shape assertions below are newline-sensitive. What we pin is content shape,
// not the checkout's line-ending policy.
const read = (rel: string): string =>
  fs.readFileSync(path.join(desktopRoot, rel), "utf8").replace(/\r\n/g, "\n");

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
    // No auto-launch after install: the CI gate launches the installed app
    // explicitly, and an auto-started instance would still be alive during
    // the uninstall assertion.
    assert.match(yml, /runAfterFinish: false/);
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

  it("pins the canonical per-user install directory Programs/WindowRunner", () => {
    // One-click per-user NSIS derives the install dir from the PACKAGED app
    // name (getWindowsInstallationDirName -> appInfo.sanitizedName in this
    // install mode), so the workspace name (@windows-runner/desktop) must be
    // overridden via extraMetadata — that is the metadata-level fix that makes
    // %LOCALAPPDATA%\Programs\WindowRunner canonical.
    assert.match(yml, /extraMetadata:\n {2}name: WindowRunner\n/);
    // The installer CI gate asserts the explicit product path. Search-based
    // discovery was a diagnostic measure only and must not return.
    const ci = read("../../.github/workflows/ci.yml");
    assert.ok(
      ci.includes(String.raw`Programs\WindowRunner\WindowRunner.exe`),
      "ci.yml must assert the explicit product path %LOCALAPPDATA%\\Programs\\WindowRunner\\WindowRunner.exe"
    );
    assert.ok(
      !ci.includes(String.raw`Filter "WindowRunner.exe" -Recurse`),
      "the installer gate must use the explicit product path, not search-based discovery"
    );
    // Docs and the builder comment must name the same directory the CI gate
    // installs into. The files write the Windows path with escaped
    // backslashes, so the literal is Programs\\WindowRunner.
    const repoRoot = path.resolve(desktopRoot, "..", "..");
    const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
    const install = fs.readFileSync(path.join(repoRoot, "docs", "INSTALL.md"), "utf8");
    const needle = String.raw`Programs\WindowRunner`;
    assert.ok(yml.includes(needle), "electron-builder.yml must name %LOCALAPPDATA%\\Programs\\WindowRunner");
    assert.ok(readme.includes(needle), "README must name the same install directory");
    assert.ok(install.includes(needle), "docs/INSTALL.md must name the same install directory");
    assert.ok(readme.includes("WindowRunner-Setup-"), "README must name the installer artifact");
    assert.ok(install.includes("WindowRunner-Setup-"), "docs/INSTALL.md must name the installer artifact");
  });

  it("package.json entry and scripts support the A2 flow", () => {
    const pkg = JSON.parse(read("package.json")) as {
      main?: string;
      author?: string;
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    assert.equal(pkg.main, "dist/main.cjs");
    assert.equal(pkg.author, "StepenkoAnatoli");
    assert.match(pkg.scripts?.["package:win"] ?? "", /electron-builder --win nsis --config electron-builder\.yml/);
    assert.equal(pkg.scripts?.["e2e"], "playwright test");
    // electron-builder refuses semver ranges for electron ("Cannot compute
    // electron version"): the devDependency must stay an exact pin.
    assert.match(
      pkg.devDependencies?.["electron"] ?? "",
      /^\d+\.\d+\.\d+$/,
      "electron must be pinned to an exact version (electron-builder requirement)"
    );
    // B5.3: the installer build is reproducible — electron-builder is pinned
    // exactly too (the lockfile would pin it anyway; the manifest states it).
    assert.match(
      pkg.devDependencies?.["electron-builder"] ?? "",
      /^\d+\.\d+\.\d+$/,
      "electron-builder must be pinned to an exact version (release reproducibility)"
    );
  });

  it("configures env-driven code signing with a fail-loud release path (B5.3)", () => {
    // SHA-256 only: the electron-builder default dual-signs with legacy SHA-1.
    assert.match(yml, /signtoolOptions:\n {4}# SHA-256 only\./);
    assert.match(yml, /signingHashAlgorithms:\n {6}- sha256\n/);
    // The activation contract is env-driven and must stay documented in the
    // config itself, next to the knobs.
    assert.match(yml, /WIN_CSC_LINK \(or CSC_LINK\) \+ WIN_CSC_KEY_PASSWORD/);
    assert.match(yml, /forceCodeSigning/);
    assert.match(yml, /rfc3161TimeStampServer/);
    // The release script must fail instead of shipping silently unsigned.
    const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
    assert.equal(
      pkg.scripts?.["package:win:release"],
      "electron-builder --win nsis --config electron-builder.yml -c.forceCodeSigning=true"
    );
    const rootPkg = JSON.parse(read("../../package.json")) as { scripts?: Record<string, string> };
    assert.equal(rootPkg.scripts?.["package:desktop:win:release"], "npm run package:win:release --workspace packages/desktop");
  });

  it("ships the desktop e2e harness", () => {
    for (const rel of [
      "playwright.config.ts",
      "e2e/desktop.spec.ts",
      "e2e/providers.spec.ts",
      "e2e/deep-routes.spec.ts",
      "e2e/launch.ts",
    ]) {
      assert.ok(fs.existsSync(path.join(desktopRoot, rel)), `missing ${rel}`);
    }
  });

  it("stages the B2 web assets into the distribution payload", () => {
    // copy-assets.mjs must keep mirroring the monorepo geometry the bundled
    // server resolves at runtime — including the dashboard asset tree
    // (resolveDashboardDir serves it at `/dashboard`). The requireFile guards
    // make a missing dashboard build fail the desktop build, not the smoke.
    const copyAssets = read("scripts/copy-assets.mjs");
    assert.match(
      copyAssets,
      /requireFile\(path\.join\(webDashboardDir, "dashboard\.html"\)/,
      "copy-assets.mjs must require the built dashboard.html before staging"
    );
    assert.ok(
      copyAssets.includes('copy(webAppDir, path.join(staged, "packages", "web", "dist", "app"));'),
      "copy-assets.mjs must stage packages/web/dist/app (the B2 route app)"
    );
    assert.ok(
      copyAssets.includes('copy(webDashboardDir, path.join(staged, "packages", "web", "dist", "dashboard"));'),
      "copy-assets.mjs must stage packages/web/dist/dashboard (the compatibility entry)"
    );
  });
});
