import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ProjectRoot } from "../project-root.js";
import { PathError } from "../project-root.js";

/**
 * Skills loader (ADR 003, phase 1).
 *
 * A skill is instructions only: `.windowrunner/skills/<name>/SKILL.md`, YAML
 * frontmatter plus a markdown body. Nothing here executes project-supplied
 * code — that is the whole point of the design. A skill that wants a command
 * run says so in prose, and the model reaches for `run_terminal`, which still
 * asks. `ToolDefinition.trust` therefore stays unused and
 * RELEASE_CHECKLIST.md:205 stays open, both correctly: neither is reachable
 * until something executes project code.
 *
 * Two invariants, both pinned by packages/server/test/skills.test.ts:
 *
 *   1. Discovery never throws. A malformed, hostile or half-written skill is
 *      excluded with a diagnostic. This is the posture of
 *      `ProjectTrustRegistry.boot()` — malformed files are ignored with a
 *      warning, never trusted, never fatal.
 *   2. Every path goes through `ProjectRoot`, logical containment AND realpath,
 *      so a skill directory cannot be a symlink pointing out of the project.
 *      That matters specifically because skills are project-local: a cloned
 *      repository gets to author them.
 */

/** Where a project keeps its skills, relative to the project root. */
export const SKILLS_DIR = path.join(".windowrunner", "skills");

/** The file inside each skill directory. */
export const SKILL_FILE = "SKILL.md";

/**
 * A skill name is the directory name: lowercase letters, digits and dashes,
 * starting with a letter, not ending in a dash. Deliberately narrow — it
 * becomes a `/`-command in the UI and an argument to `read_skill`, so anything
 * the shell or a URL would treat specially stays out.
 *
 * Starting with a letter (not a digit) is what keeps a name unambiguous as a
 * slash-command and keeps the pattern a strict subset of what a URL path
 * segment accepts.
 */
export const SKILL_NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Frontmatter description cap. Descriptions go into every turn's index. */
export const MAX_DESCRIPTION_CHARS = 500;

/** Body cap. A skill body is loaded into the model's context on demand. */
export const MAX_BODY_CHARS = 32_000;

/** Appended to a truncated body so the model knows it is not seeing the end. */
export const BODY_TRUNCATED_NOTICE = "\n\n[truncated: skill body exceeded the size limit]";

export type SkillDiagnosticReason =
  | "missing_skill_file"
  | "missing_frontmatter"
  | "malformed_frontmatter"
  | "missing_description"
  | "name_mismatch"
  | "invalid_name"
  | "reserved_name"
  | "description_too_long"
  | "body_truncated"
  | "path_escapes"
  | "io_error";

export interface SkillDiagnostic {
  reason: SkillDiagnosticReason;
  /** Skill-relative path, safe to display; never an absolute filesystem path. */
  file: string;
  message: string;
}

export interface SkillMeta {
  name: string;
  description: string;
  /** Path relative to the project root, e.g. `.windowrunner/skills/x/SKILL.md`. */
  path: string;
  body: string;
  truncated: boolean;
}

export interface SkillsIndex {
  skills: SkillMeta[];
  diagnostics: SkillDiagnostic[];
}

export interface LoadSkillsOptions {
  /**
   * Names a skill may not take — in practice the built-in tool names, so a
   * skill cannot impersonate `read_file`. Passed in rather than imported: the
   * loader stays pure and free of any dependency on the tool registry.
   */
  reservedNames?: Iterable<string>;
}

interface ParsedSkillFile {
  data: Record<string, string>;
  body: string;
}

/**
 * A deliberately strict, deliberately tiny frontmatter parser.
 *
 * There is no YAML dependency in `packages/server` — its only runtime
 * dependency is `express` — and `ci.yml:86` audits production dependencies
 * against the invariant recorded at `ci.yml:81` ("zero runtime npm
 * dependencies"). Adding a general YAML parser to read two scalars would grow
 * that audited surface permanently.
 *
 * So this accepts `key: value` scalars and **rejects everything else**: block
 * sequences, nested maps, document markers, list items. Rejecting is the right
 * posture for untrusted project-supplied files — a skill author who writes
 * nested YAML gets a diagnostic naming the problem, not a silently-dropped
 * field they will debug for an hour.
 *
 * Not a YAML parser and must not grow into one. If a future field genuinely
 * needs real YAML, that is its own decision with its own dependency audit.
 */
