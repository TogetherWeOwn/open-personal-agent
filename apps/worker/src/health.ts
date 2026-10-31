// SPDX-License-Identifier: Apache-2.0
import { openD1, readSchemaVersion, SCHEMA_VERSION } from "@opa/db";
import type { Env } from "./env";

/** Worker secrets the deploy generates (ADR 0001 #5). Health reports presence only, never values. */
export const REQUIRED_SECRETS = [
  "OPA_MASTER_KEY",
  "OPA_SESSION_SECRET",
  "OPA_SETUP_TOKEN",
] as const;
export type SecretName = (typeof REQUIRED_SECRETS)[number];

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
  secrets: Record<SecretName, boolean>;
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
  const [database, storage, durableObject] = await Promise.all([
    probe(async () => {
      applied = await readSchemaVersion(openD1(env.DB));
    }),
    // A HEAD on a key that never exists: proves the bucket is bound and reachable.
    probe(() => env.FILES.head("health/probe")),
    // A fixed name outside the `u:<userId>` space, so it never touches a user's object.
    probe(async () => {
      const pong = await env.ASSISTANT.get(env.ASSISTANT.idFromName("health")).ping();
      if (pong !== "pong") throw new Error("unexpected ping reply");
    }),
  ]);
  // Presence only: creating a Workflow instance or running a model would cost money.
  const workflow = typeof env.TASK_WORKFLOW?.create === "function";
  const ai = typeof env.AI?.run === "function";

  const isSet = (value: string | undefined) => typeof value === "string" && value !== "";
  const secrets: Record<SecretName, boolean> = {
    // The app never sees the master key (ADR 0010 D4.1 #1); a vault that started proves it valid.
    OPA_MASTER_KEY: env.VAULT !== null,
    OPA_SESSION_SECRET: isSet(env.OPA_SESSION_SECRET),
    OPA_SETUP_TOKEN: isSet(env.OPA_SETUP_TOKEN),
  };
  // A newer schema is fine: migrations stay compatible with the previous Worker (ADR 0004).
  const current = applied !== null && applied >= SCHEMA_VERSION;
  const checks = { database, storage, durableObject, workflow, ai };

  let status: Health["status"] = "ok";
  if (Object.values(checks).includes(false)) status = "degraded";
  if ((database && !current) || Object.values(secrets).includes(false)) status = "setup_required";

  return { status, schema: { expected: SCHEMA_VERSION, applied, current }, checks, secrets };
}
