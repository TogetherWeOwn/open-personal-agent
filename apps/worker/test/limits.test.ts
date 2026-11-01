// SPDX-License-Identifier: Apache-2.0
// Turn and spend limits (M2-22, M3-17): COST-1 per-turn, COST-2 turns and tool calls, COST-3
// task budgets, COST-4 the monthly hard cap, A-Co2 and A-Co5.
import { findPrice } from "@opa/pricing";
import { describe, expect, it } from "vitest";
import {
  checkSpending,
  DAILY_SPEND_CAP_MICRO_USD,
  type Kv,
  Limits,
  MAX_OUTPUT_TOKENS,
  MIN_OUTPUT_TOKENS,
  SPENDING_DEFAULTS,
  TOOL_CALLS_PER_MINUTE,
  TURNS_PER_MINUTE,
} from "@opa/server/limits";

const DAY = 86_400_000;
// $2 in and $8 out per million tokens: 2 and 8 micro-USD a token.
const [PROVIDER, MODEL] = ["openai", "gpt-4.1"];

function limits(start = 10 * DAY) {
  const store = new Map<string, unknown>();
  const kv: Kv = { get: (k) => store.get(k) as never, put: (k, v) => void store.set(k, v) };
  const clock = { now: start };
  return { limits: new Limits(kv, () => clock.now), clock, store };
}
const spent = (store: Map<string, unknown>) =>
  (store.get("spend") as { spentMicroUsd: number }).spentMicroUsd;
const held = (store: Map<string, unknown>) => (store.get("spend") as { held: object }).held;
const USAGE = { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 0 };

describe("turn rate", () => {
  it("allows 30 turns in any minute, then asks to slow down", () => {
    const { limits: l, clock } = limits();
    for (let i = 0; i < TURNS_PER_MINUTE; i++) expect(l.startTurn()).toBe(true);
    expect(l.startTurn()).toBe(false);
    clock.now += 59_999;
    expect(l.startTurn()).toBe(false);
    clock.now += 1;
    expect(l.startTurn()).toBe(true);
  });
});

