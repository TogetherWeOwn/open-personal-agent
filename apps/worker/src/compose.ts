// SPDX-License-Identifier: Apache-2.0
// The composition root. With packages/vault, the only code that may name the master key
// (ADR 0010 D4.1 #2; scripts/check-scoped-access.mjs enforces it).
import type { Bindings, Env } from "./env";

/** Worker secrets the deploy generates (ADR 0001 #5). */
export const REQUIRED_SECRETS = ["OPA_MASTER_KEY", "OPA_SESSION_SECRET", "OPA_SETUP_TOKEN"];

export type WorkerEnv = Bindings &
  Partial<
    Record<
      "OPA_MASTER_KEY" | "OPA_MASTER_KEY_PREV" | "OPA_SESSION_SECRET" | "OPA_SETUP_TOKEN",
      string
    >
  >;

/** The env the HTTP app gets: no master key, only whether each required secret is set. */
export function appEnv(env: WorkerEnv): Env {
  const { OPA_MASTER_KEY: _key, OPA_MASTER_KEY_PREV: _prev, ...rest } = env;
  const set = (name: string) => {
    const value = (env as unknown as Record<string, unknown>)[name];
    return typeof value === "string" && value !== "";
  };
  return { ...rest, SECRETS_SET: Object.fromEntries(REQUIRED_SECRETS.map((n) => [n, set(n)])) };
}
