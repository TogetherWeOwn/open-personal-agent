// SPDX-License-Identifier: Apache-2.0
// `GET/PUT /api/settings/spending` (M3-17): the limits, their defaults and this month's warning.
// Amounts are micro-USD on the wire; the screens show dollars.

export interface SpendingLimits {
  taskBudgetMicroUsd: number;
  dailyCapMicroUsd: number;
  monthlyBudgetMicroUsd: number;
  /** `null` is off, the default. */
  hardCapMicroUsd: number | null;
}

export interface Spending {
  settings: SpendingLimits;
  defaults: SpendingLimits;
  executionLimits: { callsPerMessage: number; toolCallsPerMessage: number; stepsPerTask: number };
  todayMicroUsd: number;
  monthMicroUsd: number;
  /** The highest monthly-budget threshold reached: 50, 80 or 100. It never pauses anything. */
  warning: 50 | 80 | 100 | null;
  hardCapReached: boolean;
  /** The UTC month the figures are for, as its first instant. */
  month: number;
}

export async function getSpending(): Promise<Spending> {
  const res = await fetch("/api/settings/spending");
  if (!res.ok) throw new Error(`spending ${res.status}`);
  const body = (await res.json()) as Partial<Spending> | null;
  // The banners render on every screen, so a body of another shape must not take the app down.
  if (typeof body?.settings?.monthlyBudgetMicroUsd !== "number" || !body.defaults) {
    throw new Error("spending: unexpected body");
  }
  return body as Spending;
}

export async function saveSpending(changes: Partial<SpendingLimits>): Promise<SpendingLimits> {
  const res = await fetch("/api/settings/spending", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(changes),
  });
  if (!res.ok) throw new Error(`spending ${res.status}`);
  return ((await res.json()) as { settings: SpendingLimits }).settings;
}

/** Whole dollars without cents, else two decimals: "$20", "$0.50". */
export function dollars(microUsd: number): string {
  const usd = microUsd / 1e6;
  return `$${Number.isInteger(usd) ? usd : usd.toFixed(2)}`;
}

/** A dollar amount typed by the user, as micro-USD; `null` if it isn't $0.01 to $10,000. */
export function parseDollars(text: string): number | null {
  const clean = text.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const micro = Math.round(Number(clean) * 100) * 10_000;
  return micro >= 10_000 && micro <= 10_000_000_000 ? micro : null;
}
