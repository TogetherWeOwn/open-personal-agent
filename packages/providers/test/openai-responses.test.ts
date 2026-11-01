// SPDX-License-Identifier: Apache-2.0
// M3-04: the `openai-responses` adapter. Stateless requests, reasoning replayed only under the
// A-M2 rule, and fixture replays of text, a tool call, reasoning, cached usage and errors.
import type { ModelMessage, ModelReasoning } from "@opa/core";
import { describe, expect, it } from "vitest";
import { createOpenAIResponsesProvider, usesOpenAIResponses } from "../src/openai-responses";
import failed from "./fixtures/openai-responses-failed.sse?raw";
import text from "./fixtures/openai-responses-text.sse?raw";
import toolCall from "./fixtures/openai-responses-tool-call.sse?raw";
import { byteStream, replay } from "./helpers";

const KEY = "sk-test-canary-0123456789";
const BASE = "https://api.openai.com/v1";
const MODEL = "gpt-5-mini";
const ask: ModelMessage[] = [
  { role: "system", content: "Be brief." },
  { role: "user", content: "Weather in Lisbon?" },
];
const weather = {
  name: "get_weather",
  description: "Current weather for a city",
  inputSchema: { type: "object", properties: { city: { type: "string" } } },
};
const sse = (fixture: string, chunkSize?: number) => () =>
  new Response(byteStream(fixture, chunkSize));
const event = (type: string, fields: Record<string, unknown> = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;

function provider(respond: () => Response, providerId = "openai") {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond();
  }) as typeof globalThis.fetch;
  const p = createOpenAIResponsesProvider({ providerId, baseUrl: BASE, apiKey: KEY, fetch });
  const body = (i = 0) => JSON.parse(String(calls[i]?.init.body));
  return { p, calls, body };
}

describe("openai-responses fixture replays", () => {
  it("streams text and reports usage with cached tokens", async () => {
    expect(await replay(provider(sse(text)).p.stream({ model: MODEL, messages: ask }))).toEqual([
      "text.delta Hello",
      "text.delta  there.",
      "usage 1210/3/1024/0",
      "done stop",
    ]);
  });

  it("emits a tool call and its reasoning state, then usage", async () => {
    const { p } = provider(sse(toolCall, 5));
    const events = await replay(p.stream({ model: MODEL, messages: ask, tools: [weather] }));
    expect(events).toEqual([
      "reasoning.delta Need the",
      "reasoning.delta  weather.",
      'tool_call call_wx1 get_weather {"city":"Lisbon"}',
      `reasoning openai/openai-responses/${MODEL} 1`,
      "usage 320/48/256/32",
      "done tool_calls",
    ]);
  });

  it("survives CRLF line endings split at every byte", async () => {
    const crlf = text.replaceAll("\n", "\r\n");
    const { p } = provider(sse(crlf, 1));
    expect(await replay(p.stream({ model: MODEL, messages: ask }))).toHaveLength(4);
  });

  it("maps a failed response to an error and still reports its usage", async () => {
    const { p } = provider(sse(failed));
    expect(await replay(p.stream({ model: MODEL, messages: ask }))).toEqual([
      "text.delta Par",
      "usage 12/1/0/0",
      "error upstream: The server had an error processing your request.",
    ]);
  });

  it("maps HTTP and stream errors, and never repeats the key", async () => {
    const cases: [number, string][] = [
      [401, `error auth: Incorrect API key provided: [redacted].`],
      [429, "error rate_limited: Rate limit reached"],
      [500, "error upstream: HTTP 500"],
      [400, "error bad_request: Unsupported parameter"],
      [307, "error bad_request: The provider redirected the request; check the base URL"],
    ];
    for (const [status, expected] of cases) {
      const message = expected.split(": ").slice(1).join(": ").replace("[redacted]", KEY);
      const respond = () =>
        status === 500
          ? new Response("oops", { status })
          : status === 307
            ? new Response(null, { status, headers: { location: "https://evil.test/v1" } })
            : Response.json({ error: { message } }, { status });
      expect(await replay(provider(respond).p.stream({ model: MODEL, messages: ask }))).toEqual([
        expected,
      ]);
    }
    const limited = event("error", { code: "rate_limit_exceeded", message: `slow ${KEY}` });
    expect(await replay(provider(sse(limited)).p.stream({ model: MODEL, messages: ask }))).toEqual([
      "error rate_limited: slow [redacted]",
    ]);
  });

  it("never runs a call from a reply cut off at the output limit", async () => {
    const cut = toolCall.slice(0, toolCall.indexOf("event: response.completed"));
    const incomplete = event("response.incomplete", {
      response: {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        usage: { input_tokens: 320, output_tokens: 64 },
      },
    });
    const { p } = provider(sse(cut + incomplete));
    const events = await replay(p.stream({ model: MODEL, messages: ask, tools: [weather] }));
    expect(events.slice(2)).toEqual(["usage 320/64/0/0", "done length"]);
  });

  it("reports a stream that ends before the response settles", async () => {
    const cut = toolCall.slice(0, toolCall.indexOf("event: response.completed"));
    const { p } = provider(sse(cut));
    const events = await replay(p.stream({ model: MODEL, messages: ask, tools: [weather] }));
    expect(events.at(-1)).toBe("error network: The stream ended before the model finished");
    expect(events.some((e) => e.startsWith("tool_call"))).toBe(false);
  });

  it("rejects the whole reply, emitting no call, when any call has no id or name", async () => {
    const item = (fields: object) =>
      event("response.output_item.done", { item: { type: "function_call", ...fields } });
    const valid = item({ call_id: "call_1", name: "send", arguments: "{}" });
    const nameless = item({ call_id: "call_2", arguments: "{}" });
    const done = event("response.completed", { response: { status: "completed" } });
    const { p } = provider(sse(valid + nameless + done));
    expect(await replay(p.stream({ model: MODEL, messages: ask, tools: [weather] }))).toEqual([
      "error bad_response: The provider sent a tool call with no id or name",
    ]);
  });
});

