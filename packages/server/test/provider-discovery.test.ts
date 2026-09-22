/**
 * B4.1 provider model discovery — `POST /api/providers/discover-models` and
 * the `provider-discovery.ts` module behind it:
 * - request validation (kind / baseUrl / apiKey) before any I/O;
 * - `mock` answers offline, `anthropic` returns the documented 501 fallback;
 * - `openai-compatible` probes `{baseUrl}/models` once: bounded response
 *   shapes, dedupe → deterministic sort → 500 cap, 5 s default timeout,
 *   redirects refused, body-size cap, upstream bodies never in errors;
 * - the raw key appears in NO response, error, log, or the profile store —
 *   including a hostile upstream that echoes the Authorization header back.
 *
 * The module tests inject fetch or point at a local fake upstream; the route
 * tests boot the real app with the same bearer middleware as production.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, type Server } from "node:http";
import { createApp } from "../src/app.js";
import { TurnManager } from "../src/agent/turn-manager.js";
import { InMemoryTurnLogStore } from "../src/agent/turn-log-store.js";
import { ApprovalRegistry } from "../src/agent/approval-registry.js";
import { MockProvider } from "../src/providers/mock.js";
import { createProviderFromProfile } from "../src/providers/index.js";
import { ProviderStore } from "../src/provider-profiles.js";
import { ActiveProviderBox, ProviderService } from "../src/provider-service.js";
import { removeTempPath } from "../../../scripts/temp-path.mjs";
import {
  DISCOVERY_TIMEOUT_MS,
  DISCOVERY_UNAVAILABLE_MESSAGE,
  MAX_DISCOVERED_MODELS,
  MAX_DISCOVERY_BODY_BYTES,
  discoverModels,
  DiscoveryError,
  normalizeDiscoveredModels,
  redactKey,
} from "../src/provider-discovery.js";

const KEY = "sk-discovery-secret-9876";

/** A fetchImpl that must never be called (mock/anthropic/validation paths). */
const fetchMustNotRun = (): never => {
  throw new Error("fetch must not be called for this kind");
};

function discoveryError(err: unknown): DiscoveryError {
  assert.ok(err instanceof DiscoveryError, `expected DiscoveryError, got ${String(err)}`);
  return err as DiscoveryError;
}

async function expectDiscoveryError(promise: Promise<unknown>, code: string, status: number, label = ""): Promise<DiscoveryError> {
  try {
    await promise;
  } catch (err) {
    const e = discoveryError(err);
    assert.equal(e.code, code, label);
    assert.equal(e.status, status, label);
    return e;
  }
  throw new Error(`expected ${code}, but discoverModels resolved ${label}`);
}

/** A minimal local upstream that records what the probe actually sent. */
interface FakeUpstream {
  url: string;
  requests: Array<{ method: string; path: string; authorization?: string; accept?: string }>;
  close(): Promise<void>;
}

