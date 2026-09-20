/**
 * E2E fixture server for the web UI.
 *
 * Boots the real server (`startServer`) on a fixed port with a fixed token, in
 * memory mode, with a scripted provider that reacts to the user's message so
 * every UI path can be driven deterministically without an API key:
 *
 *   "approve: <cmd>"  -> calls `run_terminal` (requires approval), then replies
 *   "trust: <x>"      -> calls `mcp_call` (declares project trust), then replies
 *   "hang"            -> never yields (exercises Stop / cancellation)
 *   "fail"            -> provider throws (turn_failed MODEL_FAILED)
 *   "slow: <text>"    -> streams <text> word by word with a delay
 *   anything else     -> echoes the message in a few deltas
 *
 * Also exposes two real tools through the loop so approvals and trust are
 * exercised end to end.
 *
 * The browser talks to a small proxy on E2E_PORT in front of the real server
 * (E2E_PORT + 1). The proxy is transparent except for one control endpoint,
 * `POST /__e2e/cut-next-events`, which arms it to sever the next `/events`
 * response right after the first SSE event has been forwarded — the only
 * reliable way to exercise the client's Last-Event-ID resume from a browser. Playwright starts this via `webServer` in
 * playwright.config.ts; `npm run e2e` runs it. Specs must import constants from
 * ./fixture.ts, never from this file: importing this file boots the server.
 */
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { startServer } from "../../server/src/boot.js";
import type { LLMChunk, LLMProvider, LLMRequest } from "../../server/src/providers/types.js";
import type { ToolDefinition } from "../../server/src/agent/tools/types.js";

import { E2E_PORT, E2E_PROJECT, E2E_TOKEN, MCP_CONFIG_HASH } from "./fixture.js";

class ScriptedProvider implements LLMProvider {
  async *stream(request: LLMRequest, { signal }: { signal: AbortSignal }): AsyncIterable<LLMChunk> {
    const lastUser = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const lastTool = request.messages[request.messages.length - 1];
    if (lastTool?.role === "tool") {
      yield { type: "text_delta", text: `tool ${lastTool.toolName} said: ${lastTool.content}` };
      return;
    }
    if (lastUser === "hang") {
      await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true }));
      return;
    }
    if (lastUser === "fail") throw new Error("scripted provider failure");
    if (lastUser.startsWith("approve: ")) {
      yield { type: "tool_call", call: { id: `call_${Date.now()}`, name: "run_terminal", input: { command: lastUser.slice(9) } } };
      return;
    }
    if (lastUser.startsWith("trust: ")) {
      yield { type: "tool_call", call: { id: `call_${Date.now()}`, name: "mcp_call", input: { query: lastUser.slice(7) } } };
      return;
    }
    const text = lastUser.startsWith("slow: ") ? lastUser.slice(6) : `echo: ${lastUser}`;
    const delay = lastUser.startsWith("slow: ") ? 150 : 5;
    for (const word of text.match(/\S+\s*/g) ?? [text]) {
      if (signal.aborted) throw signal.reason ?? new Error("aborted");
      await new Promise((r) => setTimeout(r, delay));
      yield { type: "text_delta", text: word };
    }
    yield { type: "usage", usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 } };
  }
}

const tools = new Map<string, ToolDefinition>([
  [
    "run_terminal",
    {
      name: "run_terminal",
      description: "run a shell command (fixture: never actually runs anything)",
      requiresApproval: () => true,
      reason: (input: any) => `run "${input?.command}" in the project folder`,
      execute: async (input: any) => `pretended to run: ${input?.command}`,
    },
  ],
  [
    "mcp_call",
    {
      name: "mcp_call",
      description: "call a project-configured MCP server (fixture)",
      requiresApproval: () => false,
      trust: () => ({ configHash: MCP_CONFIG_HASH, source: ".mcp.json" }),
      execute: async (input: any) => `mcp answered: ${input?.query}`,
    },
  ],
]);

async function main() {
  const project = E2E_PROJECT;
  await fs.mkdir(path.join(project, "nested"), { recursive: true });
  const handle = await startServer(
    {
      host: "127.0.0.1",
      port: E2E_PORT + 1,
      allowRemote: false,
      provider: "mock",
      auth: { mode: "token", token: E2E_TOKEN, allowedHosts: [], allowedOrigins: [] },
      persistence: { mode: "memory", dataDir: path.join(os.tmpdir(), "unused"), durableBeforeNotify: false, fsync: false },
      allowedRoots: [project],
      shutdownGraceMs: 2000,
    },
    { provider: new ScriptedProvider(), tools, log: (l) => console.log("  " + l) }
  );
  if (!handle.webDir) {
    console.error("e2e server: web UI is not built (packages/web/dist/app missing) — run npm run build first");
    process.exit(1);
  }
  const proxy = startProxy(E2E_PORT, E2E_PORT + 1);
  console.log(`e2e proxy listening on http://127.0.0.1:${E2E_PORT} -> ${handle.url}`);
  const stop = () => { proxy.close(); handle.close().then(() => process.exit(0)); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

function startProxy(listenPort: number, upstreamPort: number): http.Server {
  let cutNextEvents = false;
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/__e2e/cut-next-events") {
      cutNextEvents = true;
      res.writeHead(204).end();
      return;
    }
    const cut = cutNextEvents && /\/events(\?|$)/.test(req.url ?? "");
    if (cut) cutNextEvents = false;
    const up = http.request(
      { host: "127.0.0.1", port: upstreamPort, method: req.method, path: req.url, headers: req.headers, setHost: false },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        if (!cut) {
          upRes.pipe(res);
          return;
        }
        let buffered = "";
        let done = false;
        upRes.on("data", (chunk: Buffer) => {
          if (done) return;
          // The server writes `id:` and `data:` lines as separate chunks; buffer
          // until one whole event is present, forward exactly that, then drop
          // the socket so the client has an id to resume from.
          buffered += chunk.toString("utf8");
          const end = buffered.indexOf("\n\n");
          if (end === -1) return;
          done = true;
          res.write(buffered.slice(0, end + 2));
          setTimeout(() => { res.destroy(); up.destroy(); }, 50);
        });
        upRes.on("end", () => res.end());
      }
    );
    up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
    res.on("close", () => up.destroy());
  });
  server.listen(listenPort, "127.0.0.1");
  return server;
}
