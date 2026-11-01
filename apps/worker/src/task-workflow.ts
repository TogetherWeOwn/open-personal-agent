// SPDX-License-Identifier: Apache-2.0
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { withoutMasterKeys } from "./compose";
import type { Bindings } from "./env";

/** One instance per task run (ADR 0003). Empty until background tasks land. */
export class TaskWorkflow extends WorkflowEntrypoint<Bindings, unknown> {
  constructor(ctx: ExecutionContext, env: Bindings) {
    super(ctx, withoutMasterKeys(env));
  }

  override async run(_event: WorkflowEvent<unknown>, _step: WorkflowStep): Promise<void> {}
}