function startUpstream(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<FakeUpstream> {
  const requests: FakeUpstream["requests"] = [];
  const server: Server = createServer((req, res) => {
    requests.push({
      method: req.method ?? "",
      path: req.url ?? "",
      authorization: typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
      accept: typeof req.headers.accept === "string" ? req.headers.accept : undefined,
    });
    handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe("normalizeDiscoveredModels (pure)", () => {
  it("deduplicates, trims, and sorts {data:[{id}]} deterministically", () => {
    assert.deepEqual(normalizeDiscoveredModels({ data: [{ id: "b" }, { id: "a" }, { id: "a" }, { id: "  c  " }] }), ["a", "b", "c"]);
  });

  it("accepts a bare array and a plain {models:[...]} list", () => {
    assert.deepEqual(normalizeDiscoveredModels(["z", "y", "y"]), ["y", "z"]);
    assert.deepEqual(normalizeDiscoveredModels({ models: ["m2", "m1"] }), ["m1", "m2"]);
    assert.deepEqual(normalizeDiscoveredModels({ data: ["s-b", "s-a"] }), ["s-a", "s-b"]);
  });

  it("drops non-conforming items instead of guessing", () => {
    assert.deepEqual(
      normalizeDiscoveredModels({
        data: [{ id: "keep" }, { nope: true }, { id: 42 }, { id: "" }, { id: " ".repeat(5) }, { id: "x".repeat(257) }, null, 7, "  ", "trimmed  ".trim() ? " keep-too " : ""],
      }),
      ["keep", "keep-too"]
    );
  });

  it("sorts with plain UTF-16 < (locale-independent)", () => {
    // Locale-sensitive names ("ä") must sort by code unit, not collation.
    const models = normalizeDiscoveredModels({ data: [{ id: "z" }, { id: "ä" }, { id: "Z" }] });
    assert.deepEqual(models, ["Z", "z", "ä"]);
  });

  it("caps the list at MAX_DISCOVERED_MODELS after dedupe + sort", () => {
    const many = Array.from({ length: 600 }, (_, i) => `m${String(i).padStart(4, "0")}`);
    const models = normalizeDiscoveredModels({ data: many.map((id) => ({ id })) });
    assert.equal(models.length, MAX_DISCOVERED_MODELS);
    assert.equal(models[0], "m0000");
    assert.equal(models[MAX_DISCOVERED_MODELS - 1], "m0499");
  });

  it("rejects unrecognized SHAPES with DISCOVERY_BAD_RESPONSE", () => {
    for (const payload of [null, 42, "x", {}, { data: {} }, { data: "x" }, { models: "x" }, { items: [1] }]) {
      const err = discoveryError((() => {
        try {
          normalizeDiscoveredModels(payload);
        } catch (e) {
          return e;
        }
        throw new Error("expected throw");
      })());
      assert.equal(err.code, "DISCOVERY_BAD_RESPONSE");
      assert.equal(err.status, 502);
    }
  });

  it("an empty listing is a valid, empty result", () => {
    assert.deepEqual(normalizeDiscoveredModels({ data: [] }), []);
  });
});

describe("discoverModels — request validation (no I/O)", () => {
  it("rejects non-object bodies", async () => {
    for (const input of [null, 42, "x", [], true]) {
      await expectDiscoveryError(discoverModels(input, { fetchImpl: fetchMustNotRun }), "DISCOVERY_INVALID_REQUEST", 400);
    }
  });

  it("rejects an unknown or missing kind", async () => {
    for (const kind of [undefined, "openai", "", 7, null]) {
      await expectDiscoveryError(
        discoverModels({ kind }, { fetchImpl: fetchMustNotRun }),
        "DISCOVERY_INVALID_REQUEST",
        400
      );
    }
  });

  it("rejects invalid base URLs before any request", async () => {
    for (const baseUrl of [undefined, "", "   ", "notaurl", "ftp://host/v1", "http://", "https://user:pass@host/v1", `https://host/${"x".repeat(2100)}`, "https://ho\u00A0st/v1"]) {
      await expectDiscoveryError(
        discoverModels({ kind: "openai-compatible", baseUrl, apiKey: KEY }, { fetchImpl: fetchMustNotRun }),
        "DISCOVERY_INVALID_REQUEST",
        400,
        `baseUrl=${String(baseUrl?.slice(0, 20))}`
      );
    }
  });

  it("rejects a malformed apiKey", async () => {
    for (const apiKey of [7, true, "k".repeat(513), "has space", "tab\tkey", "cli\nkey", "uni\u2022key"]) {
      await expectDiscoveryError(
        discoverModels({ kind: "openai-compatible", baseUrl: "https://host.example/v1", apiKey }, { fetchImpl: fetchMustNotRun }),
        "DISCOVERY_INVALID_REQUEST",
        400
      );
    }
  });

  it("mock answers {models:[mock]} offline and anthropic answers the documented 501", async () => {
    const opts = { fetchImpl: fetchMustNotRun };
    assert.deepEqual(await discoverModels({ kind: "mock" }, opts), { models: ["mock"] });
    assert.deepEqual(await discoverModels({ kind: "mock", baseUrl: "garbage", apiKey: KEY }, opts), { models: ["mock"] });
    const err = await expectDiscoveryError(discoverModels({ kind: "anthropic", baseUrl: "https://host.example/v1", apiKey: KEY }, opts), "DISCOVERY_UNAVAILABLE", 501);
    assert.equal(err.message, DISCOVERY_UNAVAILABLE_MESSAGE);
    assert.equal(DISCOVERY_UNAVAILABLE_MESSAGE, "model discovery unavailable for this provider");
  });

  it("an empty apiKey means no key (local endpoints), not a validation error", async () => {
    let seen: { authorization?: string } = {};
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "local-model" }] }));
    });
    try {
      const result = await discoverModels({ kind: "openai-compatible", baseUrl: upstream.url, apiKey: "" });
      assert.deepEqual(result, { models: ["local-model"] });
      assert.equal(upstream.requests[0].authorization, undefined);
      seen = upstream.requests[0];
      assert.ok(seen);
    } finally {
      await upstream.close();
    }
  });
});

