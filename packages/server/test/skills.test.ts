/**
 * Skills loader (ADR 003, phase 1).
 *
 * A skill is instructions only: `.windowrunner/skills/<name>/SKILL.md`, YAML
 * frontmatter plus a markdown body, and nothing that executes. These tests pin
 * the two properties the ADR rests on:
 *
 *   - discovery never throws. A malformed, hostile or half-written skill
 *     directory is excluded with a diagnostic, never fatal to the scan — the
 *     posture of ProjectTrustRegistry.boot(), which ignores malformed files
 *     with a warning rather than trusting or crashing.
 *   - every path goes through ProjectRoot, so a skill cannot be a symlink out
 *     of the project.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ProjectRoot } from "../src/project-root.js";
import { removeTempPath } from "../../../scripts/temp-path.mjs";
import {
  BODY_TRUNCATED_NOTICE,
  MAX_BODY_CHARS,
  MAX_DESCRIPTION_CHARS,
  SKILLS_DIR,
  SKILL_NAME_RE,
  loadSkills,
  type SkillDiagnostic,
} from "../src/agent/skills.js";

async function makeTempRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wr-skills-test-"));
  return { root: tmp, cleanup: async () => { await removeTempPath(tmp); } };
}

/** Write a skill directory under the project root and return the ProjectRoot. */
async function withSkills(
  files: Record<string, string>,
  extra: (root: string) => Promise<void> = async () => {}
): Promise<{ pr: ProjectRoot; root: string; cleanup: () => Promise<void> }> {
  const { root, cleanup } = await makeTempRoot();
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split("/"));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }
  await extra(root);
  const pr = await ProjectRoot.create(root, []);
  return { pr, root, cleanup };
}

