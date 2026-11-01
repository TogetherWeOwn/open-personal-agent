// SPDX-License-Identifier: Apache-2.0
// Settings › Spending (M3-17 AC2, AC5): every limit with its default, and the monthly warnings.
// The limits live in the user's assistant beside the counters they cap, so reads and writes go
// there by RPC; the assistant checks a change. This month's spend for the soft cap comes from the
// ledger, as the Usage page's does, so the two never disagree.
import { createRepository } from "@opa/db/repository";
import { systemStore } from "@opa/db/system";
import { Hono } from "hono";
import { type AllowanceWarnings, WARNINGS_TTL_MS } from "./allowances";
import type { AppEnv } from "./env";

interface Limits {
  taskBudgetMicroUsd: number;
  dailyCapMicroUsd: number;
  monthlyBudgetMicroUsd: number;
  hardCapMicroUsd: number | null;
}

/** The assistant's Spending RPC (apps/worker's `Assistant`). */
interface SpendingRpc {
  spending(): Promise<{
    settings: Limits;
    defaults: Limits;
    executionLimits: { callsPerMessage: number; toolCallsPerMessage: number; stepsPerTask: number };
    todayMicroUsd: number;
    monthMicroUsd: number;
    heldMicroUsd: number;
    allowance?: AllowanceWarnings | null;
  }>;
  setSpending(body: unknown): Promise<{ before: Limits; after: Limits; write: number } | null>;
  revertSpending(write: number, before: Limits): Promise<void>;
}

/** The soft cap's thresholds (COST-4): 50% on Usage and Spending, 80% and 100% app-wide. */
const THRESHOLDS = [100, 80, 50] as const;

export const spendingRoutes = new Hono<AppEnv>();

spendingRoutes.use(async (c, next) => {
  c.header("Cache-Control", "no-store");
  return next();
});

const rpcOf = (assistant: unknown) => {
  const rpc = assistant as Partial<SpendingRpc>;
  return typeof rpc.spending === "function" &&
    typeof rpc.setSpending === "function" &&
    typeof rpc.revertSpending === "function"
    ? (rpc as SpendingRpc)
    : null;
};

spendingRoutes.get("/", async (c) => {
  const user = createRepository(c.env).forUser(c.var.session.scope);
  const rpc = rpcOf(user.assistant());
  if (!rpc) return c.json({ error: "unavailable" }, 503);
  const now = Date.now();
  const d = new Date(now);
  const utcMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const [limits, rows] = await Promise.all([rpc.spending(), user.usage.totals(utcMonth)]);
  const monthMicroUsd = rows.reduce((sum, row) => sum + (row.costMicroUsd ?? 0), 0);
  const { settings } = limits;
  const percent = Math.floor((monthMicroUsd / settings.monthlyBudgetMicroUsd) * 100);
  return c.json({
    settings,
    defaults: limits.defaults,
    executionLimits: limits.executionLimits,
    todayMicroUsd: limits.todayMicroUsd,
    monthMicroUsd,
    /** The highest soft-cap threshold reached this month, or null. It never pauses anything. */
    warning: THRESHOLDS.find((t) => percent >= t) ?? null,
    /** The hard cap, on the assistant's strict counter: background tasks are paused. */
    hardCapReached:
      settings.hardCapMicroUsd !== null &&
      limits.monthMicroUsd + limits.heldMicroUsd >= settings.hardCapMicroUsd,
    month: utcMonth,
    /** The reconciler's 70% allowance warnings (COST-5): the owner's only, and only while fresh. */
    allowanceWarnings:
      limits.allowance && now - limits.allowance.at < WARNINGS_TTL_MS
        ? limits.allowance.warnings
        : [],
    /** Whose figures these are: the banners keep each user's dismissals apart. */
    userId: c.var.session.scope.userId,
  });
});

/** Body: any of the four editable limits, in micro-USD; `hardCapMicroUsd: null` turns it off. */
spendingRoutes.put("/", async (c) => {
  const user = createRepository(c.env).forUser(c.var.session.scope);
  const rpc = rpcOf(user.assistant());
  if (!rpc) return c.json({ error: "unavailable" }, 503);
  const body = await c.req.json().catch(() => null);
  const saved = await rpc.setSpending(body);
  if (!saved) return c.json({ error: "invalid_spending" }, 400);
  const { before, after, write } = saved;
  // Settings changes are in the Activity log (M3-19 AC3), with the old and new values. The
  // limits live in the assistant and the log in D1, so the two can't commit together: a change
  // whose audit row can't be written is put back (unless a later change replaced it since), and
  // the request fails.
  const changed = Object.keys(after).filter(
    (k) => before[k as keyof Limits] !== after[k as keyof Limits],
  ) as (keyof Limits)[];
  if (changed.length) {
    const detail = JSON.stringify(
      Object.fromEntries(changed.map((k) => [k, { from: before[k], to: after[k] }])),
    );
    try {
      await systemStore(c.env).audit(
        c.var.session.scope.userId,
        "settings.spending",
        "settings",
        "ok",
        detail,
      );
    } catch {
      await rpc.revertSpending(write, before);
      return c.json({ error: "not_saved" }, 500);
    }
  }
  // Saving the limits finishes onboarding's "Costs and limits" if it was skipped (M3-24 AC1).
  await user.settings.finishSetup("costs");
  return c.json({ settings: after });
});
