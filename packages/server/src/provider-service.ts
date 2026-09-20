/**
 * ProviderService — the dashboard's backend: profile CRUD, activation
 * (hot-swap), reachability tests, and a description of the active profile.
 *
 * ActiveProviderBox is the mutable box the plan requires for hot-reload:
 * createApp closes over it and every new turn reads the CURRENT provider at
 * turn start, so "Use this" / a PATCH on the active profile takes effect for
 * the next turn without a server restart. In-flight turns keep the provider
 * they started with (a mid-turn swap would splice two wire formats).
 *
 * Errors: ProfileError carries a stable code + HTTP status so the routes in
 * app.ts can map it 1:1. No error message ever contains an API key: provider
 * error messages are already redacted by the adapters, and test() scrubs the
 * profile's key from any text it returns, as a second layer.
 */
import { ProviderError, type LLMProvider } from "./providers/types.js";
import {
  redactProfile,
  validateProfile,
  PROFILE_ID_RE,
  type ProviderProfile,
  type ProviderTestResult,
  type RedactedProfile,
} from "./provider-profiles.js";
import type { ProviderStore } from "./provider-profiles.js";
import { createProviderFromProfile } from "./providers/index.js";

export class ProfileError extends Error {
  readonly code: string;
  readonly status: number;
  readonly errors?: string[];
  constructor(code: string, status: number, message: string, errors?: string[]) {
    super(message);
    this.name = "ProfileError";
    this.code = code;
    this.status = status;
    this.errors = errors;
  }
}

/** Mutable active-provider box (see file header). */
export class ActiveProviderBox {
  private provider: LLMProvider;
  private currentProfileId: string | undefined;

  constructor(provider: LLMProvider, profileId?: string) {
    this.provider = provider;
    this.currentProfileId = profileId;
  }

  get(): LLMProvider {
    return this.provider;
  }

  /** id of the profile that produced the current provider (undefined: override/env fallback). */
  get profileId(): string | undefined {
    return this.currentProfileId;
  }

  set(provider: LLMProvider, profileId?: string): void {
    this.provider = provider;
    this.currentProfileId = profileId;
  }
}

export interface ProviderTestOutcome {
  ok: boolean;
  latencyMs: number;
  /** The model's reply (truncated). Only on success; never logged. */
  reply?: string;
  /** ProviderError code (or TEST_TIMEOUT / TEST_FAILED) when ok=false. */
  code?: string;
  /** Secret-free failure detail when ok=false. */
  message?: string;
}

export interface ProviderServiceOptions {
  store: ProviderStore;
  active: ActiveProviderBox;
  /** Build a turn-ready provider (with the configured retry wrapper). */
  build: (profile: ProviderProfile) => LLMProvider;
  /** Build a provider for the /test probe; defaults to build() with retries disabled. */
  buildForTest?: (profile: ProviderProfile) => LLMProvider;
  now?: () => number;
  log?: (line: string) => void;
  /** Probe timeout. Default 5_000ms. */
  testTimeoutMs?: number;
  /** Stop the probe once this many reply chars have arrived. Default 200. */
  maxTestChars?: number;
}

export class ProviderService {
  private store: ProviderStore;
  private active: ActiveProviderBox;
  private build: (profile: ProviderProfile) => LLMProvider;
  private buildForTest: (profile: ProviderProfile) => LLMProvider;
  private now: () => number;
  private log: (line: string) => void;
  private testTimeoutMs: number;
  private maxTestChars: number;

  constructor(opts: ProviderServiceOptions) {
    this.store = opts.store;
    this.active = opts.active;
    this.build = opts.build;
    this.buildForTest = opts.buildForTest ?? ((p) => createProviderFromProfile(p, { maxRetries: 0 }));
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? (() => {});
    this.testTimeoutMs = opts.testTimeoutMs ?? 5_000;
    this.maxTestChars = opts.maxTestChars ?? 200;
  }

  get activeProfileId(): string | null {
    return this.store.data.activeProfileId;
  }

  getActiveProfile(): ProviderProfile | null {
    return this.store.data.profiles.find((p) => p.id === this.store.data.activeProfileId) ?? null;
  }

