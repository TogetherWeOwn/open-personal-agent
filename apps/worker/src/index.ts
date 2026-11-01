// SPDX-License-Identifier: Apache-2.0
import { compose, type WorkerEnv } from "./compose";
import { workerApp } from "./worker-app";

export { Assistant } from "./assistant";
export { TaskWorkflow } from "./task-workflow";

// capnweb (via agents) parks the whole cloudflare:workers module, env and master keys included, on
// globalThis for its own one-time read at load. Drop it so only compose sees the keys (D4.1 #3).
// check-worker-bundle.mjs fails if the symbol's name changes.
for (const s of Object.getOwnPropertySymbols(globalThis)) {
  if (s.description === "workers-module") delete (globalThis as Record<symbol, unknown>)[s];
}

export default {
  async fetch(request, env, ctx) {
    return workerApp.fetch(request, await compose(env), ctx);
  },
  // Stub for the */10 reconciler (ADR 0003 #4).
  async scheduled(_controller, _env, _ctx) {},
} satisfies ExportedHandler<WorkerEnv>;
