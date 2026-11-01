// SPDX-License-Identifier: Apache-2.0
// The Assistant DO and chat transport (M2-13): two tabs share one stream, a conversation survives
// an eviction, and the DO name comes from the session only.
import { runInDurableObject } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import type { HarnessEvent, ModelEvent, ModelMessage, ModelProvider } from "@opa/core";
import { createRepository, scopeFromSession } from "@opa/db/repository";
import type { LoopTool } from "@opa/harness-builtin";
import { type RiskClass, ToolRegistry } from "@opa/policy";
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

/** The approvals route's write, without its checks: one item decided in D1 (M3-07 AC9). */
const decideInD1 = (batchId: string, approvalId: string, status: "approved" | "denied") =>
  db
    .prepare(
      "UPDATE approvals SET status = ?, scope = 'once', decided_at = ? WHERE batch_id = ? AND approval_id = ?",
    )
    .bind(status, Date.now(), batchId, approvalId)
    .run();

const assistantOf = (userId: string) => env.ASSISTANT.get(env.ASSISTANT.idFromName(`u:${userId}`));
function useModel(userId: string, provider: ModelProvider) {
  return runInDurableObject(assistantOf(userId), (instance: Assistant) => {
    instance.resolveModel = async () => ({ provider, model: "test-model", apiKey: null });
  });
}

type Reply = { text?: string; calls?: [name: string, args: unknown][] };

/** A model that answers each call with the next reply (the last one repeats), for loop tests. */
function replying(replies: (Reply | (() => Reply))[]): ModelProvider {
  let ids = 0;
  let at = 0;
  return {
    id: "scripted",
    listModels: async () => [],
    capabilities: () => ({ tools: true, usageInStream: true }),
    async *stream(): AsyncGenerator<ModelEvent> {
      const next = replies[Math.min(at++, replies.length - 1)] ?? { text: "done" };
      const reply = typeof next === "function" ? next() : next;
      for (const word of (reply.text ?? "").split(/(?<= )/).filter(Boolean)) {
        yield { type: "text.delta", text: word };
      }
      for (const [name, args] of reply.calls ?? []) {
        yield {
          type: "tool_call",
          toolCall: { id: `call_${++ids}`, name, arguments: JSON.stringify(args) },
        };
      }
      yield { type: "usage", usage: USAGE };
      yield { type: "done", finishReason: reply.calls ? "tool_calls" : "stop" };
    },
  };
}

/** A loop tool of the given risk class, recording the inputs it ran with. */
function loopTool(name: string, riskClass: RiskClass) {
  const inputs: Record<string, unknown>[] = [];
  const tool: LoopTool = {
    manifest: {
      name,
      description: `The ${name} tool.`,
      inputSchema: {
        type: "object",
        properties: { q: { type: "string", minLength: 1 } },
        required: ["q"],
        additionalProperties: false,
      },
      riskClass,
      destinations: [],
      scopes: [],
    },
    execute: async (input) => {
      inputs.push(input);
      return { ok: true, content: `${name} ok`, context: { kind: "system" } };
    },
  };
  return { tool, inputs };
}

function useTools(userId: string, tools: LoopTool[]) {
  return runInDurableObject(assistantOf(userId), (instance: Assistant) => {
    instance.resolveTools = () => {
      const registry = new ToolRegistry<LoopTool>();
      for (const t of tools) registry.register(t);
      return { tools: registry, policy: () => ({}) };
    };
  });
}

