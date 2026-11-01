// SPDX-License-Identifier: Apache-2.0
// Retention (COST-10, M3-18): the settings route and the reconciler's part. Each `*/10` tick
// collects abandoned uploads, and the first tick of each UTC day runs the sweep that applies every
// user's settings. Neither wakes a Durable Object. The Worker's cron and Node's timer both call it.
import { createRepository } from "@opa/db/repository";
import {
  DAY_MS,
  RETENTION_BOUNDS,
  RETENTION_DEFAULTS,
  type RetentionSettings,
  retentionStore,
} from "@opa/db/retention";
import { log } from "@opa/log";
import { type Context, Hono } from "hono";
import type { AppEnv, AppPorts } from "./env";

type Ctx = Context<AppEnv>;
const settingsOf = (c: Ctx) => createRepository(c.env).forUser(c.var.session.scope).settings;

const view = (settings: RetentionSettings) => ({
  ...settings,
  defaults: RETENTION_DEFAULTS,
  bounds: RETENTION_BOUNDS,
});

/** A whole number of days in range; `null` ("forever") only where `nullable`. */
function days(value: unknown, key: keyof typeof RETENTION_BOUNDS, nullable: boolean) {
  if (value === null && nullable) return null;
  const { min, max } = RETENTION_BOUNDS[key];
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max
    ? (value as number)
    : undefined;
}

export const retentionSettings = new Hono<AppEnv>();

retentionSettings.use(async (c, next) => {
  c.header("Cache-Control", "no-store");
  return next();
});

retentionSettings.get("/retention", async (c) => c.json(view(await settingsOf(c).retention())));

/**
 * Body: any of `{ messageDays, toolOutputDays, memoryInboxDays }`; `null` keeps chats or tool
 * outputs forever. Fields left out keep their value. Every change is audited with both values.
 */
retentionSettings.put("/retention", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "invalid_body" }, 400);
  const store = settingsOf(c);
  const from = await store.retention();
  const to = { ...from };
  for (const [key, nullable] of [
    ["messageDays", true],
    ["toolOutputDays", true],
    ["memoryInboxDays", false],
  ] as const) {
    if (!(key in body)) continue;
    const value = days((body as Record<string, unknown>)[key], key, nullable);
    if (value === undefined) return c.json({ error: "invalid_days", field: key }, 400);
    (to as Record<string, number | null>)[key] = value;
  }
  const changed = (Object.keys(to) as (keyof RetentionSettings)[]).some((k) => to[k] !== from[k]);
  if (changed) await store.saveRetention(from, to);
  return c.json(view(to));
});

/**
 * The reconciler's retention work. A failure logs and the next tick tries again, as with the key
 * rotation; the sweep's deployment row is written only once it has run, so a crash retries it.
 */
export async function runRetention(env: Pick<AppPorts, "DB" | "FILES">, now = Date.now()) {
  let store: ReturnType<typeof retentionStore>;
  try {
    store = retentionStore(env);
  } catch (error) {
    return log.error("retention", { errorName: (error as Error).name });
  }
  try {
    const count = await store.collectUploads(now);
    if (count) log.info("retention.uploads", { count });
  } catch (error) {
    log.error("retention.uploads", { errorName: (error as Error).name });
  }
  try {
    if (await store.sweptSince(now - (now % DAY_MS))) return;
    const totals = await store.sweep(now);
    const { conversations, toolOutputs, proposals, stepOutputs, auditRows } = totals;
    const count = conversations + toolOutputs + proposals + stepOutputs + (auditRows ?? 0);
    const partial = totals.failed || auditRows === null;
    log.info("retention.sweep", { count, status: partial ? "partial" : "ok" });
  } catch (error) {
    log.error("retention.sweep", { errorName: (error as Error).name });
  }
}
