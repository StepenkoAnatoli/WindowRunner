import { randomBytes, timingSafeEqual } from "node:crypto";
import { isLoopbackHost } from "./config.js";

/**
 * HTTP security boundary for the API (RELEASE_CHECKLIST.md, P0-01).
 *
 * One Express middleware, mounted in createApp() ahead of every /api route,
 * applies three checks in a fixed order and rejects with a stable JSON error:
 *
 *   1. Host      — the Host header must name this machine: a loopback name,
 *                  the bind address, or an entry in `allowedHosts`. Anything
 *                  else is a DNS-rebinding attempt or a misdirected proxy and
 *                  gets 403 HOST_NOT_ALLOWED. A missing Host header is refused
 *                  too (HTTP/1.1 requires it).
 *   2. Origin    — browsers add an Origin header to cross-site and to all
 *                  non-GET requests. When present it must be an explicitly
 *                  allowed origin, or (with an empty allowlist) a loopback
 *                  origin. `Origin: null` never passes. There is no wildcard.
 *                  Allowed origins get the matching CORS headers; a CORS
 *                  preflight (OPTIONS) is answered here, before auth, because
 *                  preflights carry no credentials by definition.
 *   3. Bearer    — in "token" mode the request must carry
 *                  `Authorization: Bearer <token>` matching the configured
 *                  token (constant-time compare). Missing -> 401 AUTH_REQUIRED,
 *                  wrong -> 401 AUTH_INVALID, both with WWW-Authenticate.
 *
 * `/healthz` (liveness) is exempt from auth so container health checks work,
 * but not from Host/Origin validation.
 *
 * Every rejection is reported to `onReject` (metrics/audit) with the kind, the
 * route and a short reason — never with the presented credential.
 */

export type SecurityRejectionKind = "host" | "origin" | "auth";

export interface SecurityRejection {
  kind: SecurityRejectionKind;
  code: string;
  method: string;
  path: string;
  /** Low-cardinality detail suitable for an incident record. Never a secret. */
  detail: string;
}

export interface SecurityOptions {
  /** "token" requires a bearer token on every /api route; "off" skips step 3. */
  mode: "token" | "off";
  /** Required in token mode. */
  token?: string;
  /** Address the listener is bound to; accepted as a Host value when specific. */
  bindHost?: string;
  /** Extra Host values (lower-case, no port). */
  allowedHosts?: string[];
  /** Explicit browser origins (lower-case `scheme://host[:port]`). Empty = loopback origins only. */
  allowedOrigins?: string[];
  /** Paths that skip the bearer check (Host/Origin still apply). Default: ["/healthz"]. */
  publicPaths?: string[];
  onReject?: (rejection: SecurityRejection) => void;
}

export interface SecurityPolicy {
  middleware: (req: any, res: any, next: () => void) => void;
  isHostAllowed(hostHeader: string | undefined): boolean;
  isOriginAllowed(origin: string | undefined): boolean;
  /** True when the presented Authorization header is valid (or auth is off). */
  isAuthorized(authorization: string | undefined): boolean;
  /** Secret-free description for banners and /api/health. */
  describe(): { mode: "token" | "off"; allowedHosts: string[]; allowedOrigins: string[] | "loopback" };
}

const ALLOW_METHODS = "GET, POST, DELETE, OPTIONS";
const ALLOW_HEADERS = "Authorization, Content-Type, Last-Event-ID";
const BEARER_RE = /^Bearer\s+(\S+)\s*$/i;

/** 32 random bytes, base64url — 43 characters, no separators, safe in headers and env. */
export function generateAuthToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Strip the port (and IPv6 brackets) from a Host header value, lower-cased. */
export function hostWithoutPort(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 ? trimmed : trimmed.slice(1, end);
  }
  const colon = trimmed.indexOf(":");
  // More than one colon and no brackets: bare IPv6 literal, keep whole.
  if (colon !== -1 && trimmed.indexOf(":", colon + 1) === -1) return trimmed.slice(0, colon);
  return trimmed;
}

function isAnyAddress(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "0.0.0.0" || h === "::" || h === "0:0:0:0:0:0:0:0" || h === "";
}

function isLoopbackOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return isLoopbackHost(url.hostname);
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Compare against self to keep timing flat, then fail.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function createSecurityPolicy(options: SecurityOptions): SecurityPolicy {
  if (options.mode === "token" && (!options.token || options.token.length === 0)) {
    throw new Error("security: token mode requires a token");
  }
  const token = options.token;
  const bindHost = options.bindHost && !isAnyAddress(options.bindHost) ? hostWithoutPort(options.bindHost) : undefined;
  const allowedHosts = new Set((options.allowedHosts ?? []).map((h) => hostWithoutPort(h)));
  const allowedOrigins = new Set((options.allowedOrigins ?? []).map((o) => o.trim().toLowerCase()));
  const publicPaths = new Set(options.publicPaths ?? ["/healthz"]);
  const onReject = options.onReject ?? (() => {});

  const isHostAllowed = (hostHeader: string | undefined): boolean => {
    if (!hostHeader || hostHeader.trim() === "") return false;
    const host = hostWithoutPort(hostHeader);
    if (host === "") return false;
    if (isLoopbackHost(host)) return true;
    if (bindHost !== undefined && host === bindHost) return true;
    return allowedHosts.has(host);
  };

  const isOriginAllowed = (origin: string | undefined): boolean => {
    if (origin === undefined) return true; // same-origin or non-browser client: nothing to validate
    const value = origin.trim().toLowerCase();
    if (value === "" || value === "null") return false;
    if (allowedOrigins.size > 0) return allowedOrigins.has(value);
    return isLoopbackOrigin(value);
  };

  const isAuthorized = (authorization: string | undefined): boolean => {
    if (options.mode === "off") return true;
    if (!authorization) return false;
    const match = BEARER_RE.exec(authorization);
    if (!match) return false;
    return constantTimeEquals(match[1], token!);
  };

  const reject = (res: any, status: number, rejection: SecurityRejection, extraHeaders?: Record<string, string>) => {
    onReject(rejection);
    if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
    res.status(status).json({ error: rejection.detail, code: rejection.code });
  };

  const middleware = (req: any, res: any, next: () => void): void => {
    const method: string = req.method ?? "GET";
    const path: string = req.path ?? req.url ?? "";

    // 1. Host
    const hostHeader = req.headers?.host as string | undefined;
    if (!isHostAllowed(hostHeader)) {
      reject(res, 403, {
        kind: "host",
        code: "HOST_NOT_ALLOWED",
        method,
        path,
        detail: hostHeader
          ? `Host "${hostWithoutPort(hostHeader)}" is not this server; set WINDOWS_RUNNER_ALLOWED_HOSTS to accept it`
          : "Host header required",
      });
      return;
    }

    // 2. Origin (+ CORS for allowed browser origins)
    const origin = req.headers?.origin as string | undefined;
    if (origin !== undefined) {
      if (!isOriginAllowed(origin)) {
        reject(res, 403, {
          kind: "origin",
          code: "ORIGIN_NOT_ALLOWED",
          method,
          path,
          detail:
            origin.trim().toLowerCase() === "null"
              ? 'Origin "null" is refused'
              : `origin is not allowed; set WINDOWS_RUNNER_ALLOWED_ORIGINS to accept it`,
        });
        return;
      }
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", ALLOW_METHODS);
      res.setHeader("Access-Control-Allow-Headers", ALLOW_HEADERS);
      res.setHeader("Access-Control-Max-Age", "600");
      if (method === "OPTIONS") {
        res.status(204).end();
        return;
      }
    } else if (method === "OPTIONS") {
      res.setHeader("Allow", ALLOW_METHODS);
      res.status(204).end();
      return;
    }

    // 3. Bearer token
    if (options.mode === "token" && !publicPaths.has(path)) {
      const authorization = req.headers?.authorization as string | undefined;
      if (!authorization) {
        reject(
          res,
          401,
          { kind: "auth", code: "AUTH_REQUIRED", method, path, detail: "Authorization: Bearer <token> required" },
          { "WWW-Authenticate": 'Bearer realm="windows-runner"' }
        );
        return;
      }
      if (!isAuthorized(authorization)) {
        reject(
          res,
          401,
          { kind: "auth", code: "AUTH_INVALID", method, path, detail: "bearer token is not valid" },
          { "WWW-Authenticate": 'Bearer realm="windows-runner", error="invalid_token"' }
        );
        return;
      }
    }

    next();
  };

  return {
    middleware,
    isHostAllowed,
    isOriginAllowed,
    isAuthorized,
    describe: () => ({
      mode: options.mode,
      allowedHosts: [...allowedHosts],
      allowedOrigins: allowedOrigins.size > 0 ? [...allowedOrigins] : "loopback",
    }),
  };
}
