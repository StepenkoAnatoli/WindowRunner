/**
 * ProviderService activation/update ordering (src/provider-service.ts).
 *
 * The property under test: a profile change that cannot be written to disk
 * must leave the running server exactly as it was. Both `activate()` and
 * `update()` go through `store.mutate()`, which applies the change to the
 * in-memory copy BEFORE it writes the file — so a failed write (read-only
 * data dir, full disk) leaves memory ahead of disk, and any live-provider swap
 * done first would survive into a process that the next restart contradicts.
 *
 * A stub store is used instead of a chmod'ed directory on purpose: it
 * reproduces the memory-then-disk ordering exactly, and mode bits do not
 * restrict the owner on Windows, where the CI matrix also runs this.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MockProvider } from "../src/providers/mock.js";
import { ProviderStoreError, type ProviderProfile, type ProviderProfilesFile } from "../src/provider-profiles.js";
import { ActiveProviderBox, ProfileError, ProviderService } from "../src/provider-service.js";
import type { ProviderStore } from "../src/provider-profiles.js";
import type { LLMProvider } from "../src/providers/types.js";

const profile = (id: string, over: Partial<ProviderProfile> = {}): ProviderProfile => ({
  id,
  label: id.toUpperCase(),
  kind: "mock",
  model: "mock",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

/**
 * Same contract as ProviderStore.mutate: apply `fn` to the in-memory copy,
 * then persist — and throw when the persist is the part that fails, leaving
 * the in-memory copy already changed. That is exactly the window the service
 * has to survive.
 */
class FlakyStore {
  data: ProviderProfilesFile = { version: 1, activeProfileId: "mock-a", profiles: [profile("mock-a"), profile("mock-b")] };
  /** When true, every write fails after the in-memory change was applied. */
  failWrites = false;
  /** Call order, so the tests can assert "persist happens before the swap". */
  calls: string[] = [];

  async mutate(fn: (data: ProviderProfilesFile) => void): Promise<void> {
    this.calls.push("mutate");
    fn(this.data);
    if (this.failWrites) throw new ProviderStoreError("cannot write provider-profiles.json: EACCES: permission denied");
  }
}

/** An ActiveProviderBox that records when the live provider is swapped. */
class RecordingBox extends ActiveProviderBox {
  calls: string[];
  constructor(provider: LLMProvider, profileId: string | undefined, calls: string[]) {
    super(provider, profileId);
    this.calls = calls;
  }
  override set(provider: LLMProvider, profileId?: string): void {
    this.calls.push("swap");
    super.set(provider, profileId);
  }
}

function harness() {
  const store = new FlakyStore();
  const first = new MockProvider();
  // One array shared by the store and the box, so the tests can assert the
  // order of the two side effects that must not be swapped.
  const calls: string[] = [];
  store.calls = calls;
  const box = new RecordingBox(first, "mock-a", calls);
  let built = 0;
  const service = new ProviderService({
    store: store as unknown as ProviderStore,
    active: box,
    build: (p) => {
      calls.push("build");
      built += 1;
      return new MockProvider();
    },
  });
  return { store, box, service, first, calls, built: () => built };
}

describe("ProviderService activation ordering", () => {
  it("persists before swapping the live provider (build -> persist -> swap)", async () => {
    const { store, box, service, first, calls } = harness();
    await service.activate("mock-b");
    assert.deepEqual(calls, ["build", "mutate", "swap"], "the live swap must come after the write");
    assert.equal(box.profileId, "mock-b");
    assert.notEqual(box.get(), first, "the next turn runs on the newly activated provider");
    assert.equal(store.data.activeProfileId, "mock-b");
  });

  it("a failed write leaves the live provider, the box and the in-memory active id untouched", async () => {
    const { store, box, service, first } = harness();
    store.failWrites = true;

    const err = await service.activate("mock-b").then(
      () => undefined,
      (e: unknown) => e
    );
    assert.ok(err instanceof ProfileError, "activation fails with a ProfileError");
    assert.equal(err.code, "PROFILE_PERSIST_FAILED");
    assert.equal(err.status, 500);

    // The point of the test: nothing moved. Before the ordering fix the box
    // already pointed at mock-b here while the disk still said mock-a.
    assert.equal(box.profileId, "mock-a", "the live box still names the persisted profile");
    assert.equal(box.get(), first, "the live provider was not swapped");
    assert.equal(store.data.activeProfileId, "mock-a", "the in-memory copy was rolled back to what is on disk");
  });

  it("a failed write on the active profile keeps the saved values and does not rebuild the provider", async () => {
    const { store, box, service, first } = harness();
    store.failWrites = true;

    const err = await service.update("mock-a", { model: "changed-model" }).then(
      () => undefined,
      (e: unknown) => e
    );
    assert.ok(err instanceof ProfileError, "the edit fails with a ProfileError");
    assert.equal(err.code, "PROFILE_PERSIST_FAILED");

    const saved = store.data.profiles.find((p) => p.id === "mock-a");
    assert.equal(saved?.model, "mock", "the in-memory profile was rolled back");
    assert.equal(box.get(), first, "the live provider was not rebuilt from an unsaved edit");
  });

  it("an edit that survives the write hot-reloads the active profile for the next turn", async () => {
    const { store, box, service, first } = harness();
    await service.update("mock-a", { model: "changed-model" });
    assert.equal(store.data.profiles.find((p) => p.id === "mock-a")?.model, "changed-model");
    assert.notEqual(box.get(), first, "the active profile was rebuilt in place");
    assert.equal(box.profileId, "mock-a");
  });

  it("a validation failure inside the mutation is not reported as a persist failure", async () => {
    const { store, service } = harness();
    // Deleting the active profile is refused by the service before any write.
    const err = await service.remove("mock-a").then(
      () => undefined,
      (e: unknown) => e
    );
    assert.ok(err instanceof ProfileError);
    assert.equal(err.code, "PROVIDER_ACTIVE");
    assert.equal(err.status, 409);
    assert.equal(store.data.profiles.length, 2, "nothing was removed");
  });
});
