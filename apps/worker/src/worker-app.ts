// SPDX-License-Identifier: Apache-2.0
// The Worker's app: the shared app plus the chat socket to the user's assistant (ADR 0002), named
// from the session only; the SDK's `/agents/*` router isn't mounted. apps/node never loads it.
import { createRepository } from "@opa/db/repository";
import { createApp } from "@opa/server/app";
import { type ApprovalForward, approvalRoutes } from "@opa/server/approvals";
import { sameOrigin } from "@opa/server/security";
import { Hono } from "hono";
import { SESSION_HEADER } from "./assistant";
import type { AppEnv } from "./env";

const workerRoutes = new Hono<AppEnv>();

workerRoutes.get("/chat", async (c) => {
  // A WebSocket upgrade is a GET and skips CORS, so a cross-site page could open one with the
  // user's cookie. The session guard checks Origin on writes only, so check it here.
  if (!sameOrigin(c)) return c.json({ error: "bad_origin" }, 403);
  const assistant = createRepository(c.env).forUser(c.var.session.scope).assistant();
  const upgrade = new Request(c.req.raw);
  upgrade.headers.set(SESSION_HEADER, c.var.session.id);
  return assistant.fetch(upgrade);
});

/**
 * Wakes the run a decided batch belongs to, with its ID only (M3-07 AC10): the user's assistant
 * for a turn, named from the session; the task's Workflow for a task, whose next step re-reads
 * the rows and the task row (M3-12 AC3). The route has already checked both.
 */
const forward: ApprovalForward = async (c, rows) => {
  const [first] = rows;
  if (!first) return "gone";
  const env = c.env as AppEnv["Bindings"]; // the Worker mounts this, so its bindings are there
  const user = createRepository(env).forUser(c.var.session.scope);
  if (first.turnId) return user.assistant().resumeBatch(first.batchId);
  const task = first.taskId ? await user.tasks.get(first.taskId) : undefined;
  if (!task?.workflowInstanceId) return "gone";
  const instance = await env.TASK_WORKFLOW.get(task.workflowInstanceId);
  await instance.sendEvent({ type: "approval", payload: { batchId: first.batchId } });
  return "resumed";
};

workerRoutes.route("/approvals", approvalRoutes(forward));

export const workerApp = createApp(workerRoutes);
