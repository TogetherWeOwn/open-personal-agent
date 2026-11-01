// SPDX-License-Identifier: Apache-2.0
import type { UserScope } from "@opa/db/repository";
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
  /**
   * The fetch for model-provider calls. Node's composition root sets an SSRF-guarded one
   * (ADR 0010 D8); on Workers it is unset and the runtime's fetch, which can't reach a private
   * network, is used.
   */
  MODEL_FETCH?: typeof fetch;
  /**
   * Set by a composition root whose runtime lacks these (the Node root, for now). Health reports
   * them as false without degrading.
   */
  UNAVAILABLE?: readonly ("workflow" | "ai")[];
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
  /** For the scoped repository (ADR 0010 D3). */
  scope: UserScope;
}

/** Hono's environment for the app: bindings, plus the session the guard resolved. */
export interface AppEnv {
  Bindings: Env;
  Variables: { session: Session };
}
