// SPDX-License-Identifier: Apache-2.0
// The composition root (ADR 0010 D4.1 #1). It is the only Worker code that reads the master
// keys: it hands them to the vault and gives everything else an env without them. With
// packages/vault, the only code that may name them (scripts/check-scoped-access.mjs enforces it).
import { d1VaultStore } from "@opa/db/vault-store";
import { createVault } from "@opa/vault";
import type { Bindings, Env } from "./env";

/** Worker secrets the deploy generates (ADR 0001 #5). Health reports presence only, never values. */
export const REQUIRED_SECRETS = [
  "OPA_MASTER_KEY",
  "OPA_SESSION_SECRET",
  "OPA_SETUP_TOKEN",
] as const;
export type SecretName = (typeof REQUIRED_SECRETS)[number];

/** The master key's entry in the health report. The app never sees the key, only its status. */
export function masterKeySet(env: Env): Pick<Record<SecretName, boolean>, "OPA_MASTER_KEY"> {
  return { OPA_MASTER_KEY: env.VAULT_STATUS !== "key_invalid" };
}

/** The env as the runtime passes it. */
export interface WorkerEnv extends Bindings {
  OPA_MASTER_KEY?: string;
  OPA_MASTER_KEY_PREV?: string;
}

/** A copy of `raw` without the master keys, for Durable Objects and Workflows. */
export function withoutMasterKeys<T extends Bindings>(raw: T): Bindings {
  const { OPA_MASTER_KEY: _key, OPA_MASTER_KEY_PREV: _prev, ...bindings } = raw as T & WorkerEnv;
  return bindings as Bindings;
}

// The runtime reuses one env object per isolate, so the KEKs are imported once.
const composed = new WeakMap<WorkerEnv, Promise<Env>>();

/** The app's env. A missing or invalid key leaves `VAULT` null: no fallback key (D4.1 #7). */
export function compose(raw: WorkerEnv): Promise<Env> {
  let env = composed.get(raw);
  if (!env) {
    env = build(raw);
    composed.set(raw, env);
  }
  return env;
}

async function build(raw: WorkerEnv): Promise<Env> {
  const bindings = withoutMasterKeys(raw);
  const store = d1VaultStore(bindings);
  const { OPA_MASTER_KEY: masterKey, OPA_MASTER_KEY_PREV: previousMasterKey } = raw;
  const vault = await createVault({ masterKey, previousMasterKey, store }).catch(() => null);
  if (vault) return { ...bindings, VAULT: vault, VAULT_STATUS: "ok" };
  // Tell a bad PREV from a bad master key, so health never asks to replace a working key.
  const keyValid = await createVault({ masterKey, store }).catch(() => null);
  const status = keyValid ? "previous_key_invalid" : "key_invalid";
  return { ...bindings, VAULT: null, VAULT_STATUS: status };
}
