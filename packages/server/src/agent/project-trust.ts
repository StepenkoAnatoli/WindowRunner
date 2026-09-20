import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Project trust (RELEASE_CHECKLIST.md, P0-02).
 *
 * A tool that runs code the project supplies — an MCP server command, a
 * project-defined skill, anything spawned from configuration found under the
 * project root — must not run merely because the model asked for it and the
 * user approved a single call. The user must first trust *this project* with
 * *this configuration*. That decision is:
 *
 *   - keyed by project identity: the real (symlink-resolved) root, so two
 *     aliases of one directory share a decision and a look-alike path does not;
 *   - bound to a configHash: a digest of the configuration that would be
 *     executed. When the configuration changes the hash changes and the grant
 *     is silently invalid; the user is asked again and sees what changed;
 *   - revocable, and never inferred from a persisted session or from an
 *     approval ("approve this call" is not "trust this project").
 *
 * The registry is pure state with an optional JSON file behind it
 * (`<dataDir>/trust.json`). It does not know about tools; the agent loop asks
 * `isTrusted(realRoot, configHash)` before executing a tool that declares
 * `trust` in its definition (see tools/types.ts), and the HTTP layer exposes
 * grant/revoke/inspect under /api/sessions/:id/trust.
 */

export interface TrustGrant {
  /** Symlink-resolved project root — the identity the grant is keyed by. */
  realRoot: string;
  /** Root as the user named it; informational. */
  canonicalRoot: string;
  /** Digest of the configuration that was shown to the user when they consented. */
  configHash: string;
  grantedAt: number;
  /** Free-form origin of the configuration, e.g. ".mcp.json" — informational. */
  source?: string;
}

export interface TrustCheck {
  trusted: boolean;
  /** Present when a grant exists for the root but for a different configHash. */
  staleGrant?: TrustGrant;
  grant?: TrustGrant;
}

interface TrustFileV1 {
  version: 1;
  grants: TrustGrant[];
}

const CONFIG_HASH_RE = /^sha256:[0-9a-f]{64}$/;

/** Canonical digest of a configuration object: `sha256:<hex>` over stable JSON. */
export function computeConfigHash(config: unknown): string {
  return "sha256:" + createHash("sha256").update(stableStringify(config)).digest("hex");
}

export function isValidConfigHash(value: unknown): value is string {
  return typeof value === "string" && CONFIG_HASH_RE.test(value);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k])).join(",") + "}";
}

export interface ProjectTrustRegistryOptions {
  now?: () => number;
  /** When set, grants are persisted to `<dataDir>/trust.json`. */
  dataDir?: string;
}

export class ProjectTrustRegistry {
  private grants = new Map<string, TrustGrant>();
  private now: () => number;
  private filePath?: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private diagnostics: { warnings: string[]; loaded: number; persistenceFailures: number } = { warnings: [], loaded: 0, persistenceFailures: 0 };

  constructor(options: ProjectTrustRegistryOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.filePath = options.dataDir ? path.join(options.dataDir, "trust.json") : undefined;
  }

  /** Load persisted grants. Malformed files are ignored with a warning, never trusted. */
  async boot(): Promise<{ loaded: number; warnings: string[] }> {
    if (!this.filePath) return { loaded: 0, warnings: [] };
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (err: any) {
      if (err?.code === "ENOENT") return { loaded: 0, warnings: [] };
      this.diagnostics.warnings.push(`trust.json unreadable (${err?.code ?? err?.message}); starting with no trusted projects`);
      return { loaded: 0, warnings: this.diagnostics.warnings };
    }
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.diagnostics.warnings.push("trust.json is not valid JSON; starting with no trusted projects");
      return { loaded: 0, warnings: this.diagnostics.warnings };
    }
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.grants)) {
      this.diagnostics.warnings.push(`trust.json has unsupported shape/version ${parsed?.version}; ignored`);
      return { loaded: 0, warnings: this.diagnostics.warnings };
    }
    let loaded = 0;
    for (const g of parsed.grants) {
      if (
        g &&
        typeof g.realRoot === "string" && path.isAbsolute(g.realRoot) &&
        typeof g.canonicalRoot === "string" &&
        isValidConfigHash(g.configHash) &&
        typeof g.grantedAt === "number"
      ) {
        this.grants.set(g.realRoot, { realRoot: g.realRoot, canonicalRoot: g.canonicalRoot, configHash: g.configHash, grantedAt: g.grantedAt, source: typeof g.source === "string" ? g.source : undefined });
        loaded++;
      } else {
        this.diagnostics.warnings.push("trust.json: skipped a malformed grant");
      }
    }
    this.diagnostics.loaded = loaded;
    return { loaded, warnings: this.diagnostics.warnings };
  }

  check(realRoot: string, configHash: string): TrustCheck {
    const grant = this.grants.get(realRoot);
    if (!grant) return { trusted: false };
    if (grant.configHash !== configHash) return { trusted: false, staleGrant: grant };
    return { trusted: true, grant };
  }

  isTrusted(realRoot: string, configHash: string): boolean {
    return this.check(realRoot, configHash).trusted;
  }

  get(realRoot: string): TrustGrant | undefined {
    return this.grants.get(realRoot);
  }

  list(): TrustGrant[] {
    return [...this.grants.values()];
  }

  /** Record consent. Replaces any previous grant for the root (a new hash supersedes the old one). */
  async grant(input: { realRoot: string; canonicalRoot: string; configHash: string; source?: string }): Promise<TrustGrant> {
    if (!isValidConfigHash(input.configHash)) throw new TypeError("configHash must be sha256:<64 hex>");
    const grant: TrustGrant = { ...input, grantedAt: this.now() };
    this.grants.set(input.realRoot, grant);
    await this.persist();
    return grant;
  }

  async revoke(realRoot: string): Promise<boolean> {
    const had = this.grants.delete(realRoot);
    if (had) await this.persist();
    return had;
  }

  getDiagnostics() {
    return { ...this.diagnostics, warnings: [...this.diagnostics.warnings], grants: this.grants.size, persisted: this.filePath !== undefined };
  }

  private persist(): Promise<void> {
    if (!this.filePath) return Promise.resolve();
    const file: TrustFileV1 = { version: 1, grants: this.list() };
    const target = this.filePath;
    this.writeQueue = this.writeQueue.then(async () => {
      const tmp = `${target}.${process.pid}.tmp`;
      try {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
        await fs.rename(tmp, target);
      } catch (err: any) {
        this.diagnostics.persistenceFailures++;
        this.diagnostics.warnings.push(`trust.json write failed (${err?.code ?? err?.message}); grant is in memory only`);
        try { await fs.rm(tmp, { force: true }); } catch {}
      }
    });
    return this.writeQueue;
  }
}
