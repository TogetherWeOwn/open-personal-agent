// SPDX-License-Identifier: Apache-2.0
// The Usage page's data (PRD §17): today's and this month's calls grouped by who bills them, with
// labels, subtotals and staleness worked out here, so the page does no arithmetic.
import { createRepository } from "@opa/db/repository";
import { findPrice, isStale, providerInfo, workersAiAllowance } from "@opa/pricing";
import { Hono } from "hono";
import type { AppEnv } from "./env";

type Usage = ReturnType<ReturnType<typeof createRepository>["forUser"]>["usage"];
type TotalsRow = Awaited<ReturnType<Usage["totals"]>>[number];

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
    { label: string; billingUrl: string | null; costMicroUsd: number }
  >();
  const lines = rows.map((row) => {
    const info = providerInfo(row.providerId);
    const cost = row.costSource ? (row.costMicroUsd ?? 0) : null;
    const group = groups.get(row.providerId) ?? {
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

usageRoutes.get("/", async (c) => {
  const now = Date.now();
  const utcDay = now - (now % DAY);
  const d = new Date(now);
  const utcMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const today = since(c.req.query("today"), utcDay, now, DAY + 2 * 3_600_000);
  const month = since(c.req.query("month"), utcMonth, now, 32 * DAY);
  const repo = createRepository(c.env);
  const user = repo.forUser(c.var.session.scope);
  const [todayRows, monthRows, profile] = await Promise.all([
    user.usage.totals(today),
    user.usage.totals(month),
    user.profile(),
  ]);
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
  c.header("Cache-Control", "no-store");
  return c.json({
    currency: "USD",
    today: period(todayRows, now),
    month: period(monthRows, now),
    allowance,
  });
});
