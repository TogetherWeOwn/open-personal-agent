// SPDX-License-Identifier: Apache-2.0
// The ModelProvider port (ADR 0006). Wire adapters live in `@opa/providers`; everything above
// them sees only these types. Tool calls join in M3 with `builtin-loop`.

export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  model: string;
  messages: ModelMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

/** Token counts for one call. `inputTokens` includes `cachedInputTokens`. */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
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
 * Normalized stream events. A stream always ends with exactly one `done` or `error`. `usage`
 * comes after the last delta and before `done`, and is absent when the upstream reported none.
 */
export type ModelEvent =
  | { type: "text.delta"; text: string }
  | { type: "reasoning.delta"; text: string }
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
