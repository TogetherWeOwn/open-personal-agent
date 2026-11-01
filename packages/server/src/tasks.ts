// SPDX-License-Identifier: Apache-2.0
// The Tasks view's data (M3-13 AC1-2): the user's runs with their conversation and spend so
// far, and cancel. Cancelling writes the row first and terminates the Workflow best-effort:
// where the runtime has no Workflow binding (apps/node) the row still moves to `cancelled`
// and the run's next step finds the terminal row and stops without writing (M3-12 AC3).
// Continue and Stop on a task paused by a limit (M3-17 AC1, A-Co2; m3-ux Flow D). The route
// changes D1 and the user's limits first and only then wakes the task's Workflow, whose run reads
// what happened from D1 and never from the event (M3-12 AC3).
import { createRepository, isId } from "@opa/db/repository";
import { type Context, Hono } from "hono";
import type { AppEnv } from "./env";

type Ctx = Context<AppEnv>;

/** The Workflow binding's surface used here; absent where the runtime has none (Node). */
interface TaskWorkflows {
  get(id: string): Promise<{ sendEvent(event: { type: string; payload: unknown }): Promise<void> }>;
}

/** The assistant's task-budget RPC (apps/worker's `Assistant`). */
interface BudgetRpc {
  raiseTask(taskId: string): Promise<boolean>;
  unraiseTask(taskId: string): Promise<void>;
  taskBudget(taskId: string): Promise<unknown>;
}

export const taskRoutes = new Hono<AppEnv>();

taskRoutes.use(async (c, next) => {
  c.header("Cache-Control", "no-store");
  return next();
});

/** A numeric filter, or `undefined` when absent or blank so the repository default applies. */
function numeric(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return Number(value);
}

taskRoutes.get("/", async (c) => {
  const user = createRepository(c.env).forUser(c.var.session.scope);
  const tasks = await user.tasks.list({
    status: c.req.queries("status"),
    since: numeric(c.req.query("since")),
    until: numeric(c.req.query("until")),
    limit: numeric(c.req.query("limit")),
  });
  return c.json({ tasks });
});

taskRoutes.get("/:id", async (c) => {
  const task = await createRepository(c.env)
    .forUser(c.var.session.scope)
    .tasks.details(c.req.param("id"));
  if (!task) return c.json({ error: "not_found" }, 404);
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
  return c.json({ task: await user.tasks.details(id) });
});

/** The task, if it's the user's and paused at a limit, with why it paused. */
async function pausedTask(c: Ctx) {
  const id = c.req.param("id") ?? "";
  if (!isId(id)) return null;
  const user = createRepository(c.env).forUser(c.var.session.scope);
  const task = await user.tasks.get(id);
  if (!task) return null;
  let paused: { kind?: string; final?: boolean } | undefined;
  try {
    paused = (JSON.parse(task.state ?? "{}") as { paused?: typeof paused }).paused;
  } catch {}
  return { user, task, kind: paused?.kind, final: paused?.final === true };
}

/** Wakes the run; a Workflow that has ended (its pause ran out) can't be continued. */
async function wake(c: Ctx, instanceId: string | null): Promise<boolean> {
  const workflows = c.env.TASK_WORKFLOW as unknown as Partial<TaskWorkflows> | undefined;
  if (!instanceId || typeof workflows?.get !== "function") return false;
  try {
    const instance = await workflows.get(instanceId);
    await instance.sendEvent({ type: "continue", payload: null });
    return true;
  } catch {
    return false;
  }
}

/**
 * Continue: a task-budget stop raises the budget once; an execution or rate limit gets a fresh
 * allowance in the run itself; a daily or hard cap just retries (the user may have raised it).
 */
taskRoutes.post("/:id/continue", async (c) => {
  const found = await pausedTask(c);
  if (!found) return c.json({ error: "not_found" }, 404);
  const { user, task, kind, final } = found;
  if (task.status !== "budget_limited") return c.json({ error: "not_paused" }, 409);
  // A steps or duration stop ended the run; only a new task can go on from there.
  if (final) return c.json({ error: "not_continuable" }, 409);
  const assistant = user.assistant() as unknown as Partial<BudgetRpc>;
  const raise = kind === "task_budget";
  if (raise) {
    if (typeof assistant.raiseTask !== "function") return c.json({ error: "unavailable" }, 503);
    if (!(await assistant.raiseTask(task.id))) {
      // No budget left to raise means the run settled it and ended: nothing can continue.
      const ended = (await assistant.taskBudget?.(task.id)) == null;
      return c.json({ error: ended ? "ended" : "already_raised" }, 409);
    }
  }
  // Whatever stops the Continue from here undoes the raise, so the one raise isn't spent.
  const undo = () => (raise ? assistant.unraiseTask?.(task.id) : undefined);
  if (!(await user.tasks.resume(task.id))) {
    await undo();
    return c.json({ error: "not_paused" }, 409);
  }
  if (!(await wake(c, task.workflowInstanceId))) {
    // Nothing woke the run: put the row back as it was.
    await user.tasks.finish(task.id, "budget_limited");
    await undo();
    return c.json({ error: "ended" }, 409);
  }
  return c.json({ status: "running" });
});

/** Stop: the task is cancelled; the woken run sees it at its next step and ends. */
taskRoutes.post("/:id/stop", async (c) => {
  const found = await pausedTask(c);
  if (!found) return c.json({ error: "not_found" }, 404);
  const { user, task } = found;
  if (!(await user.tasks.cancel(task.id))) return c.json({ error: "not_active" }, 409);
  await wake(c, task.workflowInstanceId);
  return c.json({ status: "cancelled" });
});
