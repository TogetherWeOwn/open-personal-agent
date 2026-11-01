// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  billingProviderId,
  estimate,
  findPrice,
  isStale,
  providerInfo,
  workersAiAllowance,
} from "../src/index";
import table from "../src/prices.json";

const usage = { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 0 };

describe("price table", () => {
  it("dates every price, links every provider and has no duplicate model", () => {
    for (const m of table.models) {
      expect(m.verifiedAt, m.model).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(providerInfo(m.providerId).billingUrl, m.model).toMatch(/^https:\/\//);
    }
    const keys = table.models.map((m) => `${m.providerId}/${m.model}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(workersAiAllowance.neuronsPerDay).toBeGreaterThan(0);
  });

  it("estimates the starter model in dollars and neurons", () => {
    const price = findPrice("workers-ai", "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    if (!price) throw new Error("no starter price");
    // 1000 × $0.293/M + 500 × $2.253/M = $0.0014195; 26.668 + 102.4025 neurons.
    expect(estimate(price, usage)).toEqual({ costMicroUsd: 1420, neurons: 130 });
  });

  it("prices cached input at its own rate and never rounds a cost to zero", () => {
    const price = findPrice("openai", "gpt-4.1-mini");
    if (!price) throw new Error("no gpt-4.1-mini price");
    // 600 × $0.40/M + 400 × $0.10/M + 500 × $1.60/M = $0.00108.
    const cached = { ...usage, cachedInputTokens: 400 };
    expect(estimate(price, cached)).toEqual({ costMicroUsd: 1080, neurons: null });
    const one = { inputTokens: 1, outputTokens: 0, cachedInputTokens: 1 };
    expect(estimate(price, one).costMicroUsd).toBe(1);
  });

  it("knows no price for an unlisted model, and still names its provider", () => {
    expect(findPrice("openai", "gpt-unknown")).toBeUndefined();
    expect(providerInfo("my-llm")).toEqual({
      name: "my-llm",
      billedBy: "provider",
      billingUrl: null,
    });
    expect(providerInfo("workers-ai").billedBy).toBe("cloudflare-workers-ai");
  });

  it("names the biller from the endpoint, not from the provider ID", () => {
    expect(billingProviderId("https://api.openai.com/v1")).toBe("openai");
    expect(billingProviderId("https://openrouter.ai/api/v1")).toBe("openrouter");
    expect(billingProviderId("http://127.0.0.1:8788/v1")).toBe("127.0.0.1:8788");
  });

  it("flags a price checked more than 90 days ago", () => {
    const now = Date.parse("2026-11-01T12:00:00Z");
    expect(isStale("2026-08-03", now)).toBe(false);
    expect(isStale("2026-08-02", now)).toBe(true);
  });
});
