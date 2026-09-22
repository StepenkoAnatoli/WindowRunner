/**
 * Release contract tests (B5).
 *
 * Same style as packaging.test.ts: text-level pins over the repo's release
 * surfaces (scripts/, .github/workflows/, CHANGELOG.md) plus unit tests of
 * the release scripts' exported helpers. These fail when a release-gate
 * contract drifts, the way packaging.test.ts fails when the installer
 * contract drifts.
 *
 * Covered:
 *   - version consistency: one source of truth, checked in CI (B5.1)
 *   - changelog format + newest-version binding (B5.2)
 *   - signing config + signing CI job (B5.3)
 *   - installer checksums (B5.4)
 *   - upgrade/uninstall gate in the installer CI job (B5.6)
 *   - release workflow contract (B5.7)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { checkChangelog, collectVersionProblems, SEMVER_RE } from "../../../scripts/check-release.mjs";
import { extractReleaseNotes } from "../../../scripts/release-notes.mjs";
import { formatSums } from "../../../scripts/checksums.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const read = (rel: string): string =>
  fs.readFileSync(path.join(repoRoot, rel), "utf8").replace(/\r\n/g, "\n");

function runScript(args: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "check-release.mjs"), ...args], {
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("release contract: versioning (B5.1)", () => {
  it("the repository passes the version gate", () => {
    assert.deepEqual(collectVersionProblems(repoRoot), []);
    const run = runScript();
    assert.equal(run.status, 0, `check-release failed:\n${run.stderr}`);
    assert.match(run.stdout, /check-release: OK \(version \d+\.\d+\.\d+\)/);
  });

  it("--require-version binds a tag to the tree", () => {
    const version = JSON.parse(read("package.json")) as { version: string };
    const ok = runScript(["--require-version", `v${version.version}`]);
    assert.equal(ok.status, 0, ok.stderr);
    const bad = runScript(["--require-version", "v0.0.0-not-our-version"]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /does not match package\.json version/);
  });

  it("semver: MAJOR.MINOR.PATCH with optional prerelease, no build metadata", () => {
    for (const good of ["0.1.0", "1.2.3", "10.20.30", "0.1.0-rc.1", "1.0.0-alpha"]) {
      assert.ok(SEMVER_RE.test(good), `${good} should be valid`);
    }
    for (const bad of ["0.1", "1.x.3", "0.1.0+build", "", "0.1.0-", "v0.1.0"]) {
      assert.ok(!SEMVER_RE.test(bad), `${bad} should be invalid`);
    }
  });

  it("a workspace version drift is reported, not just the happy path", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "wr-check-release-"));
    try {
      const root = { version: "1.2.3", workspaces: ["packages/one", "packages/two"] };
      await fsp.mkdir(path.join(tmp, "packages", "one"), { recursive: true });
      await fsp.mkdir(path.join(tmp, "packages", "two"), { recursive: true });
      await fsp.writeFile(path.join(tmp, "package.json"), JSON.stringify(root));
      await fsp.writeFile(path.join(tmp, "packages", "one", "package.json"), JSON.stringify({ version: "1.2.3" }));
      await fsp.writeFile(path.join(tmp, "packages", "two", "package.json"), JSON.stringify({ version: "1.2.4" }));
      const problems = collectVersionProblems(tmp);
      assert.equal(problems.length, 1);
      assert.match(problems[0]!, /packages\/two.*1\.2\.4.*1\.2\.3/);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("CI runs the release gate on every push and pull request", () => {
    const ci = read(".github/workflows/ci.yml");
    assert.ok(
      ci.includes("npm run check:release"),
      "ci.yml must run `npm run check:release` (the version/changelog gate)"
    );
    const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
    assert.equal(pkg.scripts?.["check:release"], "node scripts/check-release.mjs");
  });
});

describe("release contract: changelog (B5.2)", () => {
  it("the repository changelog satisfies the contract against the root version", () => {
    const version = (JSON.parse(read("package.json")) as { version: string }).version;
    const problems = checkChangelog(read("CHANGELOG.md"), version);
    assert.deepEqual(problems, []);
  });

  it("rejects the drifts it exists to catch", () => {
    const ok = checkChangelog(
      ["# Changelog", "", "## [Unreleased]", "", "### Added", "- x", "", "## [1.2.3] - 2026-09-22", "", "### Fixed", "- y", ""].join("\n"),
      "1.2.3"
    );
    assert.deepEqual(ok, []);

    const drifts: Array<[string, string, RegExp]> = [
      ["# Changelog\n\n## [0.2.0] - 2026-09-22\n", "0.1.0", /newest version section is \[0\.2\.0\]/],
      ["# Changelog\n\n## [0.1.0]\n", "0.1.0", /missing its ` - YYYY-MM-DD` date/],
      ["# Changelog\n\n## [0.1.0] - 2026-13-01\n", "0.1.0", /not a valid ISO date/],
      ["# Changelog\n\n## [0.1.0] - 2026-09-22\n\n### Everything\n- x\n", "0.1.0", /is not one of/],
      ["# Changelog\n\n## [0.0.9] - 2026-09-21\n\n## [0.1.0] - 2026-09-22\n", "0.1.0", /newest-first/],
      ["# Changelog\n\n## [0.1.0] - 2026-09-22\n\n## [Unreleased]\n", "0.1.0", /\[Unreleased\] must be the first section/],
      ["# Changelog\n\n## [Unreleased] - 2026-09-22\n\n## [0.1.0] - 2026-09-22\n", "0.1.0", /\[Unreleased\] must not carry a date/],
      ["# Changelog\n\n## 0.1.0 - 2026-09-22\n", "0.1.0", /heading must be/],
    ];
    for (const [text, version, pattern] of drifts) {
      const problems = checkChangelog(text, version);
      assert.ok(problems.length > 0, `expected problems for case ${pattern}`);
      assert.match(problems.join("\n"), pattern);
    }
  });

  it("validates a CRLF checkout identically (Windows runners materialize CRLF)", () => {
    // Regression (B5 CI): core.autocrlf on windows-latest checks CHANGELOG.md
    // out with CRLF while .gitattributes only pins *.sh — the gate must not
    // depend on the checkout's line-ending policy.
    const lf = ["# Changelog", "", "## [Unreleased]", "", "### Added", "- x", "", "## [1.2.3] - 2026-09-22", "", "### Fixed", "- y", ""].join("\n");
    const crlf = lf.replace(/\n/g, "\r\n");
    assert.deepEqual(checkChangelog(crlf, "1.2.3"), [], "a CRLF changelog must pass");
    assert.deepEqual(checkChangelog(lf, "1.2.3"), []);

    // And the notes extractor reads through CRLF the same way.
    const notes = extractReleaseNotes(crlf, "v1.2.3");
    assert.ok(notes, "notes must extract from a CRLF changelog");
    assert.match(notes!, /^# WindowRunner v1\.2\.3 \(2026-09-22\)/);
    assert.ok(notes!.includes("- y"));
    assert.ok(!notes!.includes("- x"), "the Unreleased section must not leak into the notes");
  });

  it("README and INSTALL link the changelog", () => {
    for (const doc of ["README.md", "docs/INSTALL.md"]) {
      assert.ok(read(doc).includes("CHANGELOG.md"), `${doc} must link CHANGELOG.md`);
    }
  });
});

describe("release contract: code signing (B5.3)", () => {
  const ci = read(".github/workflows/ci.yml");

  it("CI proves the signing pipeline with a test certificate on every PR", () => {
    assert.ok(ci.includes("name: Desktop signing (windows-latest)"), "the Desktop signing job must exist");
    // The proof must be the real credential path, not a parallel mechanism.
    assert.ok(ci.includes("WIN_CSC_LINK: ${{ env.WR_CI_PFX }}"), "the signing job must inject the certificate via WIN_CSC_LINK");
    assert.ok(ci.includes("WIN_CSC_KEY_PASSWORD: wr-ci-signing-proof"), "the signing job must pass the password via WIN_CSC_KEY_PASSWORD");
    // forceCodeSigning: a build that cannot sign must fail, not skip.
    assert.ok(ci.includes("npm run package:desktop:win:release"), "the signing job must build via the forceCodeSigning release script");
    // The assertion must detect both "not signed at all" and "signed by the
    // wrong certificate".
    assert.ok(ci.includes("-eq \"NotSigned\""), "the signing gate must fail on unsigned output");
    assert.ok(ci.includes("WindowRunner CI Signing Proof"), "the signing gate must pin the expected signer subject");
    // The test certificate is timestamp-free on purpose: no external service
    // in the proof path.
    assert.ok(ci.includes("ELECTRON_BUILDER_OFFLINE: \"true\""), "the signing proof must not depend on a timestamp server");
  });

  it("the test-signed installer is never published as a releasable artifact", () => {
    // The diagnostics upload must be failure-only; there is no unconditional
    // upload step in the signing job.
    const signingJob = ci.slice(ci.indexOf("  desktop-signing:"));
    const uploadSteps = signingJob.match(/- name: Upload[^\n]*/g) ?? [];
    assert.ok(uploadSteps.length > 0, "the signing job must upload diagnostics on failure");
    for (const step of uploadSteps) {
      assert.match(step, /on failure/, "signing-job artifact uploads must be failure-only");
    }
  });

  it("the builder config keeps signing env-driven (no certificate material in the repo)", () => {
    const yml = fs.readFileSync(path.join(desktopRoot, "electron-builder.yml"), "utf8").replace(/\r\n/g, "\n");
    assert.match(yml, /signingHashAlgorithms:\n {6}- sha256\n/);
    assert.ok(!yml.includes("certificateFile"), "no certificate path may be hardcoded in the builder config");
    assert.ok(!yml.includes("certificatePassword"), "no certificate password may be hardcoded in the builder config");
  });
});

