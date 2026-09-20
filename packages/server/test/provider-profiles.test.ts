/**
 * Provider profiles (src/provider-profiles.ts): save/load round trip, 0600
 * file mode, redaction (apiKey never leaves a profile), validation errors,
 * the env→default bootstrap profile, and store mutation serialisation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  ProviderStore,
  ProviderStoreError,
  defaultProfileFromConfig,
  maskKey,
  profilesFilePath,
  redactProfile,
  validateProfile,
  type ProviderProfile,
} from "../src/provider-profiles.js";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "wr-profiles-"));
}

const profile = (over: Partial<ProviderProfile> = {}): ProviderProfile => ({
  id: "omniroute",
  label: "OmniRoute (CheaperInference)",
  kind: "openai-compatible",
  baseUrl: "https://omniroute.example/v1",
  model: "gpt-4o-mini",
  apiKey: "sk-omni-0123456789abcdef",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_001,
  ...over,
});

describe("maskKey / redactProfile", () => {
  it("masks to ****last4 and never exposes the key prefix", () => {
    assert.equal(maskKey("sk-omni-0123456789abcdef"), "****cdef");
    assert.equal(maskKey("abcd1234"), "****1234");
    assert.equal(maskKey("abc"), "****");
    assert.equal(maskKey(undefined), undefined);
    assert.equal(maskKey(""), undefined);
  });

  it("redactProfile output never contains the apiKey in any serialized form", () => {
    const p = profile();
    const redacted = redactProfile(p);
    assert.ok(!("apiKey" in redacted), "apiKey key must not be present at all");
    assert.equal(redacted.apiKeyMasked, "****cdef");
    assert.ok(!JSON.stringify(redacted).includes(p.apiKey!));
    // Every other field survives.
    const { apiKeyMasked: _masked, ...rest } = redacted;
    assert.deepEqual(rest, { id: p.id, label: p.label, kind: p.kind, baseUrl: p.baseUrl, model: p.model, createdAt: p.createdAt, updatedAt: p.updatedAt });
  });

  it("redactProfile without a key omits the mask", () => {
    const redacted = redactProfile(profile({ apiKey: undefined }));
    assert.equal(redacted.apiKeyMasked, undefined);
  });
});

describe("validateProfile", () => {
  it("accepts a valid profile of every kind", () => {
    assert.deepEqual(validateProfile(profile()), []);
    assert.deepEqual(validateProfile(profile({ id: "spark-local", kind: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", apiKey: undefined })), []);
    assert.deepEqual(validateProfile(profile({ id: "anthropic", kind: "anthropic", baseUrl: undefined })), []);
    assert.deepEqual(validateProfile(profile({ id: "mock", kind: "mock", baseUrl: undefined, apiKey: undefined })), []);
  });

  it("rejects bad ids (case, length, charset)", () => {
    for (const id of ["OmniRoute", "has space", "a".repeat(65), "", "with/Slash"]) {
      const errors = validateProfile(profile({ id }));
      assert.ok(errors.some((e) => e.startsWith("id must be")), `expected id error for "${id}" in ${JSON.stringify(errors)}`);
    }
  });

  it("rejects missing/oversized label and model", () => {
    assert.ok(validateProfile(profile({ label: "" })).some((e) => e.startsWith("label")));
    assert.ok(validateProfile(profile({ label: "x".repeat(129) })).some((e) => e.startsWith("label")));
    assert.ok(validateProfile(profile({ model: "" })).some((e) => e.startsWith("model")));
    assert.ok(validateProfile(profile({ model: "x".repeat(257) })).some((e) => e.startsWith("model")));
  });

  it("rejects unknown kinds", () => {
    assert.ok(validateProfile(profile({ kind: "gemini" as any })).some((e) => e.startsWith("kind")));
  });

  it("requires baseUrl for openai-compatible and checks the scheme", () => {
    assert.ok(validateProfile(profile({ kind: "openai-compatible", baseUrl: undefined })).some((e) => e.startsWith("baseUrl required")));
    assert.ok(validateProfile(profile({ baseUrl: "ftp://x" })).some((e) => e.startsWith("baseUrl must start with")));
    assert.ok(validateProfile(profile({ kind: "anthropic", baseUrl: "not-a-url" })).some((e) => e.startsWith("baseUrl must start with")));
  });

  it("rejects overlong or whitespace-containing keys", () => {
    assert.ok(validateProfile(profile({ apiKey: "x".repeat(513) })).some((e) => e.startsWith("apiKey too long")));
    assert.ok(validateProfile(profile({ apiKey: "sk a b" })).some((e) => e.startsWith("apiKey must not contain whitespace")));
  });
});

describe("ProviderStore", () => {
  it("save/load round trip preserves profiles, keys and the active id; file mode is 0600", async () => {
    const dir = await tmpDir();
    const store = new ProviderStore({ dataDir: dir });
    assert.equal((await store.load()).fileExisted, false);
    store.data.profiles.push(profile(), profile({ id: "spark-local", kind: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b", apiKey: undefined }));
    store.data.activeProfileId = "spark-local";
    await store.persist();

    const raw = await fs.readFile(profilesFilePath(dir), "utf8");
    assert.ok(raw.includes("sk-omni-0123456789abcdef"), "the key is stored at rest (0600 file only)");
    // Windows ignores POSIX permission bits (ACLs instead of modes), so the
    // mode assertion is only meaningful on POSIX; the store still requests 0600.
    if (process.platform !== "win32") {
      const mode = (await fs.stat(profilesFilePath(dir))).mode & 0o777;
      assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
    }

    const fresh = new ProviderStore({ dataDir: dir });
    assert.equal((await fresh.load()).fileExisted, true);
    assert.equal(fresh.data.activeProfileId, "spark-local");
    assert.deepEqual(fresh.data.profiles.map((p) => p.id), ["omniroute", "spark-local"]);
    assert.equal(fresh.data.profiles[0].apiKey, "sk-omni-0123456789abcdef");
    assert.equal(fresh.data.profiles[1].apiKey, undefined);
  });

  it("load with no file yields the empty v1 state", async () => {
    const store = new ProviderStore({ dataDir: await tmpDir() });
    assert.equal((await store.load()).fileExisted, false);
    assert.deepEqual(store.data, { version: 1, activeProfileId: null, profiles: [] });
  });

  it("load rejects corrupt JSON and unknown versions (never silently discards keys)", async () => {
    const dir = await tmpDir();
    await fs.writeFile(profilesFilePath(dir), "{not json", { mode: 0o600 });
    await assert.rejects(new ProviderStore({ dataDir: dir }).load(), ProviderStoreError);

    await fs.writeFile(profilesFilePath(dir), JSON.stringify({ version: 2, activeProfileId: null, profiles: [] }), { mode: 0o600 });
    await assert.rejects(new ProviderStore({ dataDir: dir }).load(), /unsupported provider-profiles version/);
  });

  it("mutate serialises concurrent writes and persists the final state", async () => {
    const dir = await tmpDir();
    const store = new ProviderStore({ dataDir: dir });
    await store.load();
    await Promise.all([
      store.mutate((d) => d.profiles.push(profile({ id: "a" }))),
      store.mutate((d) => d.profiles.push(profile({ id: "b" }))),
      store.mutate((d) => {
        d.activeProfileId = "b";
      }),
    ]);
    const fresh = new ProviderStore({ dataDir: dir });
    await fresh.load();
    assert.deepEqual(fresh.data.profiles.map((p) => p.id).sort(), ["a", "b"]);
    assert.equal(fresh.data.activeProfileId, "b");
  });

  it("a failed mutate rejects the caller but leaves the queue usable", async () => {
    const dir = await tmpDir();
    const store = new ProviderStore({ dataDir: dir });
    await store.load();
    await assert.rejects(
      store.mutate(() => {
        throw new Error("boom");
      }),
      /boom/
    );
    store.data.profiles.push(profile({ id: "after" }));
    await store.mutate(() => {});
    assert.equal((await fs.readFile(profilesFilePath(dir), "utf8")).includes("after"), true);
  });
});

describe("defaultProfileFromConfig", () => {
  it("maps mock / openai-compatible / anthropic env config onto the default profile", () => {
    const at = 123;
    const mock = defaultProfileFromConfig({ provider: "mock", model: { baseUrl: "https://api.openai.com/v1", apiKey: "should-not-appear" } }, at);
    assert.equal(mock.id, "default");
    assert.equal(mock.label, "mock (env)");
    assert.equal(mock.kind, "mock");
    assert.equal(mock.model, "mock");
    assert.equal(mock.createdAt, at);
    assert.equal(mock.updatedAt, at);
    assert.equal(mock.baseUrl, undefined, "mock ignores baseUrl");
    assert.equal(mock.apiKey, undefined, "mock ignores apiKey");

    const oa = defaultProfileFromConfig({ provider: "openai-compatible", model: { baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b" } }, at);
    assert.equal(oa.kind, "openai-compatible");
    assert.equal(oa.baseUrl, "http://127.0.0.1:11434/v1");
    assert.equal(oa.model, "qwen2.5:7b");

    const an = defaultProfileFromConfig(
      { provider: "anthropic", model: { baseUrl: "https://custom-gateway.example/v1", model: "claude-sonnet-4-5", apiKey: "sk-ant-key" } },
      at
    );
    assert.equal(an.kind, "anthropic");
    // A user-configured gateway must survive the bootstrap.
    assert.equal(an.baseUrl, "https://custom-gateway.example/v1");
    assert.equal(an.apiKey, "sk-ant-key");
  });

  it("bootstrapped profiles pass validateProfile", () => {
    for (const provider of ["mock", "openai-compatible", "anthropic"] as const) {
      const p = defaultProfileFromConfig({ provider, model: { baseUrl: "http://127.0.0.1:11434/v1", model: provider === "mock" ? undefined : "m" } }, 0);
      assert.deepEqual(validateProfile(p), [], provider);
    }
  });
});
