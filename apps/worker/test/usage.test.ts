// SPDX-License-Identifier: Apache-2.0
// The usage ledger and the Usage page's data (M2-21, M3-16): a chat on Workers AI, `openai-chat`
// and Anthropic shows its tokens and an estimate from the price table (A-Co1); old and missing
// prices say so; the seven cost categories, the projection and the breakdowns add up.
import { runInDurableObject } from "cloudflare:test";
import type { HarnessEvent, ModelEvent, ModelProvider } from "@opa/core";
import { breakdowns, calendar } from "@opa/server/usage";
import { describe, expect, it, vi } from "vitest";
import type { Assistant } from "../src/assistant";
import { workerApp } from "../src/worker-app";
import {
  Browser,
  claim,
  db,
  env,
  freshDatabase,
  ORIGIN,
  SOCKET_WAIT,
  sessionHeaders,
} from "./helpers/app";

freshDatabase();

interface Period {
  costMicroUsd: number;
  unpricedCalls: number;
  groups: { lines: unknown[] }[];
}
interface Breakdown {
  id: string | null;
  title: string | null;
  calls: number;
  costMicroUsd: number;
  unpricedCalls: number;
}
type UsageBody = {
  today: Period;
  month: Period;
  projected: { costMicroUsd: number };
  categories: { id: string; status: string; month?: number | null }[];
  breakdowns: {
    conversation: Breakdown[];
    task: Breakdown[];
    day: { date: string; calls: number; costMicroUsd: number }[];
  };
  allowance: { resetsAt: number; freeNeuronsUsed: number; billedNeurons: number } | null;
};
const DAY = 86_400_000;

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
  await vi.waitFor(() => expect(events).toContain("turn.completed"), SOCKET_WAIT);
  ws.close();
}

