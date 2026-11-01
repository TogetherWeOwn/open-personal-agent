// SPDX-License-Identifier: Apache-2.0
// `openai-responses`: OpenAI's Responses API (ADR 0006), the only OpenAI API where current models
// call tools. Stateless: every request sends `store: false` and the whole history, and reasoning
// comes back encrypted so it can be replayed on the next step (A-M2). Fetch only, no SDK.
import type {
  FinishReason,
  ModelErrorCode,
  ModelEvent,
  ModelMessage,
  ModelProvider,
  ModelReasoning,
  ModelRequest,
  ModelTool,
  ModelToolCall,
  ModelUsage,
} from "@opa/core";
import { aborted, error } from "./chat-chunks";
import { type EndpointOptions, endpoint, listModels, openStream } from "./http";
import { sseData } from "./sse";

export const OPENAI_RESPONSES_API = "openai-responses";

export interface OpenAIResponsesOptions extends EndpointOptions {
  providerId: string;
}

/** An output item: a function call, or reasoning kept so it can go back as input. */
interface RawItem {
  type?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  encrypted_content?: string | null;
  summary?: unknown[];
}

interface RawResponse {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  error?: { code?: string; message?: string } | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  } | null;
}

interface RawEvent {
  type?: string;
  delta?: string;
  item?: RawItem;
  response?: RawResponse;
  code?: string | null;
  message?: string;
}

/** Messages as Responses input items; reasoning goes back only under the A-M2 rule. */
export function responsesInput(
  messages: readonly ModelMessage[],
  same: (reasoning: ModelReasoning) => boolean,
): unknown[] {
  const input: unknown[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      input.push({ type: "function_call_output", call_id: m.toolCallId, output: m.content });
    } else if (m.role !== "assistant") {
      input.push({ role: m.role === "system" ? "developer" : "user", content: m.content });
    } else {
      // Reasoning items precede the reply they produced, as in the output they came from.
      if (m.reasoning && same(m.reasoning)) input.push(...m.reasoning.items);
      if (m.content) input.push({ role: "assistant", content: m.content });
      for (const c of m.toolCalls ?? []) {
        input.push({ type: "function_call", call_id: c.id, name: c.name, arguments: c.arguments });
      }
    }
  }
  return input;
}

export function responsesTools(tools: readonly ModelTool[]): Record<string, unknown>[] {
  // `strict` would rewrite optional fields as required; the loop validates inputs itself.
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
    strict: false,
  }));
}

/** Upstream error codes that mean more than "the provider failed". */
const CODES: Readonly<Record<string, ModelErrorCode>> = {
  rate_limit_exceeded: "rate_limited",
  insufficient_quota: "rate_limited",
  invalid_api_key: "auth",
  invalid_prompt: "bad_request",
  context_length_exceeded: "bad_request",
};

const usageOf = (u: NonNullable<RawResponse["usage"]>): ModelUsage => ({
  inputTokens: u.input_tokens ?? 0,
  outputTokens: u.output_tokens ?? 0,
  cachedInputTokens: u.input_tokens_details?.cached_tokens ?? 0,
  reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
});

interface ReplayContext {
  providerId: string;
  model: string;
  signal?: AbortSignal | undefined;
  redact: (text: string) => string;
}

