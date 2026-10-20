// Newline-delimited JSON: one event per line. Used to stream script output and
// chat events from the local API routes to the page.

const encoder = new TextEncoder();

/** Server side: a streaming Response whose body is written by `run` through `send`. */
export function ndjsonResponse<T>(run: (send: (event: T) => void, signal: AbortSignal) => Promise<void>, signal: AbortSignal): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: T) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // The client went away; the run notices through `signal`.
        }
      };
      try {
        await run(send, signal);
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** Client side: calls `onEvent` for every line of an NDJSON response body. */
export async function readNdjson<T>(response: Response, onEvent: (event: T) => void): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onEvent(JSON.parse(line) as T);
    }
  }
  const rest = buffer.trim();
  if (rest) onEvent(JSON.parse(rest) as T);
}
