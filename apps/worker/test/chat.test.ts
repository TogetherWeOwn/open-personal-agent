// SPDX-License-Identifier: Apache-2.0
// The Assistant DO and chat transport (M2-13): two tabs share one stream, a conversation survives
// an eviction, and the DO name comes from the session only.
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import type { HarnessEvent, ModelEvent, ModelMessage, ModelProvider } from "@opa/core";
import { describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import { type Assistant, assistantName } from "../src/assistant";
import { Browser, claim, count, db, env, freshDatabase, ORIGIN } from "./helpers/app";

freshDatabase();

const USAGE = { inputTokens: 12, outputTokens: 3, cachedInputTokens: 0, reasoningTokens: 0 };
const never = new Promise<void>(() => {});

/** A model that replies "Hello there" and records what it was asked. A gate holds it mid-reply. */
function scripted(seen: ModelMessage[][] = [], gate?: Promise<void>, early = false): ModelProvider {
  return {
    id: "scripted",
    listModels: async () => [],
    capabilities: () => ({ tools: false, usageInStream: true }),
    async *stream(request): AsyncGenerator<ModelEvent> {
      seen.push(request.messages);
      const held = () =>
        Promise.race([gate, new Promise((r) => request.signal?.addEventListener("abort", r))]);
      if (early) await held();
      yield { type: "text.delta", text: "Hello" };
      await held();
      yield { type: "text.delta", text: " there" };
      yield { type: "usage", usage: USAGE };
      yield { type: "done", finishReason: "stop" };
    },
  };
}

function useModel(userId: string, provider: ModelProvider) {
  const stub = env.ASSISTANT.get(env.ASSISTANT.idFromName(assistantName(userId)));
  return runInDurableObject(stub, (instance: Assistant) => {
    instance.chatModel = { provider, model: "test-model" };
  });
}

/** Opens a tab's WebSocket and collects the events it receives. */
async function openTab(br: Browser, path = "/api/chat", origin = ORIGIN) {
  const cookie = [...br.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await app.request(
    `${ORIGIN}${path}`,
    { headers: { upgrade: "websocket", origin, cookie } },
    br.bindings,
  );
  const ws = res.webSocket;
  if (res.status !== 101 || !ws) return { res, events: [] as HarnessEvent[] } as const;
  ws.accept();
  const events: HarnessEvent[] = [];
  ws.addEventListener("message", (e) => {
    events.push(JSON.parse(e.data as string));
  });
  const closed = new Promise<number>((resolve) =>
    ws.addEventListener("close", (e) => resolve(e.code)),
  );
  const until = (type: HarnessEvent["type"]) =>
    vi.waitFor(() => expect(events.map((e) => e.type)).toContain(type));
  const send = (conversationId: string, text: string) =>
    ws.send(JSON.stringify({ type: "chat.send", conversationId, text }));
  return { res, ws, events, until, send, closed };
}

describe("chat transport", () => {
  it("streams one turn to every tab and persists it with a usage row", async () => {
    const { browser, owner } = await claim();
    const seen: ModelMessage[][] = [];
    await useModel(owner, scripted(seen));
    const [a, b] = [await openTab(browser), await openTab(browser)];
    a.send?.("conv-1", "Hi!");
    await a.until?.("turn.completed");
    await b.until?.("turn.completed");

    const types = ["turn.started", "message.delta", "message.delta", "usage.updated"];
    types.push("message.completed", "turn.completed");
    expect(a.events.map((e) => e.type)).toEqual(types);
    expect(b.events).toEqual(a.events);
    expect(a.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(seen).toEqual([[{ role: "user", content: "Hi!" }]]);

    const res = await browser.req("/api/conversations/conv-1/messages");
    const { messages } = await res.json<{ messages: { role: string; content: string }[] }>();
    expect(messages).toMatchObject([
      { role: "user", content: "Hi!", status: "complete" },
      { role: "assistant", content: "Hello there", status: "complete" },
    ]);
    const ledger = await db.prepare("SELECT * FROM usage").all();
    expect(ledger.results).toMatchObject([
      { user_id: owner, conversation_id: "conv-1", provider_id: "scripted", model: "test-model" },
    ]);
    expect(ledger.results[0]).toMatchObject({ input_tokens: 12, output_tokens: 3 });
  });

  it.each([
    ["mid-reply", "Hello", false],
    ["before the first token", "", true],
  ])(
    "keeps the conversation through an eviction %s and continues from D1",
    async (_, kept, early) => {
      const { browser, owner } = await claim();
      await useModel(owner, scripted([], never, early));
      const tab = await openTab(browser);
      tab.send?.("conv-2", "Tell me a story");
      await tab.until?.(early ? "turn.started" : "message.delta");

      await abortAllDurableObjects(); // the forced eviction: memory and the running turn are gone
      const next = await openTab(browser); // wakes the DO, which recovers the turn's fiber
      await vi.waitFor(async () => {
        const { messages } = await (await browser.req("/api/conversations/conv-2/messages")).json<{
          messages: { status: string; content: string }[];
        }>();
        expect(messages).toMatchObject([
          { content: "Tell me a story", status: "complete" },
          { content: kept, status: "interrupted" },
        ]);
      });
      expect(await count("usage", "conversation_id = 'conv-2'")).toBe(1); // the ledger keeps the call

      const seen: ModelMessage[][] = [];
      await useModel(owner, scripted(seen));
      next.send?.("conv-2", "Go on");
      await next.until?.("turn.completed");
      const story = { role: "user", content: "Tell me a story" };
      const reply = early ? [] : [{ role: "assistant", content: "Hello" }];
      expect(seen).toEqual([[story, ...reply, { role: "user", content: "Go on" }]]);
    },
  );

  it("names the DO from the session, never from the request", async () => {
    const { browser, owner } = await claim();
    expect((await openTab(new Browser())).res.status).toBe(401);
    expect((await openTab(browser, "/api/chat", "https://evil.test")).res.status).toBe(403);
    expect((await openTab(browser, "/agents/assistant/u:someone-else")).res.status).toBe(404);
    expect((await browser.req("/api/chat")).status).toBe(426);

    // Query strings and SDK name headers are ignored: the socket lands on the owner's DO.
    await useModel(owner, scripted());
    const tab = await openTab(browser, "/api/chat?name=u:someone-else&_pk=x");
    tab.send?.("conv-3", "Whose assistant is this?");
    await tab.until?.("turn.completed");
    expect(await count("conversations", `id = 'conv-3' AND user_id = '${owner}'`)).toBe(1);
  });

  it("closes an open socket on its next action once the session is logged out", async () => {
    const { browser, owner, key } = await claim();
    const other = new Browser();
    expect((await other.login(key)).status).toBe(200);
    await useModel(owner, scripted([], never));
    const [stale, live] = [await openTab(browser), await openTab(other)];
    expect((await browser.req("/api/auth/logout", { body: {} })).status).toBe(200);
    live.send?.("conv-4", "Still there?");
    await live.until?.("message.delta");
    stale.ws?.send(JSON.stringify({ type: "turn.cancel" })); // can't stop the live tab's turn
    expect(await stale.closed).toBe(4401);
    expect(live.events.map((e) => e.type)).not.toContain("turn.interrupted");
    live.ws?.send(JSON.stringify({ type: "turn.cancel" }));
    await live.until?.("turn.interrupted");
  });

  it("refuses another user's conversation, bad input and a second concurrent turn", async () => {
    const { browser, owner } = await claim();
    await db.batch([
      db.prepare("INSERT INTO users (id, display_name, role) VALUES ('other', 'Other', 'member')"),
      db.prepare("INSERT INTO conversations (id, user_id) VALUES ('theirs', 'other')"),
    ]);
    await useModel(owner, scripted([], never));
    const tab = await openTab(browser);
    tab.send?.("theirs", "hi");
    tab.send?.("../x", "hi");
    await vi.waitFor(() =>
      expect(tab.events.map((e) => e.type)).toEqual(["turn.failed", "turn.failed"]),
    );
    expect(await count("messages", "conversation_id = 'theirs'")).toBe(0);
    expect((await browser.req("/api/conversations/theirs/messages")).status).toBe(404);

    tab.send?.("mine", "first");
    await tab.until?.("message.delta");
    tab.send?.("mine", "second");
    await vi.waitFor(() =>
      expect(tab.events.at(-1)).toMatchObject({
        type: "turn.failed",
        payload: { message: "Another reply is still being written." },
      }),
    );
    tab.ws?.send(JSON.stringify({ type: "turn.cancel" }));
  });
});