describe("discoverModels — openai-compatible probe (injected fetch)", () => {
  it("sends exactly one GET {base}/models with Bearer auth, accept json, and redirect:'error'", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ data: [{ id: "a" }] }), { status: 200 });
    }) as typeof fetch;
    const models = await discoverModels({ kind: "openai-compatible", baseUrl: "https://prov.example/v1/", apiKey: KEY }, { fetchImpl });
    assert.deepEqual(models, { models: ["a"] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://prov.example/v1/models");
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].init.redirect, "error");
    assert.equal((calls[0].init.headers as any).accept, "application/json");
    assert.equal((calls[0].init.headers as any).authorization, `Bearer ${KEY}`);
  });

  it("maps a non-2xx upstream to DISCOVERY_UPSTREAM carrying only the status — never the body or the key", async () => {
    const body = JSON.stringify({ error: { message: `bad key ${KEY} on engine x` } });
    const fetchImpl = (async () => new Response(body, { status: 401 })) as typeof fetch;
    const err = await expectDiscoveryError(
      discoverModels({ kind: "openai-compatible", baseUrl: "https://prov.example/v1", apiKey: KEY }, { fetchImpl }),
      "DISCOVERY_UPSTREAM",
      502
    );
    assert.ok(/HTTP 401/.test(err.message));
    assert.ok(!err.message.includes(KEY), "key leaked into error message");
    assert.ok(!err.message.includes("engine"), "upstream body leaked into error message");
  });

  it("refuses redirects (both undici error shapes) with DISCOVERY_BAD_RESPONSE", async () => {
    // Shape 1: the redirect reason in the outer TypeError message.
    const outer = (async () => {
      throw new TypeError("uri requested responds with a redirect, redirect mode is set to 'error'");
    }) as typeof fetch;
    await expectDiscoveryError(
      discoverModels({ kind: "openai-compatible", baseUrl: "https://prov.example/v1" }, { fetchImpl: outer }),
      "DISCOVERY_BAD_RESPONSE",
      502
    );
    // Shape 2 (Node 22 undici): "fetch failed" with cause "unexpected redirect".
    const caused = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: new Error("unexpected redirect") });
    }) as typeof fetch;
    await expectDiscoveryError(
      discoverModels({ kind: "openai-compatible", baseUrl: "https://prov.example/v1" }, { fetchImpl: caused }),
      "DISCOVERY_BAD_RESPONSE",
      502
    );
  });

  it("maps network failures to DISCOVERY_UPSTREAM with the OS error code only", async () => {
    const fetchImpl = (async () => {
      const err = new TypeError("fetch failed");
      (err as TypeError & { cause?: unknown }).cause = Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" });
      throw err;
    }) as typeof fetch;
    const err = await expectDiscoveryError(
      discoverModels({ kind: "openai-compatible", baseUrl: "https://prov.example/v1" }, { fetchImpl }),
      "DISCOVERY_UPSTREAM",
      502
    );
    assert.ok(err.message.includes("ECONNREFUSED"));
  });

  it("rejects a non-JSON 200 body with DISCOVERY_BAD_RESPONSE", async () => {
    const fetchImpl = (async () => new Response("<html>hello</html>", { status: 200 })) as typeof fetch;
    await expectDiscoveryError(
      discoverModels({ kind: "openai-compatible", baseUrl: "https://prov.example/v1" }, { fetchImpl }),
      "DISCOVERY_BAD_RESPONSE",
      502
    );
  });

  it("aborts an upstream that ignores the deadline and reports DISCOVERY_TIMEOUT", async () => {
    const fetchImpl = (async (_url: any, init: any) =>
      new Promise<never>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    const err = await expectDiscoveryError(
      discoverModels({ kind: "openai-compatible", baseUrl: "https://prov.example/v1" }, { fetchImpl, timeoutMs: 25 }),
      "DISCOVERY_TIMEOUT",
      504
    );
    assert.ok(err.message.includes("25ms"));
  });

  it("the default probe timeout is 5 seconds", () => {
    assert.equal(DISCOVERY_TIMEOUT_MS, 5_000);
  });
});

