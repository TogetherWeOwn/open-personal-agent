// SPDX-License-Identifier: Apache-2.0
// The production tool wiring (M3-08) on Workers: a chat turn offers the builtin registry plus
// the memory tools (`task` deliberately not offered: no runnable creation path yet) — no test
// seam — with the policy input read from the user's stored overrides. The scripted model calls `web_fetch` (refused: a private literal, so no fetch is
// attempted and the refusal keeps the turn trusted) then `create_artifact`, so the turn
// completes with the artifact saved. A second turn shows Settings › Apps & tools governing the
// loop: with `web_fetch` set to `never`, the call is denied from the stored override and the
// tool never runs.
import { runInDurableObject } from "cloudflare:test";
import type { HarnessEvent, ModelEvent, ModelProvider } from "@opa/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Assistant } from "../src/assistant";
import { workerApp } from "../src/worker-app";
import { type Browser, claim, count, env, freshDatabase, ORIGIN, SOCKET_WAIT } from "./helpers/app";

freshDatabase();
afterEach(() => vi.restoreAllMocks());

const USAGE = { inputTokens: 12, outputTokens: 3, cachedInputTokens: 0, reasoningTokens: 0 };
/** Every tool the production turn offers, in registry order (`task` not offered yet). */
const ALL_TOOLS = [
  "web_fetch",
  "search_history",
  "create_artifact",
  "read_file",
  "remember",
  "recall",
  "forget",
];

type Reply = { text?: string; calls?: [name: string, args: unknown][] };

/**
 * A model that answers each call with the next reply (the last one repeats), recording the
 * tools each call offered. Deliberately no `useTools`: the turn offers the production registry.
 */
