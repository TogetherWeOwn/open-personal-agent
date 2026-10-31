// SPDX-License-Identifier: Apache-2.0
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "./env";

/** One instance per task run (ADR 0003). Empty until background tasks land. */
export class TaskWorkflow extends WorkflowEntrypoint<Env, unknown> {
  override async run(_event: WorkflowEvent<unknown>, _step: WorkflowStep): Promise<void> {}
}
