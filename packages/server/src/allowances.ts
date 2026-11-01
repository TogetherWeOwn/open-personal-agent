// SPDX-License-Identifier: Apache-2.0
// Cloudflare allowance meters and the reconciler's 70% warning (M3-17 AC4, COST-5). Each meter
// comes from a source the app has, since it holds no Cloudflare API token (M3-16 AC3): D1's own
// size, the sum of the stored files' sizes, and the ledger's Workers AI neurons. M3-16 adds the
// Workflows-steps and Durable Object duration meters here and reads the same list for Usage.
import { createRepository, type DataBindings } from "@opa/db/repository";
import { log } from "@opa/log";
import { cloudflareAllowances, workersAiAllowance } from "@opa/pricing";

export type MeterId = "d1_cap" | "d1_storage" | "r2_storage" | "workers_ai_neurons";

export interface AllowanceMeter {
  id: MeterId;
  used: number;
  limit: number;
  unit: "bytes" | "neurons";
}

export interface AllowanceWarning {
  id: MeterId;
  /** Whole percent of the limit used, at least 70. */
  percent: number;
}

/** What the owner's assistant keeps for the banner: the latest run's warnings and when. */
export interface AllowanceWarnings {
  at: number;
  warnings: AllowanceWarning[];
}

/** COST-5: warn at 70% of any included meter and of the D1 10 GB per-database cap. */
export const WARN_AT_PERCENT = 70;
/** Warnings from a run older than this are dropped: the reconciler runs every 10 minutes. */
export const WARNINGS_TTL_MS = 60 * 60_000;

const DAY = 86_400_000;

type Bindings = DataBindings<unknown, unknown>;

export async function allowanceMeters(env: Bindings, now = Date.now()): Promise<AllowanceMeter[]> {
  const { deployment } = createRepository(env);
  const [d1, files, neurons] = await Promise.all([
    deployment.databaseBytes(),
    deployment.fileBytes(),
    deployment.workersAiNeurons(now - (now % DAY)), // UTC days, as Cloudflare counts them
  ]);
  return [
    { id: "d1_cap", used: d1, limit: cloudflareAllowances.d1MaxBytes, unit: "bytes" },
    { id: "d1_storage", used: d1, limit: cloudflareAllowances.d1IncludedBytes, unit: "bytes" },
    { id: "r2_storage", used: files, limit: cloudflareAllowances.r2IncludedBytes, unit: "bytes" },
    {
      id: "workers_ai_neurons",
      used: neurons,
      limit: workersAiAllowance.neuronsPerDay,
      unit: "neurons",
    },
  ];
}

export function warningsFor(meters: readonly AllowanceMeter[]): AllowanceWarning[] {
  return meters
    .map((m) => ({ id: m.id, percent: Math.floor((m.used / m.limit) * 100) }))
    .filter((w) => w.percent >= WARN_AT_PERCENT);
}

/**
 * The reconciler's step: measures every meter and hands the warnings to the owner's assistant,
 * which keeps them for the banner. The allowances are the Cloudflare account's, so only the
 * owner, who runs it, is told (as on the Usage page). Each run replaces the last.
 */
export async function reconcileAllowances(env: Bindings, now = Date.now()): Promise<void> {
  try {
    const owner = (await createRepository(env).deployment.ownerAssistant()) as {
      setAllowanceWarnings?(w: AllowanceWarnings): Promise<void>;
    } | null;
    if (typeof owner?.setAllowanceWarnings !== "function") return; // unclaimed, or no DO (Node)
    const warnings = warningsFor(await allowanceMeters(env, now));
    await owner.setAllowanceWarnings({ at: now, warnings });
  } catch {
    // The next tick tries again; a warning older than an hour stops showing meanwhile.
    log.error("reconcile.allowances", { reason: "error" });
  }
}