  /** Secret-free view of the profile that will serve the next turn. */
  describeActive(): { id: string; label: string; model: string; kind: ProviderProfile["kind"] } | null {
    const p = this.getActiveProfile();
    return p ? { id: p.id, label: p.label, model: p.model, kind: p.kind } : null;
  }

  /** Redacted profiles with the active flag; never contains a raw key. */
  listProfiles(): Array<RedactedProfile & { active: boolean }> {
    return this.store.data.profiles.map((p) => ({ ...redactProfile(p), active: p.id === this.store.data.activeProfileId }));
  }

  private find(id: string, res?: never): ProviderProfile {
    if (!PROFILE_ID_RE.test(id)) throw new ProfileError("PROFILE_NOT_FOUND", 404, `profile "${id}" not found`);
    const profile = this.store.data.profiles.find((p) => p.id === id);
    if (!profile) throw new ProfileError("PROFILE_NOT_FOUND", 404, `profile "${id}" not found`);
    return profile;
  }

  async create(input: unknown): Promise<RedactedProfile> {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new ProfileError("PROFILE_INVALID", 400, "profile must be a JSON object", ["profile must be a JSON object"]);
    }
    const body = input as Partial<ProviderProfile>;
    const errors = validateProfile(body);
    if (errors.length > 0) throw new ProfileError("PROFILE_INVALID", 400, "profile is invalid", errors);

