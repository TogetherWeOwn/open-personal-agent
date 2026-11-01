// SPDX-License-Identifier: Apache-2.0
import { app } from "./app";
import { compose, type WorkerEnv } from "./compose";

export { Assistant } from "./assistant";
export { TaskWorkflow } from "./task-workflow";

export default {
  async fetch(request, env, ctx) {
    return app.fetch(request, await compose(env), ctx);
  },
  // Stub for the */10 reconciler (ADR 0003 #4).
  async scheduled(_controller, _env, _ctx) {},
} satisfies ExportedHandler<WorkerEnv>;
