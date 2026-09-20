/**
 * A scriptable Anthropic-shaped `/messages` server for adapter tests. Mirrors
 * fake-openai-server.ts: each request pops the next script entry.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

export type FakeAnthropicScript =
  | { kind: "text"; text: string; noStop?: boolean }
  | { kind: "tool_use"; calls: Array<{ id?: string; name: string; json: string }>; text?: string; splitJson?: number }
  | { kind: "http_error"; status: number; body?: unknown; headers?: Record<string, string> }
  | { kind: "error_event"; error: { type: string; message: string } }
  | { kind: "cut"; afterChunks: number; text: string }
  | { kind: "garbage" };

export interface FakeAnthropicServer {
  url: string;
  requests: Array<{ headers: IncomingMessage["headers"]; body: any }>;
  close(): Promise<void>;
}

export async function startFakeAnthropic(script: FakeAnthropicScript[]): Promise<FakeAnthropicServer> {
  const requests: FakeAnthropicServer["requests"] = [];
  let i = 0;
  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    let body: any = raw;
    try {
      body = JSON.parse(raw);
    } catch {}
    requests.push({ headers: req.headers, body });
    if (req.url !== "/v1/messages" || req.method !== "POST") {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "not found" } }));
      return;
    }
    const step = script[i++];
    if (!step) {
      res.writeHead(500).end(JSON.stringify({ type: "error", error: { type: "api_error", message: "fake: script exhausted" } }));
      return;
    }
    await play(step, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as any;
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise((r) => server.close(() => r())) };
}

const ev = (res: ServerResponse, type: string, obj: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`);
const start = (res: ServerResponse) =>
  ev(res, "message_start", { message: { id: "msg_fake", type: "message", role: "assistant", model: "fake", content: [], usage: { input_tokens: 11, output_tokens: 1 } } });
const finish = (res: ServerResponse, reason: string, outputTokens = 7) => {
  ev(res, "message_delta", { delta: { stop_reason: reason }, usage: { output_tokens: outputTokens } });
  ev(res, "message_stop", {});
};

async function play(step: FakeAnthropicScript, res: ServerResponse): Promise<void> {
  if (step.kind === "http_error") {
    res.writeHead(step.status, { "content-type": "application/json", ...(step.headers ?? {}) });
    res.end(JSON.stringify(step.body ?? { type: "error", error: { type: "api_error", message: `fake ${step.status}` } }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  switch (step.kind) {
    case "text": {
      start(res);
      ev(res, "content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      ev(res, "ping", {});
      for (const word of step.text.match(/\S+\s*/g) ?? []) ev(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: word } });
      ev(res, "content_block_stop", { index: 0 });
      if (!step.noStop) finish(res, "end_turn");
      res.end();
      return;
    }
    case "tool_use": {
      start(res);
      let index = 0;
      if (step.text) {
        ev(res, "content_block_start", { index, content_block: { type: "text", text: "" } });
        ev(res, "content_block_delta", { index, delta: { type: "text_delta", text: step.text } });
        ev(res, "content_block_stop", { index });
        index++;
      }
      for (const c of step.calls) {
        ev(res, "content_block_start", { index, content_block: { type: "tool_use", id: c.id ?? `toolu_${index}`, name: c.name, input: {} } });
        const parts = step.splitJson ? splitN(c.json, step.splitJson) : [c.json];
        for (const p of parts) ev(res, "content_block_delta", { index, delta: { type: "input_json_delta", partial_json: p } });
        ev(res, "content_block_stop", { index });
        index++;
      }
      finish(res, "tool_use");
      res.end();
      return;
    }
    case "error_event": {
      start(res);
      ev(res, "content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      ev(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: "partial " } });
      ev(res, "error", { error: step.error });
      res.end();
      return;
    }
    case "cut": {
      start(res);
      ev(res, "content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      let n = 0;
      for (const word of step.text.match(/\S+\s*/g) ?? []) {
        if (n++ >= step.afterChunks) break;
        ev(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: word } });
      }
      await new Promise((r) => setTimeout(r, 30));
      res.destroy();
      return;
    }
    case "garbage": {
      res.write("event: message_start\ndata: {nope\n\n");
      res.end();
      return;
    }
  }
}

function splitN(s: string, n: number): string[] {
  const size = Math.max(1, Math.ceil(s.length / n));
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}
