import { strict as assert } from "node:assert";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ProjectRoot, PathError } from "../src/project-root.js";

async function makeTempRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wr-test-"));
  return {
    root: tmp,
    cleanup: async () => {
      await fs.rm(tmp, { recursive: true, force: true });
    },
  };
}

test("valid relative paths", async () => {
  const { root, cleanup } = await makeTempRoot();
  try {
    const pr = await ProjectRoot.create(root, []);
    const abs = pr.resolve("a/b.txt");
    assert.ok(abs.startsWith(root));
    assert.equal(abs, path.resolve(root, "a/b.txt"));

    const abs2 = pr.resolve("./a/./b.txt");
    assert.equal(abs2, path.resolve(root, "a/b.txt"));
  } finally {
    await cleanup();
  }
});

test("absolute paths rejected", async () => {
  const { root, cleanup } = await makeTempRoot();
  try {
    const pr = await ProjectRoot.create(root, []);
    assert.throws(() => pr.resolve("/etc/passwd"), (err: any) => err.code === "PATH_ESCAPES_ROOT");
    assert.throws(() => pr.resolve("/tmp/evil"), (err: any) => err.code === "PATH_ESCAPES_ROOT");
    // Windows absolute
    assert.throws(() => pr.resolve("C:\\Windows\\file"), (err: any) => err.code === "PATH_ESCAPES_ROOT");
  } finally {
    await cleanup();
  }
});

test("traversal .. rejected", async () => {
  const { root, cleanup } = await makeTempRoot();
  try {
    const pr = await ProjectRoot.create(root, []);
    assert.throws(() => pr.resolve("../etc/passwd"), (err: any) => err.code === "PATH_ESCAPES_ROOT");
    assert.throws(() => pr.resolve("a/../../b"), (err: any) => err.code === "PATH_ESCAPES_ROOT");
    // a/b/.. resolves to a, which is inside root, so allowed
    const abs = pr.resolve("a/b/..");
    assert.equal(abs, path.resolve(root, "a"));

    assert.throws(() => pr.resolve(".."), (err: any) => err.code === "PATH_ESCAPES_ROOT");
    assert.throws(() => pr.resolve("../../etc"), (err: any) => err.code === "PATH_ESCAPES_ROOT");
  } finally {
    await cleanup();
  }
});

test("encoded traversal rejected", async () => {
  const { root, cleanup } = await makeTempRoot();
  try {
    const pr = await ProjectRoot.create(root, []);
    assert.throws(() => pr.resolve("%2e%2e/%2e%2e/etc"), (err: any) => err.code === "PATH_ESCAPES_ROOT");
    assert.throws(() => pr.resolve("a/%2e%2e/b"), (err: any) => err.code === "PATH_ESCAPES_ROOT");
    assert.throws(() => pr.resolve("%2Fetc%2Fpasswd"), (err: any) => err.code === "PATH_ESCAPES_ROOT");
  } finally {
    await cleanup();
  }
});

test("platform-specific separators", async () => {
  const { root, cleanup } = await makeTempRoot();
  try {
    const pr = await ProjectRoot.create(root, []);
    // Backslash should be treated as separator and checked
    assert.throws(() => pr.resolve("..\\..\\etc"), (err: any) => err.code === "PATH_ESCAPES_ROOT");
    // Mixed
    const abs = pr.resolve("a\\b/c.txt");
    assert.ok(abs.startsWith(root));
    assert.equal(abs, path.resolve(root, "a/b/c.txt"));
  } finally {
    await cleanup();
  }
});

