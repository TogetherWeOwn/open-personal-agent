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

/** What the HTTP app sees. `VAULT` is `null` when the master key is missing or invalid. */
export interface Env extends Bindings {
  VAULT: Vault | null;
}