describe("openai-responses requests", () => {
  it("is stateless, asks for encrypted reasoning and sends the key to the base URL", async () => {
    const { p, calls, body } = provider(sse(text));
    await replay(p.stream({ model: MODEL, messages: ask, tools: [weather], maxOutputTokens: 256 }));
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/responses");
    expect(calls[0]?.init.redirect).toBe("manual");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(body()).toEqual({
      model: MODEL,
      input: [
        { role: "developer", content: "Be brief." },
        { role: "user", content: "Weather in Lisbon?" },
      ],
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Current weather for a city",
          parameters: weather.inputSchema,
          strict: false,
        },
      ],
      max_output_tokens: 256,
    });
  });

  it("replays reasoning only when provider, API and model all match (A-M2)", async () => {
    const items = [{ type: "reasoning", id: "rs_01", encrypted_content: "enc", summary: [] }];
    const reasoning: ModelReasoning = {
      providerId: "openai",
      api: "openai-responses",
      model: MODEL,
      items,
    };
    const history = (r: ModelReasoning): ModelMessage[] => [
      ...ask,
      {
        role: "assistant",
        content: "",
        reasoning: r,
        toolCalls: [{ id: "call_wx1", name: "get_weather", arguments: '{"city":"Lisbon"}' }],
      },
      { role: "tool", toolCallId: "call_wx1", content: "18°C" },
      { role: "assistant", content: "It's 18°C." },
    ];
    const rest = [
      {
        type: "function_call",
        call_id: "call_wx1",
        name: "get_weather",
        arguments: '{"city":"Lisbon"}',
      },
      { type: "function_call_output", call_id: "call_wx1", output: "18°C" },
      { role: "assistant", content: "It's 18°C." },
    ];
    const variants: [string, ModelReasoning, boolean][] = [
      ["same", reasoning, true],
      ["another model", { ...reasoning, model: "gpt-5" }, false],
      ["another API", { ...reasoning, api: "openai-chat" }, false],
      ["another provider", { ...reasoning, providerId: "openrouter" }, false],
    ];
    for (const [, r, replayed] of variants) {
      const { p, body } = provider(sse(text));
      await replay(p.stream({ model: MODEL, messages: history(r) }));
      expect(body().input.slice(2)).toEqual(replayed ? [...items, ...rest] : rest);
    }
  });

  it("keeps a key bound to its origin: a redirect elsewhere is never followed", async () => {
    const { p, calls } = provider(
      () => new Response(null, { status: 302, headers: { location: "https://evil.test/v1" } }),
    );
    const events = await replay(p.stream({ model: MODEL, messages: ask }));
    expect(events[0]).toMatch(/^error bad_request: The provider redirected/);
    expect(calls.map((c) => c.url)).toEqual(["https://api.openai.com/v1/responses"]);
  });
});

describe("the wire API is a property of the preset", () => {
  it("uses Responses for the OpenAI preset only", () => {
    expect(usesOpenAIResponses("openai", "https://api.openai.com/v1")).toBe(true);
    expect(usesOpenAIResponses("openai", "https://API.openai.com/v1/")).toBe(true);
    // Other hosts, and OpenAI's own host under another preset, stay on Chat Completions.
    expect(usesOpenAIResponses("openai", "https://api.example.com/v1")).toBe(false);
    expect(usesOpenAIResponses("custom", "https://api.openai.com/v1")).toBe(false);
    expect(usesOpenAIResponses("openrouter", "https://openrouter.ai/api/v1")).toBe(false);
    expect(usesOpenAIResponses("openai", null)).toBe(false);
    expect(usesOpenAIResponses("openai", "not a url")).toBe(false);
  });
});
