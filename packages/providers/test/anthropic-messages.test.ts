// SPDX-License-Identifier: Apache-2.0
import type { ModelEvent, ModelMessage, ModelReasoning, ModelTool, ModelToolCall } from "@opa/core";
import { describe, expect, it } from "vitest";
import { createAnthropicMessagesProvider } from "../src/anthropic-messages";
import { messagesBody } from "../src/anthropic-request";
import { credentialBinding } from "../src/credential-binding";
import overloaded from "./fixtures/anthropic-overloaded.sse?raw";
import text from "./fixtures/anthropic-text.sse?raw";
import thinkingAnswer from "./fixtures/anthropic-thinking-answer.sse?raw";
import thinkingToolCall from "./fixtures/anthropic-thinking-tool-call.sse?raw";
import { byteStream, replay } from "./helpers";

const MODEL = "claude-opus-5-5";
const weather: ModelTool = {
  name: "get_weather",
  description: "Current weather for a city",
  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};
const time: ModelTool = {
  name: "get_time",
  description: "Local time in a zone",
  inputSchema: { type: "object", properties: { zone: { type: "string" } } },
};
const ask: ModelMessage[] = [
  { role: "system", content: "You are a helpful assistant." },
  { role: "user", content: "Weather and time in Lisbon?" },
];

/** A provider answering each call with the next fixture, recording what it was sent. */
function anthropic(fixtures: (string | Response)[], providerId = "anthropic") {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : {} });
    const next = fixtures[calls.length - 1] ?? "";
    return typeof next === "string" ? new Response(byteStream(next)) : next;
  }) as typeof globalThis.fetch;
  const p = createAnthropicMessagesProvider({
    providerId,
    baseUrl: "https://api.anthropic.com/v1/",
    apiKey: "sk-ant-test",
    fetch,
  });
  return { p, calls };
}

async function collect(events: AsyncIterable<ModelEvent>) {
  const toolCalls: ModelToolCall[] = [];
  let reasoning: ModelReasoning | undefined;
  for await (const e of events) {
    if (e.type === "tool_call") toolCalls.push(e.toolCall);
    if (e.type === "reasoning") reasoning = e.reasoning;
  }
  return { toolCalls, reasoning };
}

const SIGNED = {
  type: "thinking",
  thinking: "",
  signature: "EosnCkYICxIMMb3LzNrMuWaUjzkypQ2mUEVM36O2Txu",
};

