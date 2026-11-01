// SPDX-License-Identifier: Apache-2.0
// The ModelProvider port (ADR 0006). Wire adapters live in `@opa/providers`; everything above
// them sees only these types.

/** A call the model asked for. `arguments` is the JSON text the model wrote, unparsed. */
export interface ModelToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** A tool offered to the model; `inputSchema` is a JSON Schema object. */
export interface ModelTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Provider-specific reasoning state from one reply: Anthropic thinking blocks with their
 * signatures, or Responses reasoning items. `data` is plain JSON that only the adapter `api`
 * reads, and it replays it only when provider, API and model all match the request (A-M2).
 */
export interface ModelReasoning {
  providerId: string;
  /** The wire adapter that wrote it, for example `anthropic-messages`. */
  api: string;
  model: string;
  data: unknown;
}

export type ModelMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ModelToolCall[];
      /** Kept from the reply's `reasoning.state` event. */
      reasoning?: ModelReasoning;
    }
  /** The result of the assistant's call `toolCallId`. */
  | { role: "tool"; toolCallId: string; content: string };

export interface ModelRequest {
  model: string;
  messages: ModelMessage[];
  /** Omitted or empty: the request offers no tools. */
  tools?: ModelTool[];
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

/**
 * Token counts for one call. `inputTokens` includes `cachedInputTokens` (read from the prompt
 * cache) and `cacheWriteInputTokens` (written to it, which some providers bill above input).
 */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  /** Absent when the provider doesn't report cache writes or doesn't bill them apart. */
  cacheWriteInputTokens?: number;
}

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "other";

export type ModelErrorCode =
  | "auth"
  | "rate_limited"
  | "bad_request"
  | "upstream"
  | "bad_response"
  | "network"
  | "aborted";

/**
 * Normalized stream events. A stream always ends with exactly one `done` or `error`. Each
 * `tool_call` arrives once, complete, after the deltas. `reasoning.state` comes at most once,
 * after the tool calls; the caller keeps it on the assistant message. `usage` comes after those
 * and before `done`, and is absent when the upstream reported none.
 */
export type ModelEvent =
  | { type: "text.delta"; text: string }
  | { type: "reasoning.delta"; text: string }
  | { type: "tool_call"; toolCall: ModelToolCall }
  | { type: "reasoning.state"; reasoning: ModelReasoning }
  | { type: "usage"; usage: ModelUsage }
  | { type: "done"; finishReason: FinishReason }
  | { type: "error"; code: ModelErrorCode; message: string; status?: number };

export interface ModelInfo {
  id: string;
  label: string;
}

export interface ModelCapabilities {
  tools: boolean;
  /** The upstream reports token usage on streamed calls. */
  usageInStream: boolean;
}

export interface ModelProvider {
  /** Stable provider id, also the first half of the credential binding. */
  readonly id: string;
  listModels(): Promise<ModelInfo[]>;
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
  capabilities(model: string): ModelCapabilities;
}
