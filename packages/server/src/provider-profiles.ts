/**
 * Provider profiles — named, switchable model configurations managed from the
 * web dashboard (/dashboard) without editing environment variables.
 *
 * Storage: `<dataDir>/provider-profiles.json`, mode 0600, written atomically
 * (tmp + rename). Same pattern as the auth token in boot.ts. API keys are
 * stored plaintext in that file only (documented limitation — no OS keychain
 * in this pass); they are never logged and never leave the process in a
 * response: every profile that is serialized is passed through
 * `redactProfile()`, which replaces `apiKey` with a `****last4` mask.
 *
 * The environment-configured provider (WINDOWS_RUNNER_PROVIDER & co) becomes
 * the bootstrap `default` profile on first boot; an activeProfileId persisted
 * by a later dashboard choice wins over the environment on subsequent boots,
 * so nothing breaks for users who never touch the dashboard.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

export type ProviderKind = "mock" | "openai-compatible" | "anthropic";

/** Outcome of the dashboard's "Test" button for one profile. Bookkeeping only. */
export interface ProviderTestResult {
  at: number;
  ok: boolean;
  latencyMs?: number;
  /** ProviderError code (or TEST_TIMEOUT) when ok=false. */
  code?: string;
  /** Secret-free failure detail when ok=false. */
  message?: string;
}

export interface ProviderProfile {
  /** Stable slug, e.g. "omniroute", "openai", "spark-local". Immutable after create. */
  id: string;
  /** Display name, e.g. "OmniRoute (CheaperInference)". */
  label: string;
  kind: ProviderKind;
  /** Required for openai-compatible; optional for anthropic (defaults to the official API); ignored for mock. */
  baseUrl?: string;
  /** Model id/name sent in requests. */
  model: string;
  /** Stored 0600-only; never returned unmasked by any API. */
  apiKey?: string;
  createdAt: number;
  updatedAt: number;
  lastTest?: ProviderTestResult;
}

/** Shape of any profile that leaves the process: apiKey replaced by a mask. */
export type RedactedProfile = Omit<ProviderProfile, "apiKey"> & { apiKeyMasked?: string };

export interface ProviderProfilesFile {
  version: 1;
  activeProfileId: string | null;
  profiles: ProviderProfile[];
}

export const FILE_NAME = "provider-profiles.json";
export const PROFILE_ID_RE = /^[a-z0-9-]{1,64}$/;
export const KINDS: readonly ProviderKind[] = ["mock", "openai-compatible", "anthropic"];

export function profilesFilePath(dataDir: string): string {
  return path.join(dataDir, FILE_NAME);
}

/** `sk-...abcd` -> `****abcd`; never exposes more than the last four characters. */
export function maskKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  if (key.length <= 4) return "****";
  return `****${key.slice(-4)}`;
}

/** Strips apiKey from a profile for any response leaving the process. */
export function redactProfile(p: ProviderProfile): RedactedProfile {
  const { apiKey, ...rest } = p;
  return { ...rest, apiKeyMasked: maskKey(apiKey) };
}

/**
 * Validate a full profile (create: the input IS the profile; update: the
 * merged result). Returns a list of human-readable errors; empty = valid.
 */
export function validateProfile(input: Partial<ProviderProfile>): string[] {
  const errors: string[] = [];
  if (typeof input.id !== "string" || !PROFILE_ID_RE.test(input.id)) {
    errors.push("id must be lowercase alphanumeric/hyphen, 1-64 chars");
  }
  if (typeof input.label !== "string" || input.label.trim().length === 0 || input.label.length > 128) {
    errors.push("label required, max 128 chars");
  }
  if (typeof input.kind !== "string" || !KINDS.includes(input.kind as ProviderKind)) {
    errors.push(`kind must be one of: ${KINDS.join(" | ")}`);
  }
  if (typeof input.model !== "string" || input.model.trim().length === 0 || input.model.length > 256) {
    errors.push("model required, max 256 chars");
  }
  if (input.kind === "openai-compatible" && (typeof input.baseUrl !== "string" || input.baseUrl.length === 0)) {
    errors.push("baseUrl required for openai-compatible");
  }
  if (input.baseUrl !== undefined && !/^https?:\/\//i.test(input.baseUrl)) {
    errors.push("baseUrl must start with http:// or https://");
  }
  if (input.apiKey !== undefined && input.apiKey !== null && typeof input.apiKey === "string") {
    if (input.apiKey.length > 512) errors.push("apiKey too long (max 512 chars)");
    else if (/\s/.test(input.apiKey)) errors.push("apiKey must not contain whitespace");
  }
  return errors;
}

