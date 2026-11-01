// SPDX-License-Identifier: Apache-2.0
// `openai-chat`: the long-tail adapter for OpenAI-compatible chat-completions hosts (ADR 0006).
// Fetch only, no SDK.
import type { ModelEvent, ModelProvider, ModelRequest } from "@opa/core";
import { error, replayChunks } from "./chat-chunks";
import { chatMessages, chatTools } from "./chat-request";
import { type OpenAIChatCompat, resolveCompat } from "./compat";
import { type EndpointOptions, endpoint, listModels, openStream } from "./http";
import { sseData } from "./sse";

export interface OpenAIChatOptions extends EndpointOptions {
  providerId: string;
  compat?: Partial<OpenAIChatCompat>;
}

export function createOpenAIChatProvider(options: OpenAIChatOptions): ModelProvider {
  const http = endpoint(options);
  const compat = resolveCompat(http.base, options.compat);

  return {
    id: options.providerId,

    listModels: () => listModels(http),

    capabilities() {
      return {
        tools: compat.supportsTools,
        usageInStream: compat.supportsUsageInStreaming,
        imageInput: compat.supportsImageInput,
        pdfInput: compat.supportsPdfInput,
      };
    },

    async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
      const tools = request.tools ?? [];
      if (tools.length && !compat.supportsTools) {
        yield error("bad_request", "This provider is set up without tool support");
        return;
      }
      const body: Record<string, unknown> = {
        model: request.model,
        messages: chatMessages(request.messages),
        stream: true,
      };
      if (tools.length) body.tools = chatTools(tools);
      if (compat.supportsUsageInStreaming) body.stream_options = { include_usage: true };
      if (request.maxOutputTokens !== undefined) {
        body[compat.maxTokensField] = request.maxOutputTokens;
      }
      if (request.temperature !== undefined) body.temperature = request.temperature;
      const stream = await openStream(http, "/chat/completions", body, request.signal);
      if ("type" in stream) {
        yield stream;
        return;
      }
      yield* replayChunks(sseData(stream, request.signal), {
        signal: request.signal,
        redact: http.redact,
        expectUsage: compat.supportsUsageInStreaming,
      });
    },
  };
}
