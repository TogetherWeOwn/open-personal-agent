// SPDX-License-Identifier: Apache-2.0
// Turn and spend limits v0 (M2-22): COST-1 per-turn, COST-2 turns, COST-3 base.
import { findPrice } from "@opa/pricing";
import { describe, expect, it } from "vitest";
import {
  DAILY_SPEND_CAP_MICRO_USD,
  type Kv,
  Limits,
  MAX_OUTPUT_TOKENS,
  MIN_OUTPUT_TOKENS,
  TURNS_PER_MINUTE,
} from "../src/limits";

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

  it("caps model calls per turn", () => {
    const { limits: l } = limits();
    expect(l.call("t1")).toBe(true);
    expect(l.call("t1")).toBe(false);
    expect(l.call("t2")).toBe(true);
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

  it("drops a hold a day old: its turn was lost, so it can't shrink later days' budgets", () => {
    const { limits: l, store, clock } = limits();
    l.reserve("lost", PROVIDER, MODEL, 2000);
    clock.now += DAY;
    l.reserve("t1", PROVIDER, MODEL, 2000);
    expect(Object.keys(held(store))).toEqual(["t1"]);
  });
});
