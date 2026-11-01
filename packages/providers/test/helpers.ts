// SPDX-License-Identifier: Apache-2.0
import type { ModelEvent } from "@opa/core";

/** Replays a fixture as a byte stream cut into small chunks, so lines split across reads. */
export function byteStream(text: string, chunkSize = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

/** One line per event; usage reads `input/output/cached/reasoning`. */
export function brief(e: ModelEvent): string {
  if (e.type === "usage") {
    const u = e.usage;
    return `usage ${u.inputTokens}/${u.outputTokens}/${u.cachedInputTokens}/${u.reasoningTokens}`;
  }
  if (e.type === "done") return `done ${e.finishReason}`;
  if (e.type === "error") return `error ${e.code}: ${e.message}`;
  return `${e.type} ${e.text}`;
}

export async function replay(events: AsyncIterable<ModelEvent>): Promise<string[]> {
  const out: string[] = [];
  for await (const event of events) out.push(brief(event));
  return out;
}
