// SPDX-License-Identifier: Apache-2.0
// Cloudflare allowance meters and the reconciler's 70% warning (M3-17 AC4, COST-5). Each meter
// comes from a source the app has, since it holds no Cloudflare API token (M3-16 AC3): D1's own
// size, the sum of the stored files' sizes, and the ledger's Workers AI neurons, task steps and
// chat-turn wall-clock. D1's size is the one the reconciler records each tick. The Usage page
// reads the same list, so it and the banners agree.
import { createRepository, type DataBindings } from "@opa/db/repository";
import { log } from "@opa/log";
import { cloudflareAllowances, workersAiAllowance } from "@opa/pricing";

export type MeterId =
  | "d1_cap"
  | "d1_storage"
  | "r2_storage"
  | "workers_ai_neurons"
  | "workflows_steps"
  | "do_duration";

export interface AllowanceMeter {
  id: MeterId;
  used: number;
  limit: number;
  unit: "bytes" | "neurons" | "steps" | "gb_seconds";
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
  const d = new Date(now);
  const month = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); // Cloudflare bills UTC months
  const [d1, files, neurons, steps, turnMs] = await Promise.all([
    // The reconciler's latest reading, so Usage and the warning agree; live before its first tick.
    deployment.latestMeter("d1_bytes").then((bytes) => bytes ?? deployment.databaseBytes()),
    deployment.fileBytes(),
    deployment.workersAiNeurons(now - (now % DAY)), // UTC days, as Cloudflare counts them
    deployment.meterTotal("workflow_steps", month),
    deployment.meterTotal("do_ms", month),
  ]);
  // An estimate: chat turns' wall-clock at the memory each object is billed for. Time an object
  // spends awake between turns isn't counted, so the real figure can be higher.
  const gbSeconds = Math.round((turnMs / 1000) * cloudflareAllowances.doMemoryGb);
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
    {
      id: "workflows_steps",
      used: steps,
      limit: cloudflareAllowances.workflowStepsPerMonth,
      unit: "steps",
    },
    {
      id: "do_duration",
      used: gbSeconds,
      limit: cloudflareAllowances.doGbSecondsPerMonth,
      unit: "gb_seconds",
    },
  ];
}

/** The reconciler's step (M3-18 AC2): records D1's size as today's `d1_bytes` reading. */
export async function recordDatabaseBytes(env: Bindings, now = Date.now()): Promise<void> {
  const { deployment } = createRepository(env);
  await deployment.setMeter("d1_bytes", await deployment.databaseBytes(), now);
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
