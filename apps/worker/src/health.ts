// SPDX-License-Identifier: Apache-2.0
import { SCHEMA_VERSION } from "@opa/db";
import { createRepository } from "@opa/db/repository";
import type { Env } from "./env";

export interface Health {
  /** `setup_required`: unmigrated or a secret is missing. `degraded`: a binding check failed. */
  status: "ok" | "setup_required" | "degraded";
  schema: { expected: number; applied: number | null; current: boolean };
  checks: {
    database: boolean;
    storage: boolean;
    durableObject: boolean;
    workflow: boolean;
    ai: boolean;
  };
  /** Presence of each required Worker secret, by name; never a value. */
  secrets: Record<string, boolean>;
}

const PROBE_TIMEOUT_MS = 5_000;

/** Resolves to `false` if `fn` throws, rejects or takes longer than the timeout. */
async function probe(fn: () => Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([fn().then(() => true), timeout]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkHealth(env: Env): Promise<Health> {
  // Assigned inside the database probe; the cast stops TypeScript narrowing it to `null`.
  let applied = null as number | null;
  const { deployment } = createRepository(env);
  const [database, storage, durableObject] = await Promise.all([
    probe(async () => {
      applied = await deployment.schemaVersion();
    }),
    probe(() => deployment.probeStorage()),
    probe(async () => {
      const pong = await deployment.healthObject().ping();
      if (pong !== "pong") throw new Error("unexpected ping reply");
    }),
  ]);
  // Presence only: creating a Workflow instance or running a model would cost money.
  const workflow = typeof env.TASK_WORKFLOW?.create === "function";
  const ai = typeof env.AI?.run === "function";

  const secrets = { ...env.SECRETS_SET };
  // A newer schema is fine: migrations stay compatible with the previous Worker (ADR 0004).
  const current = applied !== null && applied >= SCHEMA_VERSION;
  const checks = { database, storage, durableObject, workflow, ai };

  let status: Health["status"] = "ok";
  if (Object.values(checks).includes(false)) status = "degraded";
  if ((database && !current) || Object.values(secrets).includes(false)) status = "setup_required";

  return { status, schema: { expected: SCHEMA_VERSION, applied, current }, checks, secrets };
}
