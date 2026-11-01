// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { Turn } from "../src/chat/state";
import {
  buildPriceTable,
  formatDuration,
  formatElapsed,
  formatSummary,
  formatWorked,
  isStillWorking,
  priceKey,
  STILL_WORKING_MS,
  turnCostMicroUsd,
  turnStatus,
} from "../src/chat/turn-summary";
import type { PriceHint } from "../src/models/settings-api";

const price = (inputUsdPerMTok: number, outputUsdPerMTok: number): PriceHint => ({
  inputUsdPerMTok,
  outputUsdPerMTok,
  verifiedAt: "2026-11-01",
  stale: false,
});

const usage = (inputTokens: number, outputTokens: number, providerId = "openai", model = "m") => ({
  usage: { inputTokens, outputTokens, cachedInputTokens: 0, reasoningTokens: 0 },
  providerId,
  model,
});

const turn = (outcome: Turn["outcome"], updatedAt: number): Turn => ({
  turnId: "t1",
  messageId: "r-t1",
  startedAt: updatedAt - 60_000,
  outcome,
  steps: [],
  tools: [],
  taint: [],
  usage: [],
  queued: [],
  steered: [],
  promotedTaskId: null,
  updatedAt,
});

describe("turn summary", () => {
  it("ticks elapsed time and worked time in the thread's words", () => {
    expect(formatElapsed(38_000)).toBe("0:38");
    expect(formatElapsed(123_000)).toBe("2:03");
    expect(formatElapsed(3_723_000)).toBe("1:02:03");
    expect(formatWorked(45_000)).toBe("45s");
    expect(formatWorked(123_000)).toBe("2m 03s");
    expect(formatWorked(72_000)).toBe("1m 12s");
  });

  it("names a finished step's own time", () => {
    expect(formatDuration(120)).toBe("120 ms");
    expect(formatDuration(1200)).toBe("1.2s");
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(12_000)).toBe("12s");
  });

  it("collapses a finished run, hiding the failed part and the cost when they don't apply", () => {
    expect(formatSummary({ durationMs: 123_000, tools: 6, failed: 1, costMicroUsd: 40_000 })).toBe(
      "Worked for 2m 03s · 6 tools · 1 failed · about $0.04",
    );
    expect(formatSummary({ durationMs: 72_000, tools: 4, failed: 0, costMicroUsd: 30_000 })).toBe(
      "Worked for 1m 12s · 4 tools · about $0.03",
    );
    expect(formatSummary({ durationMs: 5_000, tools: 0, failed: 0, costMicroUsd: null })).toBe(
      "Worked for 5s · 0 tools",
    );
  });

  it("sums a turn's calls at the settings' prices, or leaves the cost out", () => {
    const prices = new Map([[priceKey("openai", "m"), price(0.4, 1.6)]]);
    // 1M input at $0.40 + 1M output at $1.60.
    expect(turnCostMicroUsd([usage(1_000_000, 1_000_000)], prices)).toBe(2_000_000);
    expect(turnCostMicroUsd([usage(1, 1, "other", "m")], prices)).toBe(null);
    expect(turnCostMicroUsd([usage(1, 1, "openai", "m"), usage(1, 1, "other", "m")], prices)).toBe(
      null,
    );
  });

  it("bills output once when the provider reports reasoning inside it", () => {
    const prices = new Map([[priceKey("openai", "m"), price(0.4, 1.6)]]);
    const reasoning = {
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cachedInputTokens: 0,
        reasoningTokens: 400_000,
      },
      providerId: "openai",
      model: "m",
    };
    // The 400k reasoning tokens are part of the 1M output, not extra.
    expect(turnCostMicroUsd([reasoning], prices)).toBe(2_000_000);
  });

  it("leaves the cost out for a turn with no usage", () => {
    const prices = new Map([[priceKey("openai", "m"), price(0.4, 1.6)]]);
    expect(turnCostMicroUsd([], prices)).toBe(null);
  });

  it("prices Workers AI rows under the id the harness reports", () => {
    const table = buildPriceTable([
      { kind: "workers-ai", providerId: null, model: "m", price: price(0.4, 1.6) },
    ]);
    expect(table.get(priceKey("workers-ai", "m"))).toBeDefined();
    const keyed = buildPriceTable([
      { kind: "openai-chat", providerId: "openai", model: "m", price: price(0.4, 1.6) },
    ]);
    expect(keyed.get(priceKey("openai", "m"))).toBeDefined();
    const unpriced = buildPriceTable([
      { kind: "openai-chat", providerId: "openai", model: "m", price: null },
    ]);
    expect(unpriced.size).toBe(0);
  });

  it("calls a run still working after 10 s without a visible change", () => {
    const now = Date.now();
    expect(isStillWorking(turn("running", now - STILL_WORKING_MS), now)).toBe(true);
    expect(isStillWorking(turn("running", now - STILL_WORKING_MS + 1), now)).toBe(false);
    expect(isStillWorking(turn("waiting", now - 60_000), now)).toBe(false);
  });

  it("names every outcome in the thread's status vocabulary", () => {
    expect(turnStatus(turn("running", 0))).toBe("running");
    expect(turnStatus(turn("waiting", 0))).toBe("waiting_for_approval");
    expect(turnStatus(turn("limited", 0))).toBe("budget_limited");
    expect(turnStatus(turn("succeeded", 0))).toBe("succeeded");
    expect(turnStatus(turn("failed", 0))).toBe("failed");
    expect(turnStatus(turn("cancelled", 0))).toBe("cancelled");
    expect(turnStatus(turn("interrupted", 0))).toBe("interrupted");
  });
});
