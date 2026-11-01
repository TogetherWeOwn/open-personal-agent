// SPDX-License-Identifier: Apache-2.0
// Messages and tools in the OpenAI chat-completions shape. Shared by `openai-chat` and by
// Workers AI, whose chat models take the same shape.
import type { ModelMessage, ModelTool } from "@opa/core";

export function chatMessages(messages: readonly ModelMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    if (m.role !== "assistant" || !m.toolCalls?.length) return { role: m.role, content: m.content };
    return {
      role: "assistant",
      // Several hosts reject an empty string next to tool calls; null is the documented form.
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.arguments },
      })),
    };
  });
}

export function chatTools(tools: readonly ModelTool[]): Record<string, unknown>[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}
