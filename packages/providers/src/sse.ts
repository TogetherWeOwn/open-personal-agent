// SPDX-License-Identifier: Apache-2.0

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
  let buffer = "";
  let data: string[] = [];
  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // A chunk can end between "\r" and "\n"; hold the "\r" back so it isn't read as a blank line.
      const carry = !done && buffer.endsWith("\r") ? "\r" : "";
      const lines = buffer.slice(0, buffer.length - carry.length).split(/\r\n|\r|\n/);
      // Keep the trailing partial line unless the stream has ended.
      buffer = done ? "" : (lines.pop() ?? "") + carry;
      for (const line of lines) {
        // Lines already read stay undelivered once the caller cancels.
        if (signal?.aborted) return;
        if (line === "") {
          if (data.length > 0) yield data.join("\n");
          data = [];
        } else if (line.startsWith("data:")) {
          data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
        }
      }
      // An event cut off before its blank line is never dispatched (SSE spec).
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
