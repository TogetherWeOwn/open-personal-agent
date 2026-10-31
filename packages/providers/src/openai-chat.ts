// SPDX-License-Identifier: Apache-2.0
// `openai-chat`: the long-tail adapter for OpenAI-compatible chat-completions hosts (ADR 0006).
// Fetch only, no SDK.
import type { ModelErrorCode, ModelEvent, ModelProvider, ModelRequest } from "@opa/core";
import { aborted, error, replayChunks } from "./chat-chunks";
import { type OpenAIChatCompat, resolveCompat } from "./compat";
import { canonicalOrigin } from "./credential-binding";
import { sseData } from "./sse";

export interface OpenAIChatOptions {
  providerId: string;
  /** For example `https://api.openai.com/v1`. The key is only ever sent to this origin. */
  baseUrl: string;
  /** Optional: local servers often need none. */
  apiKey?: string;
  compat?: Partial<OpenAIChatCompat>;
  fetch?: typeof fetch;
}

export function createOpenAIChatProvider(options: OpenAIChatOptions): ModelProvider {
  canonicalOrigin(options.baseUrl);
  const base = options.baseUrl.replace(/\/+$/, "");
  const compat = resolveCompat(base, options.compat);
  const doFetch = options.fetch ?? fetch;
  const redact = (text: string) =>
    options.apiKey ? text.split(options.apiKey).join("[redacted]") : text;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;

  return {
    id: options.providerId,

    async listModels() {
      const res = await doFetch(`${base}/models`, { headers });
      if (!res.ok) throw new Error(`Listing models failed with HTTP ${res.status}`);
      const body = (await res.json()) as { data?: { id: string }[] };
      return (body.data ?? []).map((m) => ({ id: m.id, label: m.id }));
    },

    capabilities() {
      return { tools: compat.supportsTools, usageInStream: compat.supportsUsageInStreaming };
    },

    async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
      const body: Record<string, unknown> = {
        model: request.model,
        messages: request.messages,
        stream: true,
      };
      if (compat.supportsUsageInStreaming) body.stream_options = { include_usage: true };
      if (request.maxOutputTokens !== undefined) {
        body[compat.maxTokensField] = request.maxOutputTokens;
      }
      if (request.temperature !== undefined) body.temperature = request.temperature;
      let res: Response;
      try {
        res = await doFetch(`${base}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          ...(request.signal ? { signal: request.signal } : {}),
        });
      } catch {
        yield request.signal?.aborted
          ? aborted()
          : error("network", "Could not reach the provider");
        return;
      }
      if (!res.ok || !res.body) {
        yield await httpError(res, redact);
        return;
      }
      yield* replayChunks(sseData(res.body, request.signal), request.signal, redact);
    },
  };
}

async function httpError(res: Response, redact: (text: string) => string): Promise<ModelEvent> {
  const code: ModelErrorCode =
    res.status === 401 || res.status === 403
      ? "auth"
      : res.status === 429
        ? "rate_limited"
        : res.status >= 500
          ? "upstream"
          : "bad_request";
  let detail = "";
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    detail = body.error?.message ?? "";
  } catch {
    // Not JSON; the status says enough.
  }
  return error(code, detail ? redact(detail).slice(0, 300) : `HTTP ${res.status}`, res.status);
}
