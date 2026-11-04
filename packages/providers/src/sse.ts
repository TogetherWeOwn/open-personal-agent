// SPDX-License-Identifier: Apache-2.0

export interface SseEvent {
  data: string;
  event: string;
  heartbeat?: true;
}

/** Shared framing; only blank lines dispatch data events, never EOF. Comments signal heartbeats. */
export class SseParser {
  #buffer = "";
  #data: string[] = [];
  #event = "";
  #size = 0;
  constructor(private readonly maxSize = 1024 * 1024) {}

  push(text: string, done = false): SseEvent[] {
    this.#buffer += text;
    const carry = !done && this.#buffer.endsWith("\r") ? "\r" : "";
    const lines = this.#buffer.slice(0, this.#buffer.length - carry.length).split(/\r\n|\r|\n/);
    // Even at EOF the trailing partial line is not a line terminator.
    this.#buffer = (lines.pop() ?? "") + carry;
    const events: SseEvent[] = [];
    for (const line of lines) {
      this.#size += line.length;
      if (this.#size > this.maxSize) throw new Error("SSE event too large");
      if (line === "") {
        if (this.#data.length) events.push({ data: this.#data.join("\n"), event: this.#event });
        this.#data = [];
        this.#event = "";
        this.#size = 0;
      } else if (line.startsWith(":")) {
        // Comments keep the connection alive without exposing their provider diagnostics.
        events.push({ data: "", event: "", heartbeat: true });
      } else if (line.startsWith("data:")) {
        this.#data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
      } else if (line.startsWith("event:")) {
        this.#event = line.slice(line.startsWith("event: ") ? 7 : 6);
      }
    }
    if (this.#size + this.#buffer.length > this.maxSize) throw new Error("SSE event too large");
    return events;
  }
}

/**
 * Yields the `data` payload of each complete server-sent event in a byte stream. Comments,
 * `event` and `id` fields are ignored; multi-line data is joined with "\n".
 */
export async function* sseData(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  // A stalled stream never settles `read()`; cancelling the reader on abort ends it.
  const cancel = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
      for (const event of parser.push(text, done)) {
        if (signal?.aborted) return;
        if (!event.heartbeat) yield event.data;
      }
      if (done) return;
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
  }
}
