// SPDX-License-Identifier: Apache-2.0
// Account deletion (M3-20 AC2–3, m3-ux Flow G §3.11): the session's own account only, as with
// every other route. Deleting is an account action, so it needs a passkey step-up within the
// last 5 minutes, as with starting an export. The gate is first, so a refused delete removes
// nothing. The answer says whether the deployment is claimable again, so the app can show the
// unclaimed first-run screen (and the setup-token rotation notice) instead of the login page.
import { deleteUserData } from "@opa/db/deletion";
import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import * as auth from "./auth";
import type { AppEnv } from "./env";
import { hasAccountStepUp } from "./session";

export const accountRoutes = new Hono<AppEnv>();

accountRoutes.delete("/", async (c) => {
  // The gate is first, so a refused delete claims nothing and stops nothing.
  if (!hasAccountStepUp(c.var.session)) return c.json({ error: "step_up_required" }, 403);
  const { userId } = c.var.session;
  const result = await deleteUserData(c.env, userId);
  if (!result) return c.json({ error: "not_found" }, 404);
  // Row first, terminate best-effort, as the task cancel route: a run the terminate misses
  // still finds its task row gone or terminal and stops without writing (M3-12 AC3).
  const binding = c.env.TASK_WORKFLOW;
  if (typeof binding?.get === "function") {
    await Promise.all(
      result.terminatedInstances.map((id: string) =>
        binding
          .get(id)
          .then((instance) => instance.terminate())
          .catch(() => {}),
      ),
    );
  }
  deleteCookie(c, auth.SESSION_COOKIE, auth.COOKIE_OPTIONS);
  c.header("Cache-Control", "no-store");
  return c.json({ deleted: true, unclaimed: result.unclaimed });
});