function replyingWithOffered(replies: Reply[], offered: string[][]): ModelProvider {
  let ids = 0;
  let at = 0;
  return {
    id: "scripted",
    listModels: async () => [],
    capabilities: () => ({ tools: true, usageInStream: true }),
    async *stream(request): AsyncGenerator<ModelEvent> {
      offered.push((request.tools ?? []).map((t) => t.name));
      const reply = replies[Math.min(at++, replies.length - 1)] ?? { text: "done" };
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

const assistantOf = (userId: string) => env.ASSISTANT.get(env.ASSISTANT.idFromName(`u:${userId}`));
function useModel(userId: string, provider: ModelProvider) {
  return runInDurableObject(assistantOf(userId), (instance: Assistant) => {
    instance.resolveModel = async () => ({ provider, model: "test-model", apiKey: null });
  });
}

/** Opens a tab's WebSocket and collects the events it receives. */
async function openTab(br: Browser) {
  const cookie = [...br.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await workerApp.request(
    `${ORIGIN}/api/chat`,
    { headers: { upgrade: "websocket", origin: ORIGIN, cookie } },
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
    vi.waitFor(() => expect(events.map((e) => e.type)).toContain(type), SOCKET_WAIT);
  const send = (conversationId: string, text: string) =>
    ws.send(JSON.stringify({ type: "chat.send", conversationId, text }));
  return { res, ws, events, until, send };
}

describe("the production tool wiring (M3-08)", () => {
  it("runs the two-tool turn against the production registry", async () => {
    const { browser, owner } = await claim();
    const offered: string[][] = [];
    await useModel(
      owner,
      replyingWithOffered(
        [
          { calls: [["web_fetch", { url: "http://127.0.0.1/notes" }]] },
          {
            calls: [["create_artifact", { name: "fetch-notes.md", content: "# notes\n\nsaved\n" }]],
          },
          { text: "Saved the notes." },
        ],
        offered,
      ),
    );
    const tab = await openTab(browser);
    tab.send?.("conv-tools", "fetch the notes and save them");
    await tab.until?.("turn.completed");

    // The turn offered every production tool.
    expect(offered.length).toBeGreaterThan(0);
    expect(offered[0]).toEqual(ALL_TOOLS);

    // `web_fetch` ran first and was refused without attempting a fetch — a private literal —
    // then `create_artifact` saved, then the turn completed.
    const events = tab.events ?? [];
    const types = events.map((e) => e.type);
    expect(types).not.toContain("turn.failed");
    expect(types).not.toContain("approval.requested");
    expect(types.filter((t) => t === "tool.called")).toHaveLength(2);
    expect(types.filter((t) => t === "tool.result")).toHaveLength(2);
    const [first, second] = events.filter((e) => e.type === "tool.called");
    expect(first).toMatchObject({ payload: { tool: "web_fetch", risk: "read" } });
    expect(second).toMatchObject({
      payload: { tool: "create_artifact", risk: "write_reversible" },
    });
    const [firstResult, secondResult] = events.filter((e) => e.type === "tool.result");
    expect(firstResult).toMatchObject({ payload: { ok: false } });
    expect(JSON.stringify(firstResult)).toContain("private, loopback or link-local");
    expect(secondResult).toMatchObject({ payload: { ok: true } });

    // The artifact reached the store: one row under this conversation.
    expect(await count("artifacts", "name = 'fetch-notes.md'")).toBe(1);
    expect(await count("usage", "conversation_id = 'conv-tools'")).toBe(3);
  });

  it("denies a call Settings forbids without running it", async () => {
    const { browser, owner } = await claim();
    // Tightening needs no passkey step-up; the listing shows the stored override back.
    const put = await browser.req("/api/settings/tools/web_fetch", {
      method: "PUT",
      body: { override: "never" },
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ name: "web_fetch", override: "never" });

    const offered: string[][] = [];
    await useModel(
      owner,
      replyingWithOffered(
        [
          { calls: [["web_fetch", { url: "http://127.0.0.1/notes" }]] },
          { text: "That tool is off." },
        ],
        offered,
      ),
    );
    const tab = await openTab(browser);
    tab.send?.("conv-tools-forbidden", "fetch the notes again");
    await tab.until?.("turn.completed");

    // The loop still offers the registry, but decides the call from the stored override: the
    // denial names the user's choice, not the guard's refusal, so the tool never ran.
    const events = tab.events ?? [];
    const types = events.map((e) => e.type);
    expect(types).not.toContain("turn.failed");
    const called = events.filter((e) => e.type === "tool.called");
    expect(called).toHaveLength(1);
    expect(called[0]).toMatchObject({ payload: { tool: "web_fetch" } });
    const results = events.filter((e) => e.type === "tool.result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ payload: { ok: false } });
    expect(JSON.stringify(results[0])).toContain("turned this tool off");
    expect(JSON.stringify(results[0])).not.toContain("private, loopback or link-local");
  });

  it("settles the reply and releases the hold when tool resolution fails", async () => {
    // Through the assistant's `resolveTools` seam: the production resolver awaits D1-backed
    // policy reads, and a rejection must settle the reply as an error (not strand it as
    // `streaming`) and release the first call's hold.
    const { browser, owner } = await claim();
    const offered: string[][] = [];
    await useModel(owner, replyingWithOffered([{ text: "unused" }], offered));
    await runInDurableObject(assistantOf(owner), (instance: Assistant) => {
      instance.resolveTools = async () => {
        throw new Error("policy store down");
      };
    });
    const tab = await openTab(browser);
    tab.send?.("conv-tools-noresolve", "fetch the notes");
    await tab.until?.("turn.failed");

    const events = tab.events ?? [];
    const types = events.map((e) => e.type);
    expect(types).not.toContain("turn.completed");
    const failed = events.find((e) => e.type === "turn.failed");
    expect(JSON.stringify(failed)).toContain("couldn't be saved");
    // The reply settled as an error, not left `streaming`.
    const { messages } = await (
      await browser.req("/api/conversations/conv-tools-noresolve/messages")
    ).json<{ messages: { content: string; status: string }[] }>();
    expect(messages.filter((m) => m.status === "error")).toHaveLength(1);
    // The first call's hold went back uncharged: nothing is left held.
    const held = await runInDurableObject(
      assistantOf(owner),
      (instance: Assistant) => instance.limits.totals().heldMicroUsd,
    );
    expect(held).toBe(0);
  });
});
