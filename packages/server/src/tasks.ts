// SPDX-License-Identifier: Apache-2.0
// The Tasks view's data (M3-13 AC1-2): the user's runs with their conversation and spend so
// far, and cancel. Cancelling writes the row first and terminates the Workflow best-effort:
// where the runtime has no Workflow binding (apps/node) the row still moves to `cancelled`
// and the run's next step finds the terminal row and stops without writing (M3-12 AC3).
import { createRepository } from "@opa/db/repository";
import { Hono } from "hono";
import type { AppEnv } from "./env";

export const taskRoutes = new Hono<AppEnv>();

taskRoutes.get("/", async (c) => {
  const user = createRepository(c.env).forUser(c.var.session.scope);
  const tasks = await user.tasks.list({
    status: c.req.queries("status"),
    since: Number(c.req.query("since")),
    until: Number(c.req.query("until")),
    limit: Number(c.req.query("limit")),
  });
  c.header("Cache-Control", "no-store");
  return c.json({ tasks });
});

taskRoutes.get("/:id", async (c) => {
  const task = await createRepository(c.env)
    .forUser(c.var.session.scope)
    .tasks.details(c.req.param("id"));
  if (!task) return c.json({ error: "not_found" }, 404);
  c.header("Cache-Control", "no-store");
  return c.json({ task });
});

taskRoutes.post("/:id/cancel", async (c) => {
  const id = c.req.param("id");
  const user = createRepository(c.env).forUser(c.var.session.scope);
  const row = await user.tasks.get(id);
  if (!row) return c.json({ error: "not_found" }, 404);
  if (!(await user.tasks.cancel(id))) return c.json({ error: "already_ended" }, 409);
  const binding = c.env.TASK_WORKFLOW;
  if (row.workflowInstanceId && typeof binding?.get === "function") {
    await binding
      .get(row.workflowInstanceId)
      .then((instance) => instance.terminate())
      .catch(() => {});
  }
  c.header("Cache-Control", "no-store");
  return c.json({ task: await user.tasks.details(id) });
});
