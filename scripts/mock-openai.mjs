// SPDX-License-Identifier: Apache-2.0
// A mock OpenAI-compatible model server for local development and tests: `GET /v1/models` and a
// streaming `POST /v1/chat/completions` that echoes the last user message. No key needed, no cost.
// When the request offers tools and carries no tool result yet, it calls the first offered tool
// once (empty arguments) instead of echoing, so a smoke test can run one tool turn.
import { createServer } from "node:http";
import { isMain } from "./lib/repo.mjs";

export const MOCK_MODEL = "mock-echo";

const chunk = (choices, usage = null) =>
  `data: ${JSON.stringify({ id: "mock-1", object: "chat.completion.chunk", model: MOCK_MODEL, choices, usage })}\n\n`;

/** Starts the server on `port` (0 picks a free one). Resolves to `{ url, close }`. */
export function startMockOpenAI({ port = 8788, host = "127.0.0.1" } = {}) {
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({ object: "list", data: [{ id: MOCK_MODEL, object: "model" }] }),
      );
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Not found" } }));
    }
    let raw = "";
    for await (const part of req) raw += part;
    let body;
    try {
      body = JSON.parse(raw);
      if (!Array.isArray(body.messages)) throw new Error("messages must be an array");
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Invalid request body" } }));
    }
    const last = body.messages.findLast((m) => m?.role === "user")?.content ?? "";
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const firstTool = tools[0]?.function?.name;
    const answeredTool = body.messages.some(
      (m) => m?.role === "tool" || (Array.isArray(m?.tool_calls) && m.tool_calls.length > 0),
    );
    if (typeof firstTool === "string" && firstTool && !answeredTool) {
      // The CI smoke's one tool call (M3-23a AC2): with tools offered and no tool result yet,
      // call the first one with empty arguments. The follow-up request carries the tool
      // result, so it falls through to the echo below.
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.write(
        chunk([
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", function: { name: firstTool, arguments: "{}" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ]),
      );
      if (body.stream_options?.include_usage) {
        const usage = { prompt_tokens: raw.length, completion_tokens: 1 };
        res.write(chunk([], { ...usage, total_tokens: usage.prompt_tokens + 1 }));
      }
      res.end("data: [DONE]\n\n");
      return;
    }
    const words = `You said: ${last}`.split(/(?<= )/);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    res.write(
      chunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]),
    );
    for (const word of words) {
      res.write(chunk([{ index: 0, delta: { content: word }, finish_reason: null }]));
    }
    res.write(chunk([{ index: 0, delta: {}, finish_reason: "stop" }]));
    if (body.stream_options?.include_usage) {
      const usage = { prompt_tokens: last.length, completion_tokens: words.length };
      res.write(chunk([], { ...usage, total_tokens: usage.prompt_tokens + words.length }));
    }
    res.end("data: [DONE]\n\n");
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const url = `http://${host}:${server.address().port}/v1`;
      resolve({ url, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

if (isMain(import.meta.url)) {
  const { url } = await startMockOpenAI({ port: Number(process.env.PORT ?? 8788) });
  console.log(`Mock model server on ${url} (model "${MOCK_MODEL}", any API key)`);
}
