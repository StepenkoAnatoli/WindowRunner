/**
 * A scriptable OpenAI-shaped `/chat/completions` server for adapter and loop
 * tests. Each request pops the next script entry; the entry decides the HTTP
 * status, the streamed chunks, and whether the stream is cut short.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

export type FakeOpenAIScript =
  | { kind: "text"; text: string; usage?: boolean; noDone?: boolean; noFinish?: boolean; delayMs?: number }
  | { kind: "tool_calls"; calls: Array<{ id?: string; name: string; args: string }>; text?: string; splitArgs?: number }
  | { kind: "http_error"; status: number; body?: unknown; headers?: Record<string, string> }
  | { kind: "cut"; afterChunks: number; text: string }
  | { kind: "error_event"; error: { message: string; code?: string; type?: string } }
  | { kind: "garbage" }
  | { kind: "hang" };

export interface FakeOpenAIServer {
  url: string;
  requests: Array<{ headers: IncomingMessage["headers"]; body: any }>;
  close(): Promise<void>;
  /** Resolves when the server has observed a closed client connection during a hang. */
  hangAborted: Promise<void>;
}

export async function startFakeOpenAI(script: FakeOpenAIScript[]): Promise<FakeOpenAIServer> {
  const requests: FakeOpenAIServer["requests"] = [];
  let resolveHangAborted!: () => void;
  const hangAborted = new Promise<void>((r) => (resolveHangAborted = r));
  let i = 0;

  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    let body: any = raw;
    try {
      body = JSON.parse(raw);
    } catch {}
    requests.push({ headers: req.headers, body });
    if (req.url !== "/v1/chat/completions" || req.method !== "POST") {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    const step = script[i++];
    if (!step) {
      res.writeHead(500).end(JSON.stringify({ error: { message: "fake: script exhausted" } }));
      return;
    }
    await play(step, res, resolveHangAborted);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as any;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    hangAborted,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

const sse = (res: ServerResponse, obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) => ({
  id: "chatcmpl-fake",
  object: "chat.completion.chunk",
  created: 0,
  model: "fake-model",
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...extra,
});

async function play(step: FakeOpenAIScript, res: ServerResponse, onHangAborted: () => void): Promise<void> {
  if (step.kind === "http_error") {
    res.writeHead(step.status, { "content-type": "application/json", ...(step.headers ?? {}) });
    res.end(JSON.stringify(step.body ?? { error: { message: `fake ${step.status}`, type: "fake" } }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  switch (step.kind) {
    case "text": {
      sse(res, chunk({ role: "assistant", content: "" }));
      for (const word of step.text.match(/\S+\s*/g) ?? []) {
        if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
        sse(res, chunk({ content: word }));
      }
      if (!step.noFinish) sse(res, chunk({}, "stop"));
      if (step.usage) sse(res, { ...chunk({}, null), choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } });
      if (!step.noDone) res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    case "tool_calls": {
      sse(res, chunk({ role: "assistant", content: step.text ?? "" }));
      step.calls.forEach((c, index) => {
        sse(res, chunk({ tool_calls: [{ index, id: c.id ?? `call_${index}`, type: "function", function: { name: c.name, arguments: "" } }] }));
        const parts = step.splitArgs ? splitN(c.args, step.splitArgs) : [c.args];
        for (const p of parts) sse(res, chunk({ tool_calls: [{ index, function: { arguments: p } }] }));
      });
      sse(res, chunk({}, "tool_calls"));
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    case "cut": {
      let n = 0;
      for (const word of step.text.match(/\S+\s*/g) ?? []) {
        if (n++ >= step.afterChunks) break;
        sse(res, chunk({ content: word }));
      }
      // Let the headers and the chunks reach the client, then drop the socket:
      // no finish_reason, no [DONE].
      await new Promise((r) => setTimeout(r, 30));
      res.destroy();
      return;
    }
    case "error_event": {
      sse(res, chunk({ content: "partial " }));
      sse(res, { error: step.error });
      res.end();
      return;
    }
    case "garbage": {
      res.write("data: {this is not json\n\n");
      res.end();
      return;
    }
    case "hang": {
      sse(res, chunk({ content: "thinking… " }));
      res.on("close", () => onHangAborted());
      // never end
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
