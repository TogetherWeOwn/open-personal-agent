// SPDX-License-Identifier: Apache-2.0
// Variant B: AI SDK v7 `ToolLoopAgent`. The product keeps its own fetch-only adapters (ADR 0006), so
// the agent reaches the model through a `LanguageModelV4` bridge over the same port. That bridge is
// code we would own too, so it counts toward this variant's size.
import type {
  LanguageModelV4,
  LanguageModelV4FinishReason,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { type ModelMessage, stepCountIs, ToolLoopAgent, tool } from "ai";
import { z } from "zod";
import type { HarnessEvent, SpikeHarness, SpikeMessage, SpikeProvider } from "./shared";
import { deleteFile } from "./shared";

function fromPrompt(prompt: LanguageModelV4Prompt): SpikeMessage[] {
  const out: SpikeMessage[] = [];
  for (const m of prompt) {
    if (m.role === "system") out.push({ role: "system", content: m.content });
    else if (m.role === "user") {
      const content = m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
      out.push({ role: "user", content });
    } else if (m.role === "assistant") {
      let content = "";
      const toolCalls = [];
      for (const p of m.content) {
        if (p.type === "text") content += p.text;
        if (p.type === "tool-call")
          toolCalls.push({ id: p.toolCallId, name: p.toolName, input: p.input });
      }
      out.push({ role: "assistant", content, ...(toolCalls.length ? { toolCalls } : {}) });
    } else {
      for (const p of m.content) {
        if (p.type !== "tool-result") continue;
        const o = p.output;
        const content =
          o.type === "text" || o.type === "error-text"
            ? o.value
            : o.type === "execution-denied"
              ? (o.reason ?? "The user denied this tool call.")
              : JSON.stringify("value" in o ? o.value : o);
        out.push({ role: "tool", toolCallId: p.toolCallId, content });
      }
    }
  }
  return out;
}

const FINISH: Record<string, LanguageModelV4FinishReason["unified"]> = {
  stop: "stop",
  length: "length",
  tool_calls: "tool-calls",
  content_filter: "content-filter",
};

export function toLanguageModel(provider: SpikeProvider, modelId: string): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "opa",
    modelId,
    supportedUrls: {},
    doGenerate() {
      throw new Error("stream only");
    },
    async doStream({ prompt, abortSignal }) {
      const events = provider.stream({
        messages: fromPrompt(prompt),
        ...(abortSignal ? { signal: abortSignal } : {}),
      });
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        async start(c) {
          c.enqueue({ type: "stream-start", warnings: [] });
          let open = false;
          let input: number | undefined;
          let output: number | undefined;
          for await (const e of events) {
            if (e.type === "text.delta") {
              if (!open) c.enqueue({ type: "text-start", id: "t0" });
              open = true;
              c.enqueue({ type: "text-delta", id: "t0", delta: e.text });
            } else if (e.type === "tool_call") {
              const { id, name, input: args } = e.call;
              c.enqueue({
                type: "tool-call",
                toolCallId: id,
                toolName: name,
                input: JSON.stringify(args),
              });
            } else if (e.type === "usage") {
              input = e.usage.inputTokens;
              output = e.usage.outputTokens;
            } else if (e.type === "error") {
              // Rethrow the abort so streamText sees a real cancel, not a model error.
              c.error(
                e.code === "aborted" && abortSignal ? abortSignal.reason : new Error(e.message),
              );
              return;
            } else if (e.type === "done") {
              if (open) c.enqueue({ type: "text-end", id: "t0" });
              const none = { noCache: undefined, cacheRead: undefined, cacheWrite: undefined };
              c.enqueue({
                type: "finish",
                finishReason: { unified: FINISH[e.finishReason] ?? "other", raw: e.finishReason },
                usage: {
                  inputTokens: { total: input, ...none },
                  outputTokens: { total: output, text: output, reasoning: undefined },
                },
              });
            }
          }
          c.close();
        },
      });
      return { stream };
    },
  };
}

export function createAISDKHarness(provider: SpikeProvider): SpikeHarness {
  const agent = new ToolLoopAgent({
    model: toLanguageModel(provider, "mock"),
    tools: {
      delete_file: tool({
        description: "Delete a file",
        inputSchema: z.object({ path: z.string() }),
        needsApproval: true,
        execute: ({ path }) => deleteFile(path),
      }),
    },
    stopWhen: stepCountIs(8),
  });
  const messages: ModelMessage[] = [];

  async function* run(signal: AbortSignal): AsyncGenerator<HarnessEvent> {
    const result = await agent.stream({ messages, abortSignal: signal });
    let awaiting = false;
    let partial = "";
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        partial += part.text;
        yield { type: "text.delta", text: part.text };
      } else if (part.type === "tool-call") {
        yield {
          type: "tool.call",
          call: { id: part.toolCallId, name: part.toolName, input: part.input },
        };
      } else if (part.type === "tool-approval-request") {
        awaiting = true;
        const c = part.toolCall;
        const call = { id: c.toolCallId, name: c.toolName, input: c.input };
        yield { type: "approval.requested", approvalId: part.approvalId, call };
      } else if (part.type === "tool-result") {
        yield { type: "tool.result", toolCallId: part.toolCallId, output: String(part.output) };
      } else if (part.type === "abort") {
        // `response` rejects on abort, dropping the partial step, so keep it ourselves (as builtin-loop does).
        if (partial) messages.push({ role: "assistant", content: partial });
        yield { type: "turn.end", reason: "cancelled" };
        return;
      } else if (part.type === "error") {
        yield { type: "turn.end", reason: "error", message: String(part.error) };
        return;
      } else if (part.type === "finish-step") {
        partial = "";
      }
    }
    messages.push(...(await result.response).messages);
    yield { type: "turn.end", reason: awaiting ? "awaiting_approval" : "stop" };
  }

  return {
    turn(text, signal) {
      messages.push({ role: "user", content: text });
      return run(signal);
    },
    approve(approvalId, approved, signal) {
      messages.push({
        role: "tool",
        content: [{ type: "tool-approval-response", approvalId, approved }],
      });
      return run(signal);
    },
  };
}
