// SPDX-License-Identifier: Apache-2.0
// The Usage page's data (PRD §17, M3-16): today's and this month's calls grouped by who bills them,
// the month-end projection, the seven PRD §15 cost categories and the month's breakdowns, with
// labels, subtotals and staleness worked out here, so the page does no arithmetic.
import { createRepository } from "@opa/db/repository";
import { findPrice, isStale, providerInfo, workersAiAllowance, workersPaid } from "@opa/pricing";
import { Hono } from "hono";
import type { AppEnv } from "./env";

type Usage = ReturnType<ReturnType<typeof createRepository>["forUser"]>["usage"];
type TotalsRow = Awaited<ReturnType<Usage["totals"]>>[number];
type Breakdowns = Awaited<ReturnType<Usage["breakdowns"]>>;

export const usageRoutes = new Hono<AppEnv>();

const DAY = 86_400_000;

/** The client's local midnight, so "today" is the user's day; UTC when missing or implausible. */
function since(value: string | undefined, fallback: number, now: number, maxAge: number) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n <= now && now - n <= maxAge ? n : fallback;
}

/** A period's lines grouped by who bills them. A null cost means no price on file. */
function period(rows: TotalsRow[], now: number) {
  const groups = new Map<
    string,
    { name: string; label: string; billingUrl: string | null; costMicroUsd: number }
  >();
  const lines = rows.map((row) => {
    const info = providerInfo(row.providerId);
    const cost = row.costSource ? (row.costMicroUsd ?? 0) : null;
    const group = groups.get(row.providerId) ?? {
      name: info.name,
      label:
        info.billedBy === "included-workers-paid"
          ? "Included in Workers Paid"
          : `Billed by ${info.name}`,
      billingUrl: info.billingUrl,
      costMicroUsd: 0,
    };
    group.costMicroUsd += cost ?? 0;
    groups.set(row.providerId, group);
    return {
      providerId: row.providerId,
      model: row.model,
      name: findPrice(row.providerId, row.model)?.name ?? row.model,
      calls: row.calls,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      costMicroUsd: cost,
      costSource: row.costSource,
      priceVerifiedAt: row.priceVerifiedAt,
      stale: row.priceVerifiedAt !== null && isStale(row.priceVerifiedAt, now),
    };
  });
  return {
    costMicroUsd: lines.reduce((sum, l) => sum + (l.costMicroUsd ?? 0), 0),
    unpricedCalls: lines.reduce((sum, l) => sum + (l.costMicroUsd === null ? l.calls : 0), 0),
    groups: [...groups].map(([providerId, g]) => ({
      providerId,
      ...g,
      lines: lines.filter((l) => l.providerId === providerId),
    })),
  };
}

/** Where a day's figures are kept: the client's midnight as an offset from UTC's, in ±12 h. */
function midnightOffset(today: number) {
  const off = ((today % DAY) + DAY) % DAY;
  return off > DAY / 2 ? off - DAY : off;
}

/** The local date `days` after the day starting at `today`; noon absorbs a DST hour. */
const dateOf = (today: number, days: number) =>
  new Date(today - midnightOffset(today) + days * DAY + DAY / 2).toISOString().slice(0, 10);

/**
 * Month-end at the month's pace so far. Under a day in, it counts a whole day, so the first
 * message of the month doesn't project to a month of them.
 */
function projectMonth(costMicroUsd: number, month: number, today: number, now: number) {
  const [y, m] = dateOf(today, Math.round((month - today) / DAY))
    .split("-")
    .map(Number);
  const days = new Date(Date.UTC(y ?? 1970, m ?? 1, 0)).getUTCDate();
  return Math.round((costMicroUsd * days) / Math.max((now - month) / DAY, 1));
}

/** The month's breakdowns, with every day from the 1st to today, empty days included. */
function breakdowns(rows: Breakdowns, month: number, today: number) {
  const byDay = new Map(rows.byDay.map((r) => [r.day, r]));
  const day = [];
  for (let i = Math.round((month - today) / DAY); i <= 0; i++) {
    const r = byDay.get(i);
    day.push({
      date: dateOf(today, i),
      calls: r?.calls ?? 0,
      costMicroUsd: r?.costMicroUsd ?? 0,
      unpricedCalls: r?.unpricedCalls ?? 0,
    });
  }
  return { conversation: rows.byConversation, task: rows.byTask, day };
}

/**
 * PRD §15's seven categories in its order (A-Co4). Only AI models are in the ledger; Cloudflare's
 * own services are included in Workers Paid, and their meters come from M3-16 AC3's sources.
 */
function categories(ai: { today: number; month: number; projected: number }, now: number) {
  const plan = Math.round(workersPaid.usdPerMonth * 1e6);
  const none = { status: "none-configured" as const, label: null };
  return [
    {
      id: "workers-paid",
      status: "billed" as const,
      label: "Billed by Cloudflare",
      today: null,
      month: plan,
      projected: plan,
      priceVerifiedAt: workersPaid.verifiedAt,
      stale: isStale(workersPaid.verifiedAt, now),
    },
    { id: "cloudflare", status: "included" as const, label: "Included in Workers Paid" },
    { id: "storage", status: "included" as const, label: "Included in Workers Paid" },
    { id: "ai", status: "billed" as const, label: null, ...ai },
    { id: "computers", ...none },
    { id: "connectors", ...none },
    { id: "enhanced", ...none },
  ];
}

usageRoutes.get("/", async (c) => {
  const now = Date.now();
  const utcDay = now - (now % DAY);
  const d = new Date(now);
  const utcMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const today = since(c.req.query("today"), utcDay, now, DAY + 2 * 3_600_000);
  const month = since(c.req.query("month"), utcMonth, now, 32 * DAY);
  const repo = createRepository(c.env);
  const user = repo.forUser(c.var.session.scope);
  const [todayRows, monthRows, breakdownRows, profile] = await Promise.all([
    user.usage.totals(today),
    user.usage.totals(month),
    user.usage.breakdowns(month, today),
    user.profile(),
  ]);
  const todayPeriod = period(todayRows, now);
  const monthPeriod = period(monthRows, now);
  const projected = projectMonth(monthPeriod.costMicroUsd, month, today, now);
  // The allowance is the Cloudflare account's, so its total includes everyone's calls; only the
  // owner, who runs the account, sees it. A member's view would reveal others' activity. The
  // count is this deployment's calls only: other apps on the account use the allowance too.
  const allowance =
    profile?.role === "owner"
      ? {
          neuronsPerDay: workersAiAllowance.neuronsPerDay,
          neuronsUsedHere: await repo.deployment.workersAiNeurons(utcDay), // UTC days, as Cloudflare
          resetsAt: utcDay + DAY,
        }
      : null;
  // Past the free allowance, neurons are billed (A-Co3). Other apps on the account may have
  // used some of it, so this is at least what is billed, never more.
  const allowanceView = allowance && {
    ...allowance,
    freeNeuronsUsed: Math.min(allowance.neuronsUsedHere, allowance.neuronsPerDay),
    billedNeurons: Math.max(allowance.neuronsUsedHere - allowance.neuronsPerDay, 0),
  };
  c.header("Cache-Control", "no-store");
  return c.json({
    currency: "USD",
    today: todayPeriod,
    month: monthPeriod,
    projected: { costMicroUsd: projected },
    categories: categories(
      { today: todayPeriod.costMicroUsd, month: monthPeriod.costMicroUsd, projected },
      now,
    ),
    breakdowns: breakdowns(breakdownRows, month, today),
    allowance: allowanceView,
  });
});
