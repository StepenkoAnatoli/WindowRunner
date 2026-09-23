/**
 * The `/`-command skills palette and the read-only skills panel (ADR 003,
 * plan phase 6).
 *
 * The property these tests exist to pin: selecting a skill does NOT inject
 * skill content into the turn. The composer ends up holding `/<name>` and the
 * form submits that, so the model calls `read_skill` itself — one mechanism for
 * both activation modes. If a test here ever shows a skill body reaching the
 * composer, the two-path split the ADR rejected has come back.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installDomStub, uninstallDomStub, type FakeElement } from "./dom-stub.js";
import { attachSkillsPalette, filterSkills, renderSkillsPanel, skillInvocation } from "../src/skills-palette.js";
import type { SkillMeta } from "@windows-runner/shared";

const mk = (name: string, description: string): SkillMeta => ({
  name,
  description,
  path: `.windowrunner/skills/${name}/SKILL.md`,
});

const SKILLS = [
  mk("release-notes", "Draft changelog entries from a diff."),
  mk("commit-message", "Write a commit message for staged changes."),
  mk("db-migrate", "Generate a migration from a schema change."),
];

describe("filterSkills", () => {
  it("returns everything for an empty query, and a copy rather than the input", () => {
    const out = filterSkills(SKILLS, "");
    assert.deepEqual(out.map((s) => s.name), SKILLS.map((s) => s.name));
    assert.notEqual(out, SKILLS, "must not hand back the caller's array");
  });

  it("matches on name and on description, case-insensitively", () => {
    assert.deepEqual(filterSkills(SKILLS, "release").map((s) => s.name), ["release-notes"]);
    assert.deepEqual(filterSkills(SKILLS, "COMMIT").map((s) => s.name), ["commit-message"]);
    // Matches the description, not the name.
    assert.deepEqual(filterSkills(SKILLS, "changelog").map((s) => s.name), ["release-notes"]);
    assert.deepEqual(filterSkills(SKILLS, "migration").map((s) => s.name), ["db-migrate"]);
  });

  it("returns nothing for a query that matches no skill", () => {
    assert.deepEqual(filterSkills(SKILLS, "zzz"), []);
  });
});

describe("skillInvocation", () => {
  it("is the slash form of the name, and nothing more", () => {
    assert.equal(skillInvocation("release-notes"), "/release-notes");
  });
});

describe("attachSkillsPalette", () => {
  let form: FakeElement;
  let input: FakeElement;
  let submitted: string[];
  let palette: ReturnType<typeof attachSkillsPalette>;

  function build(skills: SkillMeta[] = SKILLS) {
    // Mirrors the composer workspace.ts builds: a container holding the form,
    // with the message input inside it. Under the DOM stub
    // `document.createElement` returns a FakeElement, so these are used
    // directly rather than cast back and forth through HTMLElement.
    input = document.createElement("textarea") as unknown as FakeElement;
    input.setAttribute("data-testid", "message-input");
    form = document.createElement("form") as unknown as FakeElement;
    form.append(input);
    const wrap = document.createElement("div") as unknown as FakeElement;
    wrap.append(form);
    submitted = [];
    palette = attachSkillsPalette(form as unknown as HTMLElement, {
      getSkills: () => skills,
      onPick: (name) => {
        // Same contract workspace.ts uses: the composer already holds the
        // invocation, and the caller submits whatever is in it.
        submitted.push(input.value);
        assert.equal(name, input.value.slice(1));
      },
    });
    return wrap;
  }

  const list = (wrap: FakeElement) => wrap.querySelector('[data-testid="skills-palette"]') as unknown as FakeElement;
  const options = (wrap: FakeElement) =>
    Array.from(wrap.querySelectorAll('[data-testid="skills-palette-option"]')) as unknown as FakeElement[];
  const type = (value: string) => {
    input.value = value;
    input.fire("input", { target: input });
  };
  const key = (k: string) => input.fire("keydown", { key: k, target: input });

  beforeEach(() => installDomStub());
  afterEach(() => uninstallDomStub());

  it("stays closed until the text starts with a slash", () => {
    const wrap = build();
    assert.equal(palette.open, false);
    assert.equal(list(wrap).getAttribute("hidden"), "true");
    type("and/or this is prose");
    assert.equal(palette.open, false, "a slash inside a sentence must not open the palette");
    type("/");
    assert.equal(palette.open, true);
  });

  it("lists every skill on a bare slash and filters as typed", () => {
    const wrap = build();
    type("/");
    assert.deepEqual(options(wrap).map((o) => o.getAttribute("data-skill")), ["release-notes", "commit-message", "db-migrate"]);
    type("/com");
    assert.deepEqual(options(wrap).map((o) => o.getAttribute("data-skill")), ["commit-message"]);
    type("/zzz");
    assert.deepEqual(options(wrap), [], "no matches renders no options");
  });

  it("closes when the user moves on to prose after the slash", () => {
    const wrap = build();
    type("/rel");
    assert.equal(palette.open, true);
    type("/rel and then some words");
    assert.equal(palette.open, false);
    assert.equal(list(wrap).getAttribute("hidden"), "true");
  });

  it("picking a skill puts the invocation in the composer and never a body", () => {
    build();
    type("/rel");
    palette.sync();
    const opts = options(form.parentElement as unknown as FakeElement);
    opts[0].click();
    assert.deepEqual(submitted, ["/release-notes"], "the composer holds the invocation, and the caller submits");
    assert.ok(!input.value.includes("Draft changelog"), "no skill body may reach the composer");
    assert.equal(palette.open, false, "the palette closes on pick");
  });

  it("arrows move the selection and Enter picks the highlighted skill", () => {
    const wrap = build();
    type("/");
    key("ArrowDown");
    assert.equal(options(wrap)[1].getAttribute("aria-selected"), "true");
    key("ArrowDown");
    assert.equal(options(wrap)[2].getAttribute("aria-selected"), "true");
    key("ArrowDown");
    assert.equal(options(wrap)[0].getAttribute("aria-selected"), "true", "wraps forward");
    key("ArrowUp");
    assert.equal(options(wrap)[2].getAttribute("aria-selected"), "true", "wraps backward");
    key("Enter");
    assert.deepEqual(submitted, ["/db-migrate"]);
  });

  it("Escape closes without clearing the composer, and does not swallow the key once closed", () => {
    build();
    type("/rel");
    let prevented = 0;
    const ev = { key: "Escape", target: input, preventDefault: () => { prevented += 1; } };
    input.fire("keydown", ev);
    assert.equal(palette.open, false);
    assert.equal(input.value, "/rel", "Escape must not discard what the user typed");
    assert.equal(prevented, 1);
    // Second Escape: the palette is already closed, so it must not intercept.
    input.fire("keydown", { key: "Escape", target: input, preventDefault: () => { prevented += 1; } });
    assert.equal(prevented, 1, "a closed palette must leave Escape alone");
  });

  it("renders no options for a project with no skills, and never opens", () => {
    const wrap = build([]);
    type("/");
    assert.deepEqual(options(wrap), []);
    key("Enter");
    assert.deepEqual(submitted, [], "Enter with nothing highlighted must not submit");
  });
});

describe("renderSkillsPanel", () => {
  beforeEach(() => installDomStub());
  afterEach(() => uninstallDomStub());

  it("explains how to add a skill when the project has none", () => {
    const panel = renderSkillsPanel([], []) as unknown as FakeElement;
    // The empty state IS the returned element, so the testid is on it rather
    // than on a descendant — querySelector is descendants-only, as in the real
    // DOM.
    assert.equal(panel.getAttribute("data-testid"), "skills-none");
    assert.match(panel.textContent, /\.windowrunner\/skills/);
  });

  it("lists skills with name, description and path", () => {
    const panel = renderSkillsPanel(SKILLS, []) as unknown as FakeElement;
    const items = Array.from(panel.querySelectorAll('[data-testid="skills-list-item"]')) as unknown as FakeElement[];
    assert.equal(items.length, 3);
    assert.equal(items[0].getAttribute("data-skill"), "release-notes");
    assert.match(items[0].textContent, /Draft changelog entries from a diff\./);
    assert.match(items[0].textContent, /release-notes\/SKILL\.md/);
  });

  it("shows diagnostics verbatim, with the reason and the file", () => {
    const panel = renderSkillsPanel([], [
      { reason: "missing_frontmatter", file: ".windowrunner/skills/broken/SKILL.md", message: "no closing '---' line" },
    ]) as unknown as FakeElement;
    const box = panel.querySelector('[data-testid="skills-diagnostics"]');
    assert.ok(box, "diagnostics must be surfaced, not swallowed");
    const item = panel.querySelector('[data-testid="skills-diagnostic"]') as unknown as FakeElement;
    assert.equal(item.getAttribute("data-reason"), "missing_frontmatter");
    assert.match(item.textContent, /broken\/SKILL\.md/);
    assert.match(item.textContent, /no closing '---' line/, "the server's message is shown verbatim");
  });
});
