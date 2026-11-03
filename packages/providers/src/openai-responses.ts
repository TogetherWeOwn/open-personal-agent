// SPDX-License-Identifier: Apache-2.0
// `openai-responses`: OpenAI's Responses API (ADR 0006), the only OpenAI API where current models
// call tools. Stateless: every request sends `store: false` and the whole history, and reasoning
// comes back encrypted so it can be replayed on the next step (A-M2). Endpoints that cannot
// stream (M4-20) are answered with one non-streaming request mapped onto the same events.
// Fetch only, no SDK.
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
import { attachmentText, dataUri } from "./attachments";
import { aborted, error } from "./chat-chunks";
import { canonicalOrigin } from "./credential-binding";
import {
  type Endpoint,
  type EndpointOptions,
  endpoint,
  listModels,
  openStream,
  postJson,
} from "./http";
import { sseData } from "./sse";

export const OPENAI_RESPONSES_API = "openai-responses";

/**
 * The OpenAI preset talks Responses; every other OpenAI-compatible host stays on Chat
 * Completions. The wire API is a property of the preset and never part of `providerId`, so the
 * key's `model:<providerId>|<origin>` binding doesn't change when an adapter does (ADR 0006 #5).
 */
export function usesOpenAIResponses(providerId: string | null, baseUrl: string | null): boolean {
  if (providerId !== "openai" || !baseUrl) return false;
  try {
    return canonicalOrigin(baseUrl) === "https://api.openai.com";
  } catch {
    return false;
  }
}

export interface OpenAIResponsesCompat {
  /** The endpoint answers whole responses only: skip the streaming attempt (M4-20). */
  supportsStreaming: boolean;
}

export const DEFAULT_OPENAI_RESPONSES_COMPAT: OpenAIResponsesCompat = {
  supportsStreaming: true,
};

/**
 * Per-host streaming support, by exact hostname. Anything else is assumed to stream; a host is
 * added here only with a recorded rejection or a documented non-streaming endpoint. AI Gateway
 * (`gateway.ai.cloudflare.com`) is absent on purpose: it forwards streaming to the provider
 * behind it, so a rejection there still falls back per request.
 */
export const OPENAI_RESPONSES_HOST_PRESETS: Readonly<
  Record<string, Partial<OpenAIResponsesCompat>>
> = {
  // Cloudflare's Responses endpoints answer whole responses only; `stream: true` is rejected.
  "api.cloudflare.com": { supportsStreaming: false },
};

/** Defaults, then the host preset, then explicit overrides (which win). */
export function resolveResponsesCompat(
  baseUrl: string,
  overrides: Partial<OpenAIResponsesCompat> = {},
): OpenAIResponsesCompat {
  const preset = OPENAI_RESPONSES_HOST_PRESETS[new URL(baseUrl).hostname] ?? {};
  return { ...DEFAULT_OPENAI_RESPONSES_COMPAT, ...preset, ...overrides };
}

export interface OpenAIResponsesOptions extends EndpointOptions {
  providerId: string;
  compat?: Partial<OpenAIResponsesCompat>;
}

/** An output item: a function call, or reasoning kept so it can go back as input. */
interface RawItem {
  type?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  encrypted_content?: string | null;
  summary?: { type?: string; text?: string }[];
  content?: { type?: string; text?: string; refusal?: string }[];
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
  /** Only on a completed (non-streaming) response; a stream carries items as events. */
  output?: RawItem[] | null;
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
    } else if (m.role === "system") {
      input.push({ role: "developer", content: m.content });
    } else if (m.role === "user") {
      input.push({ role: "user", content: m.attachments?.length ? userParts(m) : m.content });
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

/** A user message with files: text first, then each file in the Responses part shape. */
function userParts(m: Extract<ModelMessage, { role: "user" }>): Record<string, unknown>[] {
  return [
    ...(m.content ? [{ type: "input_text", text: m.content }] : []),
    ...(m.attachments ?? []).map((a): Record<string, unknown> => {
      if (a.kind === "image") return { type: "input_image", image_url: dataUri(a) };
      if (a.kind === "pdf") return { type: "input_file", filename: a.name, file_data: dataUri(a) };
      return { type: "input_text", text: attachmentText(a) };
    }),
  ];
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

/**
 * An error that blames streaming, and nothing else. Auth, quota, network and cancellation are
 * never retried; a malformed stream means the endpoint *is* streaming, and its first request
 * may already have generated output, so only a rejection names `stream`.
 */
function isStreamRejection(event: ModelEvent): boolean {
  return (
    event.type === "error" &&
    (event.code === "bad_request" || event.code === "upstream") &&
    /stream/i.test(event.message)
  );
}

/**
 * The tail every settled response shares, streamed or whole: usage, then the error or the
 * tool calls, the reasoning replay state and `done`. A reply cut off before it finished may
 * hold a call with half its arguments: never run it.
 */
function* settle({
  final,
  failed,
  calls,
  reasoning,
  providerId,
  model,
  redact,
  transport,
}: {
  final: RawResponse;
  failed: boolean;
  calls: ModelToolCall[];
  reasoning: RawItem[];
  providerId: string;
  model: string;
  redact: (text: string) => string;
  transport: "streaming" | "non-streaming";
}): Generator<ModelEvent> {
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
  const complete = finishReason === "stop";
  const run = complete ? calls : [];
  // One bad call rejects the reply before any call is emitted, so none of it runs.
  if (run.some((call) => !call.id || !call.name)) {
    yield* usage;
    yield error("bad_response", "The provider sent a tool call with no id or name");
    return;
  }
  for (const toolCall of run) yield { type: "tool_call", toolCall };
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
  yield { type: "done", finishReason, transport };
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
  yield* settle({
    final,
    failed,
    calls,
    reasoning,
    providerId,
    model,
    redact,
    transport: "streaming",
  });
}

/** Maps a whole `/responses` object onto the same events a stream of it would replay. */
function* replayCompleted(response: unknown, context: ReplayContext): Generator<ModelEvent> {
  const { providerId, model, signal, redact } = context;
  if (signal?.aborted) {
    yield aborted();
    return;
  }
  const final = (response ?? {}) as RawResponse;
  const output = Array.isArray(final.output) ? final.output : null;
  if (!output) {
    yield error("bad_response", "The provider sent a response with no output");
    return;
  }
  const calls: ModelToolCall[] = [];
  const reasoning: RawItem[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "function_call") {
      calls.push({
        id: item.call_id ?? "",
        name: item.name ?? "",
        arguments: item.arguments || "{}",
      });
    } else if (item.type === "reasoning") {
      // Same filter as the stream: only encrypted reasoning replays statelessly.
      if (item.encrypted_content) {
        reasoning.push({
          type: "reasoning",
          ...(item.id ? { id: item.id } : {}),
          encrypted_content: item.encrypted_content,
          summary: item.summary ?? [],
        });
      }
      for (const part of item.summary ?? []) {
        if (part?.type === "summary_text" && part.text) {
          yield { type: "reasoning.delta", text: part.text };
        }
      }
    } else if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part?.type === "output_text" && part.text) {
          yield { type: "text.delta", text: part.text };
        } else if (part?.type === "refusal" && part.refusal) {
          yield { type: "text.delta", text: part.refusal };
        }
      }
    }
  }
  // A stream reports failure as `response.failed`; a whole response does it as its status.
  yield* settle({
    final,
    failed: final.status === "failed",
    calls,
    reasoning,
    providerId,
    model,
    redact,
    transport: "non-streaming",
  });
}

