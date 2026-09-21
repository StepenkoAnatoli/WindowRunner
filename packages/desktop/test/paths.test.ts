/**
 * Desktop path resolution (PR A / A1, plan item 12).
 *
 * Pins three contracts: paths never depend on the installation/executable
 * location, repeated calls are stable, and tests can redirect everything into
 * a temporary directory.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DATA_DIR_ENV, ensureDesktopPaths, resolveDesktopPaths } from "../src/paths.js";

const tmps: string[] = [];
after(async () => {
  await Promise.all(tmps.map((t) => fsp.rm(t, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wr-paths-"));
  tmps.push(dir);
  return dir;
}

describe("desktop paths", () => {
  it("are outside the installation directory and stable across calls", () => {
    const installDir = path.join(os.tmpdir(), "Program Files", "WindowRunner-fake-install");
    const previousCwd = process.cwd();
    try {
      // Even when run from an install-like directory, data paths must not
      // resolve relative to it.
      process.chdir(os.tmpdir());
      const a = resolveDesktopPaths();
      const b = resolveDesktopPaths();
      assert.deepEqual(a, b);
      assert.equal(path.isAbsolute(a.appDataDir), true);
      assert.equal(a.appDataDir.startsWith(installDir), false);
      assert.equal(a.appDataDir.startsWith(previousCwd), false);
      assert.equal(a.serverDataDir, a.appDataDir);
      assert.equal(a.logsDir, path.join(a.appDataDir, "logs"));
      assert.equal(a.workspaceCatalogFile, path.join(a.appDataDir, "workspace-catalog.json"));
      assert.match(a.appDataDir, /WindowRunner$/);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("redirects to a temporary directory via the explicit option", async () => {
    const dir = await tmp();
    const paths = resolveDesktopPaths({ appDataDir: dir });
    assert.equal(paths.appDataDir, path.resolve(dir));
    assert.equal(paths.serverDataDir, path.resolve(dir));
    assert.equal(paths.logsDir, path.join(path.resolve(dir), "logs"));
    assert.equal(paths.workspaceCatalogFile, path.join(path.resolve(dir), "workspace-catalog.json"));
  });

  it("redirects to a temporary directory via the environment", async () => {
    const dir = await tmp();
    const previous = process.env[DATA_DIR_ENV];
    process.env[DATA_DIR_ENV] = dir;
    try {
      const paths = resolveDesktopPaths();
      assert.equal(paths.appDataDir, path.resolve(dir));
    } finally {
      if (previous === undefined) delete process.env[DATA_DIR_ENV];
      else process.env[DATA_DIR_ENV] = previous;
    }
  });

  it("ensureDesktopPaths creates the data and logs directories idempotently", async () => {
    const dir = await tmp();
    const paths = resolveDesktopPaths({ appDataDir: path.join(dir, "nested", "data") });
    await ensureDesktopPaths(paths);
    await ensureDesktopPaths(paths);
    const statData = await fsp.stat(paths.appDataDir);
    const statLogs = await fsp.stat(paths.logsDir);
    assert.equal(statData.isDirectory(), true);
    assert.equal(statLogs.isDirectory(), true);
  });
});
