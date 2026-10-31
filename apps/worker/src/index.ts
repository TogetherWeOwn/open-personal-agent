// SPDX-License-Identifier: Apache-2.0
import { app } from "./app";
import type { Env } from "./env";

export { Assistant } from "./assistant";
export { TaskWorkflow } from "./task-workflow";

export default {
  fetch: app.fetch,
  // Stub for the */10 reconciler (ADR 0003 #4).
  async scheduled(_controller, _env, _ctx) {},
} satisfies ExportedHandler<Env>;
