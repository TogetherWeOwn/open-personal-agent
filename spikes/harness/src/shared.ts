// SPDX-License-Identifier: Apache-2.0
// M2-16 spike (ADR 0005 #7). Throwaway: types, mock model and the gated tool both variants share.
import type { ModelEvent, ModelMessage } from "@opa/core";

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** `ModelMessage` plus the tool turns M3 will add to the port. */
export type SpikeMessage =
  | (ModelMessage & { toolCalls?: ToolCall[] })
  | { role: "tool"; toolCallId: string; content: string };

export type SpikeModelEvent = ModelEvent | { type: "tool_call"; call: ToolCall };

/** The `ModelProvider.stream()` shape with tool calls added. */
export interface SpikeProvider {
  stream(request: {
    messages: SpikeMessage[];
    signal?: AbortSignal;
  }): AsyncIterable<SpikeModelEvent>;
}

/** A cut-down `HarnessEvent` payload: just enough to compare the two variants. */
export type HarnessEvent =
  | { type: "text.delta"; text: string }
  | { type: "tool.call"; call: ToolCall }
  | { type: "approval.requested"; approvalId: string; call: ToolCall }
  | { type: "tool.result"; toolCallId: string; output: string }
  | {
      type: "turn.end";
      reason: "stop" | "awaiting_approval" | "cancelled" | "error";
      message?: string;
    };

/** What a Durable Object needs from a harness: start a turn, answer an approval. */
export interface SpikeHarness {
  turn(text: string, signal: AbortSignal): AsyncIterable<HarnessEvent>;
  approve(approvalId: string, approved: boolean, signal: AbortSignal): AsyncIterable<HarnessEvent>;
}

/**
 * Scripted model. `delete <path>` asks for the gated tool; after a tool result it confirms; anything
 * else streams 50 words, one per 20 ms, so a cancel lands mid-stream.
 */
export function createMockProvider(): SpikeProvider {
  let calls = 0;
  return {
    async *stream({ messages, signal }) {
      const last = messages.at(-1);
      if (last?.role === "user" && last.content.startsWith("delete ")) {
        const input = { path: last.content.slice(7) };
        yield { type: "tool_call", call: { id: `call_${++calls}`, name: "delete_file", input } };
        yield { type: "done", finishReason: "tool_calls" };
        return;
      }
      const text =
        last?.role === "tool"
          ? `Tool said: ${last.content}`
          : Array.from({ length: 50 }, (_, i) => `w${i}`).join(" ");
      let n = 0;
      for (const piece of text.split(/(?<= )/)) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (signal?.aborted) {
          yield { type: "error", code: "aborted", message: "aborted" };
          return;
        }
        n++;
        yield { type: "text.delta", text: piece };
      }
      const usage = { inputTokens: 10, outputTokens: n, cachedInputTokens: 0, reasoningTokens: 0 };
      yield { type: "usage", usage };
      yield { type: "done", finishReason: "stop" };
    },
  };
}

/** The approval-gated tool. It only records what it would have deleted. */
export const deleted: string[] = [];
export async function deleteFile(path: string): Promise<string> {
  deleted.push(path);
  return `deleted ${path}`;
}
