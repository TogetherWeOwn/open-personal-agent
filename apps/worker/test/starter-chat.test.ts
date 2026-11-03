// SPDX-License-Identifier: Apache-2.0
// TWO-1960: the first answer on a fresh Cloudflare deploy failed once chat turns offered the
// production tool registry to every model. The keyless starter is chat only (the T7 probe, the
// shipped "Starter — chat only" label), so a chat turn through the real Worker root with the
// real `workers-ai-binding` provider and the default starter model must complete without
// offering tools — while the production tool wiring stays in place. The stub binding refuses a
// request that offers tools, as the starter does live, so this fails on the pre-fix composition
// (the turn settles `turn.failed`) and passes with the fix.
import { runInDurableObject } from "cloudflare:test";
import type { HarnessEvent } from "@opa/core";
import { createWorkersAIProvider, STARTER_MODEL, type WorkersAIBinding } from "@opa/providers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Assistant } from "../src/assistant";
import { workerApp } from "../src/worker-app";
import { type Browser, claim, env, freshDatabase, ORIGIN, SOCKET_WAIT } from "./helpers/app";

freshDatabase();
afterEach(() => vi.restoreAllMocks());

const assistantOf = (userId: string) => env.ASSISTANT.get(env.ASSISTANT.idFromName(`u:${userId}`));

/** The starter answers plain text, and refuses a request that offers tools, as it does live. */
function starterBinding(seen: { model: unknown; inputs: Record<string, unknown> }[]) {
  const text =
    'data: {"response":"Hi from the starter.","p":"x"}\n\n' +
    'data: {"response":"","usage":{"prompt_tokens":25,"completion_tokens":6,"total_tokens":31}}\n\n' +
    "data: [DONE]\n";
  const ai: WorkersAIBinding = {
    run: async (model, inputs) => {
      seen.push({ model, inputs: inputs as Record<string, unknown> });
      if ((inputs as { tools?: unknown[] }).tools?.length) {
        throw new Error("`tools` is not supported for this model");
      }
      return new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      });
    },
  };
  return ai;
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

describe("the chat-only starter (TWO-1960)", () => {
  it("completes the first answer without offering tools", async () => {
    const { browser, owner } = await claim();
    const seen: { model: unknown; inputs: Record<string, unknown> }[] = [];
    await runInDurableObject(assistantOf(owner), (instance: Assistant) => {
      // Only the model pick is scripted: the turn composes the production tool registry.
      instance.resolveModel = async () => ({
        provider: createWorkersAIProvider(starterBinding(seen)),
        model: STARTER_MODEL,
        apiKey: null,
      });
    });
    const tab = await openTab(browser);
    tab.send?.("conv-starter-first", "hi");
    await tab.until?.("turn.completed");

    expect(seen).toHaveLength(1);
    const [first] = seen;
    expect(first?.model).toBe(STARTER_MODEL);
    expect(first?.inputs).not.toHaveProperty("tools");
    expect((tab.events ?? []).map((e) => e.type)).not.toContain("turn.failed");
  });
});
