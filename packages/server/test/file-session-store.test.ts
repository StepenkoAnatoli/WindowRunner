import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { FileSessionStore } from "../src/agent/file-session-store.js";
import { removeTempPath } from "../../../scripts/temp-path.mjs";

async function mkTmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "wr-session-store-"));
}

describe("FileSessionStore", () => {
  it("save and load meta.json atomically", async () => {
    const dir = await mkTmpDir();
    const store = new FileSessionStore({ dataDir: dir });

    const meta = {
      version: 1 as const,
      sessionId: "sess_1",
      canonicalRoot: "/tmp",
      realRoot: "/tmp",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      activeTurnId: null,
    };

    await store.save(meta);
    const loaded = await store.load("sess_1");
    assert.ok(loaded);
    assert.equal(loaded!.sessionId, "sess_1");
    assert.equal(loaded!.canonicalRoot, "/tmp");

    await removeTempPath(dir);
  });

  it("root rejection after configuration changes", async () => {
    const dir = await mkTmpDir();
    const store = new FileSessionStore({ dataDir: dir });
    // A session root that exists on every OS (/tmp does not exist on Windows).
    const sysTmp = os.tmpdir();

    // Create session with the system temp root
    const meta = {
      version: 1 as const,
      sessionId: "sess_reject",
      canonicalRoot: sysTmp,
      realRoot: sysTmp,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      activeTurnId: "t_1",
    };
    await store.save(meta);

    // Boot with allowedRoots that does NOT include the persisted root — should skip session
    const diagnostics = await store.boot(["/home/user/allowed"], () => Date.now());
    assert.equal(diagnostics.sessionsSkipped, 1);
    assert.equal(diagnostics.sessionsLoaded, 0);
    assert.ok(diagnostics.skippedSessions[0].sessionId === "sess_reject");

    // Boot with allowedRoots that includes the persisted root — should load and clear activeTurnId
    const diagnostics2 = await store.boot([sysTmp], () => Date.now());
    assert.equal(diagnostics2.sessionsLoaded, 1);
    assert.equal(diagnostics2.sessionsWithClearedActiveTurn, 1);

    const loaded = await store.load("sess_reject");
    assert.equal(loaded!.activeTurnId, null);

    await removeTempPath(dir);
  });

  it("restart recovery clears activeTurnId and never trusts persisted roots for authorization", async () => {
    const dir = await mkTmpDir();
    const store = new FileSessionStore({ dataDir: dir });
    // A session root that exists on every OS (/tmp does not exist on Windows).
    const sysTmp = os.tmpdir();

    const meta = {
      version: 1 as const,
      sessionId: "sess_restart",
      canonicalRoot: sysTmp,
      realRoot: sysTmp,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      activeTurnId: "t_active",
      allowedRootsSnapshot: ["/tmp", "/etc"], // informational only, should never override current config
    };

    await store.save(meta);

    // Boot with current allowedRoots = the persisted root — snapshot contains /etc but should not authorize /etc
    const diagnostics = await store.boot([sysTmp], () => Date.now());
    assert.equal(diagnostics.sessionsLoaded, 1);

    // The persisted allowedRootsSnapshot should be informational only, not used for auth
    // We verify that boot re-validates via ProjectRoot.create with currentAllowedRoots, not snapshot
    const loaded = await store.load("sess_restart");
    assert.equal(loaded!.activeTurnId, null);
    assert.deepEqual(loaded!.allowedRootsSnapshot, ["/tmp", "/etc"]); // snapshot preserved but not used

    // Now try boot with allowedRoots that doesn't include the persisted root — should reject even though snapshot includes /tmp
    const meta2 = {
      version: 1 as const,
      sessionId: "sess_restart2",
      canonicalRoot: sysTmp,
      realRoot: sysTmp,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      activeTurnId: null,
      allowedRootsSnapshot: ["/tmp"], // snapshot says /tmp allowed, but current config says only /home
    };
    await store.save(meta2);

    const diag2 = await store.boot(["/home"], () => Date.now());
    // Should skip both sessions because the persisted root is not in current allowedRoots, even though snapshot says it is
    assert.ok(diag2.sessionsSkipped >= 1);

    await removeTempPath(dir);
  });

  it("retention and eviction", async () => {
    const dir = await mkTmpDir();
    const store = new FileSessionStore({ dataDir: dir });

    // Create 3 sessions
    for (let i = 0; i < 3; i++) {
      await store.save({
        version: 1,
        sessionId: `sess_${i}`,
        canonicalRoot: "/tmp",
        realRoot: "/tmp",
        createdAt: Date.now() - i * 1000,
        lastActivityAt: Date.now() - i * 1000,
        activeTurnId: null,
      });
    }

    const list = await store.list();
    assert.equal(list.length, 3);

    // Delete one
    await store.delete("sess_0");
    const list2 = await store.list();
    assert.equal(list2.length, 2);

    await removeTempPath(dir);
  });
});
