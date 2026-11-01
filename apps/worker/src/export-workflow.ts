// SPDX-License-Identifier: Apache-2.0
// The Workflow entrypoint for data exports (M3-20 AC1): one instance per export. It mints its
// scope from the D1 exports row alone — instance params are data, never authority, as with
// tasks (M3-12 AC9) — then stages one file per item type, a step each, and streams the staged
// files into the final ZIP in a last step. Every step first re-reads the export row, so a step
// of a finished export does nothing: a retry or a racing finish never overwrites the outcome.
// Staged keys are deterministic and R2 puts overwrite atomically, so a rerun writes identical
// bytes; the finishes are conditional on `running` for the same reason.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { TaskStepper } from "@opa/core";
import { buildExportZip, EXPORT_ITEM_TYPES, stageExportItem } from "@opa/db/export";
import { createRepository } from "@opa/db/repository";
import type { Bindings } from "./env";
import { stepperFor } from "./task-context";

/** Advisory only: identity comes from the instance's exports row, never from these params. */
export interface ExportParams {
  exportId?: string;
}

export class ExportWorkflow extends WorkflowEntrypoint<Bindings, ExportParams> {
  override async run(event: WorkflowEvent<ExportParams>, step: WorkflowStep): Promise<void> {
    // `event.payload` is never read: the export is whatever row names this instance.
    await executeExport(this.env, event.instanceId, stepperFor(step));
  }
}

const STEP = {
  retries: { limit: 3, delayMs: 1_000, backoff: "exponential" as const },
  timeoutMs: 10 * 60_000,
};

/**
 * One export's run, over the structural stepper so tests can drive it without the Workflow
 * engine (the platform class can only be constructed by the runtime).
 */
export async function executeExport(
  env: Bindings,
  instanceId: string,
  stepper: TaskStepper,
  now: () => number = Date.now,
): Promise<void> {
  const repo = createRepository(env);
  // Called outside a step on purpose: authority is re-derived from D1 on every replay, and
  // a row's user never changes, so the replay mints the same scope.
  const minted = await repo.scopeForExport(instanceId);
  if (!minted) throw new NonRetryableError("no exports row names this Workflow instance");
  const user = repo.forUser(minted.scope);
  const id = minted.export.id;
  const running = async () => (await user.exports.get(id))?.status === "running";
  try {
    for (const type of EXPORT_ITEM_TYPES) {
      await stepper.do(`export:${type}`, STEP, async () => {
        // A finished row stops the run: finishing (or the sweep) already decided the outcome.
        if (!(await running())) return { status: "skipped" };
        await stageExportItem(user, id, type, now);
        return { status: "staged", type };
      });
    }
    const finished = await stepper.do("export:finish", STEP, async () => {
      if (!(await running())) return { status: "skipped", bytes: 0 };
      const { bytes, entries } = await buildExportZip(user, id, now);
      // The row may have passed its expiry while the ZIP was built: a past-expiry row must
      // never turn ready. Drop the just-written ZIP and the staged files, expire the row,
      // and leave nothing orphaned for the sweep to miss.
      const row = await user.exports.get(id);
      if (!row || row.status !== "running" || row.expiresAt <= now()) {
        await user.exports.removeZip(id).catch(() => {});
        await user.exports.removeStaged(id).catch(() => {});
        await user.exports.finishExpired(id);
        return { status: "expired", bytes: 0 };
      }
      await user.exports.finishReady(id, bytes, now());
      return { status: "ready", bytes, entries };
    });
    await stepper.do(
      "export:cleanup",
      { retries: { limit: 0, delayMs: 0 } },
      async (): Promise<{ status: string }> => {
        // Staged files are garbage once the ZIP exists; a failed cleanup never fails the
        // export — the sweep deletes leftovers at expiry.
        if (finished.status !== "ready") return { status: "skipped" };
        await user.exports.removeStaged(id).catch(() => {});
        return { status: "cleaned" };
      },
    );
  } catch (err) {
    const message = (err instanceof Error ? err.message : "the export failed").slice(0, 500);
    await stepper
      .do("export:finish:error", {}, async () => {
        await user.exports.finishFailed(id, message);
        return null;
      })
      .catch(() => {}); // a failed finish must not mask the export's own end
    throw err instanceof NonRetryableError ? err : new NonRetryableError(message);
  }
}
