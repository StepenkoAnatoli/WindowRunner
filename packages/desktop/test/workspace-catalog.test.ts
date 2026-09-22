/**
 * Desktop workspace-catalog persistence (B1).
 *
 * Pins the main-process contract: strict validation before every write
 * (malformed values throw and nothing is written), atomic persistence,
 * missing/corrupt files load as null, and unknown token-like fields never
 * reach the file.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeTempPath } from "../../../scripts/temp-path.mjs";
import {
  emptyWorkspaceCatalog,
  loadWorkspaceCatalogFile,
  saveWorkspaceCatalogFile,
  validateWorkspaceCatalog,
} from "../src/workspace-catalog.js";

const tmps: string[] = [];
after(async () => {
  await Promise.all(tmps.map((t) => removeTempPath(t)));
});

async function tmpFile(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wr-catalog-"));
  tmps.push(dir);
  return path.join(dir, "workspace-catalog.json");
}

describe("desktop workspace catalog", () => {
  it("validates strictly and strips unknown fields", () => {
    const validated = validateWorkspaceCatalog({
      version: 1,
      token: "bearer-secret",
      projects: [{ id: "p", root: path.sep === "\\" ? "C:\\proj" : "/proj", label: "proj", lastOpenedAt: 5, apiKey: "sk-x" }],
      sessions: [{ sessionId: "s", projectId: "p", lastOpenedAt: 6 }],
    });
    assert.ok(!JSON.stringify(validated).includes("secret"));
    assert.ok(!JSON.stringify(validated).includes("token"));
    assert.ok(!JSON.stringify(validated).includes("apiKey"));
    assert.throws(() => validateWorkspaceCatalog({ version: 1, projects: [{ id: "p", root: "relative", label: "p", lastOpenedAt: 0 }], sessions: [] }), /absolute path/);
    assert.throws(() => validateWorkspaceCatalog({ version: 2, projects: [], sessions: [] }), /version/);
    assert.throws(() => validateWorkspaceCatalog(null), /object/);
  });

  it("missing or corrupt files load as null", async () => {
    const file = await tmpFile();
    assert.equal(await loadWorkspaceCatalogFile(file), null);
    await fsp.writeFile(file, "{not json", "utf8");
    assert.equal(await loadWorkspaceCatalogFile(file), null);
    await fsp.writeFile(file, JSON.stringify({ version: 1, projects: "nope", sessions: [] }), "utf8");
    assert.equal(await loadWorkspaceCatalogFile(file), null);
  });

  it("round-trips a valid catalog atomically and rejects invalid saves without writing", async () => {
    const file = await tmpFile();
    const catalog = { ...emptyWorkspaceCatalog(), projects: [{ id: "p", root: path.sep === "\\" ? "C:\\proj" : "/proj", label: "proj", lastOpenedAt: 1 }] };
    await saveWorkspaceCatalogFile(file, catalog);
    assert.deepEqual(await loadWorkspaceCatalogFile(file), validateWorkspaceCatalog(catalog));
    // No temp-file litter beside the catalog.
    assert.deepEqual(await fsp.readdir(path.dirname(file)), ["workspace-catalog.json"]);

    await assert.rejects(saveWorkspaceCatalogFile(file, { version: 1, projects: [], sessions: "x" }));
    // The previous good file is untouched.
    assert.deepEqual(await loadWorkspaceCatalogFile(file), validateWorkspaceCatalog(catalog));
  });
});
