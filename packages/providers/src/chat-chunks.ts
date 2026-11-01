// SPDX-License-Identifier: Apache-2.0
// Normalizes OpenAI-style chat-completion stream chunks. Shared by `openai-chat` and by
// Workers AI models that answer in the same shape.
import type {
  FinishReason,
  ModelErrorCode,
  ModelEvent,
  ModelToolCall,
  ModelUsage,
} from "@opa/core";

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  /** DeepSeek reports cache hits here instead of `prompt_tokens_details`. */
  prompt_cache_hit_tokens?: number;
}

/** One fragment of a streamed call; fragments with the same `index` belong together. */
interface RawToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/**
 * A whole call at the top level of a Workers AI chunk: the OpenAI shape, or the older one with
 * `arguments` as an object and no id.
 */
type RawWholeToolCall = RawToolCallDelta & { name?: string; arguments?: unknown };

export interface RawChatDelta {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string;
  tool_calls?: RawToolCallDelta[] | null;
}

export interface RawChatChunk {
  choices?: { delta?: RawChatDelta; finish_reason?: string | null }[];
  tool_calls?: RawWholeToolCall[] | null;
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

/** Hosts that send no call id get one, so a tool result can always name its call. */
const callId = () => `call_${crypto.randomUUID().replaceAll("-", "")}`;

/** Feed chunks in order with `push`, then call `finish` once the stream ends. */
export class ChatChunkAccumulator {
  private usage: ModelUsage | undefined;
  private finishReason: FinishReason | undefined;
  private calls: ModelToolCall[] = [];
  private byIndex = new Map<number, ModelToolCall>();

  /** The reply is complete: a finish reason arrived, plus usage when it was requested. */
  complete(expectUsage: boolean): boolean {
    return this.finishReason !== undefined && (!expectUsage || this.usage !== undefined);
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
      for (const part of delta.tool_calls ?? []) this.addFragment(part);
      if (finish_reason) {
        this.finishReason = FINISH_REASONS.includes(finish_reason)
          ? (finish_reason as FinishReason)
          : "other";
      }
    }
    for (const call of chunk.tool_calls ?? []) {
      const fn = call.function;
      const args = fn ? fn.arguments : call.arguments;
      this.calls.push({
        id: call.id ?? "",
        name: fn?.name ?? call.name ?? "",
        arguments: typeof args === "string" ? args : args === undefined ? "" : JSON.stringify(args),
      });
    }
    return events;
  }

  private addFragment(part: RawToolCallDelta) {
    // Fragments of one call share an index; without one, they continue the last call.
    let call = part.index === undefined ? this.calls.at(-1) : this.byIndex.get(part.index);
    // A different id is a different call, even at the same index (some hosts reuse index 0).
    if (call && part.id && call.id && part.id !== call.id) call = undefined;
    if (!call) {
      call = { id: part.id ?? "", name: "", arguments: "" };
      this.calls.push(call);
    }
    if (part.index !== undefined) this.byIndex.set(part.index, call);
    if (part.id) call.id = part.id;
    // The name comes whole, once; some hosts repeat it on every fragment.
    if (part.function?.name && !call.name) call.name = part.function.name;
    if (part.function?.arguments) call.arguments += part.function.arguments;
  }

  finish(): ModelEvent[] {
    const toolCalls: ModelToolCall[] = [];
    for (const call of this.calls) {
      // A call with no name can't be run or answered.
      if (!call.name) return [error("bad_response", "The provider sent a tool call with no name")];
      toolCalls.push({
        id: call.id || callId(),
        name: call.name,
        arguments: call.arguments || "{}",
      });
    }
    // Some hosts report `stop` even when the reply is tool calls.
    let finishReason = this.finishReason ?? "stop";
    if (toolCalls.length && finishReason === "stop") finishReason = "tool_calls";
    const done: ModelEvent = { type: "done", finishReason };
    const events: ModelEvent[] = toolCalls.map((toolCall) => ({ type: "tool_call", toolCall }));
    if (this.usage) events.push({ type: "usage", usage: this.usage });
    events.push(done);
    return events;
  }
}

export interface ReplayOptions {
  signal?: AbortSignal | undefined;
  redact?: (text: string) => string;
  /** Usage was requested, so a stream that ends without it (and without `[DONE]`) is cut off. */
  expectUsage: boolean;
}

/** Turns the SSE `data` payloads of a chat stream into normalized events. */
export async function* replayChunks(
  data: AsyncIterable<string>,
  { signal, redact = (text) => text, expectUsage }: ReplayOptions,
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
  else if (!sawDone && !acc.complete(expectUsage)) {
    yield error("network", "The stream ended before the model finished");
  } else yield* acc.finish();
}
