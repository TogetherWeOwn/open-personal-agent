// SPDX-License-Identifier: Apache-2.0
// `workers-ai-binding`: zero-key onboarding through the Worker's `AI` binding (ADR 0006). No
// credential is involved, so there is nothing to bind.
import type { ModelEvent, ModelProvider, ModelRequest } from "@opa/core";
import {
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

export function createWorkersAIProvider(ai: WorkersAIBinding): ModelProvider {
  return {
    id: WORKERS_AI_PROVIDER_ID,

    async listModels() {
      const models = (await ai.models?.({ task: "Text Generation", per_page: 100 })) ?? [];
      return models.map((m) => ({ id: m.name, label: m.name }));
    },

    capabilities() {
      // Many Workers AI chat models take tools and the catalogue changes often; a model that
      // doesn't fails the call. The model Test's tool probe (M3-06) tells the user up front.
      return { tools: true, usageInStream: true };
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
        yield error("upstream", e instanceof Error ? e.message.slice(0, 300) : "Workers AI failed");
        return;
      }
      if (!(body instanceof ReadableStream)) {
        // Some models answer a request that offers tools with one whole object instead.
        if (isWholeReply(body)) {
          yield* whole(body);
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