describe("discoverModels — probe against a real local upstream", () => {
  it("normalizes a real listing and the upstream sees the Bearer key once", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "zeta" }, { id: "alpha" }, { id: "zeta" }, "mid"] }));
    });
    try {
      const result = await discoverModels({ kind: "openai-compatible", baseUrl: `${upstream.url}/`, apiKey: KEY });
      assert.deepEqual(result, { models: ["alpha", "mid", "zeta"] });
      assert.equal(upstream.requests.length, 1);
      assert.equal(upstream.requests[0].method, "GET");
      assert.equal(upstream.requests[0].path, "/v1/models");
      assert.equal(upstream.requests[0].authorization, `Bearer ${KEY}`);
      assert.equal(upstream.requests[0].accept, "application/json");
    } finally {
      await upstream.close();
    }
  });

  it("a hostile upstream that echoes the Authorization header cannot leak the key", async () => {
    const upstream = await startUpstream((req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `invalid credential ${req.headers.authorization ?? ""}` } }));
    });
    try {
      const err = await expectDiscoveryError(
        discoverModels({ kind: "openai-compatible", baseUrl: upstream.url, apiKey: KEY }),
        "DISCOVERY_UPSTREAM",
        502
      );
      assert.ok(!err.message.includes(KEY), "key leaked from echo upstream");
      assert.ok(!err.message.includes("Bearer"));
    } finally {
      await upstream.close();
    }
  });

  it("a real 302 redirect is refused, not followed", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(302, { location: "https://elsewhere.example/v1/models" });
      res.end();
    });
    try {
      const err = await expectDiscoveryError(
        discoverModels({ kind: "openai-compatible", baseUrl: upstream.url, apiKey: KEY }),
        "DISCOVERY_BAD_RESPONSE",
        502
      );
      assert.ok(/redirect/i.test(err.message));
    } finally {
      await upstream.close();
    }
  });

  it("a body larger than the cap fails without buffering it all", async () => {
    const big = `{"data":[{"id":"a"},{"id":"${"x".repeat(MAX_DISCOVERY_BODY_BYTES)}"}]}`;
    const upstream = await startUpstream((_req, res) => {
      // Chunked write with no content-length: the cap must fire mid-stream.
      res.writeHead(200, { "content-type": "application/json" });
      const half = Math.floor(big.length / 2);
      res.write(big.slice(0, half));
      const timer = setTimeout(() => {
        res.end(big.slice(half));
      }, 10);
      res.on("close", () => clearTimeout(timer));
    });
    try {
      await expectDiscoveryError(
        discoverModels({ kind: "openai-compatible", baseUrl: upstream.url, apiKey: KEY }),
        "DISCOVERY_BAD_RESPONSE",
        502
      );
    } finally {
      await upstream.close();
    }
  });

  it("a lying content-length over the cap fails before reading the body", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": String(MAX_DISCOVERY_BODY_BYTES + 1) });
      res.end('{"data":[{"id":"a"}]}');
    });
    try {
      await expectDiscoveryError(
        discoverModels({ kind: "openai-compatible", baseUrl: upstream.url, apiKey: KEY }),
        "DISCOVERY_BAD_RESPONSE",
        502
      );
    } finally {
      await upstream.close();
    }
  });

  it("an upstream that never answers hits the (shortened) timeout", async () => {
    const upstream = await startUpstream(() => {
      /* never respond */
    });
    try {
      await expectDiscoveryError(
        discoverModels({ kind: "openai-compatible", baseUrl: upstream.url, apiKey: KEY }, { timeoutMs: 50 }),
        "DISCOVERY_TIMEOUT",
        504
      );
    } finally {
      await upstream.close();
    }
  });

  it("an empty listing resolves to { models: [] } with HTTP-equivalent success", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    });
    try {
      assert.deepEqual(await discoverModels({ kind: "openai-compatible", baseUrl: upstream.url, apiKey: KEY }), { models: [] });
    } finally {
      await upstream.close();
    }
  });

  it("a garbage 200 body is DISCOVERY_BAD_RESPONSE", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("not json at all");
    });
    try {
      await expectDiscoveryError(discoverModels({ kind: "openai-compatible", baseUrl: upstream.url }), "DISCOVERY_BAD_RESPONSE", 502);
    } finally {
      await upstream.close();
    }
  });
});

