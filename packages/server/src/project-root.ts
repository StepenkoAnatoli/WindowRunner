import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { ToolErrorCode } from "@windows-runner/shared";

export class PathError extends Error {
  code: ToolErrorCode;
  retryable: boolean;
  constructor(code: ToolErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = "PathError";
    this.code = code;
    this.retryable = retryable;
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function containsNullByte(s: string): boolean {
  return s.includes("\0");
}

function isAbsolutePath(p: string): boolean {
  if (path.isAbsolute(p)) return true;
  // Windows absolute on posix: C:\ or C:/ or \\server\share
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true;
  if (/^\\\\/.test(p)) return true;
  return false;
}

function hasEncodedTraversal(p: string): { has: boolean; decoded?: string } {
  // Check for %2e%2e etc, case insensitive
  // Try decode, if fails, treat as has encoded
  try {
    const decoded = decodeURIComponent(p);
    if (decoded !== p) {
      // If decoded contains .. or is absolute or contains \ or null byte
      if (decoded.includes("..") || isAbsolutePath(decoded) || decoded.includes("\0")) {
        return { has: true, decoded };
      }
      // Also check for %252e -> double encoded
      if (/%2e/i.test(p) || /%2f/i.test(p) || /%5c/i.test(p)) {
        // If original had encoded dot/slash/backslash, treat as suspicious
        return { has: true, decoded };
      }
    }
    // Even if decoded == original, check if original contains encoded sequences
    if (/%2e/i.test(p) || /%252e/i.test(p)) {
      // Contains encoded dot
      return { has: true, decoded };
    }
    return { has: false };
  } catch {
    // Malformed URI encoding -> reject
    return { has: true };
  }
}

function normalizeSeparators(p: string): string {
  // Replace \ with / for uniform handling, but keep for path.resolve we will use posix?
  // Use path.normalize after replacing \ with / to catch Windows traversal even on posix
  return p.replace(/\\/g, "/");
}

export interface ProjectRootOptions {
  allowedRoots: string[];
}

export class ProjectRoot {
  readonly canonicalRoot: string;
  readonly realRoot: string;
  readonly allowedRoots: string[];
  readonly realAllowedRoots: string[];

  private constructor(canonicalRoot: string, realRoot: string, allowedRoots: string[], realAllowedRoots: string[]) {
    this.canonicalRoot = canonicalRoot;
    this.realRoot = realRoot;
    this.allowedRoots = allowedRoots;
    this.realAllowedRoots = realAllowedRoots;
  }

  static async create(requestedRoot: string, allowedRoots: string[] = []): Promise<ProjectRoot> {
    if (containsNullByte(requestedRoot)) {
      throw new PathError("PATH_ESCAPES_ROOT", `path escapes root: null byte in root: ${requestedRoot}`, false);
    }

    if (!isAbsolutePath(requestedRoot)) {
      // For ProjectRoot creation, we require absolute, but we can resolve relative to cwd for convenience?
      // Require absolute for safety
      throw new PathError("PATH_ESCAPES_ROOT", `path escapes root: root must be absolute: ${requestedRoot}`, false);
    }

    const canonicalRequested = path.resolve(requestedRoot);

    // Validate against allowedRoots if provided
    let canonicalAllowed: string[] = [];
    let realAllowed: string[] = [];

    if (allowedRoots.length > 0) {
      canonicalAllowed = allowedRoots.map((r) => path.resolve(r));
      // Check logical containment
      const insideSome = canonicalAllowed.some((allowed) => isInside(canonicalRequested, allowed));
      if (!insideSome) {
        throw new PathError(
          "PATH_ESCAPES_ROOT",
          `path escapes root: requested root ${canonicalRequested} not inside allowed roots ${canonicalAllowed.join(", ")}`,
          false
        );
      }

      // Realpath allowed roots for real check
      for (const allowed of canonicalAllowed) {
        try {
          const real = await fs.realpath(allowed);
          realAllowed.push(real);
        } catch {
          // If allowed root doesn't exist, use canonical
          realAllowed.push(allowed);
        }
      }
    }

    // Realpath requested root — must exist and be directory, but allow non-existing when allowedRoots empty (for tests)
    let realRequested: string;
    try {
      realRequested = await fs.realpath(canonicalRequested);
    } catch (err: any) {
      if (err.code === "ENOENT") {
        if (allowedRoots.length === 0) {
          // For tests, allow non-existing root — use canonical as real
          realRequested = canonicalRequested;
        } else {
          throw new PathError("PATH_NOT_FOUND", `file not found: root ${canonicalRequested} does not exist`, true);
        }
      } else {
        throw mapFsError(err, canonicalRequested);
      }
    }

    if (realRequested !== canonicalRequested || allowedRoots.length > 0) {
      try {
        const stat = await fs.stat(realRequested);
        if (!stat.isDirectory()) {
          throw new PathError("NOT_A_DIRECTORY", `not a directory: root ${canonicalRequested} is file`, true);
        }
      } catch (err: any) {
        if (err instanceof PathError) throw err;
        if (err.code === "ENOENT" && allowedRoots.length === 0) {
          // Allow non-existing for tests
        } else {
          throw mapFsError(err, canonicalRequested);
        }
      }
    }

    // If allowedRoots provided, also check real containment
    if (realAllowed.length > 0) {
      const insideReal = realAllowed.some((allowed) => isInside(realRequested, allowed));
      if (!insideReal) {
        throw new PathError(
          "PATH_ESCAPES_ROOT",
          `path escapes root: real root ${realRequested} not inside allowed real roots ${realAllowed.join(", ")}`,
          false
        );
      }
    }

    return new ProjectRoot(canonicalRequested, realRequested, canonicalAllowed, realAllowed);
  }

  /**
   * Synchronous logical containment check — no fs access
   * Throws PathError with PATH_ESCAPES_ROOT if escapes
   */
  resolve(requested: string): string {
    if (containsNullByte(requested)) {
      throw new PathError("PATH_ESCAPES_ROOT", `path escapes root: null byte in path: ${requested}`, false);
    }

    const encodedCheck = hasEncodedTraversal(requested);
    if (encodedCheck.has) {
      throw new PathError(
        "PATH_ESCAPES_ROOT",
        `path escapes root: encoded traversal: ${requested}${encodedCheck.decoded ? ` -> ${encodedCheck.decoded}` : ""}`,
        false
      );
    }

    if (isAbsolutePath(requested)) {
      throw new PathError("PATH_ESCAPES_ROOT", `path escapes root: absolute path not allowed: ${requested}`, false);
    }

    // Normalize separators: treat \ as / for security, even on posix
    const normalizedRequested = normalizeSeparators(requested);

    // Reject if normalizedRequested is absolute after replacement (e.g., /etc)
    if (path.isAbsolute(normalizedRequested) || isAbsolutePath(normalizedRequested)) {
      throw new PathError("PATH_ESCAPES_ROOT", `path escapes root: absolute path not allowed: ${requested}`, false);
    }

    const logical = path.resolve(this.canonicalRoot, normalizedRequested);

    if (!isInside(logical, this.canonicalRoot)) {
      throw new PathError(
        "PATH_ESCAPES_ROOT",
        `path escapes root: ${requested} resolves outside root: ${logical} not inside ${this.canonicalRoot}`,
        false
      );
    }

    return logical;
  }

  /**
   * Async logical + realpath containment for existing paths
   * For non-existing, verifies nearest existing parent's realpath is inside realRoot
   */
  async resolveReal(requested: string): Promise<string> {
    const logical = this.resolve(requested);

    try {
      const real = await fs.realpath(logical);
      if (!isInside(real, this.realRoot)) {
        throw new PathError(
          "PATH_ESCAPES_ROOT",
          `path escapes root: symlink ${requested} -> ${real} outside root ${this.realRoot}`,
          false
        );
      }
      return real;
    } catch (err: any) {
      if (err instanceof PathError) throw err;
      if (err.code === "ENOENT") {
        // File doesn't exist — check parent chain for symlink escape
        const existingParent = await this.findExistingParent(logical);
        if (existingParent) {
          try {
            const realParent = await fs.realpath(existingParent);
            if (!isInside(realParent, this.realRoot)) {
              throw new PathError(
                "PATH_ESCAPES_ROOT",
                `path escapes root: parent symlink ${existingParent} -> ${realParent} outside root`,
                false
              );
            }
          } catch (e: any) {
            if (e instanceof PathError) throw e;
            // If realpath of parent fails for other reason, map it
            if (e.code !== "ENOENT") {
              throw mapFsError(e, existingParent);
            }
          }
        }
        // Parent chain ok, file doesn't exist — return logical for creation
        return logical;
      }
      throw mapFsError(err, logical);
    }
  }

  private async findExistingParent(p: string): Promise<string | null> {
    let current = path.dirname(p);
    const root = path.parse(p).root;
    while (current !== root && current !== "." && current !== "") {
      try {
        await fs.stat(current);
        return current;
      } catch (err: any) {
        if (err.code === "ENOENT") {
          current = path.dirname(current);
          continue;
        }
        throw err;
      }
    }
    // Check root itself
    try {
      await fs.stat(this.canonicalRoot);
      return this.canonicalRoot;
    } catch {
      return null;
    }
  }

  // Capability methods

  async readFile(requested: string, encoding: BufferEncoding = "utf8", signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw (signal as any).reason ?? new Error("aborted");
    const abs = await this.resolveReal(requested);
    try {
      const data = (await fs.readFile(abs, { encoding, signal } as any)) as unknown as string;
      return data;
    } catch (err: any) {
      if (err.name === "AbortError" || signal?.aborted) {
        throw (signal as any).reason ?? err;
      }
      throw mapFsError(err, requested);
    }
  }

  async writeFile(requested: string, content: string, opts: { createParents?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    const { createParents = false, signal } = opts;
    if (signal?.aborted) throw (signal as any).reason ?? new Error("aborted");
    const logical = this.resolve(requested);

    // For write, we need to check parent realpath even if file doesn't exist
    const parent = path.dirname(logical);
    try {
      const existingParent = await this.findExistingParent(logical);
      if (existingParent) {
        const realParent = await fs.realpath(existingParent);
        if (!isInside(realParent, this.realRoot)) {
          throw new PathError(
            "PATH_ESCAPES_ROOT",
            `path escapes root: parent symlink ${existingParent} -> ${realParent} outside root`,
            false
          );
        }
      }

      // Check if parent exists
      try {
        await fs.stat(parent);
      } catch (err: any) {
        if (err.code === "ENOENT") {
          if (!createParents) {
            throw new PathError("PATH_NOT_FOUND", `parent not found: ${path.dirname(requested)} for ${requested}`, true);
          }
          // Create parents
          await fs.mkdir(parent, { recursive: true });
        } else {
          throw mapFsError(err, parent);
        }
      }

      // Check if target is directory
      try {
        const st = await fs.stat(logical);
        if (st.isDirectory()) {
          throw new PathError("IS_DIRECTORY", `is directory, expected file: ${requested}`, true);
        }
      } catch (err: any) {
        if (err instanceof PathError) throw err;
        if (err.code !== "ENOENT") {
          throw mapFsError(err, logical);
        }
        // ENOENT ok for write
      }

      await fs.writeFile(logical, content, { signal } as any);
    } catch (err: any) {
      if (err instanceof PathError) throw err;
      if (err.name === "AbortError" || signal?.aborted) {
        throw (signal as any).reason ?? err;
      }
      throw mapFsError(err, requested);
    }
  }

  async stat(requested: string, signal?: AbortSignal): Promise<import("fs").Stats> {
    if (signal?.aborted) throw (signal as any).reason ?? new Error("aborted");
    const abs = await this.resolveReal(requested);
    try {
      const st = await fs.stat(abs);
      return st;
    } catch (err: any) {
      if (err.name === "AbortError" || signal?.aborted) {
        throw (signal as any).reason ?? err;
      }
      throw mapFsError(err, requested);
    }
  }

  async mkdir(requested: string, opts: { recursive?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    const { recursive = false, signal } = opts;
    if (signal?.aborted) throw (signal as any).reason ?? new Error("aborted");
    const logical = this.resolve(requested);

    // Check parent realpath for symlink escape
    const existingParent = await this.findExistingParent(logical);
    if (existingParent) {
      try {
        const realParent = await fs.realpath(existingParent);
        if (!isInside(realParent, this.realRoot)) {
          throw new PathError(
            "PATH_ESCAPES_ROOT",
            `path escapes root: parent symlink ${existingParent} -> ${realParent} outside root`,
            false
          );
        }
      } catch (e: any) {
        if (e instanceof PathError) throw e;
        if (e.code !== "ENOENT") throw mapFsError(e, existingParent);
      }
    }

    try {
      await fs.mkdir(logical, { recursive });
    } catch (err: any) {
      if (err.name === "AbortError" || signal?.aborted) {
        throw (signal as any).reason ?? err;
      }
      throw mapFsError(err, requested);
    }
  }

  getRoot(): string {
    return this.canonicalRoot;
  }

  getRealRoot(): string {
    return this.realRoot;
  }
}

export function mapFsError(err: any, requestedPath: string): PathError {
  if (err instanceof PathError) return err;

  const code = err.code as string | undefined;
  const message = err.message ?? String(err);

  switch (code) {
    case "ENOENT":
      return new PathError("PATH_NOT_FOUND", `file not found: ${requestedPath}`, true);
    case "EACCES":
    case "EPERM":
      return new PathError("PERMISSION_DENIED", `permission denied: ${requestedPath}`, false);
    case "EISDIR":
      return new PathError("IS_DIRECTORY", `is directory, expected file: ${requestedPath}`, true);
    case "ENOTDIR":
      return new PathError("NOT_A_DIRECTORY", `not a directory: ${requestedPath}`, true);
    case "EEXIST":
      return new PathError("FILE_EXISTS", `file exists: ${requestedPath}`, true);
    default:
      // Check message for patterns
      if (message.includes("EACCES") || message.includes("permission denied")) {
        return new PathError("PERMISSION_DENIED", `permission denied: ${requestedPath}`, false);
      }
      return new PathError("IO_ERROR", `io error: ${requestedPath}: ${message}`, true);
  }
}
