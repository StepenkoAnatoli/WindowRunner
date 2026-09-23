import type { Express, Request, Response, NextFunction } from "express";
import { static as expressStatic } from "express";
import * as path from "node:path";
import type { AppRuntime } from "./runtime.js";

/**
 * Static UI serving. Everything here is public-but-validated: the security
 * middleware has already run Host/Origin validation, and every API call the
 * pages make carries the bearer token — but loading a page itself needs no
 * token. Nothing is cached so a rebuilt bundle is picked up immediately.
 */

/** Paths that must serve the main app shell so a refresh or a pasted link lands in the client route host. Not a SPA catch-all. */
const CLIENT_APP_ROUTES = new Set([
  "/providers",
  "/usage",
  "/settings/security",
  "/settings/storage",
  "/settings/about",
]);

/** True for an allowlisted client route. Trailing slashes and case are folded. */
export function isClientAppRoute(pathname: string): boolean {
  const normalized = (pathname || "/").split("?")[0].replace(/\/+$/, "").toLowerCase() || "/";
  return CLIENT_APP_ROUTES.has(normalized);
}

/** Security headers shared by every static UI (main app, dashboard, desktop). */
export function uiSecurityHeaders(): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'",
  };
}

export function registerStaticUi(app: Express, rt: AppRuntime): void {
  const { deps, security } = rt;
  const uiHeaders = uiSecurityHeaders();
  const withHeaders = (res: Response): void => {
    for (const [k, v] of Object.entries(uiHeaders)) res.setHeader(k, v);
  };

  // Provider dashboard (packages/web/dist/dashboard), served at /dashboard.
  // Registered before the main static handler so /dashboard* can never be
  // answered by the app bundle.
  if (deps.dashboardDir) {
    const dashDir = deps.dashboardDir;
    app.get("/dashboard", (_req: Request, res: Response, next: NextFunction) => {
      res.sendFile(path.join(dashDir, "dashboard.html"), { headers: uiHeaders }, (err) => {
        if (err) next();
      });
    });
    app.use("/dashboard", staticWithHeaders(dashDir, withHeaders));
  }

  // Desktop renderer shell (packages/desktop/dist/renderer), served at
  // /desktop. The Electron window loads this page from the server's own
  // origin, so its API and SSE calls are same-origin and the Origin policy is
  // unchanged. Registered before the main static handler so /desktop* can
  // never be answered by the app bundle.
  if (deps.desktopDir) {
    const desktopAssets = deps.desktopDir;
    app.get("/desktop", (_req: Request, res: Response, next: NextFunction) => {
      res.sendFile(path.join(desktopAssets, "index.html"), { headers: uiHeaders }, (err) => {
        if (err) next();
      });
    });
    app.use("/desktop", staticWithHeaders(desktopAssets, withHeaders));
  }

  // Deep client routes (B3). The app is a client-side route host, but a
  // refresh or a pasted link must still receive the shell. This is an
  // allowlist, not a catch-all: unknown paths, missing assets, /api/*,
  // /healthz, /dashboard, and /desktop are untouched. GET/HEAD only, so a
  // POST cannot be answered with HTML. The file is the static index.html —
  // nothing in the response is interpolated, so a token or provider key
  // cannot appear here. Registered before the static handler so a missing
  // file named "providers" cannot win, and after /dashboard and /desktop so
  // those mounts stay exact.
  if (deps.webDir) {
    const appShell = path.join(deps.webDir, "index.html");
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      if (!isClientAppRoute(req.path ?? "")) return next();
      res.sendFile(appShell, { headers: uiHeaders }, (err) => {
        if (err) next(err);
      });
    });
  }

  // Static web UI. index.html is never cached so a rebuilt bundle is picked
  // up and a stale page cannot keep an old API contract. The static handler
  // is skipped for every protected prefix (/api/ …) so a file in the UI
  // directory can never shadow or answer for an API route.
  if (deps.webDir) {
    const protectedPrefixes = security?.protectedPrefixes ?? ["/api/"];
    const serveStatic = staticWithHeaders(deps.webDir, withHeaders, { index: "index.html", etag: true });    app.use((req: Request, res: Response, next: NextFunction) => {
      const p: string = req.path ?? "";
      if (p === "/healthz" || protectedPrefixes.some((prefix) => p.startsWith(prefix))) return next();
      return serveStatic(req, res, next);
    });
  }

  // GET /healthz — liveness only: "the process is up and serving HTTP". It
  // deliberately runs no validation and touches no store, so it stays cheap
  // enough for container health checks. Readiness/diagnostics live at
  // /api/health.
  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });
}

/** express.static with the UI security headers applied to every response. */
function staticWithHeaders(
  root: string,
  withHeaders: (res: Response) => void,
  options: { index?: string; etag?: boolean } = {}
) {
  return expressStatic(root, {
    fallthrough: true,
    index: options.index,
    etag: options.etag,
    setHeaders: (res) => withHeaders(res),
  });
}
