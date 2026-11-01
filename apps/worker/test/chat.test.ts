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

/** A model that replies "Hello there" and records what it was asked. */
function scripted(seen: ModelMessage[][] = [], gate?: Promise<void>): ModelProvider {
  return {
    id: "scripted",
    listModels: async () => [],
    capabilities: () => ({ tools: false, usageInStream: true }),
    async *stream(request): AsyncGenerator<ModelEvent> {
      seen.push(request.messages);
      yield { type: "text.delta", text: "Hello" };
      await gate; // a gate that never opens holds the turn until the DO is evicted
      yield { type: "text.delta", text: " there" };
      yield { type: "usage", usage: USAGE };
      yield { type: "done", finishReason: "stop" };
    },
  };
}

const assistantOf = (userId: string) =>
  env.ASSISTANT.get(env.ASSISTANT.idFromName(assistantName(userId)));

function useModel(userId: string, provider: ModelProvider) {
  return runInDurableObject(assistantOf(userId), (instance: Assistant) => {
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
  const until = (type: HarnessEvent["type"]) =>
    vi.waitFor(() => expect(events.map((e) => e.type)).toContain(type));
  const send = (conversationId: string, text: string) =>
    ws.send(JSON.stringify({ type: "chat.send", conversationId, text }));
  return { res, ws, events, until, send };
}

describe("chat transport", () => {
  it("streams one turn to every tab and persists it with a usage row", async () => {
    const { browser, owner } = await claim();
    const seen: ModelMessage[][] = [];
    await useModel(owner, scripted(seen));
    const a = await openTab(browser);
    const b = await openTab(browser);
    a.send?.("conv-1", "Hi!");
    await a.until?.("turn.completed");
    await b.until?.("turn.completed");

    const types = ["turn.started", "message.delta", "message.delta", "usage.updated"];
    types.push("message.completed", "turn.completed");
    expect(a.events.map((e) => e.type)).toEqual(types);
    expect(b.events).toEqual(a.events);
    expect(a.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(a.events.every((e) => e.sessionId === "conv-1")).toBe(true);
    expect(a.events.find((e) => e.type === "message.completed")?.payload).toEqual({
      text: "Hello there",
    });
    expect(seen).toEqual([[{ role: "user", content: "Hi!" }]]);

    const res = await browser.req("/api/conversations/conv-1/messages");
    const { messages } = await res.json<{ messages: { role: string; content: string }[] }>();
    expect(messages).toMatchObject([
      { role: "user", content: "Hi!", status: "complete" },
      { role: "assistant", content: "Hello there", status: "complete" },
    ]);
    const list = await (await browser.req("/api/conversations")).json();
    expect(list).toMatchObject({ conversations: [{ id: "conv-1", title: "Hi!" }] });
    const ledger = await db.prepare("SELECT * FROM usage").all();
    expect(ledger.results).toMatchObject([
      { user_id: owner, conversation_id: "conv-1", provider_id: "scripted", model: "test-model" },
    ]);
    expect(ledger.results[0]).toMatchObject({ input_tokens: 12, output_tokens: 3 });
  });

  it("keeps the conversation through an eviction mid-turn and continues from D1", async () => {
    const { browser, owner } = await claim();
    await useModel(owner, scripted([], new Promise(() => {})));
    const tab = await openTab(browser);
    tab.send?.("conv-2", "Tell me a story");
    await tab.until?.("message.delta");
    await vi.waitFor(async () => expect(await count("messages", "status = 'streaming'")).toBe(1));

    await abortAllDurableObjects(); // the forced eviction: memory and the running turn are gone
    const next = await openTab(browser); // wakes the DO, which recovers the turn's fiber
    await vi.waitFor(async () => {
      const { messages } = await (await browser.req("/api/conversations/conv-2/messages")).json<{
        messages: { status: string; content: string }[];
      }>();
      expect(messages).toMatchObject([
        { content: "Tell me a story", status: "complete" },
        { content: "Hello", status: "interrupted" },
      ]);
    });

    const seen: ModelMessage[][] = [];
    await useModel(owner, scripted(seen));
    next.send?.("conv-2", "Go on");
    await next.until?.("turn.completed");
    expect(seen).toEqual([
      [
        { role: "user", content: "Tell me a story" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "Go on" },
      ],
    ]);
  });

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
    await runInDurableObject(assistantOf(owner), (instance: Assistant) => {
      expect(instance.userId).toBe(owner);
    });
    expect(await count("conversations", `id = 'conv-3' AND user_id = '${owner}'`)).toBe(1);
  });

  it("refuses another user's conversation, bad input and a second concurrent turn", async () => {
    const { browser, owner } = await claim();
    await db.batch([
      db.prepare("INSERT INTO users (id, display_name, role) VALUES ('other', 'Other', 'member')"),
      db.prepare("INSERT INTO conversations (id, user_id) VALUES ('theirs', 'other')"),
    ]);
    await useModel(owner, scripted([], new Promise(() => {})));
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
