// SPDX-License-Identifier: Apache-2.0
import type { ModelMessage } from "@opa/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpenAIChatProvider } from "../../packages/providers/src";
import { MOCK_MODEL, startMockOpenAI } from "../mock-openai.mjs";

let server: { url: string; close(): Promise<void> };
beforeAll(async () => {
  server = await startMockOpenAI({ port: 0 });
});
afterAll(() => server.close());

describe("mock OpenAI-compatible server", () => {
  it("streams an echo through the openai-chat adapter", async () => {
    const provider = createOpenAIChatProvider({ providerId: "mock", baseUrl: server.url });
    expect(await provider.listModels()).toEqual([{ id: MOCK_MODEL, label: MOCK_MODEL }]);
    const events = [];
    for await (const event of provider.stream({
      model: MOCK_MODEL,
      messages: [{ role: "user", content: "hi there" }],
    })) {
      events.push(event);
    }
    const text = events.flatMap((e) => (e.type === "text.delta" ? [e.text] : [])).join("");
    expect(text).toBe("You said: hi there");
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "stop" });
  });

  it("calls the first offered tool once, then echoes the follow-up", async () => {
    const provider = createOpenAIChatProvider({ providerId: "mock", baseUrl: server.url });
    const tools = [
      {
        name: "lookup",
        description: "The smoke's tool.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ];
    const first = [];
    for await (const event of provider.stream({
      model: MOCK_MODEL,
      messages: [{ role: "user", content: "hi there" }],
      tools,
    })) {
      first.push(event);
    }
    const calls = first.filter((e) => e.type === "tool_call");
    expect(calls).toEqual([
      { type: "tool_call", toolCall: { id: "call_1", name: "lookup", arguments: "{}" } },
    ]);
    expect(first.at(-1)).toEqual({ type: "done", finishReason: "tool_calls" });

    // With the tool result in the history, the mock echoes instead of calling again.
    const second = [];
    for await (const event of provider.stream({
      model: MOCK_MODEL,
      messages: [
        { role: "user", content: "hi there" },
        {
          role: "assistant",
          toolCalls: [{ id: "call_1", name: "lookup", arguments: "{}" }],
          content: "",
        },
        { role: "tool", toolCallId: "call_1", content: "found it" },
      ],
      tools,
    })) {
      second.push(event);
    }
    expect(second.some((e) => e.type === "tool_call")).toBe(false);
    const text = second.flatMap((e) => (e.type === "text.delta" ? [e.text] : [])).join("");
    expect(text).toBe("You said: hi there");
  });

  it("calls the tool again on a later user turn, then echoes each follow-up", async () => {
    const provider = createOpenAIChatProvider({ providerId: "mock", baseUrl: server.url });
    const tools = [
      {
        name: "lookup",
        description: "The smoke's tool.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ];
    const history: ModelMessage[] = [];
    async function turn(text: string) {
      history.push({ role: "user", content: text });
      const events = [];
      for await (const event of provider.stream({ model: MOCK_MODEL, messages: history, tools })) {
        events.push(event);
      }
      return events;
    }
    for (const [i, text] of ["first", "second"].entries()) {
      const callEvents = await turn(text);
      const calls = callEvents.filter((e) => e.type === "tool_call");
      expect(calls).toHaveLength(1);
      expect(callEvents.at(-1)).toEqual({ type: "done", finishReason: "tool_calls" });
      history.push({
        role: "assistant",
        toolCalls: [{ id: `call_${i + 1}`, name: "lookup", arguments: "{}" }],
        content: "",
      });
      history.push({ role: "tool", toolCallId: `call_${i + 1}`, content: "found it" });

      // The follow-up carrying the tool result echoes instead of calling again.
      const echoEvents = [];
      for await (const event of provider.stream({ model: MOCK_MODEL, messages: history, tools })) {
        echoEvents.push(event);
      }
      expect(echoEvents.some((e) => e.type === "tool_call")).toBe(false);
      const echo = echoEvents.flatMap((e) => (e.type === "text.delta" ? [e.text] : [])).join("");
      expect(echo).toBe(`You said: ${text}`);
    }
  });

  it("answers a malformed request with 400 and keeps serving", async () => {
    for (const body of ["{bad", '{"messages":"nope"}']) {
      const res = await fetch(`${server.url}/chat/completions`, { method: "POST", body });
      expect(res.status).toBe(400);
    }
    expect((await fetch(`${server.url}/models`)).status).toBe(200);
  });
});