/** The conversation's stored messages' contents and statuses, oldest first. */
const stored = async (br: Browser, id: string) =>
  (
    await (
      await br.req(`/api/conversations/${id}/messages`)
    ).json<{ messages: { content: string; status: string }[] }>()
  ).messages;

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
    const types = ["turn.started", "step.started", "message.delta", "message.delta"];
    types.push("usage.updated", "message.completed", "step.completed", "turn.completed");
    expect(a.events.map((e) => e.type)).toEqual(types);
    expect(b.events).toEqual(a.events);
    expect(a.events.map((e) => [e.v, e.seq])).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => [1, n]));
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
    // from the other model's turns (M3-06 AC3), but never the thread's switch line (TWO-614).
    const user = createRepository(env).forUser(scopeFromSession({ userId: owner }));
    const keyedRow = (await user.providers.list()).find((p) => p.kind === "openai-chat");
    const own6 = { provider: String(keyedRow?.id), model: "gpt-y" };
    const pinned = await browser.req("/api/conversations/conv-6/model", {
      method: "PUT",
      body: own6,
    });
    const { message: line } = await pinned.json<{ message: { content: string } }>();
    expect(line.content).toBe("Switched to gpt-y via api.example.com");
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
    // The thread keeps the line where the switch happened, for a reload or another tab.
    const thread = await (await browser.req("/api/conversations/conv-6/messages")).json<{
      messages: { role: string; content: string }[];
    }>();
    expect(thread.messages.map((m) => `${m.role}: ${m.content}`)).toEqual([
      "user: Who are you?",
      "assistant: From gpt-x",
      "user: And now?",
      "assistant: From the starter",
      `system: ${line.content}`,
      "user: Back to you",
      "assistant: From gpt-x",
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
    const checkpoint = { reply: "", wrote: false, holds: ["t"], callStarted: false };
    const ctx = {
      name: "chat-turn",
      snapshot: { ...turn, ...checkpoint, callRecorded: false, callUsage: null },
    };
    // One clock read: two `Date.now()` calls in different milliseconds make a day 1ms
    // before midnight, and the recovery recomputes the true boundary.
    const now = Date.now();
    const day = now - (now % 86_400_000);
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
    await live.until?.("turn.cancelled");
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

  it("replays a running turn to a tab that resumes it, under a seq that never restarts", async () => {
    const { browser, owner } = await claim();
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    await useModel(owner, scripted([], gate));
    const a = await openTab(browser);
    a.send?.("conv-7", "Tell me a story");
    await a.until?.("message.delta");
    const turnId = a.events[0]?.turnId;
    // A tab that connected late saw nothing; its resume replays the turn so far, to it alone.
    const b = await openTab(browser);
    const resume = (conversationId: string, id: unknown, afterSeq: number) =>
      b.ws?.send(JSON.stringify({ type: "resume", conversationId, turnId: id, afterSeq }));
    resume("conv-7", turnId, 0);
    await vi.waitFor(() => expect(b.events).toEqual(a.events), SOCKET_WAIT);
    release();
    await a.until?.("turn.completed");
    await b.until?.("turn.completed");
    expect(b.events).toEqual(a.events);
    const seqs = a.events.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1)); // 1..n for the conversation's first turn

    // The next turn continues the seq; the settled turn's rows are trimmed and replay empty.
    a.events.length = 0;
    a.send?.("conv-7", "Again");
    await a.until?.("turn.completed");
    expect(a.events[0]?.seq).toBe((seqs.at(-1) ?? 0) + 1);
    const logged = await runInDurableObject(assistantOf(owner), (_i, state) =>
      state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM event_log").one(),
    );
    expect(logged).toEqual({ n: 0 });
    const before = b.events.length;
    resume("conv-7", turnId, 0);
    resume("no-such-conversation", "no-such-turn", 0);
    resume("conv-7", turnId, -1); // not a valid frame either
    await new Promise((r) => setTimeout(r, 500)); // settled and unknown turns answer nothing
    expect(b.events.length).toBe(before);
  });

  it("answers no resume from a session that has ended", async () => {
    const { browser, owner, key } = await claim();
    const other = new Browser();
    expect((await other.login(key)).status).toBe(200);
    await useModel(owner, scripted([], never));
    const [stale, live] = [await openTab(browser), await openTab(other)];
    live.send?.("conv-8", "Only for live tabs");
    await live.until?.("message.delta");
    expect((await browser.req("/api/auth/logout", { body: {} })).status).toBe(200);
    stale.events.length = 0; // it saw the turn live; the replay is what must not come
    const turnId = live.events[0]?.turnId;
    stale.ws?.send(
      JSON.stringify({ type: "resume", conversationId: "conv-8", turnId, afterSeq: 0 }),
    );
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

  it("names a vault that needs a reset, so the tab can link to it (TWO-650)", async () => {
    const { browser, owner } = await claim();
    await runInDurableObject(assistantOf(owner), (instance: Assistant) => {
      instance.resolveModel = async () => ({ error: "vault_reset_required" });
    });
    const tab = await openTab(browser);
    tab.send?.("locked", "hi");
    await tab.until?.("turn.failed");
    expect(tab.events).toMatchObject([
      { seq: 0, type: "turn.failed", payload: { code: "vault_reset_required" } },
    ]);
    expect(await count("conversations", "id = 'locked'")).toBe(0);
  });
});

