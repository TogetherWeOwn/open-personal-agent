// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createOpenAIChatProvider } from "../src/openai-chat";
import deepseekReasoning from "./fixtures/deepseek-reasoning.sse?raw";
import openaiText from "./fixtures/openai-chat-text.sse?raw";
import openrouterError from "./fixtures/openrouter-error.sse?raw";
import { byteStream, replay } from "./helpers";

const KEY = "sk-test-canary-0123456789";
const hello = { model: "m", messages: [{ role: "user" as const, content: "Hi" }] };
const sse = (fixture: string, chunkSize?: number) => () =>
  new Response(byteStream(fixture, chunkSize));

function provider(baseUrl: string, respond: () => Response, compat = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond();
  }) as typeof globalThis.fetch;
  const p = createOpenAIChatProvider({ providerId: "openai", baseUrl, apiKey: KEY, compat, fetch });
  const body = () => JSON.parse(String(calls[0]?.init.body));
  return { p, calls, body };
}

describe("openai-chat fixture replays", () => {
  it.each([
    [
      "https://api.openai.com/v1",
      openaiText,
      ["text.delta Hello", "text.delta  there.", "usage 1210/3/1024/0", "done stop"],
    ],
    [
      "https://api.deepseek.com",
      deepseekReasoning,
      [
        "reasoning.delta 2 plus 2",
        "reasoning.delta  is 4.",
        "text.delta 4",
        "usage 14/9/6/8",
        "done length",
      ],
    ],
    [
      // An SSE comment, the `reasoning` field and a mid-stream error.
      "https://openrouter.ai/api/v1",
      openrouterError,
      ["reasoning.delta Thinking", "text.delta Par", "error upstream: Provider disconnected"],
    ],
  ])("%s", async (baseUrl, fixture, expected) => {
    expect(await replay(provider(baseUrl, sse(fixture)).p.stream(hello))).toEqual(expected);
  });

  it("survives CRLF line endings split at every byte", async () => {
    const crlf = openaiText.replaceAll("\n", "\r\n");
    const { p } = provider("https://api.openai.com/v1", sse(crlf, 1));
    expect(await replay(p.stream(hello))).toHaveLength(4);
  });
});

describe("openai-chat requests", () => {
  it("applies the api.openai.com preset and sends the key to the base URL", async () => {
    const { p, calls, body } = provider("https://api.openai.com/v1/", sse(openaiText));
    await replay(p.stream({ ...hello, maxOutputTokens: 256 }));
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    const streamOptions = { include_usage: true };
    expect(body()).toEqual({
      ...hello,
      stream: true,
      stream_options: streamOptions,
      max_completion_tokens: 256,
    });
  });

  it("uses defaults for other hosts and lets overrides win", async () => {
    const overrides = { supportsUsageInStreaming: false };
    const { p, body } = provider("http://localhost:11434/v1", sse(openaiText), overrides);
    await replay(p.stream({ ...hello, maxOutputTokens: 64 }));
    expect(body()).toEqual({ ...hello, stream: true, max_tokens: 64 });
    expect(p.capabilities("m")).toEqual({ tools: true, usageInStream: false });
  });

  it.each([
    [401, "auth"],
    [429, "rate_limited"],
    [400, "bad_request"],
    [503, "upstream"],
  ])("maps HTTP %i to %s and redacts the key", async (status, code) => {
    const res = () => Response.json({ error: { message: `Bad key ${KEY}` } }, { status });
    const events = [];
    for await (const e of provider("https://x.test/v1", res).p.stream(hello)) events.push(e);
    expect(events).toEqual([{ type: "error", code, message: "Bad key [redacted]", status }]);
  });

  it("reports a network failure and a cancelled stream", async () => {
    const down = provider("https://x.test/v1", () => {
      throw new TypeError("fetch failed");
    });
    expect(await replay(down.p.stream(hello))).toEqual([
      "error network: Could not reach the provider",
    ]);
    const controller = new AbortController();
    const seen: string[] = [];
    const { p } = provider("https://x.test/v1", sse(openaiText));
    for await (const event of p.stream({ ...hello, signal: controller.signal })) {
      seen.push(event.type);
      controller.abort();
    }
    expect(seen).toEqual(["text.delta", "error"]);
  });

  it("lists models", async () => {
    const { p, calls } = provider("https://x.test/v1", () =>
      Response.json({ data: [{ id: "a" }] }),
    );
    expect(await p.listModels()).toEqual([{ id: "a", label: "a" }]);
    expect(calls[0]?.url).toBe("https://x.test/v1/models");
  });
});
