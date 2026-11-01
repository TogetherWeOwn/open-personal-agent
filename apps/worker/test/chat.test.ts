// SPDX-License-Identifier: Apache-2.0
// The Assistant DO and chat transport (M2-13): two tabs share one stream, a conversation survives
// an eviction, and the DO name comes from the session only.
import { runInDurableObject } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import type { HarnessEvent, ModelEvent, ModelMessage, ModelProvider } from "@opa/core";
import { createRepository, scopeFromSession } from "@opa/db/repository";
import { STARTER_MODEL } from "@opa/providers";
import { resolveChatModel } from "@opa/server/chat-model";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Assistant } from "../src/assistant";
import { compose, type WorkerEnv } from "../src/compose";
import { DAILY_SPEND_CAP_MICRO_USD, TURNS_PER_MINUTE } from "../src/limits";
import { workerApp } from "../src/worker-app";
import { Browser, claim, count, db, env, freshDatabase, ORIGIN, SOCKET_WAIT } from "./helpers/app";

freshDatabase();
afterEach(() => vi.restoreAllMocks());

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

const assistantOf = (userId: string) => env.ASSISTANT.get(env.ASSISTANT.idFromName(`u:${userId}`));
function useModel(userId: string, provider: ModelProvider) {
  return runInDurableObject(assistantOf(userId), (instance: Assistant) => {
    instance.resolveModel = async () => ({ provider, model: "test-model", apiKey: null });
  });
}

/**
 * The real resolver, with the vault and AI binding the test runtime lacks: the DO's own env has no
 * master key here, and Workers AI is remote-only.
 */
async function useSavedModel(userId: string, AI: Ai) {
  const raw = { ...workerEnv, OPA_MASTER_KEY: btoa("k".repeat(32)) } as unknown as WorkerEnv;
  const { VAULT } = await compose(raw);
  await runInDurableObject(assistantOf(userId), (instance: Assistant) => {
    instance.resolveModel = (doEnv, scope, caller, pick) =>
      resolveChatModel({ ...doEnv, VAULT, AI }, scope, caller, pick);
  });
  return { ...env, VAULT };
}

const sse = (...lines: string[]) => new Response(lines.map((line) => `data: ${line}\n\n`).join(""));

