// SPDX-License-Identifier: Apache-2.0
// Variant A: `builtin-loop`, our own tool loop over the ModelProvider port.
import type { HarnessEvent, SpikeHarness, SpikeMessage, SpikeProvider, ToolCall } from "./shared";
import { deleteFile } from "./shared";

interface LoopTool {
  needsApproval: boolean;
  execute(input: unknown, signal: AbortSignal): Promise<string>;
}

const TOOLS: Record<string, LoopTool> = {
  delete_file: {
    needsApproval: true,
    execute: (input) => deleteFile((input as { path: string }).path),
  },
};

const MAX_STEPS = 8;

export function createBuiltinHarness(provider: SpikeProvider): SpikeHarness {
  const messages: SpikeMessage[] = [];
  // Calls the model made in the last step that still wait on a decision or execution.
  let pending: { approvalId: string; call: ToolCall }[] = [];

  async function* runTool(call: ToolCall, signal: AbortSignal): AsyncGenerator<HarnessEvent> {
    const tool = TOOLS[call.name];
    const output = tool ? await tool.execute(call.input, signal) : `unknown tool ${call.name}`;
    messages.push({ role: "tool", toolCallId: call.id, content: output });
    yield { type: "tool.result", toolCallId: call.id, output };
  }

  async function* loop(signal: AbortSignal): AsyncGenerator<HarnessEvent> {
    for (let step = 0; step < MAX_STEPS; step++) {
      let text = "";
      const calls: ToolCall[] = [];
      for await (const event of provider.stream({ messages, signal })) {
        if (event.type === "text.delta") {
          text += event.text;
          yield event;
        } else if (event.type === "tool_call") {
          calls.push(event.call);
          yield { type: "tool.call", call: event.call };
        } else if (event.type === "error") {
          // Keep the partial text so the transcript shows what the user saw before the cancel.
          if (text) messages.push({ role: "assistant", content: text });
          const reason = event.code === "aborted" ? "cancelled" : "error";
          yield { type: "turn.end", reason, message: event.message };
          return;
        }
      }
      messages.push({
        role: "assistant",
        content: text,
        ...(calls.length ? { toolCalls: calls } : {}),
      });
      if (calls.length === 0) {
        yield { type: "turn.end", reason: "stop" };
        return;
      }
      const gated = calls.filter((c) => TOOLS[c.name]?.needsApproval);
      for (const call of calls.filter((c) => !gated.includes(c))) yield* runTool(call, signal);
      if (gated.length) {
        pending = gated.map((call) => ({ approvalId: `appr_${call.id}`, call }));
        for (const p of pending) yield { type: "approval.requested", ...p };
        yield { type: "turn.end", reason: "awaiting_approval" };
        return;
      }
    }
    yield { type: "turn.end", reason: "stop", message: "step limit" };
  }

  return {
    turn(text, signal) {
      messages.push({ role: "user", content: text });
      return loop(signal);
    },
    async *approve(approvalId, approved, signal) {
      const entry = pending.find((p) => p.approvalId === approvalId);
      if (!entry) throw new Error(`no pending approval ${approvalId}`);
      pending = pending.filter((p) => p !== entry);
      if (approved) yield* runTool(entry.call, signal);
      else {
        const output = "The user denied this tool call.";
        messages.push({ role: "tool", toolCallId: entry.call.id, content: output });
        yield { type: "tool.result", toolCallId: entry.call.id, output };
      }
      if (pending.length === 0) yield* loop(signal);
    },
  };
}
