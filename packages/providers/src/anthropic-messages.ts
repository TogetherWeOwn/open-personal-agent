// SPDX-License-Identifier: Apache-2.0
// `anthropic-messages`: the Anthropic Messages API (ADR 0006). Fetch only, no SDK. This file is
// the transport and the stream; `anthropic-request.ts` builds the body.
import type {
  FinishReason,
  ModelErrorCode,
  ModelEvent,
  ModelProvider,
  ModelReasoning,
  ModelRequest,
  ModelToolCall,
} from "@opa/core";
import { ANTHROPIC_MESSAGES_API, messagesBody, type ReplayBlock } from "./anthropic-request";
import { aborted, error } from "./chat-chunks";
import { canonicalOrigin } from "./credential-binding";
import { type EndpointOptions, endpoint, openStream } from "./http";
import { sseData } from "./sse";

/** Pinned; `messagesBody` leaves out the sampling parameters this version rejects. */
const API_VERSION = "2026-10-21";

/**
 * The Anthropic preset talks Messages; any other host, Anthropic's own included under another
 * preset, keeps its adapter. As with `usesOpenAIResponses`, the API follows the preset and is never
 * part of `providerId`, so the key's binding is the same whichever adapter uses it.
 */
export function usesAnthropicMessages(providerId: string | null, baseUrl: string | null): boolean {
  if (providerId !== "anthropic" || !baseUrl) return false;
  try {
    return canonicalOrigin(baseUrl) === "https://api.anthropic.com";
  } catch {
    return false;
  }
}

export interface AnthropicMessagesOptions extends EndpointOptions {
  providerId: string;
}

const STOP_REASONS: Record<string, FinishReason> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  model_context_window_exceeded: "length",
  tool_use: "tool_calls",
  refusal: "content_filter",
};

const STREAM_ERRORS: Record<string, ModelErrorCode> = {
  authentication_error: "auth",
  permission_error: "auth",
  rate_limit_error: "rate_limited",
  invalid_request_error: "bad_request",
  request_too_large: "bad_request",
};

export function createAnthropicMessagesProvider(options: AnthropicMessagesOptions): ModelProvider {
  // The Messages API takes the key as a bearer token as well as in `x-api-key`.
  const base = endpoint(options);
  const http = { ...base, headers: { ...base.headers, "anthropic-version": API_VERSION } };
  const origin = (model: string) => ({
    providerId: options.providerId,
    api: ANTHROPIC_MESSAGES_API,
    model,
  });

  return {
    id: options.providerId,

    async listModels() {
      // The list is paged, 20 by default.
      const res = await http.fetch(`${http.base}/models?limit=1000`, {
        headers: http.headers,
        redirect: "manual",
      });
      if (!res.ok) throw new Error(`Listing models failed with HTTP ${res.status}`);
      const body = (await res.json()) as { data?: { id: string; display_name?: string }[] };
      return (body.data ?? []).map((m) => ({ id: m.id, label: m.display_name || m.id }));
    },

    capabilities() {
      return { tools: true, usageInStream: true };
    },

    async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
      const body = messagesBody(request, options.providerId);
      const stream = await openStream(http, "/messages", body, request.signal);
      if ("type" in stream) {
        yield stream;
        return;
      }
      yield* replayEvents(sseData(stream, request.signal), {
        signal: request.signal,
        redact: http.redact,
        origin: origin(request.model),
      });
    },
  };
}

interface RawUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** A content block as it streams in. */
interface OpenBlock {
  type: string;
  text: string;
  thinking: string;
  signature: string;
  data: string;
  id: string;
  name: string;
  json: string;
}

interface RawEvent {
  type?: string;
  index?: number;
  message?: { usage?: RawUsage };
  content_block?: Partial<OpenBlock> & { input?: unknown };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  usage?: RawUsage;
  error?: { type?: string; message?: string };
}

const callId = () => `toolu_${crypto.randomUUID().replaceAll("-", "")}`;

/** Feed events in order with `push`, then call `finish` once `message_stop` has arrived. */
class MessageAccumulator {
  stopped = false;
  private usage: RawUsage = {};
  private stopReason: string | undefined;
  private blocks: OpenBlock[] = [];
  private byIndex = new Map<number, OpenBlock>();

  constructor(private origin: Omit<ModelReasoning, "items">) {}