export function parseSkillFile(text: string): ParsedSkillFile {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---\n") && normalized !== "---") {
    throw new Error("missing frontmatter: the file must start with a '---' line");
  }
  const afterOpen = normalized.slice(4);
  const end = afterOpen.indexOf("\n---");
  if (end === -1) {
    throw new Error("missing frontmatter: no closing '---' line");
  }
  const fm = afterOpen.slice(0, end);
  const body = afterOpen.slice(end + 4).replace(/^\n/, "");

  const data: Record<string, string> = {};
  const lines = fm.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (/^\s/.test(line)) {
      throw new Error(`frontmatter line ${i + 1} is indented; only 'key: value' scalars are accepted`);
    }
    if (/^(-|\.\.\.|%)/.test(line)) {
      throw new Error(`frontmatter line ${i + 1} is not a 'key: value' scalar`);
    }
    const sep = line.indexOf(":");
    if (sep === -1) {
      throw new Error(`frontmatter line ${i + 1} has no ':' separator`);
    }
    const key = line.slice(0, sep).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
      throw new Error(`frontmatter line ${i + 1} has an invalid key`);
    }
    let value = line.slice(sep + 1).trim();
    if (value === "") {
      // Empty means a block collection follows (`description:` then indented
      // items). Reject rather than record an empty string.
      throw new Error(`frontmatter line ${i + 1} has an empty value; only scalars are accepted`);
    }
    if (/^[-?]/.test(value)) {
      throw new Error(`frontmatter line ${i + 1} is a sequence entry, not a scalar`);
    }
    // Strip one layer of matching quotes, if present.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }

  return { data, body: body.replace(/\s+$/, "") };
}

function diag(reason: SkillDiagnosticReason, file: string, message: string): SkillDiagnostic {
  return { reason, file, message };
}

/**
 * Discover the project's skills. Never throws: every failure mode becomes a
 * diagnostic, so one hostile or broken skill cannot break the turn that asked
 * for the index.
 */