describe("the DO host for the builtin loop (M3-03c)", () => {
  it("runs a tool turn: the read runs, both calls reach the ledger, segments join", async () => {
    const { browser, owner } = await claim();
    const lookup = loopTool("lookup", "read");
    await useModel(
      owner,
      replying([{ text: "Checking.", calls: [["lookup", { q: "x" }]] }, { text: "All done" }]),
    );
    await useTools(owner, [lookup.tool]);
    const tab = await openTab(browser);
    tab.send?.("conv-tool", "Look it up");
    await tab.until?.("turn.completed");
    const types = tab.events.map((e) => e.type);
    expect(types.indexOf("tool.called")).toBeLessThan(types.indexOf("tool.result"));
    expect(types.indexOf("tool.result")).toBeLessThan(types.indexOf("turn.completed"));
    expect(lookup.inputs).toEqual([{ q: "x" }]);
    expect(await count("usage", "conversation_id = 'conv-tool'")).toBe(2); // one row per call
    expect(await stored(browser, "conv-tool")).toMatchObject([
      { content: "Look it up", status: "complete" },
      { content: "Checking.\n\nAll done", status: "complete" },
    ]);
  });

  it("stops at an approval in D1, survives an eviction, and resumes on the decision", async () => {
    const { browser, owner } = await claim();
    const send = loopTool("send", "consequential");
    const provider = replying([{ calls: [["send", { q: "hi" }]] }, { text: "Sent" }]);
    await useModel(owner, provider);
    await useTools(owner, [send.tool]);
    const tab = await openTab(browser);
    tab.send?.("conv-appr", "Send it");
    await tab.until?.("approval.requested");
    const asked = tab.events.find(
      (e): e is Extract<HarnessEvent, { type: "approval.requested" }> =>
        e.type === "approval.requested",
    );
    if (!asked) throw new Error("no approval.requested");
    const { batchId, items } = asked.payload;
    const approvalId = items[0]?.approvalId;
    if (!approvalId) throw new Error("no approval item");
    const { turnId } = asked;
    expect(send.inputs).toEqual([]); // gated: it has not run
    const saved = "SELECT status FROM turn_states WHERE turn_id = ?";
    expect(await db.prepare(saved).bind(turnId).first("status")).toBe("awaiting_approval");

    // The DO's memory goes away; the stopped turn is in D1, not in it (AC5).
    await runInDurableObject(assistantOf(owner), (_, state) => state.abort()).catch(() => {});
    expect(await db.prepare(saved).bind(turnId).first("status")).toBe("awaiting_approval");
    const back = await openTab(browser); // wakes the DO
    await useModel(owner, provider);
    await useTools(owner, [send.tool]);

    // The batch is in D1 too, pending and bound (M3-07 AC9).
    const row = "SELECT status, binding_hash FROM approvals WHERE batch_id = ? AND approval_id = ?";
    expect(await db.prepare(row).bind(batchId, approvalId).first()).toMatchObject({
      status: "pending",
      binding_hash: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });

    // An unknown batch, or one still undecided, changes nothing and runs nothing.
    const resume = (id: string) =>
      runInDurableObject(assistantOf(owner), (i: Assistant) => i.resumeBatch(id));
    expect(await resume("batch_nope")).toBe("gone");
    expect(await resume(batchId)).toBe("waiting");
    expect(await db.prepare(saved).bind(turnId).first("status")).toBe("awaiting_approval");
    expect(send.inputs).toEqual([]);

    await decideInD1(batchId, approvalId, "approved");
    expect(await resume(batchId)).toBe("resumed");
    await back.until?.("turn.completed");
    expect(back.events.map((e) => e.type)).toContain("approval.resolved");
    expect(send.inputs).toEqual([{ q: "hi" }]);
    // The claim and the end of the call are on the row and in the audit log (AC5, AC12).
    expect(await db.prepare(row).bind(batchId, approvalId).first("status")).toBe("executed");
    expect(
      await count(
        "audit_log",
        `action = 'approval.execute' AND target_id = '${batchId}/${approvalId}'`,
      ),
    ).toBe(1);
    expect(await count("turn_states", `turn_id = '${turnId}'`)).toBe(0); // settling removed it
    expect(await stored(browser, "conv-appr")).toMatchObject([
      { content: "Send it", status: "complete" },
      { content: "Sent", status: "complete" },
    ]);
  });

  it("runs one loop for two concurrent approves: one tool run, one more ledger row", async () => {
    const { browser, owner } = await claim();
    const send = loopTool("send", "consequential");
    const provider = replying([{ calls: [["send", { q: "hi" }]] }, { text: "Sent" }]);
    await useModel(owner, provider);
    await useTools(owner, [send.tool]);
    const tab = await openTab(browser);
    tab.send?.("conv-race", "Send it");
    await tab.until?.("approval.requested");
    const asked = tab.events.find(
      (e): e is Extract<HarnessEvent, { type: "approval.requested" }> =>
        e.type === "approval.requested",
    );
    if (!asked) throw new Error("no approval.requested");
    const { batchId, items } = asked.payload;
    const approvalId = items[0]?.approvalId;
    if (!approvalId) throw new Error("no approval item");
    await decideInD1(batchId, approvalId, "approved");
    // A double-clicked Approve, two tabs, a retried request: both calls start without
    // awaiting between them, so both would load the same `awaiting_approval` row if the claim
    // weren't held before the first await (S1). The second waits for the first turn to end,
    // then finds nothing left to resume.
    const [first, second] = await runInDurableObject(assistantOf(owner), (i: Assistant) =>
      Promise.all([i.resumeBatch(batchId), i.resumeBatch(batchId)]),
    );
    expect([first, second].sort()).toEqual(["queued", "resumed"]);
    await tab.until?.("turn.completed");
    expect(send.inputs).toEqual([{ q: "hi" }]); // the approved tool ran once
    expect(await count("usage", "conversation_id = 'conv-race'")).toBe(2); // one row per call
  });

  it("rejects a chat.send while a resume is still starting", async () => {
    const { browser, owner } = await claim();
    const send = loopTool("send", "consequential");
    const provider = replying([{ calls: [["send", { q: "hi" }]] }, { text: "Sent" }]);
    await useModel(owner, provider);
    await useTools(owner, [send.tool]);
    const tab = await openTab(browser);
    tab.send?.("conv-busy", "Send it");
    await tab.until?.("approval.requested");
    const asked = tab.events.find(
      (e): e is Extract<HarnessEvent, { type: "approval.requested" }> =>
        e.type === "approval.requested",
    );
    if (!asked) throw new Error("no approval.requested");
    const { batchId, items } = asked.payload;
    const approvalId = items[0]?.approvalId;
    if (!approvalId) throw new Error("no approval item");
    await decideInD1(batchId, approvalId, "approved");
    // The resume parks in its model pick; the claim is already held (S1), so a send arriving
    // before the drive starts is rejected instead of starting a second loop. The releaser rides
    // on the instance because only the DO can reach the gate.
    await runInDurableObject(assistantOf(owner), (i: Assistant) => {
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      (i as unknown as { releaseResume: () => void }).releaseResume = release;
      i.resolveModel = (async () => {
        await gate;
        return { provider, model: "test-model", apiKey: null };
      }) as Assistant["resolveModel"];
      void i.resumeBatch(batchId);
    });
    tab.send?.("conv-busy", "Are you still there?");
    await tab.until?.("turn.failed");
    expect(tab.events.find((e) => e.type === "turn.failed")).toMatchObject({
      payload: { message: "Another reply is still being written." },
    });
    await runInDurableObject(assistantOf(owner), (i: Assistant) =>
      (i as unknown as { releaseResume: () => void }).releaseResume(),
    );
    await tab.until?.("turn.completed");
    expect(send.inputs).toEqual([{ q: "hi" }]);
    expect(await count("usage", "conversation_id = 'conv-busy'")).toBe(2);
  });

  it("stops at the call limit in D1 and a Continue runs it to the end", async () => {
    const { browser, owner } = await claim();
    const lookup = loopTool("lookup", "read");
    let done = false;
    const next = (): Reply => (done ? { text: "Finished" } : { calls: [["lookup", { q: "x" }]] });
    await useModel(owner, replying([next]));
    await useTools(owner, [lookup.tool]);
    const tab = await openTab(browser);
    tab.send?.("conv-limit", "Keep looking");
    await tab.until?.("limit.reached");
    const reached = tab.events.find((e) => e.type === "limit.reached");
    expect(reached).toMatchObject({ payload: { kind: "calls" } });
    const turnId = reached?.turnId;
    const status = "SELECT status FROM turn_states WHERE turn_id = ?";
    expect(await db.prepare(status).bind(turnId).first("status")).toBe("limit_reached");
    // The counts stopped it, so a resume without a fresh allowance would be wrong here:
    // resumeAfterLimit is the Continue that grants one (the same turn, counts reset).
    done = true;
    const resumed = await runInDurableObject(assistantOf(owner), (i: Assistant) =>
      i.resumeAfterLimit(turnId as string),
    );
    expect(resumed).toBe(true);
    await tab.until?.("turn.completed");
    expect(await count("turn_states", `turn_id = '${turnId}'`)).toBe(0);
    expect(await stored(browser, "conv-limit")).toMatchObject([
      { content: "Keep looking", status: "complete" },
      { content: "Finished", status: "complete" },
    ]);
  });

  it("cancels as turn.cancelled, keeping the partial reply and no saved state", async () => {
    const { browser, owner } = await claim();
    // One delta, then nothing until the abort: `scripted` yields a second delta after its gate
    // releases, which races the cancel, so this turn's model ends its stream on the abort.
    const provider: ModelProvider = {
      id: "scripted",
      listModels: async () => [],
      capabilities: () => ({ tools: false, usageInStream: true }),
      async *stream(request): AsyncGenerator<ModelEvent> {
        yield { type: "text.delta", text: "Hello" };
        await new Promise<void>((r) => request.signal?.addEventListener("abort", () => r()));
        yield { type: "usage", usage: USAGE };
        yield { type: "done", finishReason: "stop" };
      },
    };
    await useModel(owner, provider);
    const tab = await openTab(browser);
    tab.send?.("conv-cancel", "Tell me a story");
    await tab.until?.("message.delta");
    tab.ws?.send(JSON.stringify({ type: "turn.cancel" }));
    await tab.until?.("turn.cancelled");
    expect(await stored(browser, "conv-cancel")).toMatchObject([
      { content: "Tell me a story", status: "complete" },
      { content: "Hello", status: "interrupted" },
    ]);
    expect(await count("turn_states", "1")).toBe(0);
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

describe("approvals in the DO host (M3-07a)", () => {
  const asked = (events: HarnessEvent[]) => {
    const e = events.find(
      (x): x is Extract<HarnessEvent, { type: "approval.requested" }> =>
        x.type === "approval.requested",
    );
    if (!e) throw new Error("no approval.requested");
    return { batchId: e.payload.batchId, approvalId: e.payload.items[0]?.approvalId ?? "" };
  };
  const completed = (events: HarnessEvent[]) =>
    events.filter((e) => e.type === "turn.completed").length;

  it("waits in the FIFO behind a running turn, then appends a late approval at the end (AC14)", async () => {
    const { browser, owner } = await claim();
    const send = loopTool("send", "consequential");
    const seen: ModelMessage[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const replies: Reply[] = [
      { text: "Sending.", calls: [["send", { q: "hi" }]] },
      { text: "Something else" },
      { text: "Sent it after all" },
    ];
    let at = 0;
    const provider: ModelProvider = {
      ...replying([]),
      async *stream(request) {
        seen.push(request.messages);
        const n = at++;
        if (n === 1) await gate; // the newer turn is still running when the approval lands
        yield* replying([replies[n] as Reply]).stream(request);
      },
    };
    await useModel(owner, provider);
    await useTools(owner, [send.tool]);
    const tab = await openTab(browser);
    tab.send?.("conv-late", "Send it");
    await tab.until?.("approval.requested");
    const { batchId, approvalId } = asked(tab.events);

    tab.send?.("conv-late", "Never mind, something else");
    await vi.waitFor(() => expect(seen).toHaveLength(2), SOCKET_WAIT);
    await decideInD1(batchId, approvalId, "approved");
    const resumed = await runInDurableObject(assistantOf(owner), (i: Assistant) =>
      i.resumeBatch(batchId),
    );
    expect(resumed).toBe("queued");
    expect(send.inputs).toEqual([]);
    release();
    // The newer turn ends, then the batch resumes on its own: the old turn settles (its own
    // turn.completed) and a new turn runs the call at the end.
    await vi.waitFor(() => expect(completed(tab.events)).toBe(3), SOCKET_WAIT);
    expect(send.inputs).toEqual([{ q: "hi" }]);
    expect(await stored(browser, "conv-late")).toMatchObject([
      { content: "Send it", status: "complete" },
      { content: "Sending.", status: "complete" },
      { content: "Never mind, something else", status: "complete" },
      { content: "Something else", status: "complete" },
      { content: 'Approved later: send, from "Send it"', status: "complete" },
      { content: "Sent it after all", status: "complete" },
    ]);
    // The model continues from the end: the newer turn, then the label, the call, its result.
    const last = seen.at(-1) ?? [];
    expect(last.slice(-5).map((m) => [m.role, m.content.slice(0, 20)])).toEqual([
      ["user", "Never mind, somethin"],
      ["assistant", "Something else"],
      ["user", "[Approved later] I a"],
      ["assistant", ""],
      ["tool", "send ok"],
    ]);
    expect(await count("turn_states", "1")).toBe(0);
  });

  it("resumes a batch queued behind a resume that found its own batch still waiting", async () => {
    const { browser, owner } = await claim();
    const send = loopTool("send", "consequential");
    const replies = [{ calls: [["send", { q: "a" }]] }, { calls: [["send", { q: "b" }]] }];
    await useModel(owner, replying([...(replies as Reply[]), { text: "Sent" }]));
    await useTools(owner, [send.tool]);
    const tab = await openTab(browser);
    tab.send?.("conv-qa", "Send a");
    await tab.until?.("approval.requested");
    const a = asked(tab.events);
    tab.send?.("conv-qb", "Send b");
    await vi.waitFor(
      () => expect(tab.events.filter((e) => e.type === "approval.requested")).toHaveLength(2),
      SOCKET_WAIT,
    );
    const b = tab.events.filter(
      (e): e is Extract<HarnessEvent, { type: "approval.requested" }> =>
        e.type === "approval.requested",
    )[1]?.payload;
    if (!b) throw new Error("no second batch");
    await decideInD1(b.batchId, b.items[0]?.approvalId ?? "", "approved");
    // A's resume holds the slot while it reads D1, so B queues; A is still undecided and
    // starts nothing. B must still run once A lets go.
    const results = await runInDurableObject(assistantOf(owner), (i: Assistant) =>
      Promise.all([i.resumeBatch(a.batchId), i.resumeBatch(b.batchId)]),
    );
    expect(results).toEqual(["waiting", "queued"]);
    await vi.waitFor(() => expect(send.inputs).toEqual([{ q: "b" }]), SOCKET_WAIT);
  });

  it("keeps a queued batch whose resume failed, for the next try", async () => {
    const { browser, owner } = await claim();
    const send = loopTool("send", "consequential");
    const replies = [{ calls: [["send", { q: "a" }]] }, { calls: [["send", { q: "b" }]] }];
    await useModel(owner, replying([...(replies as Reply[]), { text: "Sent" }]));
    await useTools(owner, [send.tool]);
    const tab = await openTab(browser);
    tab.send?.("conv-fa", "Send a");
    await tab.until?.("approval.requested");
    const a = asked(tab.events);
    tab.send?.("conv-fb", "Send b");
    await vi.waitFor(
      () => expect(tab.events.filter((e) => e.type === "approval.requested")).toHaveLength(2),
      SOCKET_WAIT,
    );
    const b = tab.events.filter(
      (e): e is Extract<HarnessEvent, { type: "approval.requested" }> =>
        e.type === "approval.requested",
    )[1]?.payload;
    if (!b) throw new Error("no second batch");
    await decideInD1(b.batchId, b.items[0]?.approvalId ?? "", "approved");
    // B queues behind A's resume, and its own resume then fails on a vault hiccup.
    const queued = await runInDurableObject(assistantOf(owner), async (i: Assistant, state) => {
      const resolve = i.resolveModel;
      i.resolveModel = async () => {
        throw new Error("vault hiccup");
      };
      const results = await Promise.all([i.resumeBatch(a.batchId), i.resumeBatch(b.batchId)]);
      await vi.waitFor(() => expect(state.storage.kv.get("approvals:queue")).toEqual([b.batchId]));
      i.resolveModel = resolve;
      return results;
    });
    expect(queued).toEqual(["waiting", "queued"]);
    expect(send.inputs).toEqual([]);
    // Still queued, so the next try runs it.
    const again = await runInDurableObject(assistantOf(owner), (i: Assistant) =>
      i.resumeBatch(b.batchId),
    );
    expect(again).toBe("resumed");
    await vi.waitFor(() => expect(send.inputs).toEqual([{ q: "b" }]), SOCKET_WAIT);
  });

  it("keeps queued batches in order when the first one's resume fails", async () => {
    const { browser, owner } = await claim();
    const send = loopTool("send", "consequential");
    const replies = ["a", "b", "c"].map((q) => ({ calls: [["send", { q }]] }));
    await useModel(owner, replying([...(replies as Reply[]), { text: "Sent" }]));
    await useTools(owner, [send.tool]);
    const tab = await openTab(browser);
    const batches = async (n: number) => {
      await vi.waitFor(
        () => expect(tab.events.filter((e) => e.type === "approval.requested")).toHaveLength(n),
        SOCKET_WAIT,
      );
      return tab.events
        .filter(
          (e): e is Extract<HarnessEvent, { type: "approval.requested" }> =>
            e.type === "approval.requested",
        )
        .map((e) => e.payload);
    };
    tab.send?.("conv-oa", "Send a");
    await batches(1);
    tab.send?.("conv-ob", "Send b");
    await batches(2);
    tab.send?.("conv-oc", "Send c");
    const [a, b, c] = await batches(3);
    if (!a || !b || !c) throw new Error("missing batches");
    for (const x of [b, c]) await decideInD1(x.batchId, x.items[0]?.approvalId ?? "", "approved");
    // B and C queue behind A's resume; B's resume then fails once, on a vault hiccup. Its
    // failure must not let C run ahead of it.
    const queue = await runInDurableObject(assistantOf(owner), async (i: Assistant, state) => {
      const resolve = i.resolveModel;
      let failed = false;
      i.resolveModel = async (...args) => {
        if (failed) return resolve(...args);
        failed = true;
        throw new Error("vault hiccup");
      };
      await Promise.all([a, b, c].map((x) => i.resumeBatch(x.batchId)));
      await vi.waitFor(() => expect(failed).toBe(true));
      await vi.waitFor(() =>
        expect(state.storage.kv.get("approvals:queue")).toEqual([b.batchId, c.batchId]),
      );
      i.resolveModel = resolve;
      return state.storage.kv.get("approvals:queue");
    });
    expect(queue).toEqual([b.batchId, c.batchId]);
    expect(send.inputs).toEqual([]);
  });

  it("ends a row a restart left executing as failed with an unknown outcome", async () => {
    const { browser, owner } = await claim();
    const send = loopTool("send", "consequential");
    await useModel(owner, replying([{ calls: [["send", { q: "hi" }]] }, { text: "Not sent" }]));
    await useTools(owner, [send.tool]);
    const tab = await openTab(browser);
    tab.send?.("conv-claimed", "Send it");
    await tab.until?.("approval.requested");
    const { batchId, approvalId } = asked(tab.events);
    // A run claimed the row and then the DO restarted: whether the call acted is unknown.
    await decideInD1(batchId, approvalId, "approved");
    await db
      .prepare("UPDATE approvals SET status = 'executing' WHERE batch_id = ?")
      .bind(batchId)
      .run();
    await runInDurableObject(assistantOf(owner), (i: Assistant) => i.resumeBatch(batchId));
    await tab.until?.("turn.completed");
    expect(send.inputs).toEqual([]);
    const row = await db
      .prepare("SELECT status, reason FROM approvals WHERE batch_id = ?")
      .bind(batchId)
      .first();
    expect(row).toEqual({ status: "failed", reason: "outcome_unknown" });
  });

  it("refuses an approved call whose tool changed since it was approved (AC12)", async () => {
    const { browser, owner } = await claim();
    const send = loopTool("send", "consequential");
    await useModel(owner, replying([{ calls: [["send", { q: "hi" }]] }, { text: "Not sent" }]));
    await useTools(owner, [send.tool]);
    const tab = await openTab(browser);
    tab.send?.("conv-changed", "Send it");
    await tab.until?.("approval.requested");
    const { batchId, approvalId } = asked(tab.events);
    await decideInD1(batchId, approvalId, "approved");
    const changed = { ...send.tool, manifest: { ...send.tool.manifest, description: "New." } };
    await useTools(owner, [changed]);
    await runInDurableObject(assistantOf(owner), (i: Assistant) => i.resumeBatch(batchId));
    await tab.until?.("turn.completed");
    expect(send.inputs).toEqual([]);
    const row = await db
      .prepare("SELECT status, reason FROM approvals WHERE batch_id = ?")
      .bind(batchId)
      .first();
    expect(row).toEqual({ status: "denied", reason: "tool_changed" });
    const steps = tab.events.filter((e) => e.type === "step.completed");
    expect(steps.map((e) => (e.payload as { status: string }).status)).toContain("denied");
  });
});