/**
 * OpenAI's families that take both image and PDF input, dated snapshots included (M3-10 AC2).
 * A model outside them, or a text, audio or search variant inside one, is told no rather than
 * sent a file on a guess.
 */
const FILE_FAMILIES =
  /^(?:chatgpt-4o|gpt-4o|gpt-4\.1|gpt-4\.5|gpt-5(?:\.\d+)?|o1|o3|o4-mini)(?:-|$)/;
const TEXT_ONLY = /^(?:o1-mini|o1-preview|o3-mini)|audio|realtime|transcribe|tts|search/;
const readsFiles = (model: string) => FILE_FAMILIES.test(model) && !TEXT_ONLY.test(model);

export function createOpenAIResponsesProvider(options: OpenAIResponsesOptions): ModelProvider {
  const http = endpoint(options);
  const compat = resolveResponsesCompat(options.baseUrl, options.compat);
  const providerId = options.providerId;

  return {
    id: providerId,

    listModels: () => listModels(http),

    capabilities(model: string) {
      const files = readsFiles(model);
      return { tools: true, usageInStream: true, imageInput: files, pdfInput: files };
    },

    async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
      const { model } = request;
      const same = (r: ModelReasoning) =>
        r.providerId === providerId && r.api === OPENAI_RESPONSES_API && r.model === model;
      const body: Record<string, unknown> = {
        model,
        input: responsesInput(request.messages, same),
        // Nothing is kept upstream; the history lives in D1 (ADR 0002).
        store: false,
        include: ["reasoning.encrypted_content"],
      };
      const tools = request.tools ?? [];
      if (tools.length) body.tools = responsesTools(tools);
      if (request.maxOutputTokens !== undefined) body.max_output_tokens = request.maxOutputTokens;
      if (request.temperature !== undefined) body.temperature = request.temperature;
      const context = { providerId, model, signal: request.signal, redact: http.redact };
      const complete = (): AsyncGenerator<ModelEvent> =>
        completeResponse(http, body, request.signal, context);
      if (!compat.supportsStreaming) {
        yield* complete();
        return;
      }
      const stream = await openStream(
        http,
        "/responses",
        { ...body, stream: true },
        request.signal,
      );
      if ("type" in stream) {
        // An HTTP rejection of `stream: true` before anything was generated: answer the same
        // request once without streaming, with the same body otherwise.
        if (isStreamRejection(stream)) {
          yield* complete();
          return;
        }
        yield stream;
        return;
      }
      // The rejection can also arrive as an SSE error event; only one seen before any event
      // or usage retries, so a call that already produced output never runs twice.
      let produced = false;
      for await (const event of replayResponses(sseData(stream, request.signal), context)) {
        if (event.type === "error" && !produced && isStreamRejection(event)) {
          yield* complete();
          return;
        }
        if (event.type !== "error") produced = true;
        yield event;
      }
    },
  };
}

/** One non-streaming `/responses` call for the same body, mapped onto the same events. */
async function* completeResponse(
  http: Endpoint,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  context: ReplayContext,
): AsyncGenerator<ModelEvent> {
  const posted = await postJson(http, "/responses", { ...body, stream: false }, signal);
  if ("error" in posted) {
    yield posted.error;
    return;
  }
  yield* replayCompleted(posted.json, context);
}