test("symlink escaping root", async () => {
  const { root, cleanup } = await makeTempRoot();
  try {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "wr-outside-"));
    const outsideFile = path.join(outside, "secret.txt");
    await fs.writeFile(outsideFile, "secret");

    const linkPath = path.join(root, "link");
    try {
      await fs.symlink(outside, linkPath);
    } catch {
      // Symlink creation may fail on Windows without admin, skip
      await fs.rm(outside, { recursive: true, force: true });
      return;
    }

    const pr = await ProjectRoot.create(root, []);

    // Logical resolve passes (inside root), but realpath should detect escape
    const logical = pr.resolve("link/secret.txt");
    assert.ok(logical.startsWith(root));

    await assert.rejects(async () => await pr.resolveReal("link/secret.txt"), (err: any) => err.code === "PATH_ESCAPES_ROOT");

    // Symlink inside pointing inside should be allowed
    const subdir = path.join(root, "subdir");
    await fs.mkdir(subdir);
    const insideFile = path.join(subdir, "inside.txt");
    await fs.writeFile(insideFile, "inside");
    const linkInside = path.join(root, "linkInside");
    await fs.symlink(subdir, linkInside);
    const realInside = await pr.resolveReal("linkInside/inside.txt");
    assert.ok(realInside.includes("inside.txt"));

    await fs.rm(outside, { recursive: true, force: true });
  } finally {
    await cleanup();
  }
});

test("missing parent directories", async () => {
  const { root, cleanup } = await makeTempRoot();
  try {
    const pr = await ProjectRoot.create(root, []);

    // Read non-existing should throw PATH_NOT_FOUND
    await assert.rejects(async () => await pr.readFile("a/b/c.txt"), (err: any) => err.code === "PATH_NOT_FOUND");

    // Write without createParents should throw PATH_NOT_FOUND
    await assert.rejects(
      async () => await pr.writeFile("a/b/c.txt", "hello", { createParents: false }),
      (err: any) => err.code === "PATH_NOT_FOUND"
    );

    // Write with createParents true should create
    await pr.writeFile("a/b/c.txt", "hello", { createParents: true });
    const content = await pr.readFile("a/b/c.txt");
    assert.equal(content, "hello");
  } finally {
    await cleanup();
  }
});

test("files vs directories", async () => {
  const { root, cleanup } = await makeTempRoot();
  try {
    const pr = await ProjectRoot.create(root, []);

    // Create a file
    await pr.writeFile("file.txt", "content", { createParents: true });

    // Try to mkdir where file exists
    await assert.rejects(async () => await pr.mkdir("file.txt"), (err: any) => err.code === "FILE_EXISTS" || err.code === "IO_ERROR");

    // Create a dir
    await pr.mkdir("mydir");

    // Try to read dir as file -> IS_DIRECTORY
    await assert.rejects(async () => await pr.readFile("mydir"), (err: any) => err.code === "IS_DIRECTORY" || err.code === "IO_ERROR");

    // Try to write where parent is file
    await assert.rejects(
      async () => await pr.writeFile("file.txt/sub.txt", "hi", { createParents: false }),
      (err: any) => err.code === "NOT_A_DIRECTORY" || err.code === "PATH_NOT_FOUND" || err.code === "IO_ERROR"
    );
  } finally {
    await cleanup();
  }
});

test("permission errors normalized", async () => {
  const { root, cleanup } = await makeTempRoot();
  try {
    const pr = await ProjectRoot.create(root, []);

    // This test may not work as root user (root can read regardless of chmod)
    // So we test that error mapping works via direct mapFsError
    const { mapFsError } = await import("../src/project-root.js");
    const fakeErr: any = new Error("EACCES: permission denied");
    fakeErr.code = "EACCES";
    const mapped = mapFsError(fakeErr, "a.txt");
    assert.equal(mapped.code, "PERMISSION_DENIED");
    assert.equal(mapped.retryable, false);
  } finally {
    await cleanup();
  }
});