  /** Returns the events to emit, or one error that ends the stream. */
  push(event: RawEvent): ModelEvent[] {
    const delta = event.delta ?? {};
    switch (event.type) {
      case "message_start":
        Object.assign(this.usage, event.message?.usage);
        return [];
      case "content_block_start": {
        const start = event.content_block ?? {};
        const block: OpenBlock = {
          type: start.type ?? "",
          text: start.text ?? "",
          thinking: start.thinking ?? "",
          signature: start.signature ?? "",
          data: start.data ?? "",
          id: start.id ?? "",
          name: start.name ?? "",
          json: "",
        };
        this.blocks.push(block);
        this.byIndex.set(event.index ?? this.blocks.length - 1, block);
        return block.text ? [{ type: "text.delta", text: block.text }] : [];
      }
      case "content_block_delta": {
        const block = this.byIndex.get(event.index ?? -1);
        if (!block) return [error("bad_response", "The provider sent a delta for no block")];
        if (delta.type === "text_delta" && delta.text) {
          block.text += delta.text;
          return [{ type: "text.delta", text: delta.text }];
        }
        if (delta.type === "thinking_delta" && delta.thinking) {
          block.thinking += delta.thinking;
          return [{ type: "reasoning.delta", text: delta.thinking }];
        }
        if (delta.type === "signature_delta") block.signature += delta.signature ?? "";
        if (delta.type === "input_json_delta") block.json += delta.partial_json ?? "";
        return [];
      }
      case "message_delta":
        if (delta.stop_reason) this.stopReason = delta.stop_reason;
        // Counts here are cumulative; a null means "unchanged".
        for (const [k, v] of Object.entries(event.usage ?? {})) {
          if (typeof v === "number") this.usage[k as keyof RawUsage] = v;
        }
        return [];
      case "message_stop":
        this.stopped = true;
        return [];
      default:
        // `ping`, `content_block_stop` and event types added later carry nothing to act on.
        return [];
    }
  }

  finish(): ModelEvent[] {
    const u = this.usage;
    const read = u.cache_read_input_tokens ?? 0;
    const written = u.cache_creation_input_tokens ?? 0;
    const usage: ModelEvent = {
      type: "usage",
      usage: {
        // Anthropic's `input_tokens` leaves out both cache counts; ours includes them.
        inputTokens: (u.input_tokens ?? 0) + read + written,
        outputTokens: u.output_tokens ?? 0,
        cachedInputTokens: read,
        reasoningTokens: 0,
        cacheWriteInputTokens: written,
      },
    };
    const finishReason: FinishReason =
      this.stopReason === undefined ? "stop" : (STOP_REASONS[this.stopReason] ?? "other");
    // A reply cut off at the output limit may hold a call with half its input: never run it.
    const cut = finishReason === "length";
    const calls: ModelToolCall[] = [];
    const replay: ReplayBlock[] = [];
    let thinking = false;
    let unsigned = false;
    for (const b of this.blocks) {
      if (b.type === "thinking") {
        thinking = true;
        unsigned ||= !b.signature;
        replay.push({ type: "thinking", thinking: b.thinking, signature: b.signature });
      } else if (b.type === "redacted_thinking") {
        thinking = true;
        replay.push({ type: "redacted_thinking", data: b.data });
      } else if (b.type === "text") {
        replay.push({ type: "text", chars: b.text.length });
      } else if (b.type === "tool_use" && !cut) {
        // A call with no name can't be run or answered.
        if (!b.name) {
          return [usage, error("bad_response", "The provider sent a tool call with no name")];
        }
        const call = { id: b.id || callId(), name: b.name, arguments: b.json || "{}" };
        calls.push(call);
        replay.push({ type: "tool_use", id: call.id });
      }
    }
    const events: ModelEvent[] = calls.map((toolCall) => ({ type: "tool_call", toolCall }));
    // An unsigned block would be rejected on replay, and the rest can't go back without it.
    if (thinking && !unsigned) {
      events.push({
        type: "reasoning",
        reasoning: { ...this.origin, items: replay },
      });
    }
    const done: FinishReason =
      calls.length && finishReason === "stop" ? "tool_calls" : finishReason;
    return [...events, usage, { type: "done", finishReason: done }];
  }
}

interface ReplayOptions {
  signal?: AbortSignal | undefined;
  redact: (text: string) => string;
  origin: Omit<ModelReasoning, "items">;
}

/** Turns the SSE `data` payloads of a Messages stream into normalized events. */
async function* replayEvents(
  data: AsyncIterable<string>,
  { signal, redact, origin }: ReplayOptions,
): AsyncGenerator<ModelEvent> {
  const acc = new MessageAccumulator(origin);
  try {
    for await (const payload of data) {
      let event: RawEvent;
      try {
        event = JSON.parse(payload);
      } catch {
        yield error("bad_response", "The provider sent a malformed stream event");
        return;
      }
      if (event.type === "error") {
        const code = STREAM_ERRORS[event.error?.type ?? ""] ?? "upstream";
        yield error(code, redact(event.error?.message ?? "The provider reported an error"));
        return;
      }
      for (const e of acc.push(event)) {
        yield e;
        if (e.type === "error") return;
      }
      if (acc.stopped) break;
    }
  } catch {
    yield signal?.aborted ? aborted() : error("network", "The stream was interrupted");
    return;
  }
  if (signal?.aborted) yield aborted();
  else if (!acc.stopped) yield error("network", "The stream ended before the model finished");
  else yield* acc.finish();
}
