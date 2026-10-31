// SPDX-License-Identifier: Apache-2.0
// Normalizes OpenAI-style chat-completion stream chunks. Shared by `openai-chat` and by
// Workers AI models that answer in the same shape.
import type { FinishReason, ModelErrorCode, ModelEvent, ModelUsage } from "@opa/core";

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  /** DeepSeek reports cache hits here instead of `prompt_tokens_details`. */
  prompt_cache_hit_tokens?: number;
}

export interface RawChatChunk {
  choices?: {
    delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string };
    finish_reason?: string | null;
  }[];
  usage?: RawUsage | null;
  error?: { message?: string };
}

const FINISH_REASONS: readonly string[] = ["stop", "length", "tool_calls", "content_filter"];

export function error(code: ModelErrorCode, message: string, status?: number): ModelEvent {
  return status === undefined
    ? { type: "error", code, message }
    : { type: "error", code, message, status };
}

export const aborted = () => error("aborted", "The request was cancelled");

/** Feed chunks in order with `push`, then call `finish` once the stream ends. */
export class ChatChunkAccumulator {
  private usage: ModelUsage | undefined;
  private finishReason: FinishReason | undefined;

  /** The upstream sent a finish reason, so the reply is complete. */
  get finished(): boolean {
    return this.finishReason !== undefined;
  }

  push(chunk: RawChatChunk): ModelEvent[] {
    const events: ModelEvent[] = [];
    if (chunk.usage) {
      const u = chunk.usage;
      this.usage = {
        inputTokens: u.prompt_tokens ?? 0,
        outputTokens: u.completion_tokens ?? 0,
        cachedInputTokens: u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0,
        reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
      };
    }
    for (const { delta = {}, finish_reason } of chunk.choices ?? []) {
      // Hosts disagree on the reasoning field name; take the first non-empty one.
      const reasoning = delta.reasoning_content || delta.reasoning;
      if (reasoning) events.push({ type: "reasoning.delta", text: reasoning });
      if (delta.content) events.push({ type: "text.delta", text: delta.content });
      if (finish_reason) {
        this.finishReason = FINISH_REASONS.includes(finish_reason)
          ? (finish_reason as FinishReason)
          : "other";
      }
    }
    return events;
  }

  finish(): ModelEvent[] {
    const done: ModelEvent = { type: "done", finishReason: this.finishReason ?? "stop" };
    return this.usage ? [{ type: "usage", usage: this.usage }, done] : [done];
  }
}

/** Turns the SSE `data` payloads of a chat stream into normalized events. */
export async function* replayChunks(
  data: AsyncIterable<string>,
  signal: AbortSignal | undefined,
  redact: (text: string) => string,
): AsyncGenerator<ModelEvent> {
  const acc = new ChatChunkAccumulator();
  let sawDone = false;
  try {
    for await (const payload of data) {
      if (payload === "[DONE]") {
        sawDone = true;
        break;
      }
      let chunk: RawChatChunk & { response?: string };
      try {
        chunk = JSON.parse(payload);
      } catch {
        yield error("bad_response", "The provider sent a malformed stream chunk");
        return;
      }
      if (chunk.error) {
        yield error("upstream", redact(chunk.error.message ?? "The provider reported an error"));
        return;
      }
      // Older Workers AI text models stream `{ response }` chunks instead of `choices`.
      if (chunk.response) yield { type: "text.delta", text: chunk.response };
      yield* acc.push(chunk);
    }
  } catch {
    yield signal?.aborted ? aborted() : error("network", "The stream was interrupted");
    return;
  }
  if (signal?.aborted) yield aborted();
  else if (!sawDone && !acc.finished) {
    yield error("network", "The stream ended before the model finished");
  } else yield* acc.finish();
}
