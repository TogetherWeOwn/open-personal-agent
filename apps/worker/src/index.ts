// SPDX-License-Identifier: Apache-2.0
import { sweepExports } from "@opa/db/export";
import { log } from "@opa/log";
import { runRotation } from "@opa/server/vault-rotation";
import { compose, type WorkerEnv } from "./compose";
import { workerApp } from "./worker-app";

export { Assistant } from "./assistant";
export { ExportWorkflow } from "./export-workflow";
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
  // The */10 reconciler (ADR 0003 #4): a pending key rotation (crypto review C-1) and the
  // export expiry sweep (M3-20 AC1). Like the rotation, a failed sweep logs and the next tick
  // tries again — one subtask never stops the other.
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      compose(env).then((c) =>
        Promise.all([
          runRotation(c),
          sweepExports(c).catch((error: unknown) => {
            log.error("export.sweep", {
              reason: error instanceof Error ? error.message : "error",
            });
          }),
        ]),
      ),
    );
  },
} satisfies ExportedHandler<WorkerEnv>;