    const id = body.id!.trim();
    let created!: RedactedProfile;
    await this.store.mutate((data) => {
      if (data.profiles.some((p) => p.id === id)) {
        throw new ProfileError("PROFILE_EXISTS", 409, `profile id "${id}" already exists`);
      }
      const t = this.now();
      const profile: ProviderProfile = {
        id,
        label: body.label!.trim(),
        kind: body.kind as ProviderProfile["kind"],
        baseUrl: cleanUrl(body.baseUrl),
        model: body.model!.trim(),
        apiKey: cleanKey(body.apiKey),
        createdAt: t,
        updatedAt: t,
      };
      data.profiles.push(profile);
      created = redactProfile(profile);
    });
    this.log(`providers:   created profile "${id}" (${created.kind})`);
    return created;
  }

  async update(id: string, patchInput: unknown): Promise<RedactedProfile> {
    if (typeof patchInput !== "object" || patchInput === null || Array.isArray(patchInput)) {
      throw new ProfileError("PROFILE_INVALID", 400, "patch must be a JSON object", ["patch must be a JSON object"]);
    }
    const patch = patchInput as Record<string, unknown>;
    if ("id" in patch || "kind" in patch) {
      throw new ProfileError("PROFILE_INVALID", 400, "id and kind are immutable; create a new profile instead", [
        "id and kind are immutable; create a new profile instead",
      ]);
    }
    const known = ["label", "model", "baseUrl", "apiKey"];
    const unknown = Object.keys(patch).filter((k) => !known.includes(k));
    if (unknown.length > 0) {
      throw new ProfileError("PROFILE_INVALID", 400, `unknown field(s): ${unknown.join(", ")}`, [
        `only these fields can be updated: ${known.join(", ")}`,
      ]);
    }

    const existing = this.find(id);
    const merged: ProviderProfile = {
      ...existing,
      label: typeof patch.label === "string" ? patch.label.trim() : existing.label,
      model: typeof patch.model === "string" ? patch.model.trim() : existing.model,
      baseUrl: patch.baseUrl === null ? undefined : typeof patch.baseUrl === "string" ? cleanUrl(patch.baseUrl) : existing.baseUrl,
      // apiKey: omitted = keep, null/"" = clear, string = set.
      apiKey: patch.apiKey === undefined ? existing.apiKey : cleanKey(patch.apiKey),
      updatedAt: this.now(),
    };
    const errors = validateProfile(merged);
    if (errors.length > 0) throw new ProfileError("PROFILE_INVALID", 400, "profile is invalid", errors);

    let updated!: RedactedProfile;
    await this.store.mutate((data) => {
      const i = data.profiles.findIndex((p) => p.id === id);
      if (i === -1) throw new ProfileError("PROFILE_NOT_FOUND", 404, `profile "${id}" not found`);
      data.profiles[i] = merged;
      updated = redactProfile(merged);
    });

    // Hot-reload: an edit to the ACTIVE profile must take effect for the next
    // turn without a restart (plan constraint). Rebuilding is cheap.
    if (this.active.profileId === id) {
      this.active.set(this.build(merged), id);
      this.log(`providers:   updated active profile "${id}" (reloaded for next turn)`);
    } else {
      this.log(`providers:   updated profile "${id}"`);
    }
    return updated;
  }

  async remove(id: string): Promise<void> {
    this.find(id);
    if (this.active.profileId === id || this.store.data.activeProfileId === id) {
      throw new ProfileError("PROVIDER_ACTIVE", 409, `profile "${id}" is active; activate another profile before deleting it`);
    }
    await this.store.mutate((data) => {
      data.profiles = data.profiles.filter((p) => p.id !== id);
    });
    this.log(`providers:   deleted profile "${id}"`);
  }

  async activate(id: string): Promise<RedactedProfile> {
    const profile = this.find(id);
    const provider = this.build(profile); // throws ProfileError/ConfigError on a broken profile
    this.active.set(provider, id);
    await this.store.mutate((data) => {
      data.activeProfileId = id;
    });
    this.log(`providers:   active profile -> "${id}" (${profile.label}, model=${profile.model})`);
    return redactProfile(profile);
  }

  /**
   * Reachability probe: one minimal request ("say OK"), short timeout, no
   * retries. The model's reply is returned only in the response body (the
   * caller is the authenticated dashboard) and never logged. The profile's
   * lastTest is persisted so the card's status dot survives a page reload.
   */
  async test(id: string): Promise<ProviderTestOutcome> {
    const profile = this.find(id);
    const started = this.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error("test timeout")), this.testTimeoutMs);
    let reply = "";
    let satisfied = false;

    const fail = (code: string, message: string): ProviderTestOutcome => {
      const scrubbed = scrubSecret(message, profile.apiKey);
      void this.recordLastTest(profile.id, { at: this.now(), ok: false, code, message: scrubbed.slice(0, 500) });
      this.log(`providers:   test "${id}" FAILED ${code}: ${scrubbed.slice(0, 200)}`);
      return { ok: false, latencyMs: this.now() - started, code, message: scrubbed.slice(0, 500) };
    };

    try {
      const provider = this.buildForTest(profile);
      try {
        for await (const chunk of provider.stream(
          { messages: [{ role: "user", content: "say OK" }], tools: [] },
          { signal: ac.signal }
        )) {
          if (chunk.type === "text_delta") {
            reply += chunk.text;
            if (reply.length >= this.maxTestChars) {
              satisfied = true; // enough text: cut the rest short
              ac.abort();
            }
          }
        }
        satisfied = true; // stream completed cleanly (even if short/empty)
      } catch (err: any) {
        if (satisfied) {
          // Aborted on purpose after collecting enough text: success.
        } else if (ac.signal.aborted) {
          return fail("TEST_TIMEOUT", `no response within ${this.testTimeoutMs}ms`);
        } else if (err instanceof ProviderError) {
          return fail(err.code, err.message);
        } else {
          return fail("TEST_FAILED", scrubSecret(err?.message ?? String(err), profile.apiKey));
        }
      }
      const outcome: ProviderTestOutcome = {
        ok: true,
        latencyMs: this.now() - started,
        reply: scrubSecret(reply.slice(0, 300), profile.apiKey),
      };
      void this.recordLastTest(profile.id, { at: this.now(), ok: true, latencyMs: outcome.latencyMs });
      this.log(`providers:   test "${id}" ok in ${outcome.latencyMs}ms`);
      return outcome;
    } finally {
      clearTimeout(timer);
    }
  }

  private async recordLastTest(id: string, result: ProviderTestResult): Promise<void> {
    try {
      await this.store.mutate((data) => {
        const p = data.profiles.find((x) => x.id === id);
        if (p) p.lastTest = result;
      });
    } catch (err: any) {
      this.log(`providers:   test result for "${id}" not persisted: ${err?.message ?? err}`);
    }
  }
}

function cleanUrl(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim().replace(/\/+$/, "");
  return t.length > 0 ? t : undefined;
}

function cleanKey(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/** Last-resort scrub: no API key may ever travel in a message field. */
function scrubSecret(text: string, secret: string | undefined): string {
  if (!secret || secret.length < 8) return text;
  return text.split(secret).join("[redacted]");
}