describe("anthropic-messages", () => {
  it("streams text and reports cache reads inside the input count", async () => {
    const { p, calls } = anthropic([text]);
    expect(await replay(p.stream({ model: MODEL, messages: ask }))).toEqual([
      "text.delta Lisbon is ",
      "text.delta sunny, ",
      "text.delta 22 °C.",
      // 12 uncached + 1840 read from the cache; nothing written.
      "usage 1852/9/1840/0/0",
      "done stop",
    ]);
    const [call] = calls;
    expect(call?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call?.init.redirect).toBe("manual");
    expect(call?.init.headers).not.toHaveProperty("authorization");
    expect(call?.init.headers).toMatchObject({
      "x-api-key": "sk-ant-test",
      "anthropic-version": "2026-10-21",
    });
    expect(call?.body).toEqual(messagesBody({ model: MODEL, messages: ask }, "anthropic"));
  });

  it("assembles tool calls and keeps the signed thinking for replay", async () => {
    const { p } = anthropic([thinkingToolCall, thinkingToolCall]);
    const request = { model: MODEL, messages: ask, tools: [weather, time] };
    expect(await replay(p.stream(request))).toEqual([
      "text.delta Checking both.",
      'tool_call toolu_wx1 get_weather {"city": "Lisbon"}',
      'tool_call toolu_tm2 get_time {"zone": "Europe/Lisbon"}',
      `reasoning anthropic/anthropic-messages/${MODEL} 4`,
      // 30 uncached + 1840 written to the cache.
      "usage 1870/88/0/0/1840",
      "done tool_calls",
    ]);
    const { reasoning } = await collect(p.stream(request));
    expect(reasoning?.items).toEqual([
      SIGNED,
      { type: "text", chars: 14 },
      { type: "tool_use", id: "toolu_wx1" },
      { type: "tool_use", id: "toolu_tm2" },
    ]);
  });

  it("round-trips the calls with their thinking unchanged and in order", async () => {
    const { p, calls } = anthropic([thinkingToolCall, thinkingAnswer]);
    const first = await collect(p.stream({ model: MODEL, messages: ask, tools: [weather, time] }));
    const history: ModelMessage[] = [
      ...ask,
      {
        role: "assistant",
        content: "Checking both.",
        toolCalls: first.toolCalls,
        ...(first.reasoning ? { reasoning: first.reasoning } : {}),
      },
      { role: "tool", toolCallId: "toolu_wx1", content: '{"sky":"sunny","c":22}' },
      { role: "tool", toolCallId: "toolu_tm2", content: "14:05" },
    ];
    expect(await replay(p.stream({ model: MODEL, messages: history, tools: [weather] }))).toEqual([
      "reasoning.delta Both tools answered. ",
      "reasoning.delta Summarize.",
      "text.delta Sunny, 22 °C, and it is 14:05.",
      `reasoning anthropic/anthropic-messages/${MODEL} 3`,
      "usage 2114/41/1840/0/210",
      "done stop",
    ]);
    // What the stream recorded goes back exactly as the request tests expect.
    const sent = calls[1]?.body.messages as { role: string; content: unknown }[];
    expect(sent[1]?.content).toEqual([
      SIGNED,
      { type: "text", text: "Checking both." },
      { type: "tool_use", id: "toolu_wx1", name: "get_weather", input: { city: "Lisbon" } },
      { type: "tool_use", id: "toolu_tm2", name: "get_time", input: { zone: "Europe/Lisbon" } },
    ]);
  });

  it("keeps thinking out of history when a block came back unsigned", async () => {
    const unsigned = thinkingToolCall.replace(/("signature":)"E[^"]+"/, '$1""');
    const { p } = anthropic([unsigned]);
    const { reasoning, toolCalls } = await collect(
      p.stream({ model: MODEL, messages: ask, tools: [weather] }),
    );
    expect(reasoning).toBeUndefined();
    expect(toolCalls).toHaveLength(2);
  });

  it("drops calls from a reply cut off at the output limit", async () => {
    const cut = thinkingToolCall.replace('"stop_reason":"tool_use"', '"stop_reason":"max_tokens"');
    const { p } = anthropic([cut]);
    const events = await replay(p.stream({ model: MODEL, messages: ask, tools: [weather] }));
    expect(events.filter((e) => e.startsWith("tool_call"))).toEqual([]);
    expect(events.at(-1)).toBe("done length");
  });

  it("maps a mid-stream error and a stream cut before message_stop", async () => {
    const { p } = anthropic([overloaded, text.split("event: message_stop")[0] ?? ""]);
    expect(await replay(p.stream({ model: MODEL, messages: ask }))).toEqual([
      "text.delta Lis",
      "error upstream: Overloaded",
    ]);
    expect((await replay(p.stream({ model: MODEL, messages: ask }))).at(-1)).toBe(
      "error network: The stream ended before the model finished",
    );
  });

  it("maps HTTP errors and keeps the key out of the message", async () => {
    const body = (type: string, message: string) =>
      JSON.stringify({ type: "error", error: { type, message } });
    const { p } = anthropic([
      new Response(body("authentication_error", "invalid x-api-key sk-ant-test"), { status: 401 }),
      new Response(body("rate_limit_error", "Slow down"), { status: 429 }),
      new Response(body("overloaded_error", "Overloaded"), { status: 529 }),
      new Response(body("invalid_request_error", "max_tokens: too large"), { status: 400 }),
      new Response(null, { status: 307, headers: { location: "https://elsewhere.test/" } }),
    ]);
    const results = [];
    for (let i = 0; i < 5; i++)
      results.push(...(await replay(p.stream({ model: MODEL, messages: ask }))));
    expect(results).toEqual([
      "error auth: invalid x-api-key [redacted]",
      "error rate_limited: Slow down",
      "error upstream: Overloaded",
      "error bad_request: max_tokens: too large",
      "error bad_request: The provider redirected the request; check the base URL",
    ]);
  });

  it("lists models with their display names and refuses a key over plain HTTP", async () => {
    const list = new Response(
      JSON.stringify({ data: [{ id: MODEL, display_name: "Claude Opus 5.5" }] }),
    );
    const { p, calls } = anthropic([list]);
    expect(await p.listModels()).toEqual([{ id: MODEL, label: "Claude Opus 5.5" }]);
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(p.capabilities(MODEL)).toEqual({ tools: true, usageInStream: true });
    expect(() =>
      createAnthropicMessagesProvider({
        providerId: "anthropic",
        baseUrl: "http://api.anthropic.com/v1",
        apiKey: "sk-ant-test",
      }),
    ).toThrow("must use https");
  });

  it("binds the key to the Anthropic origin", () => {
    expect(credentialBinding("anthropic", "https://api.anthropic.com/v1")).toBe(
      "model:anthropic|https://api.anthropic.com",
    );
    expect(credentialBinding("anthropic", "https://api.anthropic.com.attacker.test/v1")).not.toBe(
      credentialBinding("anthropic", "https://api.anthropic.com/v1"),
    );
  });
});