describe("release contract: artifact checksums (B5.4)", () => {
  it("formatSums produces a sha256sum -c compatible, sorted, basename-only sidecar", async () => {
    const { createHash } = await import("node:crypto");
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "wr-sums-"));
    try {
      const a = path.join(tmp, "b-file.txt");
      const b = path.join(tmp, "a-file.txt");
      await fsp.writeFile(a, "content-a");
      await fsp.writeFile(b, "content-b");
      const sums = formatSums([a, b]);
      const lines = sums.trim().split("\n");
      assert.equal(lines.length, 2);
      // Sorted by basename: a-file before b-file.
      assert.match(lines[0]!, /^[0-9a-f]{64}  a-file\.txt$/);
      assert.match(lines[1]!, /^[0-9a-f]{64}  b-file\.txt$/);
      assert.equal(
        lines[0]!.split("  ")[0],
        createHash("sha256").update("content-b").digest("hex")
      );
      assert.ok(sums.endsWith("\n"), "the sidecar ends with a newline");
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("duplicate basenames are refused (a sidecar must not be ambiguous)", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "wr-sums-"));
    try {
      await fsp.writeFile(path.join(tmp, "x", "same.txt"), "one").catch(() => {});
      await fsp.mkdir(path.join(tmp, "x"), { recursive: true });
      await fsp.writeFile(path.join(tmp, "x", "same.txt"), "one");
      await fsp.mkdir(path.join(tmp, "y"), { recursive: true });
      await fsp.writeFile(path.join(tmp, "y", "same.txt"), "two");
      await assert.rejects(async () => formatSums([path.join(tmp, "x", "same.txt"), path.join(tmp, "y", "same.txt")]), /duplicate basename/);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("the installer CI job publishes a SHA256SUMS.txt with every artifact upload", () => {
    const ci = read(".github/workflows/ci.yml");
    assert.ok(
      ci.includes("node ../../../scripts/checksums.mjs --out . *-Setup-*.exe latest.yml"),
      "the installer job must generate SHA256SUMS.txt for the installer and update metadata"
    );
    const uploadBlock = ci.slice(ci.indexOf("name: windowrunner-installer"));
    assert.ok(
      uploadBlock.includes("SHA256SUMS.txt"),
      "the windowrunner-installer artifact must include SHA256SUMS.txt"
    );
  });

  it("docs teach verification and name the official download sources", () => {
    const install = read("docs/INSTALL.md");
    assert.ok(install.includes("### Verifying a download"), "INSTALL must have a verifying-a-download section");
    assert.ok(install.includes("Get-FileHash"), "INSTALL must show the PowerShell verification command");
    assert.ok(install.includes("sha256sum -c SHA256SUMS.txt"), "INSTALL must show the sha256sum verification command");
    assert.ok(/GitHub Releases of this\s+repository/.test(install), "INSTALL must name the official download sources");
  });
});

describe("release contract: upgrade/uninstall gate (B5.6)", () => {
  const ci = read(".github/workflows/ci.yml");
  const spec = read("packages/desktop/e2e/upgrade.spec.ts");

  it("the upgrade journey ships as a spec that is inert without its CI contract", () => {
    assert.ok(spec.includes("WR_UPGRADE_PHASE"), "the spec must be driven by WR_UPGRADE_PHASE");
    assert.ok(
      spec.includes('test.skip('),
      "the spec must self-skip so the standard e2e runs (dev layout, installer journey) never trigger it accidentally"
    );
  });

  it("CI verifies in-place upgrade with data preservation on every PR", () => {
    // Phase A seeds real user data at the real per-user location.
    assert.ok(ci.includes("WR_UPGRADE_PHASE: old"), "phase A must seed data with the current version");
    assert.ok(ci.includes("WR_UPGRADE_DATA_DIR: ${{ env.WR_APPDATA_DIR }}"), "the journey must use the real per-user data dir");
    // The upgrade target is the same tree with a bumped version.
    assert.ok(
      ci.includes('-c.extraMetadata.version="$NEXT"'),
      "the next-version installer must be the same tree with a bumped version"
    );
    assert.ok(ci.includes("WR_UPGRADE_PHASE: new"), "phase B must verify the upgraded app");
    // The installed exe must actually BE the new version.
    assert.ok(ci.includes("VersionInfo.ProductVersion"), "the upgrade assertion must check the exe ProductVersion");
  });

  it("CI asserts uninstall removes the app AND keeps user data", () => {
    assert.ok(ci.includes("uninstall removed user data"), "the uninstall step must fail if user data was removed");
    assert.ok(
      ci.includes("deleteAppDataOnUninstall must stay false"),
      "the assertion must name the config contract it protects"
    );
    const yml = fs.readFileSync(path.join(desktopRoot, "electron-builder.yml"), "utf8").replace(/\r\n/g, "\n");
    assert.match(yml, /deleteAppDataOnUninstall: false/, "the config must keep user data on uninstall");
  });

  it("the upgrade spec is pinned in the desktop contract inventory", () => {
    assert.ok(
      ci.includes('test -f "packages/desktop/e2e/upgrade.spec.ts"'),
      "the inventory step must fail if the upgrade spec is deleted"
    );
  });
});

describe("release contract: release workflow (B5.7)", () => {
  const release = read(".github/workflows/release.yml");

  it("is tag-driven, minimal-permission, and gated by the tag-bound check", () => {
    assert.match(release, /tags:\n {6}- "v\*\.\*\.\*"/, "trigger must be vX.Y.Z tag pushes");
    assert.match(release, /^permissions:\n {2}contents: read$/m, "default permissions must be read-only");
    // Only the publishing job escalates, and only for contents.
    const releaseJob = release.slice(release.indexOf("  release:"));
    assert.ok(releaseJob.includes("    permissions:"), "the release job declares its own permissions");
    assert.ok(releaseJob.includes("      contents: write"), "only the release job writes, and only contents");
    assert.match(release, /check:release -- --require-version "\$\{GITHUB_REF_NAME\}"/, "the tag must be bound to the tree");
    assert.match(release, /npm run smoke:packed/, "the CLI tarball must pass the packed smokes before shipping");
  });

  it("signs with the production certificate when the secret exists, and fails otherwise only into an explicitly-unsigned draft", () => {
    assert.ok(release.includes("secrets.WIN_CSC_LINK"), "signing must be driven by the production secret");
    assert.ok(
      release.includes("npm run package:desktop:win:release"),
      "the signed path must use forceCodeSigning (cannot ship silently unsigned)"
    );
    assert.ok(
      release.includes("this build is UNSIGNED"),
      "the unsigned path must stamp an explicit warning into the draft release"
    );
    assert.ok(release.includes("--draft"), "releases are created as drafts; publishing is a human action");
  });

  it("exercises the installer before shipping it", () => {
    assert.ok(release.includes("E2E against the installed app"), "the release installer must be driven, not just built");
    assert.ok(release.includes("silent uninstall verified"), "the release must verify uninstall");
  });

  it("ships checksums and changelog-derived notes with every release", () => {
    assert.ok(release.includes("scripts/checksums.mjs"), "the release must generate SHA256SUMS.txt");
    assert.ok(release.includes("scripts/release-notes.mjs"), "the release notes must come from the changelog");
    assert.ok(release.includes("SHA-256 checksums"), "the checksums must be visible in the release body");
  });
});

describe("release contract: release notes (B5.7)", () => {
  it("extracts the changelog section for a shipped version", () => {
    const notes = extractReleaseNotes(read("CHANGELOG.md"), "0.1.0");
    assert.ok(notes, "the changelog must yield notes for the current version");
    assert.match(notes!, /^# WindowRunner v0\.1\.0 \(2026-09-22\)/);
    assert.match(notes!, /### Added/);
    assert.ok(!notes!.includes("## ["), "the extracted body must not leak the next section heading");
  });

  it("accepts the tag form (leading v) and refuses versions without a section", async () => {
    const notes = extractReleaseNotes("# Changelog\n\n## [1.2.3] - 2026-09-22\n\n### Fixed\n- x\n\n## [1.2.2] - 2026-09-21\n\n### Fixed\n- y\n", "v1.2.3");
    assert.match(notes!, /^# WindowRunner v1\.2\.3 \(2026-09-22\)/);
    assert.ok(notes!.includes("- x"));
    assert.ok(!notes!.includes("- y"), "content must stop at the next version heading");
    assert.equal(extractReleaseNotes("# Changelog\n\n## [1.2.3] - 2026-09-22\n", "1.0.0"), null);

    const missing = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "release-notes.mjs"), "v0.0.0"], { encoding: "utf8" });
    assert.equal(missing.status, 1, "a version without notes must fail the release");
    assert.match(missing.stderr, /no section for \[0\.0\.0\]/);
  });
});
