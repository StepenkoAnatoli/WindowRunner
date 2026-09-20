/**
 * Minimal SSE reader shared by the model adapters. Yields one record per
 * event with the joined `data:` payload and the optional `event:` name.
 * Ignores comments and other fields; tolerates CRLF and multi-line data.
 * Cancels the body reader on exit (including abort/throw).
 */
export interface SseEvent {
  event?: string;
  data: string;
}

export async function* readSseEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error("aborted");
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, "");
        const parsed = parseEvent(rawEvent);
        if (parsed) yield parsed;
      }
    }
    const tail = parseEvent(buffer);
    if (tail) yield tail;
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }
}

/** Convenience for `data:`-only protocols (OpenAI). */
export async function* readSseData(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  for await (const { data } of readSseEvents(body, signal)) yield data;
}

function parseEvent(raw: string): SseEvent | undefined {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    else if (line.startsWith("event:")) event = line.slice(6).trim();
  }
  if (data.length === 0) return undefined;
  const joined = data.join("\n");
  if (joined.length === 0) return undefined;
  return event !== undefined ? { event, data: joined } : { data: joined };
}