export class ProviderStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderStoreError";
  }
}

/**
 * In-memory copy of provider-profiles.json with a serialized mutation queue.
 * Single-process writer only (same boundary as FileTurnLogStore): O_APPEND /
 * tmp+rename is not a substitute for a file lock, so one server per dataDir.
 */
export class ProviderStore {
  readonly file: string;
  private state: ProviderProfilesFile = { version: 1, activeProfileId: null, profiles: [] };
  /** True once the file has been read successfully from disk. */
  fileExisted = false;
  private queue: Promise<void> = Promise.resolve();
  private now: () => number;

  constructor(opts: { dataDir: string; now?: () => number }) {
    this.file = profilesFilePath(path.resolve(opts.dataDir));
    this.now = opts.now ?? (() => Date.now());
  }

  get data(): ProviderProfilesFile {
    return this.state;
  }

  /**
   * Read the file into memory. ENOENT -> empty state with fileExisted=false
   * (first boot); anything else is a hard error (a corrupt profiles file must
   * not be silently discarded, because it holds API keys the user typed).
   */
  async load(): Promise<{ fileExisted: boolean }> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch (err: any) {
      if (err?.code === "ENOENT") return { fileExisted: false };
      throw new ProviderStoreError(`cannot read ${this.file}: ${err?.code ?? err?.message}`);
    }
    let parsed: ProviderProfilesFile;
    try {
      parsed = JSON.parse(raw) as ProviderProfilesFile;
    } catch (err: any) {
      throw new ProviderStoreError(`${this.file} is not valid JSON (${err?.message}); fix or delete the file`);
    }
    if (parsed?.version !== 1 || !Array.isArray(parsed.profiles)) {
      throw new ProviderStoreError(`unsupported provider-profiles version in ${this.file} (expected version 1)`);
    }
    this.state = {
      version: 1,
      activeProfileId: typeof parsed.activeProfileId === "string" ? parsed.activeProfileId : null,
      profiles: parsed.profiles,
    };
    this.fileExisted = true;
    return { fileExisted: true };
  }

  /** Apply `fn` to the in-memory state and persist it; serialized with other mutations. */
  mutate(fn: (data: ProviderProfilesFile) => void): Promise<void> {
    const op = this.queue.then(() => {
      fn(this.state);
      return this.persist();
    });
    // Keep the chain alive even when a mutation throws (it still rejects `op`).
    this.queue = op.catch(() => {});
    return op;
  }

  /** Persist the current in-memory state (tmp + rename, mode 0600). */
  async persist(): Promise<void> {
    const dir = path.dirname(this.file);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.file}.tmp.${process.pid}.${Date.now()}`;
    try {
      await fs.writeFile(tmp, JSON.stringify(this.state, null, 2) + "\n", { mode: 0o600 });
      await fs.rename(tmp, this.file);
      // chmod after rename: a pre-existing world-readable file keeps its mode on rename on some systems.
      await fs.chmod(this.file, 0o600).catch(() => {});
    } catch (err: any) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw new ProviderStoreError(`cannot write ${this.file}: ${err?.code ?? err?.message}`);
    }
  }
}

/**
 * The bootstrap profile for the environment-configured provider (boot.ts).
 * Id "default" so docs and error messages can name it; the label says the
 * settings came from the environment, not the dashboard.
 */
export function defaultProfileFromConfig(
  config: { provider: string; model: { baseUrl: string; model?: string; apiKey?: string } },
  at: number
): ProviderProfile {
  const kind = config.provider as ProviderKind;
  return {
    id: "default",
    label: `${kind} (env)`,
    kind,
    // Keep the configured base URL for both network kinds: a user who set
    // WINDOWS_RUNNER_MODEL_BASE_URL (custom gateway, local server, the official
    // default) must keep hitting the same endpoint after the profile exists.
    // Dashboard-created anthropic profiles omit it (official API) — createProviderFromProfile
    // applies the default there.
    baseUrl: kind === "openai-compatible" || kind === "anthropic" ? config.model.baseUrl : undefined,
    model: config.model.model ?? "mock",
    apiKey: kind === "mock" ? undefined : config.model.apiKey,
    createdAt: at,
    updatedAt: at,
  };
}
