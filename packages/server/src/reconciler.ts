// SPDX-License-Identifier: Apache-2.0
// The `*/10` reconciler (ADR 0003 #4, M3-18 AC2): a pending key rotation (crypto review C-1), the
// D1 size reading (M3-18 AC2), the 70% allowance warnings (COST-5), the export expiry sweep
// (M3-20 AC1), retention (M3-18) and approval expiry (M3-07 AC1). Every part runs on its own and logs its own failure, so one never
// stops the others; the next tick tries again. None but the allowance warning wakes a Durable
// Object, and that one only the owner's.
import { sweepExports } from "@opa/db/export";
import { systemStore } from "@opa/db/system";
import { log } from "@opa/log";
import { reconcileAllowances, recordDatabaseBytes } from "./allowances";
import type { Env } from "./env";
import { runRetention } from "./retention";
import { runRotation } from "./vault-rotation";

export type ReconcilerPart = (env: Env, now: number) => Promise<unknown>;

/** Pending approvals past their expiry, in D1 only; a task waiting on one is cancelled. */
export async function expireApprovals(env: Pick<Env, "DB">, now = Date.now()) {
  const count = await systemStore(env).approvals.expireDue(now);
  if (count) log.info("approvals.expire", { count });
}

export const reconcilerParts = {
  rotation: (env) => runRotation(env),
  database: (env, now) => recordDatabaseBytes(env, now),
  allowances: (env, now) => reconcileAllowances(env, now),
  exports: (env, now) => sweepExports(env, () => now),
  retention: (env, now) => runRetention(env, now),
  approvals: (env, now) => expireApprovals(env, now),
} satisfies Record<string, ReconcilerPart>;

/** One promise per part, each settled once its part has; the Worker hands each to `waitUntil`. */
export function reconcile(
  env: Env | Promise<Env>,
  now = Date.now(),
  parts: Record<string, ReconcilerPart> = reconcilerParts,
): Promise<void>[] {
  return Object.entries(parts).map(async ([part, run]) => {
    try {
      await run(await env, now);
    } catch (error) {
      log.error(`reconcile.${part}`, { errorName: (error as Error)?.name ?? "error" });
    }
  });
}
