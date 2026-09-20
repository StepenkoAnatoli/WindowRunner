/**
 * Boot configuration contract (src/config.ts).
 *
 * The boot path reads only environment variables. Two properties are pinned
 * here: unset means the documented safe default, and a value that is set but
 * not understood is a ConfigError naming the variable — never a silent
 * fallback. Tests pass explicit env objects and an explicit home directory so
 * they are hermetic with respect to the machine running them.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  loadServerConfig,
  isLoopbackHost,
  describeConfig,
  ConfigError,
  DEFAULT_PORT,
  DEFAULT_HOST,
  DEFAULT_SHUTDOWN_GRACE_MS,
  ENV,
} from "../src/config.js";

const HOME = path.resolve(path.sep, "home", "tester");

function load(env: Record<string, string | undefined>) {
  return loadServerConfig(env, { homedir: HOME });
}

function expectConfigError(env: Record<string, string | undefined>, variable: string, messageRe: RegExp) {
  assert.throws(
    () => load(env),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError, `expected ConfigError, got ${String(err)}`);
      assert.equal(err.variable, variable);
      assert.match(err.message, messageRe);
      return true;
    }
  );
}

describe("loadServerConfig", () => {
  describe("defaults", () => {
    it("binds loopback on 7634, memory persistence, mock provider, home as the only root", () => {
      const config = load({});
      assert.equal(config.host, DEFAULT_HOST);
      assert.equal(config.port, DEFAULT_PORT);
      assert.equal(config.allowRemote, false);
      assert.equal(config.provider, "mock");
      assert.equal(config.persistence.mode, "memory");
      assert.equal(config.persistence.dataDir, path.join(HOME, ".windows-runner"));
      assert.equal(config.persistence.durableBeforeNotify, false, "memory mode defaults to async notify");
      assert.equal(config.persistence.fsync, false);
      assert.deepEqual(config.allowedRoots, [HOME]);
      assert.equal(config.shutdownGraceMs, DEFAULT_SHUTDOWN_GRACE_MS);
    });

    it("treats blank values as unset", () => {
      const config = load({ PORT: "  ", HOST: "", WINDOWS_RUNNER_PERSISTENCE_MODE: "", WINDOWS_RUNNER_ALLOWED_ROOTS: "" });
      assert.equal(config.port, DEFAULT_PORT);
      assert.equal(config.host, DEFAULT_HOST);
      assert.equal(config.persistence.mode, "memory");
      assert.deepEqual(config.allowedRoots, [HOME]);
    });

    it("file mode defaults durableBeforeNotify to true", () => {
      const config = load({ WINDOWS_RUNNER_PERSISTENCE_MODE: "file" });
      assert.equal(config.persistence.mode, "file");
      assert.equal(config.persistence.durableBeforeNotify, true);
      assert.equal(config.persistence.fsync, false);
    });
  });

  describe("PORT / HOST", () => {
    it("accepts 0 (ephemeral) and the full valid range", () => {
      assert.equal(load({ PORT: "0" }).port, 0);
      assert.equal(load({ PORT: "65535" }).port, 65535);
      assert.equal(load({ PORT: " 8080 " }).port, 8080);
    });

    it("rejects non-integers, negatives and out-of-range ports by name", () => {
      for (const bad of ["abc", "-1", "1.5", "65536", "0x1F"]) {
        expectConfigError({ PORT: bad }, ENV.port, /PORT must be an integer between 0 and 65535/);
      }
    });

    it("trims HOST and rejects values with whitespace inside", () => {
      assert.equal(load({ HOST: " ::1 " }).host, "::1");
      expectConfigError({ HOST: "127.0.0.1 evil" }, ENV.host, /HOST must be a hostname or IP address/);
    });
  });

  describe("booleans", () => {
    it("accepts 1/true/yes/on and 0/false/no/off case-insensitively", () => {
      for (const yes of ["1", "true", "YES", "On", " true "]) {
        assert.equal(load({ WINDOWS_RUNNER_ALLOW_REMOTE: yes }).allowRemote, true, yes);
      }
      for (const no of ["0", "false", "No", "OFF"]) {
        assert.equal(load({ WINDOWS_RUNNER_ALLOW_REMOTE: no }).allowRemote, false, no);
      }
    });

    it("rejects anything else, naming the variable", () => {
      expectConfigError({ WINDOWS_RUNNER_ALLOW_REMOTE: "maybe" }, ENV.allowRemote, /WINDOWS_RUNNER_ALLOW_REMOTE must be one of/);
      expectConfigError({ WINDOWS_RUNNER_FSYNC: "2" }, ENV.fsync, /WINDOWS_RUNNER_FSYNC must be one of/);
      expectConfigError({ WINDOWS_RUNNER_DURABLE_BEFORE_NOTIFY: "y" }, ENV.durableBeforeNotify, /must be one of/);
    });

    it("lets file mode opt out of durable-before-notify explicitly", () => {
      const config = load({ WINDOWS_RUNNER_PERSISTENCE_MODE: "file", WINDOWS_RUNNER_DURABLE_BEFORE_NOTIFY: "false", WINDOWS_RUNNER_FSYNC: "true" });
      assert.equal(config.persistence.durableBeforeNotify, false);
      assert.equal(config.persistence.fsync, true);
    });
  });

  describe("persistence", () => {
    it("accepts memory/file case-insensitively and rejects other modes", () => {
      assert.equal(load({ WINDOWS_RUNNER_PERSISTENCE_MODE: "FILE" }).persistence.mode, "file");
      assert.equal(load({ WINDOWS_RUNNER_PERSISTENCE_MODE: "Memory" }).persistence.mode, "memory");
      expectConfigError({ WINDOWS_RUNNER_PERSISTENCE_MODE: "sqlite" }, ENV.persistenceMode, /must be "memory" or "file"/);
    });

    it("requires an absolute data dir, expanding a leading ~", () => {
      const absolute = path.resolve(path.sep, "var", "lib", "wr");
      assert.equal(load({ WINDOWS_RUNNER_DATA_DIR: absolute }).persistence.dataDir, absolute);
      assert.equal(load({ WINDOWS_RUNNER_DATA_DIR: "~/wr-data" }).persistence.dataDir, path.join(HOME, "wr-data"));
      expectConfigError({ WINDOWS_RUNNER_DATA_DIR: "data" }, ENV.dataDir, /must be an absolute path/);
      expectConfigError({ WINDOWS_RUNNER_DATA_DIR: "./data" }, ENV.dataDir, /must be an absolute path/);
    });
  });

  describe("allowed roots", () => {
    const a = path.resolve(path.sep, "srv", "a");
    const b = path.resolve(path.sep, "srv", "b");

    it("splits on commas, trims, dedupes and resolves", () => {
      const config = load({ WINDOWS_RUNNER_ALLOWED_ROOTS: ` ${a} , ${b},${a},, ` });
      assert.deepEqual(config.allowedRoots, [a, b]);
    });

    it("expands ~ per entry", () => {
      assert.deepEqual(load({ WINDOWS_RUNNER_ALLOWED_ROOTS: "~/code" }).allowedRoots, [path.join(HOME, "code")]);
    });

    it("rejects relative entries and an all-blank list", () => {
      expectConfigError({ WINDOWS_RUNNER_ALLOWED_ROOTS: `${a},projects` }, ENV.allowedRoots, /entries must be absolute paths/);
      expectConfigError({ WINDOWS_RUNNER_ALLOWED_ROOTS: " , ," }, ENV.allowedRoots, /contains no paths/);
    });

    it("falls back to WINDOWS_RUNNER_HOME, then the OS home directory", () => {
      assert.deepEqual(load({ WINDOWS_RUNNER_HOME: a }).allowedRoots, [a]);
      assert.deepEqual(load({ WINDOWS_RUNNER_HOME: a, WINDOWS_RUNNER_ALLOWED_ROOTS: b }).allowedRoots, [b], "explicit list wins");
      expectConfigError({ WINDOWS_RUNNER_HOME: "relative" }, ENV.home, /must be an absolute path/);
    });

    it("never produces an empty root list", () => {
      assert.ok(load({}).allowedRoots.length > 0);
    });
  });

  describe("provider and shutdown grace", () => {
    it("normalises the provider name without validating availability (boot does that)", () => {
      assert.equal(load({ WINDOWS_RUNNER_PROVIDER: " Mock " }).provider, "mock");
      assert.equal(load({ WINDOWS_RUNNER_PROVIDER: "openai" }).provider, "openai");
    });

    it("parses model retries (default 2, 0 allowed, garbage rejected)", () => {
      assert.equal(load({}).model.maxRetries, 2);
      assert.equal(load({ WINDOWS_RUNNER_MODEL_MAX_RETRIES: "0" }).model.maxRetries, 0);
      assert.equal(load({ WINDOWS_RUNNER_MODEL_MAX_RETRIES: "5" }).model.maxRetries, 5);
      expectConfigError({ WINDOWS_RUNNER_MODEL_MAX_RETRIES: "-1" }, ENV.modelMaxRetries, /non-negative integer/);
    });

    it("parses the grace period as non-negative integer milliseconds", () => {
      assert.equal(load({ WINDOWS_RUNNER_SHUTDOWN_GRACE_MS: "0" }).shutdownGraceMs, 0);
      assert.equal(load({ WINDOWS_RUNNER_SHUTDOWN_GRACE_MS: "250" }).shutdownGraceMs, 250);
      expectConfigError({ WINDOWS_RUNNER_SHUTDOWN_GRACE_MS: "-5" }, ENV.shutdownGraceMs, /non-negative integer/);
      expectConfigError({ WINDOWS_RUNNER_SHUTDOWN_GRACE_MS: "soon" }, ENV.shutdownGraceMs, /non-negative integer/);
    });
  });
});

describe("isLoopbackHost", () => {
  it("recognises IPv4 loopback, IPv6 loopback and localhost", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "::1", "[::1]", "localhost", "LOCALHOST", "::ffff:127.0.0.1"]) {
      assert.equal(isLoopbackHost(host), true, host);
    }
  });

  it("rejects wildcard and routable addresses", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "10.0.0.1", "example.com", "128.0.0.1"]) {
      assert.equal(isLoopbackHost(host), false, host);
    }
  });
});

describe("describeConfig", () => {
  it("renders every setting and flags the offline provider and non-loopback binds", () => {
    const loopback = describeConfig(load({})).join("\n");
    assert.match(loopback, /bind: +127\.0\.0\.1:7634 \(loopback only\)/);
    assert.match(loopback, /provider: +mock \(offline; no model calls are made\)/);
    assert.match(loopback, /persistence: +memory/);
    assert.match(loopback, new RegExp(`roots: +${HOME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.doesNotMatch(loopback, /data dir/, "memory mode has no data dir line");

    const remote = describeConfig(load({ HOST: "0.0.0.0", WINDOWS_RUNNER_PERSISTENCE_MODE: "file" })).join("\n");
    assert.match(remote, /non-loopback; requires WINDOWS_RUNNER_ALLOW_REMOTE=1/);
    assert.match(remote, /data dir: +/);
    assert.match(remote, /durableBeforeNotify=true fsync=false/);

    const optedIn = describeConfig(load({ HOST: "0.0.0.0", WINDOWS_RUNNER_ALLOW_REMOTE: "1" })).join("\n");
    assert.match(optedIn, /remote access explicitly enabled/);
  });
});
