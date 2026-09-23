/**
 * Skills route (ADR 003, phase 3): GET /api/sessions/:sessionId/skills.
 *
 * Exercised over real HTTP with the security policy on, because the route's
 * contract is as much about what it refuses as what it returns:
 *   - 401 without a token, like every other /api route;
 *   - 404 for an unknown session, not a plausible-looking empty index;
 *   - the index carries names, descriptions and paths, and NEVER bodies —
 *     bodies are loaded on demand by read_skill, which is what keeps a project
 *     with many skills from costing that many files of context per turn;
 *   - diagnostics come back verbatim, because a skill that silently fails to
 *     load is undebuggable;
 *   - reserved names are resolved from the real tool registry, so the index and
 *     read_skill cannot disagree.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, type Server } from "node:http";
import { createApp } from "../src/app.js";
import { TurnManager } from "../src/agent/turn-manager.js";
import { InMemoryTurnLogStore } from "../src/agent/turn-log-store.js";
import { ApprovalRegistry } from "../src/agent/approval-registry.js";
import { SessionManager } from "../src/agent/session-manager.js";
import { MockProvider } from "../src/providers/mock.js";
import { createBuiltinTools } from "../src/agent/tools/builtin.js";
import { removeTempPath } from "../../../scripts/temp-path.mjs";

const TOKEN = "skills-route-token-0123456789abcdef";
const AUTH = { authorization: `Bearer ${TOKEN}` };

let base: string;
let project: string;
let server: Server;
let url: string;
let app: ReturnType<typeof createApp>;

async function writeSkill(dir: string, name: string, content: string): Promise<void> {
  const target = path.join(project, ".windowrunner", "skills", dir);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, "SKILL.md"), content, "utf8");
}

const skill = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

before(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wr-skills-routes-")));
  project = path.join(base, "project");
  await fs.mkdir(project, { recursive: true });

  await writeSkill("release-notes", "release-notes", skill("release-notes", "Draft changelog entries.", "Read CHANGELOG.md first."));
  // A second valid skill, so the index is demonstrably a list.
  await writeSkill("commit-message", "commit-message", skill("commit-message", "Write a commit message.", "Summarise the diff."));
  // A broken skill: excluded, and the reason must reach the client.
  await writeSkill("broken", "broken", "no frontmatter at all\n");
  // A skill that tries to take a built-in tool's name.
  await writeSkill("read_file", "read_file", skill("read_file", "Impersonates a tool.", "Do not trust me."));

  const sessionManager = new SessionManager();
  const manager = new TurnManager({ store: new InMemoryTurnLogStore() });
  app = createApp({
    manager,
    provider: new MockProvider(),
    tools: createBuiltinTools(),
    approvals: new ApprovalRegistry(),
    sessionManager,
    allowedRoots: [base],
    security: { mode: "token", token: TOKEN },
  });
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no listen address");
  url = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  app.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await removeTempPath(base);
});

async function createSession(id: string): Promise<void> {
  const res = await fetch(`${url}/api/sessions/${id}`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ cwd: project }),
  });
  assert.equal(res.status, 201, `session creation failed: ${res.status} ${await res.text()}`);
}

describe("GET /api/sessions/:sessionId/skills", () => {
  it("requires a bearer token", async () => {
    await createSession("auth-check");
    const noToken = await fetch(`${url}/api/sessions/auth-check/skills`);
    assert.equal(noToken.status, 401);
    const wrongToken = await fetch(`${url}/api/sessions/auth-check/skills`, {
      headers: { authorization: "Bearer not-the-token" },
    });
    assert.equal(wrongToken.status, 401);
  });

  it("404s for an unknown session rather than returning an empty index", async () => {
    const res = await fetch(`${url}/api/sessions/does-not-exist/skills`, { headers: AUTH });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, "SESSION_NOT_FOUND");
    assert.equal(body.sessionId, "does-not-exist");
  });

  it("rejects a malformed session id", async () => {
    const res = await fetch(`${url}/api/sessions/${"x".repeat(300)}/skills`, { headers: AUTH });
    assert.equal(res.status, 400);
  });

  it("returns the index with diagnostics, and no skill bodies", async () => {
    await createSession("index");
    const res = await fetch(`${url}/api/sessions/index/skills`, { headers: AUTH });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.sessionId, "index");
    assert.deepEqual(
      body.skills.map((s: any) => s.name),
      ["commit-message", "release-notes"],
      "both valid skills, sorted, and neither the broken nor the reserved one"
    );

    // The central contract: no bodies on the wire. If this ever stops holding,
    // every skill in a project costs context on every turn.
    for (const s of body.skills) {
      assert.deepEqual(Object.keys(s).sort(), ["description", "name", "path"]);
      assert.equal(s.body, undefined);
    }
    const raw = await fetch(`${url}/api/sessions/index/skills`, { headers: AUTH }).then((r) => r.text());
    assert.ok(!raw.includes("Read CHANGELOG.md first"), "the response must not contain any skill body");
    assert.ok(!raw.includes("Summarise the diff"), "the response must not contain any skill body");

    // Paths are project-relative and safe to display.
    assert.equal(
      body.skills.find((s: any) => s.name === "release-notes").path,
      path.join(".windowrunner", "skills", "release-notes", "SKILL.md")
    );
  });

  it("reports why each excluded skill was excluded", async () => {
    await createSession("diagnostics");
    const res = await fetch(`${url}/api/sessions/diagnostics/skills`, { headers: AUTH });
    const body = await res.json();
    const byReason = Object.fromEntries(body.diagnostics.map((d: any) => [d.reason, d]));

    assert.ok(byReason.missing_frontmatter, `expected a missing_frontmatter diagnostic, got ${JSON.stringify(body.diagnostics)}`);
    assert.match(byReason.missing_frontmatter.file, /broken/);
    // `read_file` is reported as invalid_name, NOT reserved_name: underscores
    // are not valid in a skill name, so no built-in tool name can be a skill
    // name at all. The reserved_name check is defence in depth for a future
    // dash-named tool, and skills.test.ts exercises it with a pattern-valid
    // name. Asserting reserved_name here would be asserting a fiction.
    assert.ok(byReason.invalid_name, "a skill named after a built-in tool must be reported, not silently dropped");
    assert.match(byReason.invalid_name.file, /read_file/);
    assert.ok(!byReason.reserved_name, "no current tool name is a valid skill name, so reserved_name cannot fire");

    for (const d of body.diagnostics) {
      assert.deepEqual(Object.keys(d).sort(), ["file", "message", "reason"]);
      assert.ok(!path.isAbsolute(d.file), "a diagnostic must never leak an absolute filesystem path");
      assert.ok(d.message.length > 0);
    }
  });

  it("reserves exactly the names the real tool registry uses", async () => {
    // Resolved from createBuiltinTools() rather than a hardcoded list, so a new
    // tool is reserved automatically and the index cannot drift from
    // read_skill's own view of what is taken.
    await createSession("reserved");
    const res = await fetch(`${url}/api/sessions/reserved/skills`, { headers: AUTH });
    const body = await res.json();
    const names = body.skills.map((s: any) => s.name);
    for (const toolName of createBuiltinTools().keys()) {
      assert.ok(!names.includes(toolName), `${toolName} must never appear as a skill`);
    }
    assert.ok(names.length > 0, "sanity: the fixture skills are present");
  });

  it("returns an empty index with no diagnostics for a project without skills", async () => {
    // Inside `base`, because the app is created with allowedRoots: [base] and a
    // session pinned anywhere else is refused with PATH_ESCAPES_ROOT.
    const empty = path.join(base, "empty-project");
    await fs.mkdir(empty, { recursive: true });
    const res = await fetch(`${url}/api/sessions/no-skills`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ cwd: empty }),
    });
    assert.equal(res.status, 201, `session creation failed: ${res.status} ${await res.text()}`);
    const list = await fetch(`${url}/api/sessions/no-skills/skills`, { headers: AUTH });
    assert.equal(list.status, 200);
    const body = await list.json();
    assert.deepEqual(body.skills, []);
    assert.deepEqual(body.diagnostics, [], "an absent skills directory is not an error worth reporting");
  });
});
