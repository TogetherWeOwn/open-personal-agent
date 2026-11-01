// SPDX-License-Identifier: Apache-2.0
// Per-host differences in the OpenAI chat-completions dialect. pi-ai's compat flags (MIT) are
// the reference (ADR 0006); only the flags this adapter acts on are modelled.

export interface OpenAIChatCompat {
  /** Send `stream_options: { include_usage: true }` so the last chunk carries usage. */
  supportsUsageInStreaming: boolean;
  /** Name of the output-token limit field. */
  maxTokensField: "max_tokens" | "max_completion_tokens";
  /** The host accepts `tools` (reported through `capabilities`; tool calls arrive in M3). */
  supportsTools: boolean;
}

export const DEFAULT_OPENAI_CHAT_COMPAT: OpenAIChatCompat = {
  supportsUsageInStreaming: true,
  maxTokensField: "max_tokens",
  supportsTools: true,
};

/**
 * Presets keyed by exact hostname. Anything else gets the defaults. A host is added here only
 * with a recorded fixture or a documented difference.
 */
export const OPENAI_CHAT_HOST_PRESETS: Readonly<Record<string, Partial<OpenAIChatCompat>>> = {
  // Reasoning models reject `max_tokens`.
  "api.openai.com": { maxTokensField: "max_completion_tokens" },
};

/** Defaults, then the host preset, then explicit overrides (which win). */
export function resolveCompat(
  baseUrl: string,
  overrides: Partial<OpenAIChatCompat> = {},
): OpenAIChatCompat {
  const preset = OPENAI_CHAT_HOST_PRESETS[new URL(baseUrl).hostname] ?? {};
  return { ...DEFAULT_OPENAI_CHAT_COMPAT, ...preset, ...overrides };
}