describe("daily spend", () => {
  it("is priced from the table", () => {
    expect(findPrice(PROVIDER, MODEL)).toMatchObject({ inputUsdPerMTok: 2, outputUsdPerMTok: 8 });
  });

  it("reserves max_tokens × price up front, and settles to the estimated cost", () => {
    const { limits: l, store } = limits();
    // 2,000 characters count as 1,000 input tokens.
    const r = l.reserve("t1", PROVIDER, MODEL, 2000);
    expect(r).toEqual({
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      reservedMicroUsd: 1000 * 2 + MAX_OUTPUT_TOKENS * 8,
    });
    l.settle("t1", PROVIDER, MODEL, USAGE);
    expect(spent(store)).toBe(1000 * 2 + 500 * 8);
    expect(store.get("spend")).toMatchObject({ held: {} });
  });

  it("caps max_tokens from what is left, and refuses below a useful reply", () => {
    const { limits: l, store, clock } = limits();
    const day = clock.now - (clock.now % DAY);
    // Room for 1,000 input tokens and 1,000 output tokens.
    const left = 1000 * 2 + 1000 * 8;
    store.set("spend", { day, spentMicroUsd: DAILY_SPEND_CAP_MICRO_USD - left, held: {} });
    expect(l.reserve("t1", PROVIDER, MODEL, 2000)).toEqual({
      maxOutputTokens: 1000,
      reservedMicroUsd: left,
    });
    l.release("t1");
    const tight = 1000 * 2 + (MIN_OUTPUT_TOKENS - 1) * 8;
    store.set("spend", { day, spentMicroUsd: DAILY_SPEND_CAP_MICRO_USD - tight, held: {} });
    expect(l.reserve("t2", PROVIDER, MODEL, 2000)).toBeNull();
  });

  it("never lets calls running at once reserve past the cap", () => {
    const { limits: l, store } = limits();
    const reserved: number[] = [];
    for (let i = 0; ; i++) {
      const r = l.reserve(`t${i}`, PROVIDER, MODEL, 2000);
      if (!r) break;
      reserved.push(r.reservedMicroUsd);
    }
    const total = reserved.reduce((a, b) => a + b, 0);
    expect(reserved.length).toBeGreaterThan(100);
    expect(total).toBeLessThanOrEqual(DAILY_SPEND_CAP_MICRO_USD);
    // Each settles at or under its reservation, so the day's spend stays under the cap too.
    reserved.forEach((_, i) => {
      l.settle(`t${i}`, PROVIDER, MODEL, USAGE);
    });
    expect(spent(store)).toBeLessThanOrEqual(DAILY_SPEND_CAP_MICRO_USD);
  });

  it("charges the whole reservation when no usage is reported, nothing on release", () => {
    const { limits: l, store } = limits();
    const r = l.reserve("t1", PROVIDER, MODEL, 2000);
    l.settle("t1", PROVIDER, MODEL, null);
    expect(spent(store)).toBe(r?.reservedMicroUsd);
    l.reserve("t2", PROVIDER, MODEL, 2000);
    l.release("t2");
    expect(spent(store)).toBe(r?.reservedMicroUsd);
  });

  it("charges a turn once, however often it settles (a recovery after the turn settled)", () => {
    const { limits: l, store } = limits();
    l.reserve("t1", PROVIDER, MODEL, 2000);
    l.settle("t1", PROVIDER, MODEL, USAGE);
    l.settle("t1", PROVIDER, MODEL, USAGE);
    l.settle("t1", PROVIDER, MODEL, null);
    expect(spent(store)).toBe(1000 * 2 + 500 * 8);
  });

  it("starts each UTC day from zero, and reserves nothing for an unpriced model", () => {
    const { limits: l, store, clock } = limits();
    l.reserve("t1", PROVIDER, MODEL, 2000);
    l.settle("t1", PROVIDER, MODEL, USAGE);
    clock.now += DAY - 1000;
    l.reserve("late", PROVIDER, MODEL, 2000);
    clock.now += 2000;
    // A call still running at midnight keeps its hold, which the new day's calls reserve around,
    // and is charged to the new day when it settles.
    l.reserve("t2", PROVIDER, MODEL, 2000);
    expect(Object.keys(held(store))).toEqual(["late", "t2"]);
    l.settle("late", PROVIDER, MODEL, USAGE);
    expect(spent(store)).toBe(1000 * 2 + 500 * 8);
    l.settle("t2", PROVIDER, MODEL, { ...USAGE, outputTokens: 0 });
    expect(spent(store)).toBe(1000 * 2 + 500 * 8 + 1000 * 2);
    const free = { maxOutputTokens: MAX_OUTPUT_TOKENS, reservedMicroUsd: 0 };
    expect(l.reserve("t3", "local", "llama", 2000)).toEqual(free);
  });

  it("reads a hold stored as a plain amount, on the same day and across midnight", () => {
    const { limits: l, store, clock } = limits();
    store.set("spend", { day: 10 * DAY, spentMicroUsd: 0, held: { old: 1000, gone: 500 } });
    l.reserve("t1", PROVIDER, MODEL, 2000);
    l.settle("old", PROVIDER, MODEL, null);
    expect(spent(store)).toBe(1000);
    clock.now += DAY - 1;
    l.settle("t1", PROVIDER, MODEL, USAGE);
    clock.now += 1;
    // `gone` never settled; after midnight it is a day old and dropped.
    l.reserve("t2", PROVIDER, MODEL, 2000);
    expect(Object.keys(held(store))).toEqual(["t2"]);
  });

  it("drops a hold a day old: its turn was lost, so it can't shrink later days' budgets", () => {
    const { limits: l, store, clock } = limits();
    l.reserve("lost", PROVIDER, MODEL, 2000);
    clock.now += DAY;
    l.reserve("t1", PROVIDER, MODEL, 2000);
    expect(Object.keys(held(store))).toEqual(["t1"]);
  });
});

describe("tool call rate (COST-2)", () => {
  it("allows 60 tool calls in any minute, then refuses without counting", () => {
    const { limits: l, clock } = limits();
    for (let i = 0; i < TOOL_CALLS_PER_MINUTE; i++) expect(l.toolCall()).toBe(true);
    expect(l.toolCall()).toBe(false);
    clock.now += 60_000;
    expect(l.toolCall()).toBe(true);
    // Turns and tool calls are counted apart.
    expect(l.startTurn()).toBe(true);
  });
});

