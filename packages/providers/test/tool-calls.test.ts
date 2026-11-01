// SPDX-License-Identifier: Apache-2.0
import type { ModelEvent, ModelMessage, ModelTool, ModelToolCall } from "@opa/core";
import { describe, expect, it } from "vitest";
import { createOpenAIChatProvider } from "../src/openai-chat";
import { createWorkersAIProvider } from "../src/workers-ai";
import openaiText from "./fixtures/openai-chat-text.sse?raw";
import openaiToolCall from "./fixtures/openai-chat-tool-call.sse?raw";
import workersAiToolCall from "./fixtures/workers-ai-tool-call.sse?raw";
import { byteStream, replay } from "./helpers";

const weather: ModelTool = {
  name: "get_weather",
  description: "Current weather for a city",
  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};
const ask: ModelMessage[] = [{ role: "user", content: "Weather and time in Lisbon?" }];
const wireTool = {
  type: "function",
  function: {
    name: weather.name,
    description: weather.description,
    parameters: weather.inputSchema,
  },
};
const GENERATED_ID = /^tool_call call_[0-9a-f]{32} /;

/** An `openai-chat` provider answering each call with the next fixture, recording the bodies. */
function openai(fixtures: string[], compat = {}) {
  const bodies: Record<string, unknown>[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(byteStream(fixtures[bodies.length - 1] ?? ""));
  }) as typeof globalThis.fetch;
  const p = createOpenAIChatProvider({
    providerId: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    compat,
    fetch,
  });
  return { p, bodies };
}

function workersAi(reply: unknown) {
  const inputs: Record<string, unknown>[] = [];
  const p = createWorkersAIProvider({
    run: async (_model, i) => {
      inputs.push(i);
      return typeof reply === "string" ? byteStream(reply) : reply;
    },
  });
  return { p, inputs };
}

async function collect(events: AsyncIterable<ModelEvent>) {
  const calls: ModelToolCall[] = [];
  for await (const e of events) if (e.type === "tool_call") calls.push(e.toolCall);
  return calls;
}

const chunk = (delta: object, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`;

describe("openai-chat tool calls", () => {
  it("assembles parallel calls from fragments and emits each once, before usage", async () => {
    const { p, bodies } = openai([openaiToolCall]);
    expect(await replay(p.stream({ model: "m", messages: ask, tools: [weather] }))).toEqual([
      'tool_call call_wx1 get_weather {"city":"Lisbon"}',
      'tool_call call_tm2 get_time {"zone":"Europe/Lisbon"}',
      "usage 96/41/0/0",
      "done tool_calls",
    ]);
    expect(bodies[0]?.tools).toEqual([wireTool]);
  });

  it("round-trips a call and its result back to the model", async () => {
    const { p, bodies } = openai([openaiToolCall, openaiText]);
    const calls = await collect(p.stream({ model: "m", messages: ask, tools: [weather] }));
    const history: ModelMessage[] = [
      ...ask,
      { role: "assistant", content: "", toolCalls: calls },
      ...calls.map((c) => ({ role: "tool" as const, toolCallId: c.id, content: `${c.name}: ok` })),
    ];
    const reply = await replay(p.stream({ model: "m", messages: history, tools: [weather] }));
    expect(reply).toEqual([
      "text.delta Hello",
      "text.delta  there.",
      "usage 1210/3/1024/0",
      "done stop",
    ]);
    expect(bodies[1]?.messages).toEqual([
      { role: "user", content: "Weather and time in Lisbon?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_wx1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Lisbon"}' },
          },
          {
            id: "call_tm2",
            type: "function",
            function: { name: "get_time", arguments: '{"zone":"Europe/Lisbon"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_wx1", content: "get_weather: ok" },
      { role: "tool", tool_call_id: "call_tm2", content: "get_time: ok" },
    ]);
  });

  it("sends no tools when none are offered", async () => {
    const { p, bodies } = openai([openaiText]);
    await replay(p.stream({ model: "m", messages: ask, tools: [] }));
    expect(bodies[0]).not.toHaveProperty("tools");
  });

  it("refuses tools when the host is set up without them", async () => {
    const { p, bodies } = openai([openaiText], { supportsTools: false });
    expect(await replay(p.stream({ model: "m", messages: ask, tools: [weather] }))).toEqual([
      "error bad_request: This provider is set up without tool support",
    ]);
    expect(bodies).toEqual([]);
  });

  it("handles hosts that omit index and id, repeat the name and finish with `stop`", async () => {
    const fn = (name: string | undefined, args: string) => ({
      tool_calls: [{ function: { ...(name ? { name } : {}), arguments: args } }],
    });
    const stream = [
      chunk(fn("get_weather", '{"city":')),
      chunk(fn("get_weather", '"Porto"}')),
      chunk({}, "stop"),
      "data: [DONE]\n\n",
    ].join("");
    const { p } = openai([stream]);
    const events = await replay(p.stream({ model: "m", messages: ask, tools: [weather] }));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatch(GENERATED_ID);
    expect(events[0]).toMatch(/ get_weather \{"city":"Porto"\}$/);
    expect(events[1]).toBe("done tool_calls");
  });

  it("splits calls that share an index but not an id", async () => {
    const call = (id: string, city: string) => ({
      tool_calls: [
        { index: 0, id, function: { name: "get_weather", arguments: `{"city":"${city}"}` } },
      ],
    });
    const stream = `${chunk(call("a", "Porto"))}${chunk(call("b", "Faro"))}data: [DONE]\n\n`;
    const { p } = openai([stream]);
    expect(await replay(p.stream({ model: "m", messages: ask, tools: [weather] }))).toEqual([
      'tool_call a get_weather {"city":"Porto"}',
      'tool_call b get_weather {"city":"Faro"}',
      "done tool_calls",
    ]);
  });

  it("gives a no-argument call `{}` and rejects a call with no name", async () => {
    const noArgs = [chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "now" } }] })];
    const { p } = openai([`${noArgs[0]}${chunk({}, "tool_calls")}data: [DONE]\n\n`]);
    expect(await replay(p.stream({ model: "m", messages: ask, tools: [weather] }))).toEqual([
      "tool_call c1 now {}",
      "done tool_calls",
    ]);
    const nameless = chunk({ tool_calls: [{ index: 0, id: "c1", function: { arguments: "{}" } }] });
    const usage = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } })}\n\n`;
    const bad = openai([`${nameless}${chunk({}, "tool_calls")}${usage}data: [DONE]\n\n`]).p;
    // The call was billed, so its usage still reaches the ledger.
    expect(await replay(bad.stream({ model: "m", messages: ask, tools: [weather] }))).toEqual([
      "usage 9/2/0/0",
      "error bad_response: The provider sent a tool call with no name",
    ]);
  });

  it("never emits a call from a reply cut off at the output limit", async () => {
    const half = chunk({
      tool_calls: [{ index: 0, id: "c1", function: { name: "get_weather", arguments: '{"ci' } }],
    });
    const { p } = openai([`${half}${chunk({}, "length")}data: [DONE]\n\n`]);
    expect(await replay(p.stream({ model: "m", messages: ask, tools: [weather] }))).toEqual([
      "done length",
    ]);
  });

  it("emits no call from a stream that was cut off mid-call", async () => {
    const cut = openaiToolCall.slice(
      0,
      openaiToolCall.indexOf('"finish_reason":"tool_calls"') - 80,
    );
    const events = await replay(
      openai([cut]).p.stream({ model: "m", messages: ask, tools: [weather] }),
    );
    expect(events).toEqual(["error network: The stream ended before the model finished"]);
  });
});

