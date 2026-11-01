// SPDX-License-Identifier: Apache-2.0
import { app } from "./app";
import { appEnv, type WorkerEnv } from "./compose";

export { Assistant } from "./assistant";
export { TaskWorkflow } from "./task-workflow";

export default {
  fetch: (request, env, ctx) => app.fetch(request, appEnv(env), ctx),
  // Stub for the */10 reconciler (ADR 0003 #4).
  async scheduled(_controller, _env, _ctx) {},
} satisfies ExportedHandler<WorkerEnv>;
