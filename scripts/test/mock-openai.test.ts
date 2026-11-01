// SPDX-License-Identifier: Apache-2.0
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

  it("answers a malformed request with 400 and keeps serving", async () => {
    for (const body of ["{bad", '{"messages":"nope"}']) {
      const res = await fetch(`${server.url}/chat/completions`, { method: "POST", body });
      expect(res.status).toBe(400);
    }
    expect((await fetch(`${server.url}/models`)).status).toBe(200);
  });
});
