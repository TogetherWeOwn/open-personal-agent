// SPDX-License-Identifier: Apache-2.0
import type { ModelMessage, ModelReasoning, ModelTool, ModelToolCall } from "@opa/core";
import { describe, expect, it } from "vitest";
import { messagesBody, type ReplayBlock } from "../src/anthropic-request";

const MODEL = "claude-opus-5-5";
const EPHEMERAL = { type: "ephemeral" };
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
const SIGNED = { type: "thinking", thinking: "", signature: "EosnCkYICxIMMb3LzNrMu" } as const;
const REDACTED = { type: "redacted_thinking", data: "EmwKAhgB" } as const;

const reasoning = (blocks: ReplayBlock[], over: Partial<ModelReasoning> = {}): ModelReasoning => ({
  providerId: "anthropic",
  api: "anthropic-messages",
  model: MODEL,
  data: { blocks },
  ...over,
});
const call = (id: string, name = "get_time", args = "{}"): ModelToolCall => ({
  id,
  name,
  arguments: args,
});
const use = (id: string, name = "get_time", input = {}) => ({ type: "tool_use", id, name, input });

/** The wire messages for `messages` sent to `model` through provider `anthropic`. */
const wire = (messages: ModelMessage[], model = MODEL) =>
  messagesBody({ model, messages }, "anthropic").messages as { role: string; content: unknown }[];

describe("anthropic-messages request", () => {
  it("puts the system prompt on top with cache_control, and sends no temperature", () => {
    expect(messagesBody({ model: MODEL, messages: ask, temperature: 0.2 }, "anthropic")).toEqual({
      model: MODEL,
      max_tokens: 16000,
      stream: true,
      system: [{ type: "text", text: "You are a helpful assistant.", cache_control: EPHEMERAL }],
      messages: [
        { role: "user", content: [{ type: "text", text: "Weather and time in Lisbon?" }] },
      ],
    });
    const body = messagesBody({ model: MODEL, messages: ask, maxOutputTokens: 512 }, "a");
    expect(body.max_tokens).toBe(512);
  });

  it("puts cache_control on the last tool only", () => {
    const body = messagesBody({ model: MODEL, messages: ask, tools: [weather, time] }, "anthropic");
    expect(body.tools).toEqual([
      { name: "get_weather", description: weather.description, input_schema: weather.inputSchema },
      {
        name: "get_time",
        description: time.description,
        input_schema: time.inputSchema,
        cache_control: EPHEMERAL,
      },
    ]);
  });

  it("replays a tool turn with its thinking unchanged, and its results in one user message", () => {
    const blocks: ReplayBlock[] = [
      SIGNED,
      { type: "text", chars: 14 },
      { type: "tool_use", id: "toolu_wx1" },
      { type: "tool_use", id: "toolu_tm2" },
    ];
    const history: ModelMessage[] = [
      ...ask,
      {
        role: "assistant",
        content: "Checking both.",
        toolCalls: [
          call("toolu_wx1", "get_weather", '{"city": "Lisbon"}'),
          call("toolu_tm2", "get_time", '{"zone": "Europe/Lisbon"}'),
        ],
        reasoning: reasoning(blocks),
      },
      { role: "tool", toolCallId: "toolu_wx1", content: '{"sky":"sunny","c":22}' },
      { role: "tool", toolCallId: "toolu_tm2", content: "14:05" },
    ];
    expect(wire(history)).toEqual([
      { role: "user", content: [{ type: "text", text: "Weather and time in Lisbon?" }] },
      {
        role: "assistant",
        content: [
          SIGNED,
          { type: "text", text: "Checking both." },
          use("toolu_wx1", "get_weather", { city: "Lisbon" }),
          use("toolu_tm2", "get_time", { zone: "Europe/Lisbon" }),
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_wx1", content: '{"sky":"sunny","c":22}' },
          { type: "tool_result", tool_use_id: "toolu_tm2", content: "14:05" },
        ],
      },
    ]);
  });

  it("replays thinking only when provider, API and model all match (A-M2)", () => {
    const sent = (r: ModelReasoning, model = MODEL) =>
      wire(
        [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hi", reasoning: r },
          { role: "user", content: "Again" },
        ],
        model,
      )[1]?.content;
    const r = reasoning([SIGNED, { type: "text", chars: 2 }]);
    expect(sent(r)).toEqual([SIGNED, { type: "text", text: "Hi" }]);
    const plain = [{ type: "text", text: "Hi" }];
    expect(sent({ ...r, providerId: "work-anthropic" })).toEqual(plain);
    expect(sent({ ...r, api: "openai-responses" })).toEqual(plain);
    expect(sent(r, "claude-sonnet-5-5")).toEqual(plain);
  });

  it("keeps interleaved thinking between the calls it came with, and only its own fields", () => {
    const content = wire([
      { role: "user", content: "Go" },
      {
        role: "assistant",
        // Not the length the placeholders recorded, so it goes in whole after the first thinking.
        content: "Edited.",
        toolCalls: [call("t1"), call("t2"), call("t3")],
        reasoning: reasoning([
          { ...SIGNED, extra: "dropped" } as ReplayBlock,
          { type: "tool_use", id: "t1" },
          REDACTED,
          { type: "tool_use", id: "t2" },
        ]),
      },
    ])[1]?.content;
    // A call the placeholders don't name goes last.
    expect(content).toEqual([
      SIGNED,
      { type: "text", text: "Edited." },
      use("t1"),
      REDACTED,
      use("t2"),
      use("t3"),
    ]);
  });

  it("merges system prompts and roles, skips empty turns and sends a non-object input as {}", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "One." },
      { role: "system", content: "Two." },
      { role: "user", content: "Go" },
      // A cancelled reply with nothing in it.
      { role: "assistant", content: "" },
      { role: "user", content: "Go on" },
      { role: "assistant", content: "", toolCalls: [call("t1", "x", "[1")] },
      { role: "tool", toolCallId: "t1", content: "" },
      { role: "assistant", content: "", toolCalls: [call("t2", "x", "[1, 2]")] },
    ];
    const body = messagesBody({ model: MODEL, messages }, "anthropic");
    expect(body.system).toEqual([{ type: "text", text: "One.\n\nTwo.", cache_control: EPHEMERAL }]);
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Go" },
          { type: "text", text: "Go on" },
        ],
      },
      { role: "assistant", content: [use("t1", "x")] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] },
      { role: "assistant", content: [use("t2", "x")] },
    ]);
  });
});
