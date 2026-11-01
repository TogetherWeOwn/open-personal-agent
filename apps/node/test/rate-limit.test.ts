// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryRateLimit } from "../src/rate-limit";

afterEach(() => vi.useRealTimers());

describe("memoryRateLimit", () => {
  it("allows `limit` per key in each window, then resets", async () => {
    vi.useFakeTimers();
    const limiter = memoryRateLimit(2, 60_000);
    const results = async (key: string, n: number) => {
      const out = [];
      for (let i = 0; i < n; i++) out.push((await limiter.limit({ key })).success);
      return out;
    };
    expect(await results("a", 3)).toEqual([true, true, false]);
    expect(await results("b", 1)).toEqual([true]);
    vi.advanceTimersByTime(60_000);
    expect(await results("a", 1)).toEqual([true]);
  });
});
