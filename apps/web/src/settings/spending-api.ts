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
  userId: string;
  /** The reconciler's warnings at 70% of a Cloudflare allowance (COST-5); the owner's only. */
  allowanceWarnings?: { id: string; percent: number }[];
}

export async function getSpending(): Promise<Spending> {
  const res = await fetch("/api/settings/spending");
  if (!res.ok) throw new Error(`spending ${res.status}`);
  const body: unknown = await res.json();
  // The banners render on every screen, so a body of another shape must not take the app down.
  if (!isSpending(body)) throw new Error("spending: unexpected body");
  return body;
}

/** Tells the banners the limits changed, so they don't wait for their next check. */
export const SPENDING_CHANGED = "opa:spending-changed";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isLimits = (v: unknown): v is SpendingLimits => {
  const l = v as Partial<SpendingLimits> | null;
  return (
    isNum(l?.taskBudgetMicroUsd) &&
    isNum(l.dailyCapMicroUsd) &&
    isNum(l.monthlyBudgetMicroUsd) &&
    l.monthlyBudgetMicroUsd > 0 &&
    (l.hardCapMicroUsd === null || isNum(l.hardCapMicroUsd))
  );
};

/** Every field the Spending page and the banners read, checked. */
function isSpending(v: unknown): v is Spending {
  const s = v as Partial<Spending> | null;
  const x = s?.executionLimits;
  return (
    isLimits(s?.settings) &&
    isLimits(s.defaults) &&
    isNum(x?.callsPerMessage) &&
    isNum(x.toolCallsPerMessage) &&
    isNum(x.stepsPerTask) &&
    isNum(s.todayMicroUsd) &&
    isNum(s.monthMicroUsd) &&
    (s.warning === null || s.warning === 50 || s.warning === 80 || s.warning === 100) &&
    typeof s.hardCapReached === "boolean" &&
    isNum(s.month) &&
    typeof s.userId === "string"
  );
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
