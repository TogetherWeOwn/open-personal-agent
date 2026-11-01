// SPDX-License-Identifier: Apache-2.0
import { SCHEMA_VERSION } from "@opa/db";
import { createRepository } from "@opa/db/repository";
import { vaultStatus } from "@opa/vault";
import { masterKeySet, RETIRE_PREVIOUS_KEY, type SecretName } from "./compose";
import type { Env } from "./env";

export interface Health {
  /**
   * `setup_required`: unmigrated or a secret is missing. `degraded`: a check failed, other than
   * for a capability the runtime declares `UNAVAILABLE`.
   */
  status: "ok" | "setup_required" | "degraded";
  schema: { expected: number; applied: number | null; current: boolean };
  checks: {
    database: boolean;
    storage: boolean;
    durableObject: boolean;
    workflow: boolean;
    ai: boolean;
    /** The vault started: the master keys are valid (ADR 0010 D4.1 #7). */
    vault: boolean;
  };
  secrets: Record<SecretName, boolean>;
  /** The key rotation and unreadable rows (crypto review C-1). Counts only; absent without a vault. */
  vault?: VaultHealth;
}

export interface VaultHealth {
  /** `pending`: the scheduled runner is still re-keying users under the previous master key. */
  rotation: "none" | "pending" | "complete";
  /** `user_keys` and `secrets` rows of users no key the vault holds can open. */
  orphanedRows: number;
  /** What the operator does next, once the rotation is complete. */
  action?: typeof RETIRE_PREVIOUS_KEY;
}

async function vaultHealth(env: Env): Promise<VaultHealth | undefined> {
  if (!env.VAULT) return undefined;
  const { rotation, orphanedRows } = await vaultStatus(env.VAULT);
  return rotation === "complete"
    ? { rotation, orphanedRows, action: RETIRE_PREVIOUS_KEY }
    : { rotation, orphanedRows };
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
    if (timer) clearTimeout(timer);
  }
}

function secretsSet(env: Env): Record<SecretName, boolean> {
  const isSet = (value: string | undefined) => typeof value === "string" && value !== "";
  return {
    ...masterKeySet(env),
    OPA_SESSION_SECRET: isSet(env.OPA_SESSION_SECRET),
    OPA_SETUP_TOKEN: isSet(env.OPA_SETUP_TOKEN),
  };
}

// A newer schema is fine: migrations stay compatible with the previous Worker (ADR 0004).
const isCurrent = (applied: number | null) => applied !== null && applied >= SCHEMA_VERSION;

/**
 * `checkHealth(env).status === "setup_required"`, from the schema version and the secrets only:
 * one query, no storage or Durable Object probe. For the setup routes.
 */
export async function setupRequired(env: Env): Promise<boolean> {
  if (Object.values(secretsSet(env)).includes(false)) return true;
  let applied = null as number | null;
  const database = await probe(async () => {
    applied = await createRepository(env).deployment.schemaVersion();
  });
  return database && !isCurrent(applied);
}

export async function checkHealth(env: Env): Promise<Health> {
  // Assigned inside the database probe; the cast stops TypeScript narrowing it to `null`.
  let applied = null as number | null;
  const { deployment } = createRepository(env);
  let vault: VaultHealth | undefined;
  const [database, storage, durableObject] = await Promise.all([
    probe(async () => {
      applied = await deployment.schemaVersion();
    }),
    probe(() => deployment.probeStorage()),
    probe(async () => {
      const pong = await deployment.healthObject().ping();
      if (pong !== "pong") throw new Error("unexpected ping reply");
    }),
    // Left out, not failed, if the counts can't be read in time.
    probe(async () => {
      vault = await vaultHealth(env);
    }),
  ]);
  // Presence only: creating a Workflow instance or running a model would cost money.
  const workflow = typeof env.TASK_WORKFLOW?.create === "function";
  const ai = typeof env.AI?.run === "function";

  const secrets = secretsSet(env);
  const current = isCurrent(applied);
  const checks = { database, storage, durableObject, workflow, ai, vault: env.VAULT !== null };
  const unavailable = new Set<string>(env.UNAVAILABLE ?? []);

  let status: Health["status"] = "ok";
  if (Object.entries(checks).some(([name, ok]) => !ok && !unavailable.has(name))) {
    status = "degraded";
  }
  if ((database && !current) || Object.values(secrets).includes(false)) status = "setup_required";

  const schema = { expected: SCHEMA_VERSION, applied, current };
  return { status, schema, checks, secrets, ...(vault ? { vault } : {}) };
}
