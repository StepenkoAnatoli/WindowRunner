import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApiClient, ApiRequestError } from "../src/api.js";

/**
 * The provider-dashboard ApiClient methods (listProviders, createProfile,
 * updateProfile, deleteProfile, activateProfile, testProfile, usage) against a
 * fake fetch. Same style as api.test.ts: record each request, serve a canned
 * response, and assert the URL, method, auth header and (for mutation calls)
 * the JSON body so the dashboard can't drift from the server's routes.
 */

/** One recorded fetch call: the (path-joined) URL and the RequestInit. */
interface Call {
  url: string;
  init: RequestInit;
  /** Raw request body, if any. */
  body?: string;
}

function makeFetch(handler: (url: string, init: RequestInit) => Response): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (url: any, init: any) => {
    const u = String(url);
    calls.push({ url: u, init, body: init?.body ?? undefined });
    return handler(u, init);
  };
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const PROFILE = {
  id: "omniroute",
  label: "OmniRoute (CheaperInference)",
  kind: "openai-compatible",
  baseUrl: "https://example.com/v1",
  model: "model-x",
  apiKeyMasked: "****1234",
  createdAt: 1,
  updatedAt: 2,
};

describe("ApiClient provider-dashboard methods", () => {
  it("listProviders GETs /api/providers with the bearer token", async () => {
    const payload = { activeProfileId: "omniroute", profiles: [PROFILE] };
    const { fetchImpl, calls } = makeFetch(() => json(payload));
    const client = new ApiClient({ baseUrl: "http://x", token: "tok", fetch: fetchImpl });

    assert.deepEqual(await client.listProviders(), payload);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://x/api/providers");
    assert.equal(calls[0].init.method, "GET");
    assert.equal((calls[0].init.headers as any).authorization, "Bearer tok");
  });

  it("createProfile POSTs the input JSON to /api/providers", async () => {
    const { fetchImpl, calls } = makeFetch(() => json(PROFILE, 201));
    const client = new ApiClient({ baseUrl: "http://x", token: "tok", fetch: fetchImpl });

    const input = { id: "omniroute", label: "OmniRoute", kind: "openai-compatible", baseUrl: "https://example.com/v1", model: "model-x", apiKey: "sk-secret" };
    assert.deepEqual(await client.createProfile(input), PROFILE);
    assert.equal(calls[0].url, "http://x/api/providers");
    assert.equal(calls[0].init.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].body!), input);
  });

  it("updateProfile PATCHes only the provided fields and URL-encodes the id", async () => {
    const { fetchImpl, calls } = makeFetch(() => json({ ...PROFILE, label: "Renamed" }));
    const client = new ApiClient({ baseUrl: "http://x", token: "tok", fetch: fetchImpl });

    await client.updateProfile("omni route", { label: "Renamed", apiKey: "" });
    assert.equal(calls[0].url, "http://x/api/providers/omni%20route");
    assert.equal(calls[0].init.method, "PATCH");
    assert.deepEqual(JSON.parse(calls[0].body!), { label: "Renamed", apiKey: "" });
  });

  it("deleteProfile DELETEs /api/providers/:id and returns nothing", async () => {
    const { fetchImpl, calls } = makeFetch(() => new Response(null, { status: 204 }));
    const client = new ApiClient({ baseUrl: "http://x", token: "tok", fetch: fetchImpl });

    assert.equal(await client.deleteProfile("openai"), undefined);
    assert.equal(calls[0].url, "http://x/api/providers/openai");
    assert.equal(calls[0].init.method, "DELETE");
    assert.equal(calls[0].body, undefined);
  });

  it("activateProfile POSTs /api/providers/:id/activate with no body", async () => {
    const { fetchImpl, calls } = makeFetch(() => json({ activeProfileId: "omniroute", profile: PROFILE }));
    const client = new ApiClient({ baseUrl: "http://x", token: "tok", fetch: fetchImpl });

    assert.deepEqual(await client.activateProfile("omniroute"), { activeProfileId: "omniroute", profile: PROFILE });
    assert.equal(calls[0].url, "http://x/api/providers/omniroute/activate");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].body, undefined);
  });

  it("testProfile POSTs /api/providers/:id/test and passes the result through", async () => {
    const result = { ok: false, latencyMs: 8000, code: "TEST_TIMEOUT", message: "probe timed out" };
    const { fetchImpl, calls } = makeFetch(() => json(result));
    const client = new ApiClient({ baseUrl: "http://x", token: "tok", fetch: fetchImpl });

    assert.deepEqual(await client.testProfile("spark-local"), result);
    assert.equal(calls[0].url, "http://x/api/providers/spark-local/test");
    assert.equal(calls[0].init.method, "POST");
  });

  it("usage GETs /api/usage with the requested limit", async () => {
    const record = { at: 3, providerId: "omniroute", model: "model-x", turnId: "t1", sessionId: "s1", status: "completed", inputTokens: 10, outputTokens: 20 };
    const { fetchImpl, calls } = makeFetch(() => json({ records: [record], retained: 1, bounded: false }));
    const client = new ApiClient({ baseUrl: "http://x", token: "tok", fetch: fetchImpl });

    assert.deepEqual(await client.usage(50), { records: [record], retained: 1, bounded: false });
    assert.equal(calls[0].url, "http://x/api/usage?limit=50");
    assert.equal(calls[0].init.method, "GET");
    // The default is 50 too, but the URL must always carry the limit.
    assert.equal(calls[0].body, undefined);
  });

  it("surfaces the server's code + per-field `errors` list on a rejected profile create", async () => {
    const { fetchImpl } = makeFetch(() => json({ error: "profile is invalid", code: "PROFILE_INVALID", errors: ["baseUrl required for openai-compatible"] }, 400));
    const client = new ApiClient({ token: "tok", fetch: fetchImpl });

    await assert.rejects(client.createProfile({ id: "x" }), (err: unknown) => {
      const e = err as ApiRequestError;
      return (
        e instanceof ApiRequestError &&
        e.status === 400 &&
        e.code === "PROFILE_INVALID" &&
        Array.isArray((e.details as any).errors) &&
        (e.details as any).errors[0] === "baseUrl required for openai-compatible"
      );
    });
  });
});
