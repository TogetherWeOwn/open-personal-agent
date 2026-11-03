// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createWorkersAIProvider, STARTER_MODEL, type WorkersAIBinding } from "../src/workers-ai";
import openaiText from "./fixtures/openai-chat-text.sse?raw";
import workersAiLegacy from "./fixtures/workers-ai-legacy.sse?raw";
import { byteStream, replay } from "./helpers";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const hello = { model: MODEL, messages: [{ role: "user" as const, content: "Hi" }] };

function binding(fixture: string) {
  const runs: unknown[] = [];
  const ai: WorkersAIBinding = {
    run: async (model, inputs) => {
      runs.push({ model, inputs });
      return byteStream(fixture);
    },
    models: async () => [{ name: MODEL }],
  };
  return { p: createWorkersAIProvider(ai), runs };
}

describe("workers-ai-binding", () => {
  it("replays the `{ response }` stream with usage", async () => {
    const { p, runs } = binding(workersAiLegacy);
    expect(await replay(p.stream({ ...hello, maxOutputTokens: 99 }))).toEqual([
      "text.delta Hi",
      "text.delta  from",
      "text.delta  the edge.",
      "usage 25/6/0/0",
      "done stop",
    ]);
    const inputs = { messages: hello.messages, stream: true, max_tokens: 99 };
    expect(runs).toEqual([{ model: MODEL, inputs }]);
  });

  it("replays models that stream OpenAI-shaped chunks", async () => {
    expect(await replay(binding(openaiText).p.stream(hello))).toContain("usage 1210/3/1024/0");
  });

  it("reports binding failures", async () => {
    const run = async () => Promise.reject(new Error("3036: account limit"));
    expect(await replay(createWorkersAIProvider({ run }).stream(hello))).toEqual([
      "error upstream: 3036: account limit",
    ]);
  });

  it("lists text-generation models by name", async () => {
    const { p } = binding("");
    expect(await p.listModels()).toEqual([{ id: MODEL, label: MODEL }]);
    expect(p.capabilities(MODEL)).toEqual({
      tools: false,
      usageInStream: true,
      imageInput: false,
      pdfInput: false,
    });
  });

  it("reports the chat-only starter as tool-incapable (TWO-1960)", async () => {
    expect(MODEL).toBe(STARTER_MODEL);
    const { p } = binding("");
    expect(p.capabilities(STARTER_MODEL).tools).toBe(false);
    expect(p.capabilities("@cf/openai/gpt-oss-20b").tools).toBe(true);
  });

  it("names tools when the binding refuses a tools-offering request (TWO-1960)", async () => {
    const offered: unknown[] = [];
    const ai: WorkersAIBinding = {
      run: async (_model, inputs) => {
        offered.push(inputs);
        throw new Error("Tool calls are not supported for this model");
      },
    };
    const events = await replay(
      createWorkersAIProvider(ai).stream({
        model: "@cf/openai/gpt-oss-20b",
        messages: [{ role: "user", content: "Hi" }],
        tools: [
          {
            name: "web_fetch",
            description: "Fetch a page.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
    );
    expect(offered).toHaveLength(1);
    expect(events).toEqual([
      "error upstream: Tool calls are not supported for this model (the model refused a request offering tools; retry without tools or use a tool-capable model)",
    ]);
  });

  it("stays conditional when a tools-bearing request fails without naming tools (TWO-1960)", async () => {
    const offered: unknown[] = [];
    const ai: WorkersAIBinding = {
      run: async (_model, inputs) => {
        offered.push(inputs);
        throw new Error("3036: account limit");
      },
    };
    const events = await replay(
      createWorkersAIProvider(ai).stream({
        model: "@cf/openai/gpt-oss-20b",
        messages: [{ role: "user", content: "Hi" }],
        tools: [
          {
            name: "web_fetch",
            description: "Fetch a page.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
    );
    expect(offered).toHaveLength(1);
    expect(events).toEqual([
      "error upstream: 3036: account limit (this request offered tools; if the model does not support tools, retry without tools or use a tool-capable model)",
    ]);
  });
});