describe("tool call rate, retries", () => {
  it("counts a call that names itself once, however often its step retries", () => {
    const { limits: l } = limits();
    for (let i = 0; i < 4; i++) expect(l.toolCall("inst:tool:1")).toBe(true);
    for (let i = 1; i < TOOL_CALLS_PER_MINUTE; i++)
      expect(l.toolCall(`inst:tool:${i + 1}`)).toBe(true);
    expect(l.toolCall("inst:tool:61")).toBe(false);
    expect(l.toolCall("inst:tool:1")).toBe(true); // a retry of a counted call still runs
  });

  it("counts an approved call past the limit, so it holds a slot for its own minute", () => {
    const { limits: l, clock } = limits();
    for (let i = 0; i < TOOL_CALLS_PER_MINUTE; i++) expect(l.toolCall(`inst:tool:${i}`)).toBe(true);
    clock.now += 30_000;
    expect(l.toolCall("inst:approved", { approved: true })).toBe(true);
    expect(l.toolCall("inst:approved", { approved: true })).toBe(true); // its retry counts once
    // The first 60 age out; the approved call is still in the window.
    clock.now += 30_000;
    for (let i = 1; i < TOOL_CALLS_PER_MINUTE; i++) expect(l.toolCall(`inst:late:${i}`)).toBe(true);
    expect(l.toolCall("inst:late:60")).toBe(false);
  });
});