describe("workers-ai-binding tool calls", () => {
  const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

  it("replays the older whole-call shape and gives the call an id", async () => {
    const { p, inputs } = workersAi(workersAiToolCall);
    const events = await replay(p.stream({ model: MODEL, messages: ask, tools: [weather] }));
    expect(events).toHaveLength(3);
    expect(events[0]).toMatch(GENERATED_ID);
    expect(events[0]).toMatch(/ get_weather \{"city":"Lisbon"\}$/);
    expect(events.slice(1)).toEqual(["usage 312/18/0/0", "done tool_calls"]);
    expect(inputs[0]).toEqual({ messages: ask, stream: true, tools: [wireTool] });
    expect(p.capabilities(MODEL)).toEqual({ tools: true, usageInStream: true });
    // A model the catalogue doesn't list as taking tools isn't reported as supporting them.
    expect(p.capabilities("@cf/meta/llama-2-7b-chat-int8").tools).toBe(false);
  });

  it("replays models that stream OpenAI-shaped calls", async () => {
    expect(
      await replay(workersAi(openaiToolCall).p.stream({ model: MODEL, messages: ask })),
    ).toEqual([
      'tool_call call_wx1 get_weather {"city":"Lisbon"}',
      'tool_call call_tm2 get_time {"zone":"Europe/Lisbon"}',
      "usage 96/41/0/0",
      "done tool_calls",
    ]);
  });

  it("round-trips a call and its result in the chat shape", async () => {
    const { p, inputs } = workersAi(openaiText);
    const call = { id: "call_wx1", name: "get_weather", arguments: '{"city":"Lisbon"}' };
    const history: ModelMessage[] = [
      ...ask,
      { role: "assistant", content: "Checking.", toolCalls: [call] },
      { role: "tool", toolCallId: call.id, content: "18°C, clear" },
    ];
    expect(await replay(p.stream({ model: MODEL, messages: history }))).toContain("done stop");
    expect(inputs[0]?.messages).toEqual([
      ask[0],
      {
        role: "assistant",
        content: "Checking.",
        tool_calls: [
          {
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          },
        ],
      },
      { role: "tool", tool_call_id: call.id, content: "18°C, clear" },
    ]);
  });

  it.each([
    ["older", { response: "", tool_calls: [{ name: "get_weather", arguments: { city: "Faro" } }] }],
    [
      "chat",
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "c9",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"city":"Faro"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 9 },
      },
    ],
  ])("takes a whole-object reply in the %s shape", async (_shape, reply) => {
    const events = await replay(
      workersAi(reply).p.stream({ model: MODEL, messages: ask, tools: [weather] }),
    );
    expect(events.at(-1)).toBe("done tool_calls");
    expect(events[0]).toMatch(/^tool_call \S+ get_weather \{"city":"Faro"\}$/);
  });

  it("drops a whole-object reply that arrives after a cancel", async () => {
    const controller = new AbortController();
    const reply = {
      response: "",
      tool_calls: [{ name: "get_weather", arguments: { city: "Faro" } }],
    };
    const p = createWorkersAIProvider({
      run: async () => {
        controller.abort();
        return reply;
      },
    });
    const request = { model: MODEL, messages: ask, tools: [weather], signal: controller.signal };
    expect(await replay(p.stream(request))).toEqual(["error aborted: The request was cancelled"]);
  });
});