export async function loadSkills(projectRoot: ProjectRoot, options: LoadSkillsOptions = {}): Promise<SkillsIndex> {
  const reserved = new Set(options.reservedNames ?? []);
  const diagnostics: SkillDiagnostic[] = [];

  let entries: string[];
  try {
    const abs = projectRoot.resolve(SKILLS_DIR);
    const dirents = await fs.readdir(abs, { withFileTypes: true });
    // Sorted so diagnostics are deterministic across platforms: readdir order
    // is filesystem-dependent, and a test that asserts diagnostic order must
    // not depend on it.
    entries = dirents.map((d) => d.name).sort();
  } catch (err) {
    // No skills directory is the normal case for most projects, not an error.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { skills: [], diagnostics: [] };
    // A skills directory that exists but cannot be read IS worth reporting.
    diagnostics.push(
      diag("io_error", SKILLS_DIR, `cannot read the skills directory: ${(err as Error)?.message ?? String(err)}`)
    );
    return { skills: [], diagnostics };
  }

  const candidates: { name: string; dirName: string; relPath: string; description: string; body: string }[] = [];

  for (const dirName of entries) {
    const relDir = path.join(SKILLS_DIR, dirName);
    const relPath = path.join(relDir, SKILL_FILE);

    // Logical containment AND realpath, via ProjectRoot. A skill directory that
    // is a symlink out of the project is refused here — which is what stops a
    // cloned repository from pointing a "skill" at an arbitrary path on disk.
    try {
      await projectRoot.resolveReal(relDir);
      await projectRoot.resolveReal(relPath);
    } catch (err) {
      if (err instanceof PathError && err.code === "PATH_ESCAPES_ROOT") {
        diagnostics.push(diag("path_escapes", relDir, `not inside the project root: ${err.message}`));
        continue;
      }
      // ENOENT and friends: not a skill directory (a stray file, an empty
      // directory, a directory with no SKILL.md). Handle below.
    }

    let isDirectory = false;
    let hasSkillFile = false;
    try {
      const absDir = projectRoot.resolve(relDir);
      // stat follows symlinks, but resolveReal above has already refused any
      // skill directory whose real path leaves the project, so what is left to
      // shape-check is genuinely inside the root.
      isDirectory = (await fs.stat(absDir)).isDirectory();
      if (isDirectory) {
        await fs.stat(projectRoot.resolve(relPath));
        hasSkillFile = true;
      }
    } catch {
      // Not a directory, or no SKILL.md — decided below.
    }

    if (!isDirectory) continue;
    if (!hasSkillFile) {
      diagnostics.push(diag("missing_skill_file", relDir, `no ${SKILL_FILE} in ${relDir}`));
      continue;
    }

    let raw: string;
    try {
      raw = await projectRoot.readFile(relPath);
    } catch (err) {
      if (err instanceof PathError && err.code === "PATH_ESCAPES_ROOT") {
        diagnostics.push(diag("path_escapes", relPath, `not inside the project root: ${err.message}`));
      } else {
        diagnostics.push(diag("io_error", relPath, `cannot read ${SKILL_FILE}: ${(err as Error)?.message ?? String(err)}`));
      }
      continue;
    }

    let parsed: ParsedSkillFile;
    try {
      parsed = parseSkillFile(raw);
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      const reason: SkillDiagnosticReason = message.startsWith("missing frontmatter")
        ? "missing_frontmatter"
        : "malformed_frontmatter";
      diagnostics.push(diag(reason, relPath, message));
      continue;
    }

    const name = parsed.data.name;
    const description = parsed.data.description;

    if (!description) {
      diagnostics.push(diag("missing_description", relPath, "frontmatter has no `description`; the index needs one"));
      continue;
    }
    if (description.length > MAX_DESCRIPTION_CHARS) {
      diagnostics.push(
        diag(
          "description_too_long",
          relPath,
          `description is ${description.length} characters; the limit is ${MAX_DESCRIPTION_CHARS}`
        )
      );
      continue;
    }
    if (name !== dirName) {
      diagnostics.push(
        diag("name_mismatch", relPath, `frontmatter name ${JSON.stringify(name ?? "")} must equal the directory name ${JSON.stringify(dirName)}`)
      );
      continue;
    }
    if (!SKILL_NAME_RE.test(name)) {
      diagnostics.push(
        diag("invalid_name", relPath, `skill name ${JSON.stringify(name)} is not valid: lowercase letters, digits and dashes, no leading or trailing dash`)
      );
      continue;
    }
    if (reserved.has(name)) {
      // Defence in depth. Every built-in tool today uses underscores
      // (read_file, run_terminal, …) and SKILL_NAME_RE forbids underscores, so
      // a collision is currently impossible — this fires only if a future tool
      // is named with dashes. Kept because the alternative is discovering the
      // gap the day someone adds `read-file`.
      diagnostics.push(diag("reserved_name", relPath, `skill name ${JSON.stringify(name)} collides with a built-in tool name`));
      continue;
    }

    candidates.push({ name, dirName, relPath, description, body: parsed.body });
  }

  // NOTE ON DUPLICATES: there is no duplicate-name resolution here, and that is
  // a property rather than an omission. The name IS the directory name and
  // `name === dirName` is enforced above, so two skills cannot share a name —
  // directory entries are unique within a directory by definition. Shadowing
  // is structurally impossible. (ADR 003 originally specified a
  // lexicographic-precedence rule; it was unreachable and has been removed.)
  //
  // `candidates` is still sorted so the emitted index and any diagnostics are
  // deterministic across filesystems, whose readdir order is not.
  candidates.sort((a, b) => (a.dirName < b.dirName ? -1 : a.dirName > b.dirName ? 1 : 0));
  const skills: SkillMeta[] = [];
  for (const c of candidates) {
    let body = c.body;
    let truncated = false;
    if (body.length > MAX_BODY_CHARS) {
      body = body.slice(0, MAX_BODY_CHARS) + BODY_TRUNCATED_NOTICE;
      truncated = true;
      diagnostics.push(
        diag("body_truncated", c.relPath, `body exceeded ${MAX_BODY_CHARS} characters and was truncated`)
      );
    }

    skills.push({ name: c.name, description: c.description, path: c.relPath, body, truncated });
  }

  return { skills, diagnostics };
}