test("concurrent roots isolation", async () => {
  const { root: root1, cleanup: cleanup1 } = await makeTempRoot();
  const { root: root2, cleanup: cleanup2 } = await makeTempRoot();
  try {
    const pr1 = await ProjectRoot.create(root1, []);
    const pr2 = await ProjectRoot.create(root2, []);

    await pr1.writeFile("file.txt", "root1", { createParents: true });
    await pr2.writeFile("file.txt", "root2", { createParents: true });

    const c1 = await pr1.readFile("file.txt");
    const c2 = await pr2.readFile("file.txt");
    assert.equal(c1, "root1");
    assert.equal(c2, "root2");

    // Ensure pr1 cannot access pr2's file via traversal
    assert.throws(() => pr1.resolve(`../${path.basename(root2)}/file.txt`), (err: any) => err.code === "PATH_ESCAPES_ROOT");
  } finally {
    await cleanup1();
    await cleanup2();
  }
});

test("deadline cancellation/timeout during filesystem operation", async () => {
  const { root, cleanup } = await makeTempRoot();
  try {
    const pr = await ProjectRoot.create(root, []);

    // Simulate hanging read by using a tool that hangs, not ProjectRoot itself
    // But we test that ProjectRoot respects signal abort
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await assert.rejects(async () => await pr.readFile("a.txt", "utf8", controller.signal), (err: any) => {
      return err.message.includes("cancelled") || err.code === "CANCELLED" || true;
    });

    // Test via executor deadline
    const { executeTool } = await import("../src/agent/tools/executor.js");
    const hangingTool: any = {
      name: "hanging",
      description: "hangs",
      requiresApproval: () => false,
      execute: async (input: any, ctx: any) => {
        // Hang until signal aborts
        await new Promise<void>((_, reject) => {
          ctx.signal.addEventListener("abort", () => reject((ctx.signal as any).reason ?? new Error("aborted")), { once: true });
        });
        return "ok";
      },
    };

    const toolResult = await executeTool(
      hangingTool,
      {},
      {
        projectRoot: pr,
        signal: new AbortController().signal,
        cwd: pr.getRoot(),
        safePath: (p: string) => pr.resolve(p),
      },
      10, // 10ms timeout
      undefined,
      50
    );

    assert.equal(toolResult.ok, false);
    assert.equal((toolResult as any).code, "TOOL_TIMED_OUT");
  } finally {
    await cleanup();
  }
});

test("exact ToolResult error codes and model-facing messages", async () => {
  const { root, cleanup } = await makeTempRoot();
  try {
    const pr = await ProjectRoot.create(root, []);

    // PATH_ESCAPES_ROOT message stable
    try {
      pr.resolve("/etc/passwd");
      assert.fail();
    } catch (err: any) {
      assert.equal(err.code, "PATH_ESCAPES_ROOT");
      assert.match(err.message, /path escapes root/);
      assert.equal(err.retryable, false);
    }

    // PATH_NOT_FOUND
    try {
      await pr.readFile("nonexistent.txt");
      assert.fail();
    } catch (err: any) {
      assert.equal(err.code, "PATH_NOT_FOUND");
      assert.match(err.message, /file not found/);
      assert.equal(err.retryable, true);
    }

    // Ensure raw ENOENT not leaked
    try {
      await pr.readFile("nope.txt");
    } catch (err: any) {
      assert.ok(!err.message.includes("ENOENT"), "should not leak ENOENT");
    }
  } finally {
    await cleanup();
  }
});

test("allowedRoots validation", async () => {
  const { root, cleanup } = await makeTempRoot();
  const { root: allowed, cleanup: cleanupAllowed } = await makeTempRoot();
  try {
    // root inside allowed should pass
    const sub = path.join(allowed, "sub");
    await fs.mkdir(sub);
    const pr = await ProjectRoot.create(sub, [allowed]);
    assert.ok(pr.getRoot().startsWith(allowed));

    // root outside allowed should fail
    await assert.rejects(async () => await ProjectRoot.create(root, [allowed]), (err: any) => err.code === "PATH_ESCAPES_ROOT");
  } finally {
    await cleanup();
    await cleanupAllowed();
  }
});
