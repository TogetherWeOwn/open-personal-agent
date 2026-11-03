// SPDX-License-Identifier: Apache-2.0
// `workers-ai-binding`: zero-key onboarding through the Worker's `AI` binding (ADR 0006). No
// credential is involved, so there is nothing to bind.
import type { ModelEvent, ModelProvider, ModelRequest } from "@opa/core";
import {
  aborted,
  ChatChunkAccumulator,
  error,
  type RawChatChunk,
  type RawChatDelta,
  replayChunks,
} from "./chat-chunks";
import { chatMessages, chatTools } from "./chat-request";
import { sseData } from "./sse";

/** The part of the Workers AI binding this adapter uses; the real `Ai` binding satisfies it. */
export interface WorkersAIBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
  models?(params?: { task?: string; per_page?: number }): Promise<{ name: string }[]>;
}

export const WORKERS_AI_PROVIDER_ID = "workers-ai";
/** What a fresh deployment chats with until onboarding picks a model: it needs no key. */
export const STARTER_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * Models that actually perform tool calls, seeded from `@cloudflare/workers-types` 5.20261031
 * (models whose input schema takes `tools`) and corrected by live evidence. A model missing here
 * reports no tool support; a successful model Test tool probe (M3-06) is the evidence that
 * justifies adding it here in a code change — the probe does not enable tools at runtime.
 * The keyless starter
 * (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) is deliberately absent although its schema takes
 * `tools`: the T7 probe called one tool 7 of 8 times and two tools 0 of 8, so it is sold as chat
 * only, and offering the production registry to it failed the first answer on a fresh deploy
 * (TWO-1960). Gating reads this set through `capabilities`, never a model-name check elsewhere.
 */
const TOOL_MODELS: ReadonlySet<string> = new Set([
  "@cf/aisingapore/gemma-sea-lion-v4-27b-it",
  "@cf/deepseek-ai/deepseek-v4-flash-0731",
  "@cf/deepseek-ai/deepseek-v4-pro-0813",
  "@cf/google/gemma-3-12b-it",
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/meta/llama-3.2-11b-vision-instruct",
  "@cf/meta/llama-4-scout-17b-16e-instruct",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
  "@cf/moonshotai/kimi-k2.5",
  "@cf/moonshotai/kimi-k2.6",
  "@cf/moonshotai/kimi-k2.7-code",
  "@cf/nvidia/nemotron-3-120b-a12b",
  "@cf/openai/gpt-oss-120b",
  "@cf/openai/gpt-oss-20b",
  "@cf/qwen/qwen2.5-coder-32b-instruct",
  "@cf/qwen/qwen3-30b-a3b-fp8",
  "@cf/qwen/qwen3.8-27b",
  "@cf/qwen/qwq-32b",
  "@cf/zai-org/glm-4.7-flash",
  "@cf/zai-org/glm-5.2",
  "@cf/zai-org/glm-5.3",
  "@cf/zai-org/glm-5.3-flash",
]);

/**
 * Models whose input schema takes `image_url` content parts with a data URI, from
 * `@cloudflare/workers-types` 5.20261031 (M3-10 AC2). No Workers AI chat model takes a PDF.
 */
const IMAGE_MODELS: ReadonlySet<string> = new Set([
  "@cf/google/gemma-3-12b-it",
  "@cf/meta/llama-3.2-11b-vision-instruct",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
]);

export function createWorkersAIProvider(ai: WorkersAIBinding): ModelProvider {
  return {
    id: WORKERS_AI_PROVIDER_ID,

    async listModels() {
      const models = (await ai.models?.({ task: "Text Generation", per_page: 100 })) ?? [];
      return models.map((m) => ({ id: m.name, label: m.name }));
    },

    capabilities(model) {
      return {
        tools: TOOL_MODELS.has(model),
        usageInStream: true,
        imageInput: IMAGE_MODELS.has(model),
        pdfInput: false,
      };
    },

    async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
      let body: unknown;
      try {
        body = await ai.run(request.model, {
          messages: chatMessages(request.messages),
          stream: true,
          ...(request.tools?.length ? { tools: chatTools(request.tools) } : {}),
          ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        });
      } catch (e) {
        const detail = e instanceof Error ? e.message.slice(0, 300) : "Workers AI failed";
        // A tools-bearing request can fail for reasons unrelated to tools (quota, outage),
        // so only an error that names tools states a refusal as fact; otherwise the advice
        // stays conditional and the upstream detail leads (TWO-1960). The loop only offers
        // where `capabilities` reports tool support; the Test probe offers to gather
        // evidence for any model. Either way the outcome came from the binding, so it is
        // real evidence, not a local refusal.
        const namesTools = /tool/i.test(detail);
        yield error(
          "upstream",
          request.tools?.length
            ? namesTools
              ? `${detail} (the model refused a request offering tools; retry without tools or use a tool-capable model)`
              : `${detail} (this request offered tools; if the model does not support tools, retry without tools or use a tool-capable model)`
            : detail,
        );
        return;
      }
      if (!(body instanceof ReadableStream)) {
        // Some models answer a request that offers tools with one whole object instead.
        if (isWholeReply(body)) {
          yield* request.signal?.aborted ? [aborted()] : whole(body);
          return;
        }
        yield error("bad_response", "Workers AI did not return a stream");
        return;
      }
      // Workers AI ends every stream with usage and `[DONE]`.
      yield* replayChunks(sseData(body, request.signal), {
        signal: request.signal,
        expectUsage: true,
      });
    },
  };
}

type WholeReply = Omit<RawChatChunk, "choices"> & {
  response?: unknown;
  choices?: { message?: RawChatDelta; finish_reason?: string | null }[];
};

const isWholeReply = (body: unknown): body is WholeReply =>
  !!body &&
  typeof body === "object" &&
  ("response" in body || "tool_calls" in body || "choices" in body);

/** Events for a reply that came as one object, in either of Workers AI's output shapes. */
function* whole(body: WholeReply): Generator<ModelEvent> {
  const acc = new ChatChunkAccumulator();
  if (typeof body.response === "string" && body.response) {
    yield { type: "text.delta", text: body.response };
  }
  const { choices, ...rest } = body;
  const deltas = choices?.map(({ message = {}, finish_reason = null }) => ({
    delta: message,
    finish_reason,
  }));
  yield* acc.push({ ...rest, ...(deltas ? { choices: deltas } : {}) });
  yield* acc.finish();
}
