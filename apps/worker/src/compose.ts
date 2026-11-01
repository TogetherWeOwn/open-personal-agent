// SPDX-License-Identifier: Apache-2.0
// The Worker's composition root (ADR 0010 D4.1 #1): the runtime's env, master keys included, goes
// to `@opa/server/compose`, which hands them to the vault and gives everything else an env
// without them.
import {
  compose as composeEnv,
  type MasterKeys,
  withoutMasterKeys as strip,
} from "@opa/server/compose";
import type { Bindings, Env } from "./env";

/** The env as the runtime passes it. */
export interface WorkerEnv extends Bindings, MasterKeys {}

/** The app's env. A missing or invalid key leaves `VAULT` null: no fallback key (D4.1 #7). */
export const compose = (raw: WorkerEnv): Promise<Env> => composeEnv<Bindings>(raw);

/** A copy of `raw` without the master keys, for Durable Objects and Workflows. */
export const withoutMasterKeys = (raw: Bindings & MasterKeys): Bindings => strip<Bindings>(raw);
