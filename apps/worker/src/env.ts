// SPDX-License-Identifier: Apache-2.0

/** Bindings declared in the root `wrangler.jsonc`. */
export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  AI: Ai;
  ASSETS: Fetcher;
  ASSISTANT: DurableObjectNamespace;
  TASK_WORKFLOW: Workflow;
  OPA_MASTER_KEY?: string;
  OPA_SESSION_SECRET?: string;
  OPA_SETUP_TOKEN?: string;
}
