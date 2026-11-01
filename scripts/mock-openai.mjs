// SPDX-License-Identifier: Apache-2.0
// A mock OpenAI-compatible model server for local development and tests: `GET /v1/models` and a
// streaming `POST /v1/chat/completions` that echoes the last user message. No key needed, no cost.
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
    const body = JSON.parse(raw || "{}");
    const last = (body.messages ?? []).findLast((m) => m.role === "user")?.content ?? "";
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
