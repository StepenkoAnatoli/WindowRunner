import type { Express, Request, Response } from "express";
import { ProfileError } from "../../provider-service.js";
import type { ProviderService } from "../../provider-service.js";
import { DiscoveryError, discoverModels, redactKey } from "../../provider-discovery.js";
import type { AppRuntime } from "../runtime.js";
import { bodyObject } from "../validate.js";

/**
 * Provider profiles (dashboard) and the usage history feed.
 *
 * All routes are under /api/ → bearer token required by the security
 * middleware like every other API route. Responses are always redacted: an
 * apiKey never leaves the process unmasked (provider-service).
 *
 * The routes are registered only when the app was composed with a
 * `providerAdmin` / `usageLog` (boot always supplies both; minimal test apps
 * omit them).
 */

export function registerProviderRoutes(app: Express, rt: AppRuntime): void {
  const { deps } = rt;

  if (deps.providerAdmin) {
    registerProviderAdminRoutes(app, rt);
  }
  if (deps.usageLog) {
    registerUsageRoute(app, rt);
  }
}

function registerProviderAdminRoutes(app: Express, rt: AppRuntime): void {
  const { deps } = rt;
  const admin: ProviderService = deps.providerAdmin!;

  const sendProfileError = (res: Response, err: unknown): Response => {
    if (err instanceof ProfileError) {
      const body: Record<string, unknown> = { error: err.message, code: err.code };
      if (err.errors) body.errors = err.errors;
      return res.status(err.status).json(body);
    }
    console.error(err);
    return res.status(500).json({ error: "provider operation failed", code: "PROVIDER_ERROR" });
  };

  const requireProfileId = (req: Request, res: Response): string | undefined => {
    const id = req.params.id;
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
      res.status(404).json({ error: `profile "${id ?? ""}" not found`, code: "PROFILE_NOT_FOUND" });
      return undefined;
    }
    return id;
  };

  // POST /api/providers/discover-models — one-shot model discovery (B4.1).
  // Static path, deliberately registered BEFORE the parameterized /:id
  // routes so it can never be captured by one. The body carries kind, base
  // URL, and the freshly typed raw key; the key exists only in this
  // request's memory and the Authorization header of the single upstream
  // probe — it is never persisted, never logged, and never part of any
  // response or error (redactKey is a second layer on top of messages that
  // are already secret-free by construction). Discovery never creates,
  // updates, activates, or tests a profile.
  app.post("/api/providers/discover-models", async (req: Request, res: Response) => {
    const body = bodyObject(req, res);
    if (!body) return;
    try {
      res.json(await discoverModels(body));
    } catch (err) {
      if (err instanceof DiscoveryError) {
        const message = redactKey(err.message, typeof body.apiKey === "string" ? body.apiKey : undefined);
        return res.status(err.status).json({ error: message, code: err.code });
      }
      sendProfileError(res, err);
    }
  });

  // GET /api/providers — list profiles (keys masked) + which is active + last health check
  app.get("/api/providers", (_req: Request, res: Response) => {
    res.json({ activeProfileId: admin.activeProfileId, profiles: admin.listProfiles() });
  });

  // POST /api/providers — create a profile. Body: { id, label, kind, baseUrl?, model, apiKey? }
  app.post("/api/providers", async (req: Request, res: Response) => {
    const body = bodyObject(req, res);
    if (!body) return;
    try {
      const profile = await admin.create(body);
      res.status(201).json(profile);
    } catch (err) {
      sendProfileError(res, err);
    }
  });

  // PATCH /api/providers/:id — update label/model/baseUrl/apiKey (apiKey omitted = keep existing)
  app.patch("/api/providers/:id", async (req: Request, res: Response) => {
    const id = requireProfileId(req, res);
    if (!id) return;
    const body = bodyObject(req, res);
    if (!body) return;
    try {
      const profile = await admin.update(id, body);
      res.json(profile);
    } catch (err) {
      sendProfileError(res, err);
    }
  });

  // DELETE /api/providers/:id — refuse if it is the active profile (409 PROVIDER_ACTIVE)
  app.delete("/api/providers/:id", async (req: Request, res: Response) => {
    const id = requireProfileId(req, res);
    if (!id) return;
    try {
      await admin.remove(id);
      res.status(204).end();
    } catch (err) {
      sendProfileError(res, err);
    }
  });

  // POST /api/providers/:id/activate — hot-swap; 404 if id unknown
  app.post("/api/providers/:id/activate", async (req: Request, res: Response) => {
    const id = requireProfileId(req, res);
    if (!id) return;
    try {
      const profile = await admin.activate(id);
      res.json({ activeProfileId: id, profile });
    } catch (err) {
      sendProfileError(res, err);
    }
  });

  // POST /api/providers/:id/test — one minimal request ("say OK") with a short
  // timeout. { ok, latencyMs, reply } or { ok: false, code, message }. The
  // reply goes only to the authenticated dashboard, never to a log.
  app.post("/api/providers/:id/test", async (req: Request, res: Response) => {
    const id = requireProfileId(req, res);
    if (!id) return;
    try {
      res.json(await admin.test(id));
    } catch (err) {
      sendProfileError(res, err);
    }
  });
}

function registerUsageRoute(app: Express, rt: AppRuntime): void {
  const { deps } = rt;
  const usageLog = deps.usageLog!;

  // GET /api/usage?limit=50 — recent turns for the dashboard's history table.
  // Newest first; estCostUsd is only present when a price table entry exists
  // for the exact model id (never fabricated).
  app.get("/api/usage", (req: Request, res: Response) => {
    const raw = req.query.limit;
    let limit = 50;
    if (raw !== undefined) {
      // Repeated params arrive as arrays — an ambiguous limit is a 400.
      if (Array.isArray(raw) || typeof raw !== "string" || !/^\d+$/.test(raw)) {
        return res.status(400).json({ error: "limit must be a positive integer", code: "LIMIT_INVALID" });
      }
      limit = Number(raw);
      if (limit < 1 || limit > 500) {
        return res.status(400).json({ error: "limit must be between 1 and 500", code: "LIMIT_INVALID" });
      }
    }
    // `retained`/`bounded` let the dashboard state that the table is the
    // newest turns only: the ring is capped, the boot read is a bounded
    // tail, and usage.jsonl rotates — so "no more rows" is not "no more
    // turns ever".
    res.json({
      records: usageLog.recent(limit),
      retained: usageLog.length,
      bounded: usageLog.bounded ?? false,
    });
  });
}
