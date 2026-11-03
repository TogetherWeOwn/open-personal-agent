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

/**
 * Starts the server on `port` (0 picks a free one). Resolves to `{ url, close, requests }`.
 * `requests` holds one entry per chat-completions call: `{ tools }`, the offered tool names in
 * order, so a test can assert what the turn offered the model. With `script` — an array of
 * `{ tool, args }` and `{ text }` entries — each call answers with the next entry (unique
 * call ids) instead of the first offered tool, so a test can drive a multi-tool turn: size
 * the script to the turn's model calls, ending with a `{ text }` entry for the call that
 * ends it. Once the script is spent it echoes. Without it the server keeps its default:
 * one call of the first offered tool with no tool result yet, then the echo.
 */
export function startMockOpenAI({ port = 8788, host = "127.0.0.1", script = null } = {}) {
  const queue = Array.isArray(script) ? [...script] : null;
  const requests = [];
  let calls = 0;
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
    requests.push({
      tools: tools.map((t) => t?.function?.name).filter((n) => typeof n === "string"),
    });
    // Only a tool result after the latest user message means the current turn already
    // called a tool: an earlier turn's result stays in the history, and must not block
    // a later user message from calling a tool again.
    const lastUserIdx = body.messages.findLastIndex((m) => m?.role === "user");
    const answeredTool = body.messages
      .slice(Math.max(lastUserIdx, 0))
      .some((m) => m?.role === "tool" || (Array.isArray(m?.tool_calls) && m.tool_calls.length > 0));
    // In script mode each model call spends the next entry, whether or not the request
    // carries a tool result: the script sequences the turn's calls, and the default's
    // answered-tool gate would starve every call after the first. A spent script echoes: the
    // default first-tool call would invent calls the test didn't ask for.
    let scripted = null;
    if (queue && queue.length > 0) scripted = queue.shift();
    const emit = (name, args) => {
      calls += 1;
      const callId = `call_${calls}`;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.write(
        chunk([
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: callId, function: { name, arguments: JSON.stringify(args) } },
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
    };
    if (scripted && typeof scripted.tool === "string" && scripted.tool) {
      emit(scripted.tool, scripted.args ?? {});
      return;
    }
    if (scripted && typeof scripted.text === "string") {
      const words = scripted.text.split(/(?<= )/);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.write(
        chunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]),
      );
      for (const word of words) {
        res.write(chunk([{ index: 0, delta: { content: word }, finish_reason: null }]));
      }
      res.write(chunk([{ index: 0, delta: {}, finish_reason: "stop" }]));
      if (body.stream_options?.include_usage) {
        const usage = { prompt_tokens: raw.length, completion_tokens: words.length };
        res.write(chunk([], { ...usage, total_tokens: usage.prompt_tokens + words.length }));
      }
      res.end("data: [DONE]\n\n");
      return;
    }
    if (!queue && typeof tools[0]?.function?.name === "string" && !answeredTool) {
      // The CI smoke's one tool call (M3-23a AC2): with tools offered and no tool result yet,
      // call the first one with empty arguments. The follow-up request carries the tool
      // result, so it falls through to the echo below.
      // Note for M3-04+: the mock calls the first offered tool unconditionally, so once
      // builtin tools register, the first message of every dev (`scripts/dev.mjs`) and e2e
      // (`test/e2e/stack.mjs`) conversation will call one. `test/e2e/persistence.spec.ts`
      // expects a plain `You said: …` echo and will need a marker or a name gate then.
      emit(tools[0].function.name, {});
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
      resolve({
        url,
        close: () => new Promise((done) => server.close(done)),
        requests,
      });
    });
  });
}

if (isMain(import.meta.url)) {
  const { url } = await startMockOpenAI({ port: Number(process.env.PORT ?? 8788) });
  console.log(`Mock model server on ${url} (model "${MOCK_MODEL}", any API key)`);
}
