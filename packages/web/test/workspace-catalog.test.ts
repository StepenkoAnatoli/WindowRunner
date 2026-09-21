import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CATALOG_PROJECTS,
  MAX_CATALOG_SESSIONS,
  WORKSPACE_CATALOG_STORAGE_KEY,
  createInMemoryCatalogStore,
  createLocalStorageCatalogStore,
  emptyWorkspaceCatalog,
  newCatalogId,
  parseWorkspaceCatalogLenient,
  sessionsForProject,
  sortedProjects,
  validateWorkspaceCatalog,
} from "../src/workspace-catalog.js";

function project(id: string, root: string, lastOpenedAt: number, extra: Record<string, unknown> = {}) {
  return { id, root, label: id, lastOpenedAt, ...extra };
}

function session(sessionId: string, projectId: string, lastOpenedAt: number) {
  return { sessionId, projectId, lastOpenedAt };
}

describe("validateWorkspaceCatalog", () => {
  it("accepts a valid catalog and sorts projects/sessions most-recent-first", () => {
    const validated = validateWorkspaceCatalog({
      version: 1,
      projects: [project("p-old", "/old", 10), project("p-new", "/new", 20)],
      sessions: [session("s-old", "p-old", 5), session("s-new", "p-new", 25)],
    });
    assert.deepEqual(validated.projects.map((p) => p.id), ["p-new", "p-old"]);
    assert.deepEqual(validated.sessions.map((s) => s.sessionId), ["s-new", "s-old"]);
  });

  it("rejects malformed top-level data", () => {
    for (const bad of [null, undefined, 42, "nope", [], { version: 2, projects: [], sessions: [] }, { projects: [], sessions: [] }, { version: 1, projects: {}, sessions: [] }, { version: 1, projects: [], sessions: "x" }]) {
      assert.throws(() => validateWorkspaceCatalog(bad), /workspace catalog/, JSON.stringify(bad));
    }
  });

  it("rejects malformed entries (bad ids, non-absolute roots)", () => {
    assert.throws(() => validateWorkspaceCatalog({ version: 1, projects: [{ id: "", root: "/p", label: "p", lastOpenedAt: 0 }], sessions: [] }), /project id/);
    for (const root of ["relative/path", "", "C:relative"]) {
      assert.throws(() => validateWorkspaceCatalog({ version: 1, projects: [project("p", root, 0)], sessions: [] }), /absolute path/, root);
    }
    assert.throws(() => validateWorkspaceCatalog({ version: 1, projects: [project("p", "/p", 0)], sessions: [{ sessionId: "", projectId: "p", lastOpenedAt: 0 }] }), /session id/);
    assert.throws(() => validateWorkspaceCatalog({ version: 1, projects: [project("p", "/p", 0)], sessions: ["x"] }), /session must be an object/);
  });

  it("accepts windows absolute roots", () => {
    const validated = validateWorkspaceCatalog({ version: 1, projects: [project("p", "C:\\Users\\me\\proj", 0)], sessions: [] });
    assert.equal(validated.projects[0].root, "C:\\Users\\me\\proj");
  });

  it("never accepts token-like unknown fields into the persisted shape", () => {
    const validated = validateWorkspaceCatalog({
      version: 1,
      token: "bearer-secret",
      apiKey: "sk-secret",
      provider: { apiKey: "x" },
      projects: [project("p", "/p", 0, { token: "t", toolInput: { command: "rm" }, transcript: "hello" })],
      sessions: [{ ...session("s", "p", 0), authToken: "t" }],
    });
    const json = JSON.stringify(validated);
    assert.ok(!json.includes("secret"), json);
    assert.ok(!json.includes("token"), json);
    assert.ok(!json.includes("toolInput"), json);
    assert.ok(!json.includes("transcript"), json);
    assert.ok(!json.includes("authToken"), json);
    assert.ok(!json.includes("provider"), json);
    assert.deepEqual(Object.keys(validated).sort(), ["projects", "sessions", "version"]);
    assert.deepEqual(Object.keys(validated.projects[0]).sort(), ["id", "label", "lastOpenedAt", "root"]);
  });

  it("drops orphaned sessions and duplicate ids, derives a missing label", () => {
    const validated = validateWorkspaceCatalog({
      version: 1,
      projects: [project("p", "/projects/cool", 0), { id: "p", root: "/dup", label: "dup", lastOpenedAt: 99 }],
      sessions: [session("s-keep", "p", 0), session("s-orphan", "missing", 0)],
    });
    assert.equal(validated.projects.length, 1);
    assert.equal(validated.projects[0].root, "/projects/cool");
    assert.deepEqual(validated.sessions.map((s) => s.sessionId), ["s-keep"]);
    const unlabeled = validateWorkspaceCatalog({ version: 1, projects: [{ id: "q", root: "/projects/cool", lastOpenedAt: 0 }], sessions: [] });
    assert.equal(unlabeled.projects[0].label, "cool");
  });

  it("caps list sizes after sorting", () => {
    const projects = Array.from({ length: MAX_CATALOG_PROJECTS + 10 }, (_, i) => project(`p${i}`, `/p${i}`, i));
    const validated = validateWorkspaceCatalog({ version: 1, projects, sessions: [] });
    assert.equal(validated.projects.length, MAX_CATALOG_PROJECTS);
    assert.equal(validated.projects[0].id, `p${MAX_CATALOG_PROJECTS + 9}`);
    const many = Array.from({ length: MAX_CATALOG_SESSIONS + 5 }, (_, i) => session(`s${i}`, "p0", i));
    const withSessions = validateWorkspaceCatalog({ version: 1, projects: [project("p0", "/p0", 0)], sessions: many });
    assert.equal(withSessions.sessions.length, MAX_CATALOG_SESSIONS);
  });
});

