// SPDX-License-Identifier: Apache-2.0
import type { AppPorts, Env as ServerAppEnv, AppEnv as ServerEnv } from "@opa/server/env";
import type { Assistant } from "./assistant";

export type { Session } from "@opa/server/env";

/**
 * Bindings declared in the root `wrangler.jsonc`, without the master keys: only the composition
 * root (`compose.ts`) sees those (ADR 0010 D4.1 #1). Cloudflare's own types, which satisfy the
 * app's structural ports (`@opa/server/env`).
 */
export interface Bindings extends AppPorts {
  DB: D1Database;
  FILES: R2Bucket;
  AI: Ai;
  ASSETS: Fetcher;
  ASSISTANT: DurableObjectNamespace<Assistant>;
  TASK_WORKFLOW: Workflow;
  PUBLIC_LIMIT?: RateLimit;
}

/** What the HTTP app sees on Workers. `VAULT` is `null` unless `VAULT_STATUS` is `ok`. */
export type Env = ServerAppEnv<Bindings>;

/** Hono's environment for the Worker's own routes. */
export type AppEnv = ServerEnv<Bindings>;
