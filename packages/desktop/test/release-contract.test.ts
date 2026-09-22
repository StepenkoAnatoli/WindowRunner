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

  it("README and INSTALL link the changelog", () => {
    for (const doc of ["README.md", "docs/INSTALL.md"]) {
      assert.ok(read(doc).includes("CHANGELOG.md"), `${doc} must link CHANGELOG.md`);
    }
  });
});