/** Turns the SSE `data` payloads of a Responses stream into normalized events. */
export async function* replayResponses(
  data: AsyncIterable<string>,
  { providerId, model, signal, redact }: ReplayContext,
): AsyncGenerator<ModelEvent> {
  const calls: ModelToolCall[] = [];
  const reasoning: RawItem[] = [];
  let final: RawResponse | undefined;
  let failed = false;
  try {
    for await (const payload of data) {
      let event: RawEvent;
      try {
        event = JSON.parse(payload);
      } catch {
        yield error("bad_response", "The provider sent a malformed stream event");
        return;
      }
      switch (event.type) {
        case "response.output_text.delta":
        case "response.refusal.delta":
          if (event.delta) yield { type: "text.delta", text: event.delta };
          break;
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta":
          if (event.delta) yield { type: "reasoning.delta", text: event.delta };
          break;
        case "response.output_item.done": {
          const item = event.item;
          if (item?.type === "function_call") {
            calls.push({
              id: item.call_id ?? "",
              name: item.name ?? "",
              arguments: item.arguments || "{}",
            });
          } else if (item?.type === "reasoning") {
            // Without its encrypted content, a reasoning item can't be replayed statelessly.
            if (item.encrypted_content) {
              reasoning.push({
                type: "reasoning",
                ...(item.id ? { id: item.id } : {}),
                encrypted_content: item.encrypted_content,
                summary: item.summary ?? [],
              });
            }
          }
          break;
        }
        case "response.completed":
        case "response.incomplete":
          final = event.response ?? {};
          break;
        case "response.failed":
          final = event.response ?? {};
          failed = true;
          break;
        case "error": {
          const code = (event.code && CODES[event.code]) || "upstream";
          yield error(
            code,
            redact(event.message ?? "The provider reported an error").slice(0, 300),
          );
          return;
        }
      }
      if (final) break;
    }
  } catch {
    yield signal?.aborted ? aborted() : error("network", "The stream was interrupted");
    return;
  }
  if (signal?.aborted) {
    yield aborted();
    return;
  }
  if (!final) {
    yield error("network", "The stream ended before the model finished");
    return;
  }
  // The model was billed whatever else happened, so usage is always reported.
  const usage: ModelEvent[] = final.usage ? [{ type: "usage", usage: usageOf(final.usage) }] : [];
  if (failed) {
    const e = final.error ?? {};
    const code = (e.code && CODES[e.code]) || "upstream";
    yield* usage;
    yield error(code, redact(e.message ?? "The provider reported an error").slice(0, 300));
    return;
  }
  const reason = final.incomplete_details?.reason;
  let finishReason: FinishReason =
    final.status !== "incomplete"
      ? "stop"
      : reason === "max_output_tokens"
        ? "length"
        : reason === "content_filter"
          ? "content_filter"
          : "other";
  // A reply cut off before it finished may hold a call with half its arguments: never run it.
  const complete = finishReason === "stop";
  for (const call of complete ? calls : []) {
    if (!call.id || !call.name) {
      yield* usage;
      yield error("bad_response", "The provider sent a tool call with no id or name");
      return;
    }
    yield { type: "tool_call", toolCall: call };
  }
  if (complete && calls.length) finishReason = "tool_calls";
  if (complete && reasoning.length) {
    const state: ModelReasoning = {
      providerId,
      api: OPENAI_RESPONSES_API,
      model,
      items: reasoning,
    };
    yield { type: "reasoning", reasoning: state };
  }
  yield* usage;
  yield { type: "done", finishReason };
}

export function createOpenAIResponsesProvider(options: OpenAIResponsesOptions): ModelProvider {
  const http = endpoint(options);
  const providerId = options.providerId;

  return {
    id: providerId,

    listModels: () => listModels(http),

    capabilities() {
      return { tools: true, usageInStream: true };
    },

    async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
      const { model } = request;
      const same = (r: ModelReasoning) =>
        r.providerId === providerId && r.api === OPENAI_RESPONSES_API && r.model === model;
      const body: Record<string, unknown> = {
        model,
        input: responsesInput(request.messages, same),
        stream: true,
        // Nothing is kept upstream; the history lives in D1 (ADR 0002).
        store: false,
        include: ["reasoning.encrypted_content"],
      };
      const tools = request.tools ?? [];
      if (tools.length) body.tools = responsesTools(tools);
      if (request.maxOutputTokens !== undefined) body.max_output_tokens = request.maxOutputTokens;
      if (request.temperature !== undefined) body.temperature = request.temperature;
      const stream = await openStream(http, "/responses", body, request.signal);
      if ("type" in stream) {
        yield stream;
        return;
      }
      const context = { providerId, model, signal: request.signal, redact: http.redact };
      yield* replayResponses(sseData(stream, request.signal), context);
    },
  };
}
