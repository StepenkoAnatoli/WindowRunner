/**
 * One implementation of "turn an unknown failure into a sentence the user can
 * act on". main.ts and the dashboard each had their own copy, which is how the
 * dashboard ended up not knowing about PATH_ESCAPES_ROOT — the exact error its
 * quick-chat folder field produces.
 *
 * The defaults reproduce the main UI's original wording byte for byte, so
 * existing E2E assertions on those strings still hold; callers opt in to the
 * extra detail they want.
 */
import { ApiRequestError } from "./api.js";

export interface DescribeErrorOptions {
  /** Message for a 401. Defaults to the main UI's wording. */
  auth?: string;
  /**
   * Append the server's per-field `errors` array when the body carries one.
   * The provider profile routes return `errors: [...]` for a rejected profile;
   * the dashboard opts in so "profile is invalid" becomes
   * "profile is invalid: baseUrl required for openai-compatible".
   */
  fieldErrors?: boolean;
}

export function describeError(err: unknown, opts: DescribeErrorOptions = {}): string {
  if (err instanceof ApiRequestError) {
    if (err.status === 401) {
      return opts.auth ?? (err.code === "AUTH_INVALID" ? "token rejected (401 AUTH_INVALID)" : "token required (401)");
    }
    if (err.status === 403 && err.code === "PATH_ESCAPES_ROOT") {
      return `folder is outside the allowed roots (403 PATH_ESCAPES_ROOT): ${err.message}`;
    }
    if (opts.fieldErrors) {
      // Validation failures put the per-field list either at the top level or
      // nested under `details`; both shapes have been observed.
      const details = (err.details ?? {}) as { errors?: unknown; details?: { errors?: unknown } };
      const list = Array.isArray(details.errors) ? details.errors : Array.isArray(details.details?.errors) ? details.details!.errors : [];
      if (list.length > 0) return `${err.message}: ${list.join("; ")}`;
    }
    return `${err.message} (${err.status} ${err.code})`;
  }
  // `fetch` rejects with a TypeError for a refused connection / DNS failure.
  if (err instanceof TypeError) return `cannot reach the server: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
