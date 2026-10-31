// SPDX-License-Identifier: Apache-2.0
// `workers-ai-binding`: zero-key onboarding through the Worker's `AI` binding (ADR 0006). No
// credential is involved, so there is nothing to bind.
import type { ModelEvent, ModelProvider, ModelRequest } from "@opa/core";
import { error, replayChunks } from "./chat-chunks";
import { sseData } from "./sse";

/** The part of the Workers AI binding this adapter uses; the real `Ai` binding satisfies it. */
export interface WorkersAIBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
  models?(params?: { task?: string; per_page?: number }): Promise<{ name: string }[]>;
}

export const WORKERS_AI_PROVIDER_ID = "workers-ai";

export function createWorkersAIProvider(ai: WorkersAIBinding): ModelProvider {
  return {
    id: WORKERS_AI_PROVIDER_ID,

    async listModels() {
      const models = (await ai.models?.({ task: "Text Generation", per_page: 100 })) ?? [];
      return models.map((m) => ({ id: m.name, label: m.name }));
    },

    capabilities() {
      // Some Workers AI models take tools; M2 doesn't wire them.
      return { tools: false, usageInStream: true };
    },

    async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
      let body: unknown;
      try {
        body = await ai.run(request.model, {
          messages: request.messages,
          stream: true,
          ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        });
      } catch (e) {
        yield error("upstream", e instanceof Error ? e.message.slice(0, 300) : "Workers AI failed");
        return;
      }
      if (!(body instanceof ReadableStream)) {
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
