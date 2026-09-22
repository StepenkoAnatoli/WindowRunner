import { strict as assert } from "node:assert";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../src/agent/session-manager.js";
import { removeTempPath } from "../../../scripts/temp-path.mjs";

async function makeTempRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wr-session-"));
  return {
    root: tmp,
    cleanup: async () => {
      await removeTempPath(tmp);
    },
  };
}

test("session selects root once, later turns cannot change", async () => {
  const { root, cleanup } = await makeTempRoot();
  const { root: otherRoot, cleanup: cleanupOther } = await makeTempRoot();
  try {
    const sm = new SessionManager();
    const s1 = await sm.createSession("s1", root, []);
    assert.equal(s1.projectRoot.getRoot(), path.resolve(root));
    await assert.rejects(async () => await sm.getOrCreateSession("s1", otherRoot, []), (err: any) => err.code === "ROOT_MISMATCH");
    const s1Again = await sm.getOrCreateSession("s1", root, []);
    assert.equal(s1Again.sessionId, "s1");
  } finally {
    await cleanup();
    await cleanupOther();
  }
});

test("two concurrent starts — second rejected deterministically 409", async () => {
  const { root, cleanup } = await makeTempRoot();
  try {
    const sm = new SessionManager();
    await sm.createSession("s1", root, []);
    const ok1 = sm.tryStartTurn("s1", "t1");
    assert.equal(ok1.ok, true);
    const ok2 = sm.tryStartTurn("s1", "t2");
    assert.equal(ok2.ok, false);
    if (!ok2.ok) {
      assert.equal(ok2.code, "TURN_ALREADY_ACTIVE");
      assert.equal(ok2.activeTurnId, "t1");
    }
    sm.finishTurn("s1", "t1");
    const ok3 = sm.tryStartTurn("s1", "t2");
    assert.equal(ok3.ok, true);
  } finally {
    await cleanup();
  }
});

test("cleanup after model/tool/approval failure clears guard", async () => {
  const { root, cleanup } = await makeTempRoot();
  try {
    const sm = new SessionManager();
    await sm.createSession("s1", root, []);
    sm.tryStartTurn("s1", "t1");
    sm.finishTurn("s1", "t1");
    assert.equal(sm.getSession("s1")?.activeTurnId, null);
    const ok = sm.tryStartTurn("s1", "t2");
    assert.equal(ok.ok, true);
  } finally {
    await cleanup();
  }
});

test("cancellation followed immediately by new turn", async () => {
  const { root, cleanup } = await makeTempRoot();
  try {
    const sm = new SessionManager();
    await sm.createSession("s1", root, []);
    sm.tryStartTurn("s1", "t1");
    sm.finishTurn("s1", "t1");
    const ok = sm.tryStartTurn("s1", "t2");
    assert.equal(ok.ok, true);
  } finally {
    await cleanup();
  }
});

test("two sessions using different roots isolated", async () => {
  const { root: root1, cleanup: cleanup1 } = await makeTempRoot();
  const { root: root2, cleanup: cleanup2 } = await makeTempRoot();
  try {
    const sm = new SessionManager();
    const s1 = await sm.createSession("s1", root1, []);
    const s2 = await sm.createSession("s2", root2, []);
    assert.notEqual(s1.projectRoot.getRoot(), s2.projectRoot.getRoot());
    const ok1 = sm.tryStartTurn("s1", "t1");
    const ok2 = sm.tryStartTurn("s2", "t2");
    assert.equal(ok1.ok, true);
    assert.equal(ok2.ok, true);
    assert.throws(() => s1.projectRoot.resolve(`../${path.basename(root2)}/file`), (err: any) => err.code === "PATH_ESCAPES_ROOT");
  } finally {
    await cleanup1();
    await cleanup2();
  }
});

test("rejected roots and symlink escapes at session creation", async () => {
  const { root: allowed, cleanup: cleanupAllowed } = await makeTempRoot();
  const { root: outside, cleanup: cleanupOutside } = await makeTempRoot();
  try {
    const sm = new SessionManager();
    await assert.rejects(async () => await sm.createSession("s1", outside, [allowed]), (err: any) => err.code === "PATH_ESCAPES_ROOT");
    const sub = path.join(allowed, "sub");
    await fs.mkdir(sub);
    const s2 = await sm.createSession("s2", sub, [allowed]);
    assert.ok(s2.projectRoot.getRoot().startsWith(allowed));
    const linkPath = path.join(allowed, "linkOutside");
    try {
      await fs.symlink(outside, linkPath);
      await assert.rejects(async () => await sm.createSession("s3", linkPath, [allowed]), (err: any) => err.code === "PATH_ESCAPES_ROOT");
    } catch {}
  } finally {
    await cleanupAllowed();
    await cleanupOutside();
  }
});

test("concurrent creation — pending lock prevents duplicate", async () => {
  const { root, cleanup } = await makeTempRoot();
  try {
    const sm = new SessionManager();
    const p1 = sm.createSession("s1", root, []);
    const p2 = sm.createSession("s1", root, []);
    const results = await Promise.allSettled([p1, p2]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    const err = (rejected[0] as any).reason;
    assert.equal(err.code, "SESSION_ALREADY_EXISTS");
  } finally {
    await cleanup();
  }
});

test("SSE disconnect remains observational only — does not release lease", async () => {
  const { root, cleanup } = await makeTempRoot();
  try {
    const sm = new SessionManager();
    await sm.createSession("s1", root, []);
    sm.tryStartTurn("s1", "t1");
    assert.equal(sm.getSession("s1")?.activeTurnId, "t1");
    const ok = sm.tryStartTurn("s1", "t2");
    assert.equal(ok.ok, false);
    sm.finishTurn("s1", "t1");
    const ok2 = sm.tryStartTurn("s1", "t2");
    assert.equal(ok2.ok, true);
  } finally {
    await cleanup();
  }
});
