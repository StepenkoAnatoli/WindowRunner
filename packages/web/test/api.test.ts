import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApiClient, ApiRequestError, readSse } from "../src/api.js";

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
