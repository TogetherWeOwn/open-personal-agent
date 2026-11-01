// SPDX-License-Identifier: Apache-2.0
// Messages and tools in the OpenAI chat-completions shape. Shared by `openai-chat` and by
// Workers AI, whose chat models take the same shape.
import type { ModelAttachment, ModelMessage, ModelTool } from "@opa/core";
import { attachmentText, dataUri } from "./attachments";

/** One file as a content part: an image by data URI, a PDF as a file part, text as text. */
function part(a: ModelAttachment): Record<string, unknown> {
  if (a.kind === "image") return { type: "image_url", image_url: { url: dataUri(a) } };
  if (a.kind === "pdf") return { type: "file", file: { filename: a.name, file_data: dataUri(a) } };
  return { type: "text", text: attachmentText(a) };
}

export function chatMessages(messages: readonly ModelMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    if (m.role === "user" && m.attachments?.length) {
      return {
        role: "user",
        content: [
          ...(m.content ? [{ type: "text", text: m.content }] : []),
          ...m.attachments.map(part),
        ],
      };
    }
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
