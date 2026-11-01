// SPDX-License-Identifier: Apache-2.0
// The turn timeline's words and numbers (M3-09 AC1-2, m3-ux §3.1): the ticking header, the
// collapsed "Worked for …" summary, the still-working timer and the turn's cost. Pure, so the
// unit tests pin the copy without rendering anything.

import type { PriceHint } from "../models/settings-api";
import type { Status } from "../ui";
import { money } from "../usage/usage-data";
import type { Turn } from "./state";

/** A usage entry prices under its own pair, like the usage page groups its lines. */
export const priceKey = (providerId: string, model: string) => `${providerId}\0${model}`;

/** The prices the summary reads, from `GET /api/settings` providers. */
export type PriceTable = Map<string, PriceHint | null>;

/** Elapsed time as the header ticks it: "0:38", "2:03", "1:02:03". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = `${total % 60}`.padStart(2, "0");
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}:${seconds}`;
  return `${Math.floor(minutes / 60)}:${`${minutes % 60}`.padStart(2, "0")}:${seconds}`;
}

/** How long the summary says the turn worked: "45s", "2m 03s", "1h 02m". */
export function formatWorked(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  if (minutes < 1) return `${total}s`;
  if (minutes < 60) return `${minutes}m ${`${total % 60}`.padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${`${minutes % 60}`.padStart(2, "0")}m`;
}

/**
 * The turn's model calls at the settings' prices, in micro-USD. Reasoning tokens bill as
 * output and cached input at the input price (packages/pricing shades them finer; the summary
 * is an estimate). Null when any call has no price on file, so the summary never mixes a
 * partial total with "about".
 */
export function turnCostMicroUsd(usage: Turn["usage"], prices: PriceTable): number | null {
  let total = 0;
  for (const entry of usage) {
    const price = prices.get(priceKey(entry.providerId, entry.model));
    if (!price) return null;
    // Tokens times dollars-per-million-tokens is micro-USD, as in packages/pricing.
    total +=
      entry.usage.inputTokens * price.inputUsdPerMTok +
      (entry.usage.outputTokens + entry.usage.reasoningTokens) * price.outputUsdPerMTok;
  }
  return Math.round(total);
}

export interface SummaryFacts {
  durationMs: number;
  tools: number;
  failed: number;
  costMicroUsd: number | null;
}

/**
 * "Worked for 2m 03s · 6 tools · 1 failed · about $0.04" (M3-09 AC2). The "failed" part shows
 * only when something failed, and the cost only when every call has a price.
 */
export function formatSummary({ durationMs, tools, failed, costMicroUsd }: SummaryFacts): string {
  const parts = [
    `Worked for ${formatWorked(durationMs)}`,
    `${tools} ${tools === 1 ? "tool" : "tools"}`,
  ];
  if (failed > 0) parts.push(`${failed} failed`);
  if (costMicroUsd !== null) {
    const amount = money(costMicroUsd, "USD");
    parts.push(amount.startsWith("<") ? amount : `about ${amount}`);
  }
  return parts.join(" · ");
}

/** A finished step's own time: "120 ms", "1.2s", "12s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  return `${seconds < 10 ? Math.round(seconds * 10) / 10 : Math.round(seconds)}s`;
}

/** No visible change for 10 s while the turn runs: the header says what it is still doing. */
export const STILL_WORKING_MS = 10_000;

export function isStillWorking(turn: Turn, now: number): boolean {
  return turn.outcome === "running" && now - turn.updatedAt >= STILL_WORKING_MS;
}

/** The thread's status vocabulary for the turn's outcome (m3-ux §1.3). */
export function turnStatus(turn: Turn): Status {
  switch (turn.outcome) {
    case "running":
      return "running";
    case "waiting":
      return "waiting_for_approval";
    case "limited":
      return "budget_limited";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "interrupted":
      return "interrupted";
  }
}

/** Tool calls that failed, kept visible in the collapsed summary (M3-09 AC2). */
export const failedTools = (turn: Turn) => turn.tools.filter((t) => t.status === "error");
