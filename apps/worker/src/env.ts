// SPDX-License-Identifier: Apache-2.0
import type { Assistant } from "./assistant";

/** Bindings declared in the root `wrangler.jsonc`. */
export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  AI: Ai;
  ASSETS: Fetcher;
  ASSISTANT: DurableObjectNamespace<Assistant>;
  TASK_WORKFLOW: Workflow;
  OPA_MASTER_KEY?: string;
  OPA_SESSION_SECRET?: string;
  OPA_SETUP_TOKEN?: string;
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
