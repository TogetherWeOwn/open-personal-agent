// SPDX-License-Identifier: Apache-2.0
// The Tasks API (M3-13 AC1-2): the list with its conversation and spend, one task, and cancel.
// Cancelling writes the row first and terminates the Workflow best-effort; a missing or foreign
// id is 404, and cancelling an ended task is 409.
import { createRepository, scopeFromSession } from "@opa/db/repository";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { Browser, claim, db, env, freshDatabase, sessionHeaders } from "./helpers/app";

const repo = createRepository(env);

freshDatabase();

let seq = 0;
/** A conversation and task for `ownerId`, with unique ids across the file's tests. */
async function makeTask(ownerId: string) {
  seq += 1;
  const user = repo.forUser(scopeFromSession({ userId: ownerId }));
  const conversationId = `rconv${seq}`;
  const taskId = `rtask${seq}`;
  const instanceId = `rinst${seq}`;
  await user.createConversation(conversationId, "Trip plan");
  await user.tasks.create({
    id: taskId,
    conversationId,
    workflowInstanceId: instanceId,
    kind: "turn",
    mode: "background",
    title: "Report",
  });
  return { user, taskId, instanceId };
}

const CALL = {
  providerId: "openai",
  model: "gpt-4.1-mini",
  usage: { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 0, reasoningTokens: 0 },
};

/** A signed-in browser for a second user, without claiming the deployment again. */
async function strangerBrowser(userId: string) {
  await db
    .prepare("INSERT INTO users (id, display_name, role) VALUES (?, 'Stranger', 'member')")
    .bind(userId)
    .run();
  const { cookie } = await sessionHeaders(userId);
  const outsider = new Browser();
  const [name = "", value = ""] = cookie.split("=");
  outsider.cookies.set(name, value);
  return outsider;
}

describe("tasks routes", () => {
  it("lists the user's tasks with conversation, cost and calls", async () => {
    const { browser, owner } = await claim();
    const { user, taskId } = await makeTask(owner);
    await user.usage.record({ ...CALL, taskId });
    const res = await browser.req("/api/tasks");
    expect(res.status).toBe(200);
    const { tasks } = (await res.json()) as { tasks: Record<string, unknown>[] };
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: taskId,
      title: "Report",
      conversationTitle: "Trip plan",
      status: "queued",
      limitKind: null,
      calls: 1,
    });
    expect(typeof tasks[0]?.costMicroUsd).toBe("number");
  });

  it("filters the list and reads one task, hiding other users' runs", async () => {
    const { browser, owner } = await claim();
    const first = await makeTask(owner);
    const second = await makeTask(owner);
    await second.user.tasks.markRunning(second.taskId, Date.now());
    await second.user.tasks.finish(second.taskId, "succeeded");
    const stranger = await strangerBrowser("u2");

    const succeeded = await browser.req("/api/tasks?status=succeeded");
    expect(
      ((await succeeded.json()) as { tasks: { id: string }[] }).tasks.map((t) => t.id),
    ).toEqual([second.taskId]);
    const queued = await browser.req("/api/tasks?status=queued&limit=1");
    expect(((await queued.json()) as { tasks: { id: string }[] }).tasks.map((t) => t.id)).toEqual([
      first.taskId,
    ]);
    const unknown = await browser.req("/api/tasks?status=bogus");
    expect(((await unknown.json()) as { tasks: unknown[] }).tasks).toHaveLength(2);

    const one = await browser.req(`/api/tasks/${first.taskId}`);
    expect(one.status).toBe(200);
    expect(((await one.json()) as { task: { id: string } }).task.id).toBe(first.taskId);
    expect((await browser.req("/api/tasks/missing")).status).toBe(404);
    // Another user's run is a 404, never a leak; their own list is empty.
    expect((await stranger.req(`/api/tasks/${first.taskId}`)).status).toBe(404);
    const theirs = await stranger.req("/api/tasks");
    expect(theirs.status).toBe(200);
    expect(((await theirs.json()) as { tasks: unknown[] }).tasks).toEqual([]);
  });

  it("cancels the row first, then terminates the Workflow; an ended task is a 409", async () => {
    const { browser, owner } = await claim();
    const { taskId, instanceId } = await makeTask(owner);
    const terminated: string[] = [];
    const seen: string[] = [];
    const fake = {
      create: async () => ({}),
      get: async (id: string) => {
        seen.push(id);
        return { terminate: async () => void terminated.push(id) };
      },
    };
    const bound = new Browser({ ...env, TASK_WORKFLOW: fake as unknown as Workflow });

    // The route test's browser holds no session; copy the claim over.
    bound.cookies = new Map(browser.cookies);
    const res = await bound.req(`/api/tasks/${taskId}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(seen).toEqual([instanceId]);
    expect(terminated).toEqual([instanceId]);
    expect(((await res.json()) as { task: { status: string } }).task.status).toBe("cancelled");

    expect((await bound.req(`/api/tasks/${taskId}/cancel`, { method: "POST" })).status).toBe(409);
    expect((await bound.req("/api/tasks/missing/cancel", { method: "POST" })).status).toBe(404);
    const stranger = await strangerBrowser("u2");
    expect((await stranger.req(`/api/tasks/${taskId}/cancel`, { method: "POST" })).status).toBe(
      404,
    );
  });

  it("cancels row-only without a Workflow binding, and survives a terminate failure", async () => {
    const { browser, owner } = await claim();
    const small = await makeTask(owner);
    const nodeEnv = { ...env, TASK_WORKFLOW: undefined } as unknown as Env;
    const node = new Browser(nodeEnv);
    node.cookies = new Map(browser.cookies);
    const res = await node.req(`/api/tasks/${small.taskId}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { task: { status: string } }).task.status).toBe("cancelled");

    const failing = await makeTask(owner);
    const broken = new Browser({
      ...env,
      TASK_WORKFLOW: {
        create: async () => ({}),
        get: async () => {
          throw new Error("already terminated");
        },
      } as unknown as Workflow,
    });
    broken.cookies = new Map(browser.cookies);
    const retry = await broken.req(`/api/tasks/${failing.taskId}/cancel`, { method: "POST" });
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { task: { status: string } }).task.status).toBe("cancelled");
  });
});