describe("redactKey (route-level second layer)", () => {
  it("scrubs the key from any text as defense in depth", () => {
    assert.equal(redactKey(`boom ${KEY} done`, KEY), "boom **** done");
    assert.equal(redactKey("no key here", KEY), "no key here");
    assert.equal(redactKey("text", undefined), "text");
    // Guard: very short keys (< 4 chars) are not scrubbed — they would mangle text.
    assert.equal(redactKey("abc in text", "abc"), "abc in text");
  });
});

describe("POST /api/providers/discover-models (route)", () => {
  let base: string;
  let server: ReturnType<typeof createServer>;
  let dataDir: string;
  let store: ProviderStore;
  let app: any;

  before(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wr-discovery-"));
    store = new ProviderStore({ dataDir });
    await store.load();
    const box = new ActiveProviderBox(new MockProvider());
    const service = new ProviderService({ store, active: box, build: (p) => createProviderFromProfile(p, { maxRetries: 0 }) });
    const manager = new TurnManager({ store: new InMemoryTurnLogStore() });
    app = createApp({
      manager,
      provider: box.get(),
      activeProvider: box,
      providerAdmin: service,
      tools: new Map(),
      approvals: new ApprovalRegistry(),
      security: { mode: "token", token: "discovery-route-token-0123456789" },
    });
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempPath(dataDir);
  });

  const req = async (body: unknown, token: string | "none" = "discovery-route-token-0123456789") => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token !== "none") headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${base}/api/providers/discover-models`, { method: "POST", headers, body: JSON.stringify(body) });
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {}
    return { status: res.status, json, text };
  };

  it("401 without and with a wrong bearer token — same middleware as every provider route", async () => {
    const missing = await req({ kind: "mock" }, "none");
    assert.equal(missing.status, 401);
    assert.equal(missing.json.code, "AUTH_REQUIRED");
    const wrong = await req({ kind: "mock" }, "wrong-token-0123456789");
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.code, "AUTH_INVALID");
  });

  it("400 DISCOVERY_INVALID_REQUEST for a bad kind / base URL, before any upstream I/O", async () => {
    for (const body of [{ kind: "openai" }, { kind: "openai-compatible" }, { kind: "openai-compatible", baseUrl: "not a url" }]) {
      const { status, json } = await req(body);
      assert.equal(status, 400, JSON.stringify(body));
      assert.equal(json.code, "DISCOVERY_INVALID_REQUEST");
    }
  });

  it("200 mock without any upstream; 501 anthropic with the exact documented message", async () => {
    const mock = await req({ kind: "mock" });
    assert.equal(mock.status, 200);
    assert.deepEqual(mock.json, { models: ["mock"] });
    const anthropic = await req({ kind: "anthropic", baseUrl: "https://prov.example/v1", apiKey: KEY });
    assert.equal(anthropic.status, 501);
    assert.equal(anthropic.json.code, "DISCOVERY_UNAVAILABLE");
    assert.equal(anthropic.json.error, "model discovery unavailable for this provider");
  });

  it("200 with a normalized, sorted list — and the key appears nowhere in the response or the store", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "zeta" }, { id: "alpha" }, { id: "zeta" }] }));
    });
    try {
      const { status, json, text } = await req({ kind: "openai-compatible", baseUrl: upstream.url, apiKey: KEY });
      assert.equal(status, 200);
      assert.deepEqual(json, { models: ["alpha", "zeta"] });
      assert.equal(upstream.requests.length, 1, "exactly one upstream probe");
      assert.equal(upstream.requests[0].authorization, `Bearer ${KEY}`);
      assert.ok(!text.includes(KEY), "raw key leaked into the discovery response");
      // Discovery persisted nothing: no profiles were written, the active
      // provider is untouched, and the profiles file (if any) holds no key.
      assert.equal(store.data.profiles.length, 0);
      assert.equal(store.data.activeProfileId, null);
      if (store.fileExisted) {
        const stored = await fs.readFile(store.file, "utf8");
        assert.ok(!stored.includes(KEY), "raw key leaked into the provider-profiles store");
      }
      const list = await fetch(`${base}/api/providers`, { headers: { authorization: "Bearer discovery-route-token-0123456789" } });
      assert.ok(!(await list.text()).includes(KEY));
    } finally {
      await upstream.close();
    }
  });

  it("a hostile echoing upstream becomes a 502 whose body never contains the key", async () => {
    const upstream = await startUpstream((inbound, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `credential ${inbound.headers.authorization ?? ""} rejected` } }));
    });
    try {
      const { status, text } = await req({ kind: "openai-compatible", baseUrl: upstream.url, apiKey: KEY });
      assert.equal(status, 502);
      assert.equal(JSON.parse(text).code, "DISCOVERY_UPSTREAM");
      assert.ok(!text.includes(KEY), "key leaked through the echo upstream into the route response");
    } finally {
      await upstream.close();
    }
  });

  it("502 DISCOVERY_BAD_RESPONSE on a redirect and on an oversized body", async () => {
    const redirector = await startUpstream((_req, res) => {
      res.writeHead(302, { location: "https://elsewhere.example/v1/models" });
      res.end();
    });
    try {
      const red = await req({ kind: "openai-compatible", baseUrl: redirector.url, apiKey: KEY });
      assert.equal(red.status, 502);
      assert.equal(red.json.code, "DISCOVERY_BAD_RESPONSE");
    } finally {
      await redirector.close();
    }
    const huge = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`{"data":[{"id":"${"x".repeat(MAX_DISCOVERY_BODY_BYTES + 16)}"}]}`);
    });
    try {
      const big = await req({ kind: "openai-compatible", baseUrl: huge.url, apiKey: KEY });
      assert.equal(big.status, 502);
      assert.equal(big.json.code, "DISCOVERY_BAD_RESPONSE");
    } finally {
      await huge.close();
    }
  });

  it("502 DISCOVERY_UPSTREAM for an unreachable provider, with an actionable secret-free message", async () => {
    const { status, json } = await req({ kind: "openai-compatible", baseUrl: "http://127.0.0.1:9/v1", apiKey: KEY });
    assert.equal(status, 502);
    assert.equal(json.code, "DISCOVERY_UPSTREAM");
    assert.ok(!JSON.stringify(json).includes(KEY));
  });

  it("a non-object JSON body is rejected by the shared body validation", async () => {
    const headers = { "content-type": "application/json", authorization: "Bearer discovery-route-token-0123456789" };
    const res = await fetch(`${base}/api/providers/discover-models`, { method: "POST", headers, body: JSON.stringify([1, 2]) });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(await res.text()).code, "BODY_INVALID");
  });
});