describe("parseWorkspaceCatalogLenient", () => {
  it("degrades malformed data to an empty catalog instead of throwing", () => {
    assert.deepEqual(parseWorkspaceCatalogLenient("garbage"), emptyWorkspaceCatalog());
    assert.deepEqual(parseWorkspaceCatalogLenient({ version: 99 }), emptyWorkspaceCatalog());
    assert.deepEqual(parseWorkspaceCatalogLenient(null), emptyWorkspaceCatalog());
  });
});

describe("catalog view helpers", () => {
  it("scopes sessions to the selected project, most-recent-first", () => {
    const catalog = validateWorkspaceCatalog({
      version: 1,
      projects: [project("a", "/a", 0), project("b", "/b", 0)],
      sessions: [session("s1", "a", 1), session("s2", "b", 2), session("s3", "a", 3)],
    });
    assert.deepEqual(sessionsForProject(catalog, "a").map((s) => s.sessionId), ["s3", "s1"]);
    assert.deepEqual(sessionsForProject(catalog, "b").map((s) => s.sessionId), ["s2"]);
    assert.deepEqual(sortedProjects(catalog).map((p) => p.id).sort(), ["a", "b"]);
  });

  it("mints URL- and session-id-safe catalog ids", () => {
    const ids = new Set([newCatalogId("p"), newCatalogId("s"), newCatalogId("s")]);
    assert.equal(ids.size, 3);
    for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{1,128}$/);
  });
});

describe("catalog stores", () => {
  function memoryStorage(initial: Record<string, string> = {}) {
    const map = new Map(Object.entries(initial));
    return {
      storage: {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
      },
      map,
    };
  }

  it("localStorage store migrates absent storage to an empty v1 catalog", async () => {
    const { storage } = memoryStorage();
    assert.deepEqual(await createLocalStorageCatalogStore(storage).load(), emptyWorkspaceCatalog());
  });

  it("localStorage store degrades corrupt data to empty and round-trips valid catalogs", async () => {
    const { storage, map } = memoryStorage({ [WORKSPACE_CATALOG_STORAGE_KEY]: "{not json" });
    const store = createLocalStorageCatalogStore(storage);
    assert.deepEqual(await store.load(), emptyWorkspaceCatalog());
    map.set(WORKSPACE_CATALOG_STORAGE_KEY, JSON.stringify({ version: 1, projects: [project("p", "relative", 0)], sessions: [] }));
    assert.deepEqual(await store.load(), emptyWorkspaceCatalog());
    const catalog = validateWorkspaceCatalog({ version: 1, projects: [project("p", "/p", 7)], sessions: [session("s", "p", 8)] });
    await store.save(catalog);
    assert.deepEqual(await store.load(), catalog);
    assert.deepEqual(JSON.parse(map.get(WORKSPACE_CATALOG_STORAGE_KEY)!), catalog);
  });

  it("localStorage save rejects invalid catalogs without writing", async () => {
    const { storage, map } = memoryStorage();
    const store = createLocalStorageCatalogStore(storage);
    await assert.rejects(store.save({ version: 1, projects: [{ id: "p", root: "relative", label: "p", lastOpenedAt: 0 }], sessions: [] } as never));
    assert.equal(map.has(WORKSPACE_CATALOG_STORAGE_KEY), false);
  });

  it("in-memory store validates on the way in and degrades on load", async () => {
    const store = createInMemoryCatalogStore("garbage");
    assert.deepEqual(await store.load(), emptyWorkspaceCatalog());
    const catalog = validateWorkspaceCatalog({ version: 1, projects: [project("p", "/p", 1)], sessions: [] });
    await store.save(catalog);
    assert.deepEqual(await store.load(), catalog);
    await assert.rejects(store.save("garbage" as never));
  });
});