describe("Spending settings (M3-17 AC5)", () => {
  it("defaults to $0.50 a task, $5 a day, $20 a month and no hard cap", () => {
    const { limits: l } = limits();
    expect(l.settings()).toEqual({
      taskBudgetMicroUsd: 500_000,
      dailyCapMicroUsd: 5_000_000,
      monthlyBudgetMicroUsd: 20_000_000,
      hardCapMicroUsd: null,
    });
    expect(l.settings()).toEqual(SPENDING_DEFAULTS);
  });

  it("reads the daily cap from settings instead of the constant", () => {
    const { limits: l } = limits();
    l.setSettings({ dailyCapMicroUsd: 1000 * 2 + 1000 * 8 });
    expect(l.reserve("t1", PROVIDER, MODEL, 2000)?.maxOutputTokens).toBe(1000);
    expect(l.reserveFor("t2", PROVIDER, MODEL, 2000)).toEqual({
      limit: "daily",
      detail: "$0.01 daily limit",
    });
  });

  it("accepts whole micro-USD from $0.01 to $10,000, and null only to turn the hard cap off", () => {
    expect(checkSpending({ taskBudgetMicroUsd: 100_000, hardCapMicroUsd: null })).toEqual({
      taskBudgetMicroUsd: 100_000,
      hardCapMicroUsd: null,
    });
    expect(checkSpending({ hardCapMicroUsd: 30_000_000 })).toEqual({ hardCapMicroUsd: 30_000_000 });
    for (const bad of [
      { taskBudgetMicroUsd: 9_999 },
      { dailyCapMicroUsd: 10_000_000_001 },
      { monthlyBudgetMicroUsd: 1.5e6 + 0.5 },
      { dailyCapMicroUsd: null },
      { dailyCapMicroUsd: "5000000" },
      { other: 1 },
      { toString: 50_000 },
      { constructor: 50_000 },
      [],
      null,
    ]) {
      expect(checkSpending(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("task budgets (COST-3, A-Co2)", () => {
  const HOLD = 1000 * 2 + MAX_OUTPUT_TOKENS * 8; // a call's worst case at 2,000 characters

  it("stops a $0.10 task at its budget, raises it once on Continue, and settles at the end", () => {
    const { limits: l } = limits();
    expect(l.startTask("task1", 100_000)).toEqual({ budgetMicroUsd: 100_000 });
    const scope = { taskId: "task1" };
    let calls = 0;
    for (;;) {
      const r = l.reserveFor(`k${calls}`, PROVIDER, MODEL, 2000, 0, scope);
      if ("limit" in r) {
        expect(r).toEqual({ limit: "task_budget", detail: "$0.10 task budget" });
        break;
      }
      l.settle(`k${calls}`, PROVIDER, MODEL, null); // charged its whole reservation
      calls += 1;
    }
    // Two whole holds, then a third capped to what the budget has left.
    expect(calls).toBe(Math.floor(100_000 / HOLD) + 1);
    const spentBefore = l.task("task1")?.spentMicroUsd ?? 0;
    expect(spentBefore).toBeLessThanOrEqual(100_000);
    // Continue raises it once, by the task's own budget; a second Continue can't.
    expect(l.raiseTask("task1")).toBe(true);
    expect(l.raiseTask("task1")).toBe(false);
    expect(l.task("task1")).toMatchObject({ budgetMicroUsd: 200_000, raised: true });
    expect(l.reserveFor("again", PROVIDER, MODEL, 2000, 0, scope)).toHaveProperty(
      "maxOutputTokens",
    );
    l.settle("again", PROVIDER, MODEL, USAGE);
    expect(l.endTask("task1")).toBe(spentBefore + 1000 * 2 + 500 * 8);
    expect(l.task("task1")).toBeNull();
  });

  it("refuses a task's call when the task has no budget (never started, or ended)", () => {
    const { limits: l } = limits();
    expect(l.reserveFor("k", PROVIDER, MODEL, 2000, 0, { taskId: "unknown" })).toMatchObject({
      limit: "task_budget",
    });
    l.startTask("t");
    l.endTask("t");
    expect(l.reserveFor("k", PROVIDER, MODEL, 2000, 0, { taskId: "t" })).toMatchObject({
      limit: "task_budget",
    });
    expect(l.reserve("chat", PROVIDER, MODEL, 2000)).not.toBeNull(); // chat has no task
  });

  it("ends with what the task spent, counting a call still held at its full reservation", () => {
    const { limits: l } = limits();
    l.startTask("t");
    const r = l.reserveFor("k", PROVIDER, MODEL, 2000, 0, { taskId: "t" });
    expect(l.endTask("t")).toBe("reservedMicroUsd" in r ? r.reservedMicroUsd : -1);
  });

  it("undoes a raise whose Continue couldn't wake the task, so Continue can try again", () => {
    const { limits: l } = limits();
    l.startTask("t", 100_000);
    expect(l.raiseTask("t")).toBe(true);
    l.unraiseTask("t");
    expect(l.task("t")).toMatchObject({ budgetMicroUsd: 100_000, raised: false });
    expect(l.raiseTask("t")).toBe(true);
  });

  it("uses the default budget, and a replayed start keeps what the task spent", () => {
    const { limits: l } = limits();
    l.setSettings({ taskBudgetMicroUsd: 200_000 });
    expect(l.startTask("t")).toEqual({ budgetMicroUsd: 200_000 });
    l.reserveFor("k", PROVIDER, MODEL, 2000, 0, { taskId: "t" });
    l.settle("k", PROVIDER, MODEL, USAGE);
    expect(l.startTask("t", 999_999)).toEqual({ budgetMicroUsd: 200_000 });
    expect(l.task("t")?.spentMicroUsd).toBe(1000 * 2 + 500 * 8);
  });

  it("counts calls running at once against the task, so they can't pass its budget together", () => {
    const { limits: l } = limits();
    l.startTask("t", 100_000);
    const held = [0, 1, 2, 3, 4].map((i) =>
      l.reserveFor(`k${i}`, PROVIDER, MODEL, 2000, 0, { taskId: "t" }),
    );
    const granted = held.filter((r) => "reservedMicroUsd" in r) as { reservedMicroUsd: number }[];
    expect(granted.reduce((n, r) => n + r.reservedMicroUsd, 0)).toBeLessThanOrEqual(100_000);
    expect(held.at(-1)).toMatchObject({ limit: "task_budget" });
  });

  it("charges a call to the day and month even when its task ended while it ran", () => {
    const { limits: l } = limits();
    l.startTask("t");
    l.reserveFor("k", PROVIDER, MODEL, 2000, 0, { taskId: "t" });
    l.endTask("t");
    l.settle("k", PROVIDER, MODEL, USAGE);
    expect(l.totals()).toMatchObject({ todayMicroUsd: 6000, monthMicroUsd: 6000, heldMicroUsd: 0 });
  });
});

describe("monthly hard cap (COST-4)", () => {
  it("is off by default, and once set stops background calls but never chat", () => {
    const { limits: l } = limits();
    l.reserve("k0", PROVIDER, MODEL, 2000);
    l.settle("k0", PROVIDER, MODEL, null);
    const spentThisMonth = l.totals().monthMicroUsd;
    expect(l.reserveFor("b0", PROVIDER, MODEL, 2000, 0, { background: true })).toHaveProperty(
      "maxOutputTokens",
    );
    l.release("b0");
    l.setSettings({ hardCapMicroUsd: spentThisMonth });
    expect(l.reserveFor("b1", PROVIDER, MODEL, 2000, 0, { background: true })).toEqual({
      limit: "monthly_hard",
      detail: `$${(spentThisMonth / 1e6).toFixed(2)} monthly hard limit`,
    });
    // Even a model with no price on file: the cap is already used up.
    expect(l.reserveFor("b2", "local", "llama", 2000, 0, { background: true })).toMatchObject({
      limit: "monthly_hard",
    });
    expect(l.reserve("chat", PROVIDER, MODEL, 2000)).not.toBeNull();
  });

  it("starts each UTC month from zero; the soft cap never refuses anything", () => {
    const { limits: l, clock } = limits(Date.UTC(2026, 0, 31, 23));
    l.setSettings({ hardCapMicroUsd: 30_000, monthlyBudgetMicroUsd: 10_000 });
    l.reserve("k", PROVIDER, MODEL, 2000);
    l.settle("k", PROVIDER, MODEL, null);
    expect(l.reserveFor("b", PROVIDER, MODEL, 2000, 0, { background: true })).toMatchObject({
      limit: "monthly_hard",
    });
    clock.now += 3_600_000; // 1 February
    expect(l.totals().monthMicroUsd).toBe(0);
    expect(l.reserveFor("b", PROVIDER, MODEL, 2000, 0, { background: true })).toHaveProperty(
      "maxOutputTokens",
    );
  });
  it("keeps a task's budget through a month-long pause at the hard cap", () => {
    const { limits: l, clock } = limits(Date.UTC(2027, 0, 1, 0, 30));
    l.startTask("t1");
    l.reserve("k", PROVIDER, MODEL, 2000);
    l.settle("k", PROVIDER, MODEL, null);
    l.setSettings({ hardCapMicroUsd: l.totals().monthMicroUsd });
    const bg = { taskId: "t1", background: true };
    expect(l.reserveFor("b1", PROVIDER, MODEL, 2000, 0, bg)).toMatchObject({
      limit: "monthly_hard",
    });
    clock.now = Date.UTC(2027, 1, 1, 0, 1); // 31 days later: the cap lifts
    expect(l.reserveFor("b2", PROVIDER, MODEL, 2000, 0, bg)).toHaveProperty("maxOutputTokens");
  });
});

describe("concurrent calls over the daily cap (A-Co5)", () => {
  it("chat turns and task calls together pass it by at most one in-flight call", () => {
    const { limits: l, store } = limits();
    l.startTask("bg", 10_000_000);
    const granted: { id: string; reservedMicroUsd: number }[] = [];
    // Chat and Workflow calls interleave through the same assistant, as they do over DO RPC.
    for (let i = 0; i < 1000; i++) {
      const id = `c${i}`;
      const scope = i % 2 ? { taskId: "bg", background: true } : {};
      const r = l.reserveFor(id, PROVIDER, MODEL, 2000, 0, scope);
      if ("limit" in r) {
        expect(r.limit).toBe("daily");
        continue;
      }
      granted.push({ id, ...r });
    }
    const cap = DAILY_SPEND_CAP_MICRO_USD;
    expect(granted.reduce((n, r) => n + r.reservedMicroUsd, 0)).toBeLessThanOrEqual(cap);
    // Each call's real cost overruns its input estimate by up to one call's worth in the worst
    // case; settled at their reservations they land at or under the cap.
    for (const { id } of granted) l.settle(id, PROVIDER, MODEL, null);
    expect(spent(store)).toBeLessThanOrEqual(cap);
    expect(cap - spent(store)).toBeLessThan(1000 * 2 + MIN_OUTPUT_TOKENS * 8);
  });
});