/** Opens a tab's WebSocket and collects the events it receives. */
async function openTab(br: Browser, path = "/api/chat", origin = ORIGIN) {
  const cookie = [...br.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await workerApp.request(
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
    vi.waitFor(() => expect(events.map((e) => e.type)).toContain(type), SOCKET_WAIT);
  const send = (
    conversationId: string,
    text: string,
    model?: { provider: string; model: string },
  ) => ws.send(JSON.stringify({ type: "chat.send", conversationId, text, model }));
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
    expect(a.events.map((e) => [e.v, e.seq])).toEqual([1, 2, 3, 4, 5, 6].map((n) => [1, n]));
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

  it("calls the saved model, and a settings change applies to the next turn", async () => {
    const { browser, owner } = await claim();
    const AI = {
      run: vi.fn(async (_model: string) => sse('{"response":"From the starter"}', "[DONE]").body),
    };
    const withVault = new Browser(await useSavedModel(owner, AI as unknown as Ai));
    withVault.cookies = browser.cookies;
    const KEY = "sk-chat-0123456789abcdefWXYZ";
    const keyed = {
      kind: "openai-chat",
      providerId: "openai",
      baseUrl: "https://api.example.com/v1",
    };
    const saved = await withVault.req("/api/settings/model", {
      method: "PUT",
      body: { ...keyed, model: "gpt-x", apiKey: KEY },
    });
    expect(saved.status).toBe(200);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const chunk = JSON.stringify({ choices: [{ delta: { content: "From gpt-x" } }] });
      return sse(chunk, "[DONE]");
    });

    const tab = await openTab(browser);
    tab.send?.("conv-6", "Who are you?");
    await tab.until?.("turn.completed");
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(init?.body as string)).toMatchObject({ model: "gpt-x" });

    // Switching to the starter model takes effect on the same socket's next turn.
    const starter = { method: "PUT", body: { kind: "workers-ai" } };
    expect((await withVault.req("/api/settings/model", starter)).status).toBe(200);
    tab.events.length = 0;
    tab.send?.("conv-6", "And now?");
    await tab.until?.("turn.completed");
    expect(AI.run.mock.calls[0]?.[0]).toBe(STARTER_MODEL);
    expect(fetch).toHaveBeenCalledTimes(1);

    const res = await browser.req("/api/conversations/conv-6/messages");
    const { messages } = await res.json<{ messages: { content: string }[] }>();
    expect(messages.map((m) => m.content)).toEqual([
      "Who are you?",
      "From gpt-x",
      "And now?",
      "From the starter",
    ]);
    const ledger = await db
      .prepare("SELECT provider_id, model FROM usage WHERE conversation_id = 'conv-6'")
      .all();
    // The ledger names who bills the call from its endpoint, not the provider ID typed for it.
    expect(ledger.results).toEqual([
      { provider_id: "api.example.com", model: "gpt-x" },
      { provider_id: "workers-ai", model: STARTER_MODEL },
    ]);

    // A conversation's own model overrides the Chat role, and the model gets the whole history
    // from the other model's turns (M3-06 AC3).
    const user = createRepository(env).forUser(scopeFromSession({ userId: owner }));
    const keyedRow = (await user.providers.list()).find((p) => p.kind === "openai-chat");
    await user.chat.setModel("conv-6", { provider: String(keyedRow?.id), model: "gpt-y" });
    tab.events.length = 0;
    tab.send?.("conv-6", "Back to you");
    await tab.until?.("turn.completed");
    expect(AI.run).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetch.mock.calls[1]?.[1]?.body as string);
    expect(body.model).toBe("gpt-y");
    expect(body.messages.map((m: { content: string }) => m.content)).toEqual([
      "Who are you?",
      "From gpt-x",
      "And now?",
      "From the starter",
      "Back to you",
    ]);

    // A chat picked before the server had it sends its model with its first message, and that
    // reply already uses it; the pick is saved with the new chat.
    const own = { provider: String(keyedRow?.id), model: "gpt-z" };
    tab.events.length = 0;
    tab.send?.("conv-7", "Hi from a new chat", own);
    await tab.until?.("turn.completed");
    expect(JSON.parse(fetch.mock.calls[2]?.[1]?.body as string).model).toBe("gpt-z");
    expect((await user.getConversation("conv-7"))?.model).toBe("gpt-z");
    // An existing chat keeps its saved pin: a send's pick never overwrites a newer switch.
    tab.events.length = 0;
    tab.send?.("conv-6", "Still you?", own);
    await tab.until?.("turn.completed");
    expect(JSON.parse(fetch.mock.calls[3]?.[1]?.body as string).model).toBe("gpt-y");
    expect((await user.getConversation("conv-6"))?.model).toBe("gpt-y");
    // A pick naming no saved provider of this user's is refused, and writes nothing.
    tab.events.length = 0;
    tab.send?.("conv-8", "Hi", { provider: "not-mine", model: "gpt-z" });
    const refused = {
      type: "turn.failed",
      payload: { message: "Pick a model in Settings first." },
    };
    await vi.waitFor(() => expect(tab.events).toMatchObject([refused]), SOCKET_WAIT);
    expect(await count("conversations", "id = 'conv-8'")).toBe(0);
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

      // The forced eviction, of this DO only: its memory and running turn are gone.
      await runInDurableObject(assistantOf(owner), (_, state) => state.abort()).catch(() => {});
      const next = await openTab(browser); // wakes the DO, which recovers the turn's fiber
      await vi.waitFor(async () => {
        const { messages } = await (await browser.req("/api/conversations/conv-2/messages")).json<{
          messages: { status: string; content: string }[];
        }>();
        expect(messages).toMatchObject([
          { content: "Tell me a story", status: "complete" },
          { content: kept, status: "interrupted" },
        ]);
      }, SOCKET_WAIT);
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

  it("settles a turn evicted before its first write: no messages, no ledger row", async () => {
    const { owner } = await claim();
    const turn = { conversationId: "c5", turnId: "t", replyId: "r", providerId: "p", model: "m" };
    const ctx = { name: "chat-turn", snapshot: { ...turn, reply: "", usage: null, called: false } };
    const day = Date.now() - (Date.now() % 86_400_000);
    const spend = await runInDurableObject(assistantOf(owner), async (i: Assistant, state) => {
      state.storage.kv.put("spend", {
        day,
        spentMicroUsd: 0,
        held: { t: { microUsd: 500, at: Date.now() } },
      });
      await i.onFiberRecovered(ctx as never);
      return state.storage.kv.get("spend");
    });
    expect([await count("messages", "1"), await count("usage", "1")]).toEqual([0, 0]);
    // It never called the model, so its reservation is released without a charge.
    expect(spend).toEqual({ day, spentMicroUsd: 0, held: {} });
  });

  it("names the DO from the session, never from the request", async () => {
    const { browser, owner } = await claim();
    expect((await openTab(new Browser())).res.status).toBe(401);
    expect((await openTab(browser, "/api/chat", "https://evil.test")).res.status).toBe(403);
    expect((await openTab(browser, "/agents/assistant/u:someone-else")).res.status).toBe(404);

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
    stale.ws?.send(JSON.stringify({ type: "turn.cancel" }));
    expect(await stale.closed).toBe(4401);
    live.send?.("conv-4", "Still there?");
    await live.until?.("message.delta");
    live.ws?.send(JSON.stringify({ type: "turn.cancel" }));
    await live.until?.("turn.interrupted");
  });

  it("sends a turn to no tab whose session has ended", async () => {
    const { browser, owner, key } = await claim();
    const other = new Browser();
    expect((await other.login(key)).status).toBe(200);
    await useModel(owner, scripted());
    const [stale, live] = [await openTab(browser), await openTab(other)];
    expect((await browser.req("/api/auth/logout", { body: {} })).status).toBe(200);
    live.send?.("conv-5", "Only for live tabs");
    await live.until?.("turn.completed");
    expect(await stale.closed).toBe(4401);
    expect(stale.events).toEqual([]);
  });

  it("refuses another user's conversation, bad input and a second concurrent turn", async () => {
    const { browser, owner } = await claim();
    await db.exec(`INSERT INTO users (id, display_name, role) VALUES ('other', 'Other', 'member');
      INSERT INTO conversations (id, user_id) VALUES ('theirs', 'other');`);
    const tab = await openTab(browser);
    // Before onboarding picks a model, the real resolver finds none, and nothing is written.
    tab.send?.("mine", "first");
    const failed = (message: string) => ({ type: "turn.failed", seq: 0, payload: { message } });
    const noModel = failed("Pick a model in Settings first.");
    await vi.waitFor(() => expect(tab.events).toMatchObject([noModel]), SOCKET_WAIT);
    expect(await count("conversations", "id = 'mine'")).toBe(0);
    await useModel(owner, scripted([], never));
    // A bad message is refused before any turn starts. Sent after "theirs", it could arrive while
    // that turn still runs and be refused as busy instead.
    tab.send?.("../x", "hi");
    tab.send?.("theirs", "hi");
    const bad = failed("That message can't be sent.");
    const gone = failed("That conversation doesn't exist.");
    await vi.waitFor(() => expect(tab.events).toMatchObject([noModel, bad, gone]), SOCKET_WAIT);
    expect(await count("messages", "conversation_id = 'theirs'")).toBe(0);
    expect((await browser.req("/api/conversations/theirs/messages")).status).toBe(404);
    tab.send?.("mine", "first");
    await tab.until?.("message.delta");
    tab.send?.("mine", "second");
    const busy = { message: "Another reply is still being written." };
    await vi.waitFor(() => expect(tab.events.at(-1)).toMatchObject({ payload: busy }), SOCKET_WAIT);
    tab.ws?.send(JSON.stringify({ type: "turn.cancel" }));
    // The list holds the user's own conversations only.
    const list = await (await browser.req("/api/conversations")).json<{ conversations: unknown }>();
    expect(list.conversations).toEqual([
      { id: "mine", title: "first", updatedAt: expect.any(Number), model: null },
    ]);
  });
});

