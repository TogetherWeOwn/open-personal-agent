// SPDX-License-Identifier: Apache-2.0
import type { Vault } from "@opa/vault";
import type { Assistant } from "./assistant";

/**
 * Bindings declared in the root `wrangler.jsonc`, without the master keys: only the composition
 * root (`compose.ts`) sees those (ADR 0010 D4.1 #1).
 */
export interface Bindings {
  DB: D1Database;
  FILES: R2Bucket;
  AI: Ai;
  ASSETS: Fetcher;
  ASSISTANT: DurableObjectNamespace<Assistant>;
  TASK_WORKFLOW: Workflow;
  OPA_SESSION_SECRET?: string;
  OPA_SETUP_TOKEN?: string;
}

/** What the HTTP app sees. `VAULT` is `null` unless `VAULT_STATUS` is `ok`. */
export interface Env extends Bindings {
  VAULT: Vault | null;
  VAULT_STATUS: "ok" | "key_invalid" | "previous_key_invalid";
}

export interface Session {
  /** The `sessions` row ID, never the cookie value. */
  id: string;
  userId: string;
}

/** Hono's environment for the app: bindings, plus the session the guard resolved. */
export interface AppEnv {
  Bindings: Env;
  Variables: { session: Session };
}
