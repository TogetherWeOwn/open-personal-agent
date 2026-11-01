// SPDX-License-Identifier: Apache-2.0
// The vault's half of each composition root (ADR 0010 D4.1 #1). It is the only app code that
// reads the master keys: it hands them to the vault and gives everything else an env without
// them. With packages/vault and the roots that pass the keys in (apps/worker and apps/node
// `compose.ts`), the only code that may name them (scripts/check-scoped-access.mjs enforces it).
import { d1VaultStore } from "@opa/db/vault-store";
import { createVault } from "@opa/vault";
import type { AppPorts, Env } from "./env";

/** Secrets the deploy generates (ADR 0001 #5). Health reports presence only, never values. */
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

/** Health's next step for the operator once a rotation is complete (crypto review C-1). */
export const RETIRE_PREVIOUS_KEY = "delete OPA_MASTER_KEY_PREV";

/** The keys a root passes in with its ports. */
export interface MasterKeys {
  OPA_MASTER_KEY?: string | undefined;
  OPA_MASTER_KEY_PREV?: string | undefined;
}

/** A copy of `raw` without the master keys, for the app and the Worker's Durable Objects. */
export function withoutMasterKeys<P extends AppPorts>(raw: P): P {
  const { OPA_MASTER_KEY: _key, OPA_MASTER_KEY_PREV: _prev, ...ports } = raw as P & MasterKeys;
  return ports as P;
}

// The runtime reuses one env object per isolate, so the KEKs are imported once.
const composed = new WeakMap<object, Promise<Env>>();

/** The app's env. A missing or invalid key leaves `VAULT` null: no fallback key (D4.1 #7). */
export function compose<P extends AppPorts>(raw: P & MasterKeys): Promise<Env<P>> {
  let env = composed.get(raw) as Promise<Env<P>> | undefined;
  if (!env) {
    env = build(raw);
    composed.set(raw, env);
  }
  return env;
}

async function build<P extends AppPorts>(raw: P & MasterKeys): Promise<Env<P>> {
  const ports = withoutMasterKeys<P>(raw);
  const store = d1VaultStore(ports);
  const { OPA_MASTER_KEY: masterKey, OPA_MASTER_KEY_PREV: previousMasterKey } = raw;
  const vault = await createVault({ masterKey, previousMasterKey, store }).catch(() => null);
  if (vault) return { ...ports, VAULT: vault, VAULT_STATUS: "ok" };
  // Tell a bad PREV from a bad master key, so health never asks to replace a working key.
  const keyValid = await createVault({ masterKey, store }).catch(() => null);
  const status = keyValid ? "previous_key_invalid" : "key_invalid";
  return { ...ports, VAULT: null, VAULT_STATUS: status };
}
