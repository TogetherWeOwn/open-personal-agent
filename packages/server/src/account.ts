// SPDX-License-Identifier: Apache-2.0
// Account deletion (M3-20 AC2–3, m3-ux Flow G §3.11): the session's own account only, as with
// every other route. Deleting is an account action, so it needs a passkey step-up within the
// last 5 minutes, as with starting an export. The gate is first, so a refused delete removes
// nothing. The answer says whether the deployment is claimable again, so the app can show the
// unclaimed first-run screen (and the setup-token rotation notice) instead of the login page.
// The preview needs no step-up: the deletion screen reads it before the passkey ceremony, to
// show the only-owner warning up front.
import { type DeletionResult, deleteUserData, deletionPreview } from "@opa/db/deletion";
import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import * as auth from "./auth";
import type { AppEnv } from "./env";
import { hasAccountStepUp } from "./session";

export const accountRoutes = new Hono<AppEnv>();

accountRoutes.get("/", async (c) => {
  const preview = await deletionPreview(c.env, c.var.session.userId);
  if (!preview) return c.json({ error: "not_found" }, 404);
  c.header("Cache-Control", "no-store");
  return c.json(preview);
});

accountRoutes.delete("/", async (c) => {
  // The gate is first, so a refused delete claims nothing and stops nothing.
  if (!hasAccountStepUp(c.var.session)) return c.json({ error: "step_up_required" }, 403);
  const { userId } = c.var.session;
  // Fail closed with a stable code: a purge the store cannot prove empty (or any object
  // delete that throws) refuses the delete instead of stranding the user's objects.
  let result: DeletionResult | null;
  try {
    result = await deleteUserData(c.env, userId);
  } catch {
    return c.json({ error: "delete_failed" }, 503);
  }
  if (!result) return c.json({ error: "not_found" }, 404);
  // Row first, terminate best-effort, as the task cancel route. A run the terminate misses
  // still finds its task row cancelled or its export row failed — or no row at all — and
  // stops without writing (tasks M3-12 AC3, exports M3-20 AC1); the final purge in
  // `deleteUserData` removes what a step past its re-read wrote anyway.
  const tasks = c.env.TASK_WORKFLOW;
  if (typeof tasks?.get === "function") {
    await Promise.all(
      result.taskInstances.map((id: string) =>
        tasks
          .get(id)
          .then((instance) => instance.terminate())
          .catch(() => {}),
      ),
    );
  }
  const exportWorkflows = c.env.EXPORT_WORKFLOW;
  if (exportWorkflows && typeof exportWorkflows.get === "function") {
    // Bound, so the call keeps its receiver: the binding rejects a detached method call.
    const terminate = exportWorkflows.get.bind(exportWorkflows);
    await Promise.all(
      result.exportInstances.map((id: string) =>
        terminate(id)
          .then((instance) => instance.terminate())
          .catch(() => {}),
      ),
    );
  }
  deleteCookie(c, auth.SESSION_COOKIE, auth.COOKIE_OPTIONS);
  c.header("Cache-Control", "no-store");
  return c.json({ deleted: true, unclaimed: result.unclaimed });
});
