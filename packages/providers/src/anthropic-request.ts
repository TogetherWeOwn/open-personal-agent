// SPDX-License-Identifier: Apache-2.0
// The request side of `anthropic-messages`: the port's messages and tools in the Messages API
// shape, with `cache_control` on the system prompt and the tool list, and thinking blocks
// replayed with their signatures under A-M2.
import type {
  ModelMessage,
  ModelReasoning,
  ModelRequest,
  ModelTool,
  ModelToolCall,
} from "@opa/core";

export const ANTHROPIC_MESSAGES_API = "anthropic-messages";

/** Messages requires `max_tokens`. It counts thinking as well as the answer. */
const DEFAULT_MAX_TOKENS = 16_000;

/**
 * A reply's content blocks in order, kept as `ModelReasoning.items`. Thinking blocks are verbatim;
 * text and tool calls are placeholders, since their content is already on the message.
 */
export type ReplayBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "text"; chars: number }
  | { type: "tool_use"; id: string };

type WireBlock = Record<string, unknown> & { type: string };
type WireMessage = { role: "user" | "assistant"; content: WireBlock[] };

const EPHEMERAL = { type: "ephemeral" } as const;

/**
 * The streaming request body for `request`. `providerId` decides, with the API and the model,
 * whether an assistant message's reasoning goes back. `temperature` is never sent: API version
 * 2026-10-21 rejects it on every model.
 */
export function messagesBody(request: ModelRequest, providerId: string): Record<string, unknown> {
  const replays = (r: ModelReasoning | undefined) =>
    r?.providerId === providerId && r.api === ANTHROPIC_MESSAGES_API && r.model === request.model;
  const { system, messages } = wireMessages(request.messages, replays);
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    messages,
    stream: true,
  };
  // One breakpoint after the system prompt and one after the tools: the API caches tools, then
  // system, then messages, so each is a prefix the next call shares.
  if (system) body.system = [{ type: "text", text: system, cache_control: EPHEMERAL }];
  if (request.tools?.length) body.tools = wireTools(request.tools);
  return body;
}

function wireTools(tools: readonly ModelTool[]): Record<string, unknown>[] {
  return tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
    ...(i === tools.length - 1 ? { cache_control: EPHEMERAL } : {}),
  }));
}

/**
 * System messages join into the top-level prompt. Tool results ride in a user message, and
 * consecutive messages of one role merge, since the API wants the roles to alternate.
 */
function wireMessages(
  messages: readonly ModelMessage[],
  replays: (r: ModelReasoning | undefined) => boolean,
): { system: string; messages: WireMessage[] } {
  const system: string[] = [];
  const out: WireMessage[] = [];
  const push = (role: WireMessage["role"], content: WireBlock[]) => {
    if (!content.length) return;
    const last = out.at(-1);
    if (last?.role !== role) out.push({ role, content });
    else if (role === "user") last.content.push(...content);
    else {
      // Two replies in a row become one. Only the later one's thinking may still be needed (a
      // reply with no tool result after it needs none), and dropping the earlier one's keeps
      // each signed run next to the answer it came with.
      last.content = [...last.content.filter((b) => !isThinking(b)), ...content];
    }
  };
  for (const m of messages) {
    if (m.role === "assistant") {
      const blocks = replays(m.reasoning) ? (m.reasoning?.items as ReplayBlock[]) : undefined;
      push("assistant", assistantContent(m.content, m.toolCalls ?? [], blocks));
    } else if (m.role === "tool") {
      const result: WireBlock = { type: "tool_result", tool_use_id: m.toolCallId };
      if (m.content) result.content = m.content;
      push("user", [result]);
    } else if (m.role === "system") {
      if (m.content) system.push(m.content);
    } else {
      push("user", m.content ? [{ type: "text", text: m.content }] : []);
    }
  }
  return { system: system.join("\n\n"), messages: out };
}

const textBlock = (text: string): WireBlock => ({ type: "text", text });

const isThinking = (b: { type: string }) => b.type === "thinking" || b.type === "redacted_thinking";

const toolUse = (call: ModelToolCall): WireBlock => {
  let input: unknown;
  try {
    input = JSON.parse(call.arguments || "{}");
  } catch {
    input = {};
  }
  // The API takes only an object; the tool already got an error for anything else.
  const object = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return { type: "tool_use", id: call.id, name: call.name, input: object };
};

/**
 * Rebuilds the reply's blocks in their original order, with the thinking blocks unchanged (the
 * API rejects edited, reordered or partly dropped ones). Without replayable reasoning, the text
 * comes first and then the calls.
 */
function assistantContent(
  text: string,
  calls: readonly ModelToolCall[],
  blocks: readonly ReplayBlock[] | undefined,
): WireBlock[] {
  if (!blocks) return [...(text ? [textBlock(text)] : []), ...calls.map(toolUse)];
  const out: WireBlock[] = [];
  const placed = new Set<string>();
  const chars = blocks.reduce((n, b) => n + (b.type === "text" ? b.chars : 0), 0);
  // Text stored apart from its placeholders, say after an edit, goes in whole at the first one.
  const split = chars === text.length;
  let offset = 0;
  let rest = text;
  for (const b of blocks) {
    // Only the fields the API defined, whatever else the stored copy holds.
    if (b.type === "thinking")
      out.push({ type: b.type, thinking: b.thinking, signature: b.signature });
    else if (b.type === "redacted_thinking") out.push({ type: b.type, data: b.data });
    else if (b.type === "text") {
      const piece = split ? text.slice(offset, offset + b.chars) : rest;
      offset += b.chars;
      rest = "";
      if (piece) out.push(textBlock(piece));
    } else {
      const call = calls.find((c) => c.id === b.id);
      if (call && !placed.has(call.id)) {
        out.push(toolUse(call));
        placed.add(call.id);
      }
    }
  }
  if (!split && rest) {
    const at = out.findIndex((b) => !isThinking(b));
    out.splice(at === -1 ? out.length : at, 0, textBlock(rest));
  }
  for (const call of calls) if (!placed.has(call.id)) out.push(toolUse(call));
  return out;
}
