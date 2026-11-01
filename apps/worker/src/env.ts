// SPDX-License-Identifier: Apache-2.0
import type { Assistant } from "./assistant";

/** Bindings declared in the root `wrangler.jsonc`. */
export interface Bindings {
  DB: D1Database;
  FILES: R2Bucket;
  AI: Ai;
  ASSETS: Fetcher;
  ASSISTANT: DurableObjectNamespace<Assistant>;
  TASK_WORKFLOW: Workflow;
}

/**
 * What the HTTP app sees. The composition root (`compose.ts`) builds it without the master key
 * (ADR 0010 D4.1); only `packages/vault` and the composition root may name that key.
 */
export interface Env extends Bindings {
  OPA_SESSION_SECRET?: string;
  OPA_SETUP_TOKEN?: string;
  /** Whether each required Worker secret is set, by name. Presence only, never a value. */
  SECRETS_SET: Record<string, boolean>;
}
