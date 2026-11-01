// SPDX-License-Identifier: Apache-2.0
// The price table (PRD §17 cost transparency). Every figure the Usage page shows comes from
// prices.json, which dates each price; nothing here or in the UI hard-codes one.
import table from "./prices.json";

/** Who sends the bill for a call. */
export type BilledBy = "provider" | "cloudflare-workers-ai" | "included-workers-paid";

export interface ProviderInfo {
  name: string;
  /** The API origin this provider bills for; Workers AI is a binding, so it has none. */
  origin?: string;
  billedBy: BilledBy;
  billingUrl: string | null;
}

/** Prices in USD per million tokens, which is also micro-USD per token. */
export interface ModelPrice {
  providerId: string;
  model: string;
  name: string;
  inputUsdPerMTok: number;
  cachedInputUsdPerMTok?: number;
  /** Writing to the prompt cache, where the provider bills it above input (Anthropic). */
  cacheWriteUsdPerMTok?: number;
  outputUsdPerMTok: number;
  neuronsPerMInputTok?: number;
  neuronsPerMOutputTok?: number;
  /** The day someone last checked the price against its source, YYYY-MM-DD. */
  verifiedAt: string;
  source: string;
}

/** A price this many days past its check is flagged on the Usage page. */
export const STALE_AFTER_DAYS = 90;

/** Cloudflare's free Workers AI allowance, shared by everything on the account. */
export const workersAiAllowance: {
  neuronsPerDay: number;
  usdPer1000Neurons: number;
  resetsAtUtc: string;
  verifiedAt: string;
} = table.workersAi;

/**
 * The Workers Paid allowances the app can measure itself (COST-5, M3-16 AC3): D1 storage included
 * and the per-database cap, and R2 storage included. The reconciler warns at 70% of each.
 */
export const cloudflareAllowances: {
  d1IncludedBytes: number;
  d1MaxBytes: number;
  r2IncludedBytes: number;
  verifiedAt: string;
} = table.cloudflare;

const providers: Record<string, ProviderInfo> = table.providers as Record<string, ProviderInfo>;
const models: ModelPrice[] = table.models;

/** A provider with no entry is still billed by itself; it just has no billing link. */
export function providerInfo(providerId: string): ProviderInfo {
  return providers[providerId] ?? { name: providerId, billedBy: "provider", billingUrl: null };
}

/**
 * Who bills calls to an OpenAI-compatible base URL: the provider whose origin it is, else its
 * host. The endpoint decides, never the provider ID a user typed, so a key labelled "openai" that
 * points at another host is never priced as OpenAI.
 */
export function billingProviderId(baseUrl: string): string {
  const { origin, host } = new URL(baseUrl);
  return Object.keys(providers).find((id) => providers[id]?.origin === origin) ?? host;
}

export function findPrice(providerId: string, model: string): ModelPrice | undefined {
  return models.find((m) => m.providerId === providerId && m.model === model);
}

/** Counted in whole UTC days since the check. */
export function isStale(verifiedAt: string, now = Date.now()): boolean {
  const days = Math.floor((now - Date.parse(`${verifiedAt}T00:00:00Z`)) / 86_400_000);
  return days > STALE_AFTER_DAYS;
}

/** `inputTokens` includes the cache reads and writes, as in `ModelUsage`. */
export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens?: number;
}

/** Rounds up after dropping float noise, so 1000 × 0.293 is 293, not 294. */
const up = (n: number) => Math.ceil(Number(n.toFixed(6)));

/**
 * A call's cost at published prices, in micro-USD, and its Workers AI neurons. Both round up, so
 * a call that cost anything never shows as free.
 */
export function estimate(price: ModelPrice, usage: TokenCounts) {
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const written = Math.min(usage.cacheWriteInputTokens ?? 0, usage.inputTokens - cached);
  const micro =
    (usage.inputTokens - cached - written) * price.inputUsdPerMTok +
    cached * (price.cachedInputUsdPerMTok ?? price.inputUsdPerMTok) +
    written * (price.cacheWriteUsdPerMTok ?? price.inputUsdPerMTok) +
    usage.outputTokens * price.outputUsdPerMTok;
  const neurons =
    price.neuronsPerMInputTok !== undefined && price.neuronsPerMOutputTok !== undefined
      ? up(
          (usage.inputTokens * price.neuronsPerMInputTok +
            usage.outputTokens * price.neuronsPerMOutputTok) /
            1e6,
        )
      : null;
  return { costMicroUsd: up(micro), neurons };
}
