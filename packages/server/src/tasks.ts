// SPDX-License-Identifier: Apache-2.0
// Continue and Stop on a task paused by a limit (M3-17 AC1, A-Co2; m3-ux Flow D). The route
// changes D1 and the user's limits first and only then wakes the task's Workflow, whose run reads
// what happened from D1 and never from the event (M3-12 AC3). The Tasks view is M3-13's.
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
  taskBudget(taskId: string): Promise<unknown>;
}

export const taskRoutes = new Hono<AppEnv>();

taskRoutes.use(async (c, next) => {
  c.header("Cache-Control", "no-store");
  return next();
});

/** The task, if it's the user's and paused at a limit, with why it paused. */
async function pausedTask(c: Ctx) {
  const id = c.req.param("id") ?? "";
  if (!isId(id)) return null;
  const user = createRepository(c.env).forUser(c.var.session.scope);
  const task = await user.tasks.get(id);
  if (!task) return null;
  let kind: string | undefined;
  try {
    kind = (JSON.parse(task.state ?? "{}") as { paused?: { kind?: string } }).paused?.kind;
  } catch {}
  return { user, task, kind };
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
  const { user, task, kind } = found;
  if (task.status !== "budget_limited") return c.json({ error: "not_paused" }, 409);
  if (kind === "task_budget") {
    const assistant = user.assistant() as unknown as Partial<BudgetRpc>;
    if (typeof assistant.raiseTask !== "function") return c.json({ error: "unavailable" }, 503);
    if (!(await assistant.raiseTask(task.id))) {
      // No budget left to raise means the run settled it and ended: nothing can continue.
      const ended = (await assistant.taskBudget?.(task.id)) == null;
      return c.json({ error: ended ? "ended" : "already_raised" }, 409);
    }
  }
  if (!(await user.tasks.resume(task.id))) return c.json({ error: "not_paused" }, 409);
  if (!(await wake(c, task.workflowInstanceId))) {
    // Nothing is left to run it: put the row back as it was.
    await user.tasks.finish(task.id, "budget_limited");
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