const skill = (name: string, description: string, body = "Do the thing.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

const reasons = (d: SkillDiagnostic[]) => d.map((x) => x.reason);
const files = (d: SkillDiagnostic[]) => d.map((x) => x.file);

describe("skills loader: discovery", () => {
  it("returns one SkillMeta for one well-formed skill, with no diagnostics", async () => {
    const ctx = await withSkills({
      ".windowrunner/skills/release-notes/SKILL.md": skill("release-notes", "Draft changelog entries from a diff."),
    });
    try {
      const { skills, diagnostics } = await loadSkills(ctx.pr);
      assert.deepEqual(diagnostics, []);
      assert.equal(skills.length, 1);
      assert.equal(skills[0].name, "release-notes");
      assert.equal(skills[0].description, "Draft changelog entries from a diff.");
      assert.equal(skills[0].body, "Do the thing.");
      assert.equal(skills[0].truncated, false);
      // The path is relative to the project root, so it is safe to display.
      assert.equal(skills[0].path, path.join(".windowrunner", "skills", "release-notes", "SKILL.md"));
    } finally {
      await ctx.cleanup();
    }
  });

  it("returns an empty index and NO diagnostic when there is no skills directory", async () => {
    const ctx = await withSkills({ "README.md": "# nothing here" });
    try {
      const { skills, diagnostics } = await loadSkills(ctx.pr);
      assert.deepEqual(skills, []);
      assert.deepEqual(diagnostics, [], "an absent skills directory is not an error worth reporting");
    } finally {
      await ctx.cleanup();
    }
  });

  it("ignores non-directory entries, but reports a directory with no SKILL.md", async () => {
    const ctx = await withSkills({
      ".windowrunner/skills/notes.txt": "not a skill",
      ".windowrunner/skills/real/SKILL.md": skill("real", "A real skill."),
      ".windowrunner/skills/half-finished/.keep": "",
    });
    try {
      const { skills, diagnostics } = await loadSkills(ctx.pr);
      assert.deepEqual(skills.map((s) => s.name), ["real"]);
      // A stray file is not a skill attempt and is ignored silently. A
      // DIRECTORY under the skills dir with no SKILL.md is a half-created
      // skill, and saying so is actionable — so it gets a diagnostic.
      assert.deepEqual(reasons(diagnostics), ["missing_skill_file"]);
      assert.match(files(diagnostics)[0], /half-finished/);
    } finally {
      await ctx.cleanup();
    }
  });
});

describe("skills loader: exclusion cases", () => {
  it("excludes a skill with no SKILL.md and says so", async () => {
    const ctx = await withSkills({ ".windowrunner/skills/orphan/README.md": "wrong filename" });
    try {
      const { skills, diagnostics } = await loadSkills(ctx.pr);
      assert.deepEqual(skills, []);
      assert.deepEqual(reasons(diagnostics), ["missing_skill_file"]);
      assert.match(files(diagnostics)[0], /orphan/);
    } finally {
      await ctx.cleanup();
    }
  });

  it("excludes a file with no frontmatter and continues scanning", async () => {
    const ctx = await withSkills({
      ".windowrunner/skills/bare/SKILL.md": "Just prose, no frontmatter at all.\n",
      ".windowrunner/skills/good/SKILL.md": skill("good", "Still discovered."),
    });
    try {
      const { skills, diagnostics } = await loadSkills(ctx.pr);
      assert.deepEqual(skills.map((s) => s.name), ["good"], "one bad skill must not stop the scan");
      assert.deepEqual(reasons(diagnostics), ["missing_frontmatter"]);
    } finally {
      await ctx.cleanup();
    }
  });

  it("excludes malformed frontmatter", async () => {
    const ctx = await withSkills({
      ".windowrunner/skills/broken/SKILL.md": "---\nname: broken\nthis line has no colon\n---\nbody\n",
    });
    try {
      const { skills, diagnostics } = await loadSkills(ctx.pr);
      assert.deepEqual(skills, []);
      assert.deepEqual(reasons(diagnostics), ["malformed_frontmatter"]);
    } finally {
      await ctx.cleanup();
    }
  });

  it("rejects non-scalar frontmatter rather than silently ignoring structure", async () => {
    // A strict parser that only accepts `key: value` scalars is the correct
    // posture for untrusted project files: nested YAML gets a diagnostic, not
    // a silently-dropped field.
    for (const [label, content] of [
      ["block sequence", "---\nname: seq\ndescription:\n  - one\n  - two\n---\nbody\n"],
      ["nested map", "---\nname: nested\ndescription: d\nextra:\n  deep: value\n---\nbody\n"],
    ] as const) {
      const ctx = await withSkills({ ".windowrunner/skills/x/SKILL.md": content });
      try {
        const { skills, diagnostics } = await loadSkills(ctx.pr);
        assert.deepEqual(skills, [], label);
        assert.deepEqual(reasons(diagnostics), ["malformed_frontmatter"], label);
      } finally {
        await ctx.cleanup();
      }
    }
  });

  it("excludes a skill with no description", async () => {
    const ctx = await withSkills({ ".windowrunner/skills/nodesc/SKILL.md": "---\nname: nodesc\n---\nbody\n" });
    try {
      const { skills, diagnostics } = await loadSkills(ctx.pr);
      assert.deepEqual(skills, []);
      assert.deepEqual(reasons(diagnostics), ["missing_description"]);
    } finally {
      await ctx.cleanup();
    }
  });

  it("excludes a skill whose name does not match its directory", async () => {
    const ctx = await withSkills({ ".windowrunner/skills/actual-dir/SKILL.md": skill("claimed-name", "Mismatch.") });
    try {
      const { skills, diagnostics } = await loadSkills(ctx.pr);
      assert.deepEqual(skills, []);
      assert.deepEqual(reasons(diagnostics), ["name_mismatch"]);
      assert.match(diagnostics[0].message, /actual-dir/);
      assert.match(diagnostics[0].message, /claimed-name/);
    } finally {
      await ctx.cleanup();
    }
  });

  it("excludes an invalid skill name", async () => {
    for (const bad of ["Bad-Case", "9lives", "has space", "under_score", "", "-lead", "trail-"]) {
      const dir = bad === "" ? "(empty)" : bad;
      // Directory name must equal the frontmatter name, so this reaches the
      // name-pattern check rather than the mismatch check. Fixtures are
      // written before ProjectRoot.create, which realpaths at construction.
      const { root, cleanup } = await makeTempRoot();
      try {
        const skillDir = path.join(root, ".windowrunner", "skills", dir);
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(
          path.join(skillDir, "SKILL.md"),
          `---\nname: ${bad}\ndescription: d\n---\nbody\n`,
          "utf8"
        );
        const pr = await ProjectRoot.create(root, []);
        const { skills, diagnostics } = await loadSkills(pr);
        assert.deepEqual(skills, [], `name ${JSON.stringify(bad)} must be rejected`);
        // An empty `name:` is rejected one stage earlier, by the parser: in
        // YAML an empty value means a block collection follows, so it is
        // malformed_frontmatter rather than invalid_name. What must hold for
        // every case is that it is rejected and the reason is one of these.
        assert.ok(
          reasons(diagnostics).includes("invalid_name") || reasons(diagnostics).includes("malformed_frontmatter"),
          `name ${JSON.stringify(bad)} must be reported as invalid_name or malformed_frontmatter, got ${JSON.stringify(reasons(diagnostics))}`
        );
      } finally {
        await cleanup();
      }
    }
  });

  it("excludes a skill whose name is reserved, even though no built-in can collide today", async () => {
    // Every built-in tool uses underscores and SKILL_NAME_RE forbids them, so
    // `read_file` can never be a skill name — it is rejected as invalid_name
    // before the reserved check is reached. The reserved check is defence in
    // depth for a future dash-named tool, so it is exercised with a name that
    // IS pattern-valid. Without this the assertion would be vacuous.
    const ctx = await withSkills({
      ".windowrunner/skills/run-anything/SKILL.md": skill("run-anything", "Impersonates a future tool."),
      ".windowrunner/skills/read_file/SKILL.md": `---\nname: read_file\ndescription: Impersonates a tool.\n---\nbody\n`,
    });
    try {
      const { skills, diagnostics } = await loadSkills(ctx.pr, {
        reservedNames: ["run-anything", "read_file", "read-file"],
      });
      assert.deepEqual(skills, [], "ambiguity is refused, not resolved silently");
      assert.deepEqual(reasons(diagnostics).sort(), ["invalid_name", "reserved_name"]);
      const reserved = diagnostics.find((d) => d.reason === "reserved_name");
      assert.match(reserved!.file, /run-anything/, "the reserved rejection must be the dash-named one");
    } finally {
      await ctx.cleanup();
    }
  });
});

describe("skills loader: names cannot collide", () => {
  it("cannot produce two skills with the same name, so no precedence rule is needed", async () => {
    // ADR 003 originally specified lexicographic precedence for duplicate
    // names. That rule is unreachable: the name IS the directory name and
    // `name === dirName` is enforced, and directory entries are unique within a
    // directory. This test pins the property that makes shadowing impossible,
    // so a future change that lets frontmatter override the directory name
    // fails here and has to confront the question deliberately.
    const ctx = await withSkills({
      ".windowrunner/skills/beta/SKILL.md": skill("beta", "From beta."),
      ".windowrunner/skills/alpha/SKILL.md": skill("alpha", "From alpha."),
      // A third directory that tries to claim "alpha" is a name_mismatch, not a
      // shadow: it is excluded, and the real alpha survives untouched.
      ".windowrunner/skills/gamma/SKILL.md": skill("alpha", "Impersonates alpha."),
    });
    try {
      const { skills, diagnostics } = await loadSkills(ctx.pr);
      assert.deepEqual(
        skills.map((s) => s.name),
        ["alpha", "beta"],
        "the index is sorted by name and contains no duplicates"
      );
      assert.deepEqual(new Set(skills.map((s) => s.name)).size, skills.length);
      assert.deepEqual(reasons(diagnostics), ["name_mismatch"]);
      assert.match(diagnostics[0].message, /gamma/);
    } finally {
      await ctx.cleanup();
    }
  });
});

describe("skills loader: size limits", () => {
  it("caps the description length", async () => {
    const long = "x".repeat(MAX_DESCRIPTION_CHARS + 500);
    const ctx = await withSkills({ ".windowrunner/skills/verbose/SKILL.md": skill("verbose", long) });
    try {
      const { skills, diagnostics } = await loadSkills(ctx.pr);
      assert.deepEqual(skills, [], "an over-long description is rejected, not silently clipped");
      assert.deepEqual(reasons(diagnostics), ["description_too_long"]);
    } finally {
      await ctx.cleanup();
    }
  });

  it("truncates an oversized body and reports it", async () => {
    const huge = "y".repeat(MAX_BODY_CHARS + 10_000);
    const ctx = await withSkills({ ".windowrunner/skills/huge/SKILL.md": skill("huge", "A big skill.", huge) });
    try {
      const { skills, diagnostics } = await loadSkills(ctx.pr);
      assert.equal(skills.length, 1);
      assert.equal(skills[0].truncated, true);
      assert.equal(skills[0].body.length, MAX_BODY_CHARS + BODY_TRUNCATED_NOTICE.length);
      assert.ok(skills[0].body.endsWith(BODY_TRUNCATED_NOTICE));
      assert.deepEqual(reasons(diagnostics), ["body_truncated"]);
    } finally {
      await ctx.cleanup();
    }
  });
});

describe("skills loader: path confinement", () => {
  it("refuses a skill directory that is a symlink out of the project", async () => {
    // Both trees under one temp parent so a single cleanup covers them.
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "wr-skills-symlink-"));
    const root = path.join(parent, "project");
    const outside = path.join(parent, "outside");
    try {
      // A real skill-shaped directory OUTSIDE the project, then a symlink
      // inside .windowrunner/skills pointing at it. This is the case that
      // makes "every read goes through ProjectRoot" load-bearing: without a
      // realpath check, a cloned repo could point a skill at anything on disk.
      await fs.mkdir(path.join(outside, "evil"), { recursive: true });
      await fs.writeFile(path.join(outside, "evil", "SKILL.md"), skill("evil", "Smuggled in."), "utf8");
      const skillsDir = path.join(root, ".windowrunner", "skills");
      await fs.mkdir(skillsDir, { recursive: true });
      await fs.symlink(outside, path.join(skillsDir, "evil"), "junction");

      const pr = await ProjectRoot.create(root, []);
      const { skills, diagnostics } = await loadSkills(pr);
      assert.deepEqual(skills, [], "a symlinked skill directory must never be loaded");
      assert.deepEqual(reasons(diagnostics), ["path_escapes"]);
    } finally {
      await removeTempPath(parent);
    }
  });
});

describe("skills loader: exposed constants", () => {
  it("publishes the conventions the rest of the system depends on", () => {
    assert.equal(SKILLS_DIR, path.join(".windowrunner", "skills"));
    assert.match("release-notes", SKILL_NAME_RE);
    assert.match("a", SKILL_NAME_RE);
    assert.match("a1-b2", SKILL_NAME_RE);
    for (const bad of ["Release", "1abc", "a_b", "a b", "", "-lead", "trail-"]) {
      assert.doesNotMatch(bad, SKILL_NAME_RE, `${JSON.stringify(bad)} must not be a valid skill name`);
    }
    assert.ok(MAX_BODY_CHARS > 0);
    assert.ok(MAX_DESCRIPTION_CHARS > 0);
    assert.ok(BODY_TRUNCATED_NOTICE.length > 0);
  });
});
