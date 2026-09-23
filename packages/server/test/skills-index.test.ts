/**
 * The auto-discovery skills index (ADR 003, plan phase 5).
 *
 * The index is how the model learns skills exist: names and descriptions only,
 * never bodies, prepended to the turn's first user message. Bodies load on
 * demand through `read_skill`.
 *
 * Two properties this file exists to pin:
 *   - no skills means byte-identical messages. A project without skills pays
 *     nothing — no framing, no header, no stray newline.
 *   - bodies never enter the index. If they did, every skill in a project would
 *     cost context on every turn, which is the thing the on-demand design
 *     avoids.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { TurnRunner } from "../src/agent/loop.js";
import { TurnManager } from "../src/agent/turn-manager.js";
import { InMemoryTurnLogStore } from "../src/agent/turn-log-store.js";
import { ApprovalRegistry } from "../src/agent/approval-registry.js";
import { createBuiltinTools } from "../src/agent/tools/builtin.js";
import { FakeProvider, Steps, type ProviderStep } from "./fakes/fake-provider.js";
import {
  MAX_INDEX_SKILLS,
  renderSkillsIndex,
  type SkillLoaded,
} from "../src/agent/skills.js";
import { removeTempPath } from "../../../scripts/temp-path.mjs";

let base: string;
let project: string;
const tools = createBuiltinTools({ terminalTimeoutMs: 5000 });

const mk = (name: string, description: string, body = "Body text."): SkillLoaded => ({
  name,
  description,
  path: path.join(".windowrunner", "skills", name, "SKILL.md"),
  body,
  truncated: false,
});

before(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wr-skills-index-")));
  project = path.join(base, "project");
  await fs.mkdir(project, { recursive: true });
});

after(async () => {
  await removeTempPath(base);
});

async function writeSkill(dir: string, description: string, body: string): Promise<void> {
  const target = path.join(project, ".windowrunner", "skills", dir);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, "SKILL.md"), `---\nname: ${dir}\ndescription: ${description}\n---\n${body}\n`, "utf8");
}

async function runTurn(steps: ProviderStep[], userMessage = "go") {
  const manager = new TurnManager({ store: new InMemoryTurnLogStore() });
  const approvals = new ApprovalRegistry();
  const provider = new FakeProvider(steps);
  const runner = new TurnRunner({ provider, tools, approvals, manager, allowedRoots: [base] });
  manager.ensureLog("s", "t", { maxSteps: 4, modelCallTimeoutMs: 5000, toolTimeoutMs: 5000, approvalTimeoutMs: 5000 });
  const result = await runner.run({
    sessionId: "s",
    turnId: "t",
    cwd: project,
    request: {
      messages: [{ role: "user", content: userMessage }],
      tools: [...tools.values()].map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })),
    },
    limits: { maxSteps: 4, modelCallTimeoutMs: 5000, toolTimeoutMs: 5000, approvalTimeoutMs: 5000 },
    signal: new AbortController().signal,
  });
  return { result, provider };
}

describe("renderSkillsIndex", () => {
  it("returns undefined for no skills, so nothing is injected at all", () => {
    assert.equal(renderSkillsIndex([]), undefined);
  });

  it("lists names and descriptions, marks the content untrusted, and never includes a body", () => {
    const text = renderSkillsIndex([
      mk("release-notes", "Draft changelog entries.", "SECRET BODY ONE"),
      mk("commit-message", "Write a commit message.", "SECRET BODY TWO"),
    ])!;
    assert.match(text, /release-notes/);
    assert.match(text, /Draft changelog entries\./);
    assert.match(text, /commit-message/);
    assert.match(text, /Write a commit message\./);
    // The framing that keeps project-authored text from reading as system truth.
    assert.match(text, /untrusted/i);
    assert.match(text, /read_skill/);
    assert.ok(!text.includes("SECRET BODY ONE"), "a body must never enter the index");
    assert.ok(!text.includes("SECRET BODY TWO"), "a body must never enter the index");
  });

  it("caps the listing and says how many were omitted", () => {
    const extra = 15;
    const many = Array.from({ length: MAX_INDEX_SKILLS + extra }, (_, i) => mk(`skill-${String(i).padStart(3, "0")}`, `Description ${i}.`));
    const text = renderSkillsIndex(many)!;
    // Omitted = total - cap, stated rather than silent.
    assert.match(text, new RegExp(`and ${extra} more`), "the omission must be stated, not silent");
    assert.ok(text.includes(`skill-${String(MAX_INDEX_SKILLS - 1).padStart(3, "0")}`), "the last skill within the cap is listed");
    assert.ok(!text.includes(`skill-${String(MAX_INDEX_SKILLS).padStart(3, "0")}`), "the first skill past the cap is not");
    assert.ok(!text.includes(`Description ${MAX_INDEX_SKILLS}.`), "skills past the cap must not be listed");
    // Exactly the cap, no more.
    assert.equal((text.match(/^- skill-/gm) ?? []).length, MAX_INDEX_SKILLS);
  });

  it("lists everything when the count is exactly at the cap, with no omission notice", () => {
    const atCap = Array.from({ length: MAX_INDEX_SKILLS }, (_, i) => mk(`s${i}`, `D ${i}.`));
    const text = renderSkillsIndex(atCap)!;
    assert.ok(!/more \(list omitted/.test(text), "nothing was omitted, so nothing should be claimed omitted");
    assert.equal((text.match(/^- s\d+: /gm) ?? []).length, MAX_INDEX_SKILLS);
  });
});

describe("the per-turn index", () => {
  it("sends a byte-identical message when the project has no skills", async () => {
    const { provider } = await runTurn([Steps.text("hi")], "please summarise");
    const sent = provider.requests[0].messages[0];
    assert.equal(sent.role, "user");
    assert.equal(sent.content, "please summarise", "no framing, no header, no stray newline");
  });

  it("prepends the index when the project has skills, without leaking bodies", async () => {
    await writeSkill("release-notes", "Draft changelog entries from a diff.", "Read CHANGELOG.md first, then draft.");
    try {
      const { provider } = await runTurn([Steps.text("hi")], "please summarise");
      const content = provider.requests[0].messages[0].content as string;
      assert.match(content, /release-notes/);
      assert.match(content, /Draft changelog entries from a diff\./);
      assert.ok(content.endsWith("please summarise"), "the user's message stays last and intact");
      assert.ok(!content.includes("Read CHANGELOG.md first"), "the body must not be in the index");
    } finally {
      await removeTempPath(path.join(project, ".windowrunner"));
    }
  });

  it("recomputes per turn, so a skill added mid-session appears on the next turn", async () => {
    const first = await runTurn([Steps.text("hi")], "one");
    assert.ok(!(first.provider.requests[0].messages[0].content as string).includes("late-addition"));

    await writeSkill("late-addition", "Added after the first turn.", "Body.");
    try {
      const second = await runTurn([Steps.text("hi")], "two");
      assert.match(second.provider.requests[0].messages[0].content as string, /late-addition/);
    } finally {
      await removeTempPath(path.join(project, ".windowrunner"));
    }
  });

  it("still runs the turn when the skills directory cannot be read", async () => {
    // loadSkills reports rather than throws, and the loop must not turn a
    // skills problem into a failed turn — the user's request is the priority.
    const skillsDir = path.join(project, ".windowrunner", "skills");
    await fs.mkdir(skillsDir, { recursive: true });
    // A skill directory whose SKILL.md is unreadable-as-text is still just a
    // diagnostic; assert the turn completes regardless.
    await fs.writeFile(path.join(skillsDir, "odd"), "", "utf8");
    try {
      const { result, provider } = await runTurn([Steps.text("hi")], "carry on");
      assert.equal(result.status, "completed");
      assert.equal(provider.requests[0].messages[0].content, "carry on");
    } finally {
      await removeTempPath(path.join(project, ".windowrunner"));
    }
  });
});
