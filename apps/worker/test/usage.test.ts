// SPDX-License-Identifier: Apache-2.0
// The usage ledger and the Usage page's data (M2-21): a chat on Workers AI and on `openai-chat`
// shows its tokens and an estimate from the price table; old and missing prices say so.
import { runInDurableObject } from "cloudflare:test";
import type { HarnessEvent, ModelEvent, ModelProvider } from "@opa/core";
import { describe, expect, it, vi } from "vitest";
import type { Assistant } from "../src/assistant";
import { workerApp } from "../src/worker-app";
import { Browser, claim, db, env, freshDatabase, ORIGIN, sessionHeaders } from "./helpers/app";

freshDatabase();

interface Period {
  costMicroUsd: number;
  unpricedCalls: number;
  groups: { lines: unknown[] }[];
}
type UsageBody = { today: Period; month: Period; allowance: { resetsAt: number } | null };

const USAGE = { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 400, reasoningTokens: 0 };

function provider(id: string): ModelProvider {
  return {
    id,
    listModels: async () => [],
    capabilities: () => ({ tools: false, usageInStream: true }),
    async *stream(): AsyncGenerator<ModelEvent> {
      yield { type: "text.delta", text: "Hi" };
      yield { type: "usage", usage: USAGE };
      yield { type: "done", finishReason: "stop" };
    },
  };
}

/** One chat turn on `providerId`/`model`, over the real socket and Assistant DO. */
async function chat(owner: string, cookie: string, providerId: string, model: string) {
  const stub = env.ASSISTANT.get(env.ASSISTANT.idFromName(`u:${owner}`));
  await runInDurableObject(stub, (i: Assistant) => {
    i.resolveModel = async () => ({ provider: provider(providerId), model, apiKey: null });
  });
  const headers = { upgrade: "websocket", origin: ORIGIN, cookie };
  const ws = (await workerApp.request(`${ORIGIN}/api/chat`, { headers }, env)).webSocket;
  if (!ws) throw new Error("no socket");
  ws.accept();
  const events: string[] = [];
  ws.addEventListener("message", (e) => {
    events.push((JSON.parse(e.data as string) as HarnessEvent).type);
  });
  ws.send(JSON.stringify({ type: "chat.send", conversationId: crypto.randomUUID(), text: "Hi" }));
  await vi.waitFor(() => expect(events).toContain("turn.completed"));
  ws.close();
}

describe("usage ledger", () => {
  it("prices Workers AI and openai-chat calls from the table and groups them by who bills", async () => {
    const { browser, owner } = await claim();
    const cookie = [...browser.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    await chat(owner, cookie, "workers-ai", "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    await chat(owner, cookie, "openai", "gpt-4.1-mini");
    await chat(owner, cookie, "my-llm", "homebrew-7b");

    const res = await browser.req("/api/usage");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json<UsageBody>();
    // Workers AI: 1000 × $0.293/M + 500 × $2.253/M = 1420 µ$; 130 neurons.
    // gpt-4.1-mini: 600 × $0.40/M + 400 × $0.10/M + 500 × $1.60/M = 1080 µ$.
    expect(body.today).toMatchObject({ costMicroUsd: 2500, unpricedCalls: 1 });
    expect(body.today.groups).toMatchObject([
      { label: "Billed by my-llm", billingUrl: null, costMicroUsd: 0 },
      { label: "Billed by OpenAI", costMicroUsd: 1080 },
      { label: "Billed by Cloudflare: Workers AI", costMicroUsd: 1420 },
    ]);
    const lines = body.today.groups.flatMap((g) => g.lines);
    expect(lines).toMatchObject([
      { name: "homebrew-7b", calls: 1, costMicroUsd: null, costSource: null, stale: false },
      { name: "GPT-4.1 mini", inputTokens: 1000, outputTokens: 500, costSource: "estimated" },
      { name: "Llama 3.3 70B (fast)", costMicroUsd: 1420, priceVerifiedAt: "2026-11-01" },
    ]);
    expect(body.month).toEqual(body.today);
    expect(body.allowance).toMatchObject({ neuronsPerDay: 10000, neuronsUsedHere: 130 });
    expect((body.allowance?.resetsAt ?? 1) % 86_400_000).toBe(0);
  });

  it("flags a price checked more than 90 days ago and keeps other users' calls out", async () => {
    const { browser, owner } = await claim();
    const insert = db.prepare(
      "INSERT INTO usage (id, user_id, provider_id, model, cost_micro_usd, cost_source, price_verified_at) VALUES (?, ?, 'openai', 'gpt-4.1', ?, 'estimated', ?)",
    );
    await db.batch([
      db.prepare("INSERT INTO users (id, display_name, role) VALUES ('other', 'O', 'member')"),
      insert.bind("u1", owner, 5, "2020-01-01"),
      insert.bind("u2", "other", 7, "2026-11-01"),
    ]);
    const body = await (await browser.req("/api/usage")).json<UsageBody>();
    expect(body.today.costMicroUsd).toBe(5);
    // The allowance total includes everyone's calls, so a member doesn't get it.
    const member = { headers: await sessionHeaders("other") };
    const theirs = await workerApp.request(`${ORIGIN}/api/usage`, member, env);
    expect((await theirs.json<UsageBody>()).allowance).toBeNull();
    expect(body.today.groups[0]?.lines).toMatchObject([
      { name: "GPT-4.1", priceVerifiedAt: "2020-01-01", stale: true },
    ]);
  });

  it("takes the client's local midnight, and ignores an implausible one", async () => {
    const { browser, owner } = await claim();
    const insert = db.prepare(
      "INSERT INTO usage (id, user_id, provider_id, model, created_at) VALUES (?, ?, 'openai', 'x', ?)",
    );
    const hourAgo = Date.now() - 3_600_000;
    await insert.bind("a", owner, hourAgo).run();
    const calls = async (q: string) =>
      (await (await browser.req(`/api/usage?${q}`)).json<UsageBody>()).today.unpricedCalls;
    expect(await calls(`today=${hourAgo + 1}`)).toBe(0);
    expect(await calls(`today=${hourAgo - 1}`)).toBe(1);
    expect(await calls("today=0")).toBe(await calls(""));
  });

  it("is for signed-in users only", async () => {
    await claim();
    expect((await new Browser().req("/api/usage")).status).toBe(401);
  });
});