describe("turn and spend limits (M2-22)", () => {
  /** gpt-4.1 at $2 in and $8 out per million tokens, recording each request's `max_tokens`. */
  function priced(userId: string, maxTokens: (number | undefined)[]) {
    const provider = { ...scripted(), id: "openai" };
    const stream = provider.stream;
    provider.stream = (request) => {
      maxTokens.push(request.maxOutputTokens);
      return stream(request);
    };
    return runInDurableObject(assistantOf(userId), (instance: Assistant) => {
      instance.resolveModel = async () => ({ provider, model: "gpt-4.1", apiKey: null });
    });
  }
  /** The DO's storage is usable only inside it. */
  const storage = <T>(userId: string, fn: (kv: SyncKvStorage) => T) =>
    runInDurableObject(assistantOf(userId), (_: Assistant, state) => fn(state.storage.kv));
  const spendLeft = async (userId: string, left: number) => {
    const now = Date.now();
    const day = now - (now % 86_400_000);
    const spend = { day, spentMicroUsd: DAILY_SPEND_CAP_MICRO_USD - left, held: {} };
    await storage(userId, (kv) => kv.put("spend", spend));
  };

  it("asks to slow down past 30 turns a minute, without calling the model", async () => {
    const { browser, owner } = await claim();
    const seen: ModelMessage[][] = [];
    await useModel(owner, scripted(seen));
    await storage(owner, (kv) => kv.put("turns", Array(TURNS_PER_MINUTE).fill(Date.now())));
    const tab = await openTab(browser);
    tab.send?.("conv-1", "Hi!");
    await tab.until?.("turn.failed");
    expect(tab.events).toMatchObject([
      { seq: 0, type: "turn.failed", payload: { reason: "slow_down" } },
    ]);
    expect(seen).toEqual([]);
    expect(await count("messages")).toBe(0);
  });

  it("refuses a turn the day's budget can't cover, leaving no trace", async () => {
    const { browser, owner } = await claim();
    const maxTokens: (number | undefined)[] = [];
    await priced(owner, maxTokens);
    await spendLeft(owner, 100);
    const tab = await openTab(browser);
    tab.send?.("conv-1", "Hi!");
    await tab.until?.("turn.failed");
    expect(tab.events).toMatchObject([
      { seq: 0, type: "turn.failed", payload: { reason: "limit_reached" } },
    ]);
    expect(maxTokens).toEqual([]);
    expect(await count("messages")).toBe(0);
    expect(await count("conversations")).toBe(0);
  });

  it("caps max_tokens from the budget left and charges the call's cost", async () => {
    const { browser, owner } = await claim();
    const maxTokens: (number | undefined)[] = [];
    await priced(owner, maxTokens);
    // "Hi!" counts as 2 input tokens (4 micro-USD), leaving room for 1,000 output tokens.
    await spendLeft(owner, 4 + 1000 * 8);
    const tab = await openTab(browser);
    tab.send?.("conv-1", "Hi!");
    await tab.until?.("turn.completed");
    expect(maxTokens).toEqual([1000]);
    // USAGE: 12 input tokens at 2 and 3 output tokens at 8.
    expect(await storage(owner, (kv) => kv.get("spend"))).toMatchObject({
      spentMicroUsd: DAILY_SPEND_CAP_MICRO_USD - (4 + 1000 * 8) + 12 * 2 + 3 * 8,
      held: {},
    });
  });
});
