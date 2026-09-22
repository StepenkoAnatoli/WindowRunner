import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApiClient, ApiConfigError, ApiRequestError, invalidHeaderCharacter, readSse, loadToken, saveToken, clearToken, getApiClientBootstrap, publishApiClientBootstrap } from "../src/api.js";

function sseBody(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
}

function event(seq: number, type: string, extra: Record<string, unknown> = {}) {
  return { seq, at: seq, sessionId: "s", turnId: "t", type, ...extra };
}

function sseText(events: any[]): string {
  return events.map((e) => `id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

describe("readSse", () => {
  it("parses frames split across arbitrary chunk boundaries and CRLF separators", async () => {
    const text = sseText([event(1, "turn_started"), event(2, "text_delta", { delta: "hi" })]).replace(/\n/g, "\r\n") + "id: 3\r\ndata: " + JSON.stringify(event(3, "turn_completed")) + "\r\n\r\n";
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += 7) chunks.push(text.slice(i, i + 7));
    const seen: number[] = [];
    const outcome = await readSse(sseBody(chunks), (e) => {
      seen.push(e.seq);
      return e.type === "turn_completed";
    });
    assert.equal(outcome, "terminal");
    assert.deepEqual(seen, [1, 2, 3]);
  });

  it("ignores comments, blank frames and malformed JSON; reports 'ended' when the stream closes early", async () => {
    const seen: number[] = [];
    const outcome = await readSse(sseBody([": keepalive\n\n", "data: {not json}\n\n", sseText([event(1, "turn_started")])]), (e) => {
      seen.push(e.seq);
      return false;
    });
    assert.equal(outcome, "ended");
    assert.deepEqual(seen, [1]);
  });
});

describe("host bootstrap token flow (desktop shell)", () => {
  function fakeWindow(fragment = "#token=from-fragment") {
    const storage = new Map<string, string>();
    const win = {
      location: { hash: fragment, pathname: "/", search: "" },
      history: { replaceState() {} },
      sessionStorage: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => void storage.set(k, v),
        removeItem: (k: string) => void storage.delete(k),
      },
    };
    return { win, storage };
  }

  it("prefers the in-memory bootstrap and never touches the URL or storage", () => {
    const { win, storage } = fakeWindow();
    (globalThis as Record<string, unknown>).window = win;
    (globalThis as Record<string, unknown>).__WINDOWS_RUNNER_BOOTSTRAP__ = {
      baseUrl: "http://127.0.0.1:9",
      token: "bootstrap-token-1234567890",
    };
    try {
      assert.deepEqual(getApiClientBootstrap(), { baseUrl: "http://127.0.0.1:9", token: "bootstrap-token-1234567890" });
      assert.equal(loadToken(), "bootstrap-token-1234567890");
      assert.equal(win.location.hash, "#token=from-fragment"); // never consumed/rewritten
      assert.equal(storage.size, 0, "bootstrap mode must not write sessionStorage");
      saveToken("other-token");
      clearToken();
      assert.equal(storage.size, 0);
    } finally {
      delete (globalThis as Record<string, unknown>).window;
      delete (globalThis as Record<string, unknown>).__WINDOWS_RUNNER_BOOTSTRAP__;
    }
  });

  it("publishApiClientBootstrap keeps the token in memory and out of the URL and storage", () => {
    const { win, storage } = fakeWindow("#token=from-fragment");
    (globalThis as Record<string, unknown>).window = win;
    try {
      publishApiClientBootstrap({ baseUrl: "http://127.0.0.1:9", token: "published-token-123456" });
      assert.equal(loadToken(), "published-token-123456");
      saveToken("other-token");
      clearToken();
      assert.equal(storage.size, 0);
      assert.equal(win.location.hash, "#token=from-fragment");
    } finally {
      delete (globalThis as Record<string, unknown>).window;
      delete (globalThis as Record<string, unknown>).__WINDOWS_RUNNER_BOOTSTRAP__;
    }
  });

  it("falls back to the fragment/sessionStorage flow without a bootstrap", () => {
    const { win, storage } = fakeWindow("#token=fragment-token-123");
    (globalThis as Record<string, unknown>).window = win;
    try {
      assert.equal(getApiClientBootstrap(), undefined);
      assert.equal(loadToken(), "fragment-token-123");
      assert.equal(storage.get("windows-runner.token"), "fragment-token-123");
    } finally {
      delete (globalThis as Record<string, unknown>).window;
    }
  });
});

describe("ApiClient", () => {
  it("sends the bearer token on every request and maps error bodies to ApiRequestError", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/api/health")) return new Response(JSON.stringify({ status: "ok", security: { mode: "token" } }), { status: 200 });
      return new Response(JSON.stringify({ error: "bearer token is not valid", code: "AUTH_INVALID" }), { status: 401 });
    };
    const client = new ApiClient({ baseUrl: "http://x", token: "tok-123", fetch: fetchImpl });
    const health = await client.health();
    assert.equal(health.security?.mode, "token");
    await assert.rejects(client.startTurn("s 1", "m"), (err: unknown) => err instanceof ApiRequestError && err.status === 401 && err.code === "AUTH_INVALID" && err.isAuth);
    for (const c of calls) assert.equal((c.init.headers as any).authorization, "Bearer tok-123");
    assert.equal(calls[1].url, "http://x/api/sessions/s%201/turns", "ids are URL-encoded");
    assert.equal(JSON.parse(calls[1].init.body as string).message, "m");
  });

  it("refuses a token holding characters a header cannot carry, without calling fetch", async () => {
    // `Bearer ` is 7 chars, so the 5th character of a value lands at header
    // index 11 — the offset in the original report.
    const token = `abcd\u2022`;
    assert.equal(invalidHeaderCharacter(`Bearer ${token}`), "U+2022");
    assert.equal(`Bearer ${token}`.indexOf("\u2022"), 11);
    let called = 0;
    const fetchImpl: typeof fetch = async () => {
      called++;
      return new Response("{}", { status: 200 });
    };
    const client = new ApiClient({ token, fetch: fetchImpl });
    await assert.rejects(client.health(), (err: unknown) => err instanceof ApiConfigError && err.message.includes("U+2022") && err.message.includes("retype"));
    // The SSE path builds its own headers object and would otherwise retry the
    // bad header six times before quietly reporting `gave_up`.
    const reported: unknown[] = [];
    await assert.rejects(
      client.streamTurn("s", "t", { onEvent: () => {}, onError: (e) => reported.push(e) }),
      (err: unknown) => err instanceof ApiConfigError && err.message.includes("U+2022")
    );
    assert.equal(reported.length, 1, "must fail on the first attempt, not after the retry budget");
    assert.equal(called, 0);
  });

  it("carries a top-level `errors` validation list through to details, where the dashboard reads it", async () => {
    const client = new ApiClient({
      token: "tok",
      fetch: (async () => new Response(JSON.stringify({ error: "profile is invalid", code: "PROFILE_INVALID", errors: ["apiKey contains \u2022 (U+2022) at index 3"] }), { status: 400 })) as any,
    });
    await assert.rejects(client.createProfile({}), (err: unknown) => {
      const e = err as ApiRequestError;
      return e instanceof ApiRequestError && Array.isArray((e.details as any).errors) && (e.details as any).errors[0].includes("U+2022");
    });
  });

  it("accepts any printable-ASCII token, including one with interior spaces", async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (_u: any, init: any) => {
      seen.push((init.headers as any).authorization);
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    };
    const client = new ApiClient({ token: "tok 123!~", fetch: fetchImpl });
    await client.health();
    assert.deepEqual(seen, ["Bearer tok 123!~"]);
  });

  it("streamTurn reconnects with Last-Event-ID after a transport drop and never delivers a seq twice", async () => {
    const all = [event(1, "turn_started"), event(2, "text_delta", { delta: "a" }), event(3, "text_delta", { delta: "b" }), event(4, "turn_completed")];
    const requests: Array<Record<string, string>> = [];
    let n = 0;
    const fetchImpl: typeof fetch = async (_url: any, init: any) => {
      requests.push(init.headers);
      n++;
      if (n === 1) return new Response(sseBody([sseText(all.slice(0, 2))]), { status: 200, headers: { "content-type": "text/event-stream" } }); // drops after seq 2
      if (n === 2) throw new TypeError("network down"); // transport error
      // Server replays after the cursor; include a duplicate to prove de-duplication.
      return new Response(sseBody([sseText(all.slice(1))]), { status: 200 });
    };
    const client = new ApiClient({ token: "t", fetch: fetchImpl });
    const seen: number[] = [];
    const reconnects: number[] = [];
    const result = await client.streamTurn("s", "t", { onEvent: (e) => seen.push(e.seq), onReconnect: (a) => reconnects.push(a) }, { reconnectBaseMs: 1 });
    assert.deepEqual(seen, [1, 2, 3, 4]);
    assert.equal(result.terminal, true);
    assert.equal(result.seq, 4);
    assert.deepEqual(reconnects, [1, 2]);
    assert.equal(requests[0]["last-event-id"], undefined);
    assert.equal(requests[1]["last-event-id"], "2");
    assert.equal(requests[2]["last-event-id"], "2");
    for (const h of requests) assert.equal(h.authorization, "Bearer t");
  });

  it("streamTurn surfaces a 401 immediately instead of retrying, and honours abort", async () => {
    let n = 0;
    const client401 = new ApiClient({ token: "t", fetch: (async () => { n++; return new Response(JSON.stringify({ code: "AUTH_REQUIRED", error: "x" }), { status: 401 }); }) as any });
    await assert.rejects(client401.streamTurn("s", "t", { onEvent: () => {} }, { reconnectBaseMs: 1 }), (e: unknown) => e instanceof ApiRequestError && e.status === 401);
    assert.equal(n, 1);

    const ac = new AbortController();
    const hanging = new ApiClient({ token: "t", fetch: (async (_u: any, init: any) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as any });
    const p = hanging.streamTurn("s", "t", { onEvent: () => {} }, { signal: ac.signal });
    ac.abort();
    assert.deepEqual(await p, { seq: 0, terminal: false, reason: "aborted" });
  });

  it("streamTurn gives up after maxAttempts consecutive failures", async () => {
    const client = new ApiClient({ token: "t", fetch: (async () => { throw new TypeError("down"); }) as any });
    const result = await client.streamTurn("s", "t", { onEvent: () => {} }, { reconnectBaseMs: 1, maxAttempts: 2, afterSeq: 5 });
    assert.deepEqual(result, { seq: 5, terminal: false, reason: "gave_up" });
  });
});
