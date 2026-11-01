// SPDX-License-Identifier: Apache-2.0
import { compose, type WorkerEnv } from "./compose";
import { workerApp } from "./worker-app";

export { Assistant } from "./assistant";
export { TaskWorkflow } from "./task-workflow";

export default {
  async fetch(request, env, ctx) {
    return workerApp.fetch(request, await compose(env), ctx);
  },
  // Stub for the */10 reconciler (ADR 0003 #4).
  async scheduled(_controller, _env, _ctx) {},
} satisfies ExportedHandler<WorkerEnv>;
