// SPDX-License-Identifier: Apache-2.0
// Continue and Stop on a task paused by a limit (M3-17 AC1, A-Co2): Continue raises a task
// budget once and wakes the run only after D1 says `running`; Stop cancels it.
import { createRepository, scopeFromSession } from "@opa/db/repository";
import { describe, expect, it, vi } from "vitest";
import type { Assistant } from "../src/assistant";
import { workerApp } from "../src/worker-app";
import { claim, env, freshDatabase, ORIGIN, sessionHeaders } from "./helpers/app";

freshDatabase();

let seq = 0;
async function setup(kind = "task_budget") {
  const { owner } = await claim();
  const user = createRepository(env).forUser(scopeFromSession({ userId: owner }));
  const conversationId = crypto.randomUUID();
  await user.createConversation(conversationId, "Chat");
  seq += 1;
  const taskId = `rt${seq}`;
  const state = {
    history: [],
    turn: {},
    turnId: "t",
    paused: { kind, detail: "$0.50 task budget" },
  };
  await user.tasks.create({
    id: taskId,
    conversationId,
    workflowInstanceId: `rt-inst${seq}`,
    kind: "turn",
    mode: "background",
    state: JSON.stringify(state),
  });
  await user.tasks.markRunning(taskId, Date.now());
  await user.tasks.finish(taskId, "budget_limited");
  const assistant = user.assistant() as unknown as DurableObjectStub<Assistant>;
  await assistant.startTask(taskId, 500_000);
  const statusWhenWoken: (string | undefined)[] = [];
  const sendEvent = vi.fn(async () => {
    statusWhenWoken.push((await user.tasks.get(taskId))?.status);
  });
  const bindings = { ...env, TASK_WORKFLOW: { get: async () => ({ sendEvent }) } };
  const headers = await sessionHeaders(owner);
  const post = (path: string, over = bindings) =>
    workerApp.request(`${ORIGIN}/api/tasks/${taskId}/${path}`, { method: "POST", headers }, over);
  return { user, taskId, assistant, sendEvent, statusWhenWoken, post };
}

describe("task Continue and Stop", () => {
  it("Continue raises a task budget once, and wakes the run only once D1 says running", async () => {
    const { user, taskId, assistant, sendEvent, statusWhenWoken, post } = await setup();
    const res = await post("continue");
    expect(res.status).toBe(200);
    expect(sendEvent).toHaveBeenCalledWith({ type: "continue", payload: null });
    expect(statusWhenWoken).toEqual(["running"]);
    expect(await assistant.taskBudget(taskId)).toMatchObject({ budgetMicroUsd: 1_000_000 });
    // Paused again at the raised budget: Continue can't raise it a second time.
    await user.tasks.finish(taskId, "budget_limited");
    const again = await post("continue");
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "already_raised" });
    expect((await user.tasks.get(taskId))?.status).toBe("budget_limited");
  });

  it("Continue on an execution limit wakes the run without touching the budget", async () => {
    const { taskId, assistant, sendEvent, post } = await setup("tools");
    expect((await post("continue")).status).toBe(200);
    expect(sendEvent).toHaveBeenCalledTimes(1);
    expect(await assistant.taskBudget(taskId)).toMatchObject({ budgetMicroUsd: 500_000 });
  });

  it("leaves a task paused when its run has ended, and refuses one that isn't paused", async () => {
    const { user, taskId, post } = await setup("daily");
    const ended = { ...env, TASK_WORKFLOW: { get: async () => Promise.reject(new Error("gone")) } };
    expect((await post("continue", ended as never)).status).toBe(409);
    // The row stays paused with the limit kind it paused with.
    expect(await user.tasks.get(taskId)).toMatchObject({ status: "budget_limited" });
    expect((await user.tasks.details(taskId))?.limitKind).toBe("daily");
    await user.tasks.resume(taskId);
    expect((await post("continue")).status).toBe(409);
  });

  it("a Continue whose wake fails undoes the raise, so a later Continue still works", async () => {
    const { taskId, assistant, post, sendEvent } = await setup();
    const down = { ...env, TASK_WORKFLOW: { get: async () => Promise.reject(new Error("blip")) } };
    expect((await post("continue", down as never)).status).toBe(409);
    expect(await assistant.taskBudget(taskId)).toMatchObject({
      budgetMicroUsd: 500_000,
      raised: false,
    });
    expect((await post("continue")).status).toBe(200);
    expect(sendEvent).toHaveBeenCalledTimes(1);
    expect(await assistant.taskBudget(taskId)).toMatchObject({ budgetMicroUsd: 1_000_000 });
  });

  it("refuses Continue on a run that ended at an execution limit", async () => {
    const { user, taskId, post, sendEvent } = await setup();
    const row = await user.tasks.get(taskId);
    const state = {
      ...JSON.parse(row?.state ?? "{}"),
      paused: { kind: "steps", detail: "200 steps", final: true },
    };
    await user.tasks.saveState(taskId, JSON.stringify(state));
    const res = await post("continue");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_continuable" });
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("Stop cancels the task and wakes the run so it ends", async () => {
    const { user, taskId, sendEvent, post } = await setup();
    expect((await post("stop")).status).toBe(200);
    expect((await user.tasks.get(taskId))?.status).toBe("cancelled");
    expect(sendEvent).toHaveBeenCalledTimes(1);
    expect((await post("stop")).status).toBe(409);
  });

  it("finds no other user's task", async () => {
    const { taskId } = await setup();
    await env.DB.prepare(
      "INSERT INTO users (id, display_name, role) VALUES ('mallory', 'M', 'member')",
    ).run();
    const headers = await sessionHeaders("mallory");
    const res = await workerApp.request(
      `${ORIGIN}/api/tasks/${taskId}/stop`,
      { method: "POST", headers },
      env,
    );
    expect(res.status).toBe(404);
  });
});
