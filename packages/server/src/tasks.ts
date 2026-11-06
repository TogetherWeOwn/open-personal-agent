// SPDX-License-Identifier: Apache-2.0
// The Tasks view's data (M3-13 AC1-2): the user's runs with their conversation and spend so
// far, and cancel. Cancelling writes the row first and terminates the Workflow best-effort:
// where the runtime has no Workflow binding (apps/node) the row still moves to `cancelled`
// and the run's next step finds the terminal row and stops without writing (M3-12 AC3).
// Continue and Stop on a task paused by a limit (M3-17 AC1, A-Co2; m3-ux Flow D). The route
// changes D1 and the user's limits first and only then wakes the task's Workflow, whose run reads
// what happened from D1 and never from the event (M3-12 AC3).
import { createRepository, isId, TASK_LIMIT_KINDS, type TaskLimitKind } from "@opa/db/repository";
import { type Context, Hono } from "hono";
import { resolveComputerProvider } from "./computer-settings";
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

/** The assistant's task-progress RPC, for ending a promoted turn whose run was terminated. */
interface ProgressRpc {
  taskProgress(progress: {
    conversationId: string;
    turnId: string;
    taskId: string;
    seq: number;
    type: string;
    payload: unknown;
    inTurn?: boolean;
  }): Promise<void>;
}

type ScopedUser = ReturnType<ReturnType<typeof createRepository>["forUser"]>;

/**
 * Cuts a cancelled promoted task's reply where it is and tells its tabs the turn ended.
 * Termination stops the run before its own cancel path can, so the route does it instead:
 * conditional on the reply still streaming, so a run that settled first keeps its end.
 * The route doesn't know the driver's per-task counter, so the end carries a sequence past
 * any it could have sent, which the conversation's log never dedupes away.
 */
async function cutPromotedReply(
  user: ScopedUser,
  task: { id: string; conversationId: string; state: string | null },
): Promise<void> {
  let replyId: string | undefined;
  let turnId: string | undefined;
  let saved = "";
  try {
    const state = JSON.parse(task.state ?? "{}") as {
      replyId?: string;
      turnId?: string;
      turn?: { messages?: { role?: string; content?: string }[] };
    };
    replyId = state.replyId;
    turnId = state.turnId;
    saved = (state.turn?.messages ?? [])
      .flatMap((m) => (m.role === "assistant" && m.content ? [m.content] : []))
      .join("\n\n");
  } catch {}
  if (!replyId) return;
  const stored = ((await user.chat.listMessages(task.conversationId).catch(() => null)) ?? []).find(
    (m) => m.id === replyId,
  );
  if (stored?.status !== "streaming") return;
  // Whichever text is fuller: segments are checkpointed as they complete, ahead of the save.
  const reply = stored.content.length >= saved.length ? stored.content : saved;
  await user.chat.interrupt({ replyId, reply }).catch(() => {});
  const assistant = user.assistant() as unknown as Partial<ProgressRpc>;
  if (typeof assistant.taskProgress === "function") {
    await assistant
      .taskProgress({
        conversationId: task.conversationId,
        turnId: turnId ?? task.id,
        taskId: task.id,
        seq: Number.MAX_SAFE_INTEGER,
        type: "turn.cancelled",
        payload: {},
        inTurn: true,
      })
      .catch(() => {});
  }
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
  // A previous attempt may have committed cancellation before an abort RPC failed. The
  // remaining Workflow/reply cleanup is idempotent and must still run on that retry.
  if (!(await user.tasks.cancel(id)) && row.status !== "cancelled")
    return c.json({ error: "already_ended" }, 409);
  const binding = c.env.TASK_WORKFLOW;
  if (row.workflowInstanceId && typeof binding?.get === "function") {
    await binding
      .get(row.workflowInstanceId)
      .then((instance) => instance.terminate())
      .catch(() => {});
  }
  // The terminated run never reaches its own cancel path, so the reply is cut here.
  await cutPromotedReply(user, row);
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
    // Nothing woke the run: put the row back as it was, keeping the limit kind it paused
    // with so the Tasks view keeps its "Paused" label.
    const limitKind = (TASK_LIMIT_KINDS as readonly string[]).includes(kind ?? "")
      ? (kind as TaskLimitKind)
      : null;
    await user.tasks.finish(task.id, "budget_limited", undefined, limitKind);
    await undo();
    return c.json({ error: "ended" }, 409);
  }
  return c.json({ status: "running" });
});

/**
 * Sets the task's computer provider override (M4-10 AC1), from the composer or the task card;
 * `null` clears it back to the Settings default the router otherwise reads (M4-07 AC4). Like
 * the other task writes it is scoped to the caller's rows — another user's task is a 404 that
 * changes nothing — and the provider id is validated against the live registry before it is
 * stored. A task op, not a settings change, so it writes no audit row, as with cancel/stop.
 */
taskRoutes.put("/:id/computer", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || !("provider" in body)) {
    return c.json({ error: "invalid_body" }, 400);
  }
  const provider =
    body.provider === null
      ? null
      : typeof body.provider === "string" &&
          body.provider.trim() !== "" &&
          body.provider.length <= 128
        ? body.provider.trim()
        : null;
  if (body.provider !== null && provider === null)
    return c.json({ error: "invalid_provider" }, 400);
  if (provider !== null) {
    try {
      resolveComputerProvider(provider);
    } catch {
      return c.json({ error: "unknown_provider" }, 409);
    }
  }
  const user = createRepository(c.env).forUser(c.var.session.scope);
  const id = c.req.param("id");
  if (!isId(id) || !(await user.tasks.get(id))) return c.json({ error: "not_found" }, 404);
  await user.tasks.setComputerProvider(id, provider);
  return c.json({ computerProvider: provider });
});

/** Stop: the task is cancelled; the woken run sees it at its next step and ends. */
taskRoutes.post("/:id/stop", async (c) => {
  const found = await pausedTask(c);
  if (!found) return c.json({ error: "not_found" }, 404);
  const { user, task } = found;
  if (!(await user.tasks.cancel(task.id)) && task.status !== "cancelled")
    return c.json({ error: "not_active" }, 409);
  await wake(c, task.workflowInstanceId);
  // A run that never wakes (its wait already ended it) can't cut its reply; this is a no-op
  // once the woken run has cut it itself.
  await cutPromotedReply(user, task);
  return c.json({ status: "cancelled" });
});
