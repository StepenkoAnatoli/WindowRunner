/**
 * Preload bridge surface (PR A / A1, plan item 12).
 *
 * Pins the security contract: `window.windowRunnerDesktop` carries exactly the
 * intended methods, those methods touch exactly the allowlisted IPC channels
 * (never arbitrary channel names from the renderer), and the bridge source
 * never touches URLs or web storage.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BRIDGE_METHODS,
  DESKTOP_CHANNELS,
  createDesktopBridge,
  type BridgeTransport,
} from "../src/desktop-bridge.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, "..", "src");

function recordingTransport(bootstrapResult: unknown = { baseUrl: "http://127.0.0.1:1", token: "t".repeat(20) }) {
  const calls: Array<{ kind: "invoke" | "sendSync"; channel: string; args: unknown[] }> = [];
  const transport: BridgeTransport = {
    invoke: (channel, ...args) => {
      calls.push({ kind: "invoke", channel, args });
      return Promise.resolve(null);
    },
    sendSync: (channel, ...args) => {
      calls.push({ kind: "sendSync", channel, args });
      return bootstrapResult;
    },
  };
  return { transport, calls };
}

describe("preload bridge surface", () => {
  it("exposes exactly the intended bridge methods", () => {
    const { transport } = recordingTransport();
    const bridge = createDesktopBridge(transport);
    assert.deepEqual(Object.keys(bridge).sort(), [...BRIDGE_METHODS].sort());
  });

  it("touches only the allowlisted IPC channels — never arbitrary ones", async () => {
    const { transport, calls } = recordingTransport();
    const bridge = createDesktopBridge(transport);
    bridge.getBootstrap();
    await bridge.chooseProjectFolder();
    await bridge.openExternalEditor("/tmp/x");
    await bridge.getAppInfo();

    const allowed = new Set<string>(Object.values(DESKTOP_CHANNELS));
    assert.equal(calls.length, 4);
    for (const call of calls) {
      assert.ok(allowed.has(call.channel), `unexpected IPC channel ${call.channel}`);
    }
    assert.deepEqual(
      calls.map((c) => c.channel),
      [DESKTOP_CHANNELS.bootstrap, DESKTOP_CHANNELS.chooseFolder, DESKTOP_CHANNELS.openExternal, DESKTOP_CHANNELS.appInfo]
    );
  });

  it("passes the bootstrap through unchanged and rejects a malformed one", () => {
    const bootstrap = { baseUrl: "http://127.0.0.1:9", token: "secret-token-value" };
    const good = createDesktopBridge(recordingTransport(bootstrap).transport);
    assert.deepEqual(good.getBootstrap(), bootstrap);

    const bad = createDesktopBridge(recordingTransport(null).transport);
    assert.throws(() => bad.getBootstrap(), /bootstrap unavailable/);
  });

  it("never reads or writes web storage or URLs", () => {
    for (const file of ["desktop-bridge.ts", "preload.ts"]) {
      // Strip comments so the contract is about code, not documentation.
      const source = fs
        .readFileSync(path.join(srcDir, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      assert.doesNotMatch(source, /localStorage|sessionStorage/, `${file} must not touch web storage`);
      assert.doesNotMatch(source, /location\.hash|location\.search|history\.replaceState/, `${file} must not touch the URL`);
      assert.doesNotMatch(source, /child_process|node:fs|require\(/, `${file} must not expose privileged Node APIs`);
    }
  });
});