describe("usage ledger", () => {
  it("prices Workers AI and openai-chat calls from the table and groups them by who bills", async () => {
    const { browser, owner } = await claim();
    const cookie = [...browser.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    await chat(owner, cookie, "workers-ai", "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    await chat(owner, cookie, "openai", "gpt-4.1-mini");
    await chat(owner, cookie, "anthropic", "claude-sonnet-5-5");
    await chat(owner, cookie, "my-llm", "homebrew-7b");

    const res = await browser.req("/api/usage");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json<UsageBody>();
    // Workers AI: 1000 × $0.293/M + 500 × $2.253/M = 1420 µ$; 130 neurons.
    // gpt-4.1-mini: 600 × $0.40/M + 400 × $0.10/M + 500 × $1.60/M = 1080 µ$.
    // claude-sonnet-5-5: 600 × $2/M + 400 × $0.10/M + 500 × $10/M = 6240 µ$.
    expect(body.today).toMatchObject({ costMicroUsd: 8740, unpricedCalls: 1 });
    expect(body.today.groups).toMatchObject([
      { label: "Billed by Anthropic", costMicroUsd: 6240 },
      { label: "Billed by my-llm", billingUrl: null, costMicroUsd: 0 },
      { label: "Billed by OpenAI", costMicroUsd: 1080 },
      { label: "Billed by Cloudflare: Workers AI", costMicroUsd: 1420 },
    ]);
    const lines = body.today.groups.flatMap((g) => g.lines);
    expect(lines).toMatchObject([
      { name: "Claude Sonnet 5.5", inputTokens: 1000, outputTokens: 500, costMicroUsd: 6240 },
      { name: "homebrew-7b", calls: 1, costMicroUsd: null, costSource: null, stale: false },
      { name: "GPT-4.1 mini", inputTokens: 1000, outputTokens: 500, costSource: "estimated" },
      { name: "Llama 3.3 70B (fast)", costMicroUsd: 1420, priceVerifiedAt: "2026-11-01" },
    ]);
    expect(body.month).toEqual(body.today);
    expect(body.allowance).toMatchObject({
      neuronsPerDay: 10000,
      neuronsUsedHere: 130,
      freeNeuronsUsed: 130,
      billedNeurons: 0,
    });
    // Each chat is its own conversation, titled from its first message.
    expect(body.breakdowns.conversation).toHaveLength(4);
    expect(body.breakdowns.task).toEqual([
      { id: null, title: null, calls: 4, costMicroUsd: 8740, unpricedCalls: 1 },
    ]);
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

  it("splits the month into the seven categories and projects it to month-end", async () => {
    const { browser, owner } = await claim();
    const now = Date.now();
    const d = new Date(now);
    const month = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const days = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    await db
      .prepare(
        "INSERT INTO usage (id, user_id, provider_id, model, cost_micro_usd, cost_source, created_at) VALUES ('m', ?, 'openai', 'gpt-4.1', 1000, 'estimated', ?)",
      )
      .bind(owner, month)
      .run();
    const body = await (await browser.req(`/api/usage?month=${month}`)).json<UsageBody>();
    expect(body.categories.map((c) => [c.id, c.status])).toEqual([
      ["workers-paid", "billed"],
      ["cloudflare", "included"],
      ["storage", "included"],
      ["ai", "billed"],
      ["computers", "none-configured"],
      ["connectors", "none-configured"],
      ["enhanced", "none-configured"],
    ]);
    expect(body.categories[0]).toMatchObject({ month: 5_000_000, label: "Billed by Cloudflare" });
    expect(body.categories[3]).toMatchObject({ month: 1000 });
    // Under a day in, the pace counts a whole day.
    const elapsed = Math.max((now - month) / DAY, 1);
    expect(body.projected.costMicroUsd).toBeCloseTo((1000 * days) / elapsed, -1);
  });

  it("breaks the month down by conversation, task and local day", async () => {
    const { browser, owner } = await claim();
    // Another user's rows stay out. (A row of mine can't name their conversation or task: the
    // migrations' triggers refuse it, TWO-427 L-4.)
    // A client two hours ahead of UTC: its midnight is 22:00 UTC the day before.
    const utcDay = Date.now() - (Date.now() % DAY);
    const today = utcDay - 2 * 3_600_000 + (Date.now() - utcDay >= 22 * 3_600_000 ? DAY : 0);
    const month = today - 2 * DAY;
    const row = db.prepare(
      "INSERT INTO usage (id, user_id, conversation_id, task_id, provider_id, model, cost_micro_usd, cost_source, created_at) VALUES (?, ?, ?, ?, 'openai', 'gpt-4.1', ?, ?, ?)",
    );
    await db.batch([
      db.prepare("INSERT INTO users (id, display_name, role) VALUES ('other', 'O', 'member')"),
      db
        .prepare("INSERT INTO conversations (id, user_id, title) VALUES ('c1', ?, 'Trip')")
        .bind(owner),
      db.prepare("INSERT INTO conversations (id, user_id, title) VALUES ('c2', 'other', 'Theirs')"),
      db
        .prepare(
          "INSERT INTO tasks (id, user_id, conversation_id, kind, mode, title) VALUES ('t1', ?, 'c1', 'turn', 'background', 'Plan the trip')",
        )
        .bind(owner),
      row.bind("a", owner, "c1", "t1", 30, "estimated", month + 1),
      row.bind("b", owner, "c1", null, 20, "estimated", today - 1),
      row.bind("c", owner, null, null, null, null, today + 1),
      row.bind("e", "other", "c2", null, 1000, "estimated", today + 3),
    ]);
    const body = await (
      await browser.req(`/api/usage?today=${today}&month=${month}`)
    ).json<UsageBody>();
    expect(body.breakdowns.conversation).toEqual([
      { id: "c1", title: "Trip", calls: 2, costMicroUsd: 50, unpricedCalls: 0 },
      { id: null, title: null, calls: 1, costMicroUsd: 0, unpricedCalls: 1 },
    ]);
    expect(body.breakdowns.task).toEqual([
      { id: "t1", title: "Plan the trip", calls: 1, costMicroUsd: 30, unpricedCalls: 0 },
      { id: null, title: null, calls: 2, costMicroUsd: 20, unpricedCalls: 1 },
    ]);
    const local = (t: number) => new Date(t + 2 * 3_600_000).toISOString().slice(0, 10);
    expect(body.breakdowns.day).toEqual([
      { date: local(month), calls: 1, costMicroUsd: 30, unpricedCalls: 0 },
      { date: local(month + DAY), calls: 1, costMicroUsd: 20, unpricedCalls: 0 },
      { date: local(today), calls: 1, costMicroUsd: 0, unpricedCalls: 1 },
    ]);
  });

  it("puts each call on the client's calendar across a DST change, and at UTC+12", async () => {
    const at = (t: number) => ({
      bucket: Math.floor(t / 900_000),
      calls: 1,
      costMicroUsd: 10,
      unpricedCalls: 0,
    });
    const rows = (...times: number[]) => ({
      byConversation: [],
      byTask: [],
      byBucket: times.map(at),
    });
    // New York: 1 November began at 04:00 UTC (EDT), 2 November at 05:00 UTC (EST).
    const nov1 = Date.UTC(2026, 10, 1, 4);
    const nov2 = Date.UTC(2026, 10, 2, 5);
    const ny = calendar("America/New_York", nov2);
    const calls = rows(nov1 + 30 * 60_000, nov2 - 30 * 60_000, nov2 + 30 * 60_000);
    expect(
      breakdowns(calls, "2026-11-01", "2026-11-02", ny).day.map((d) => [d.date, d.calls]),
    ).toEqual([
      ["2026-11-01", 2],
      ["2026-11-02", 1],
    ]);
    // A request without its month falls back to the UTC month, which is still 31 October in New
    // York: the days start on the client's own 1st all the same.
    const { browser } = await claim();
    const now = Date.now();
    const local = calendar("America/New_York", now)(now);
    const res = await browser.req(`/api/usage?tz=America%2FNew_York`);
    const { day } = (await res.json<UsageBody>()).breakdowns;
    expect([day[0]?.date, day.at(-1)?.date]).toEqual([`${local.slice(0, 7)}-01`, local]);
    // An old client sends no zone: its midnight's offset stands in, and +12 h is a day ahead.
    const auckland = Date.UTC(2026, 10, 1, 12); // midnight on 2 November at UTC+12
    const plus12 = calendar(undefined, auckland);
    expect(plus12(auckland)).toBe("2026-11-02");
    expect(calendar("Not/AZone", auckland)(auckland)).toBe("2026-11-02");
  });

  it("shows neurons past the free allowance as billed (A-Co3)", async () => {
    const { browser, owner } = await claim();
    await db
      .prepare(
        "INSERT INTO usage (id, user_id, provider_id, model, neurons) VALUES ('n', ?, 'workers-ai', 'x', 12500)",
      )
      .bind(owner)
      .run();
    const body = await (await browser.req("/api/usage")).json<UsageBody>();
    expect(body.allowance).toMatchObject({ freeNeuronsUsed: 10000, billedNeurons: 2500 });
  });

  it("is for signed-in users only", async () => {
    await claim();
    expect((await new Browser().req("/api/usage")).status).toBe(401);
  });
});
