// SPDX-License-Identifier: Apache-2.0
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import type { JsonValue, TaskStepper } from "@opa/core";
import { createRepository, scopeFromSession } from "@opa/db/repository";
import {
  blobStoreContract,
  databaseContract,
  memoryContract,
  memoryGateContract,
  memoryRecallContract,
  usageLedgerContract,
} from "../../../test/contract/storage";
import {
  type TaskContextConnectOptions,
  type TaskContextHarness,
  taskContextContract,
  taskStoreContract,
} from "../../../test/contract/tasks";
import type { Env } from "../src/env";
import {
  type AssistantTaskRpc,
  createWorkflowTaskContext,
  type WorkflowTaskContextDeps,
} from "../src/task-context";

const env = workerEnv as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };

databaseContract("D1", () => env.DB);
blobStoreContract("R2", () => env.FILES);
usageLedgerContract("D1", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  return env.DB;
});
memoryContract("D1", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  return env.DB;
});
memoryGateContract("D1", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  return env.DB;
});
memoryRecallContract("D1", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  return env.DB;
});
taskStoreContract(
  "D1",
  async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    return env.DB;
  },
  () => env.FILES,
);

/**
 * A stepper that persists (and replays) step outputs the way the Workflow engine does,
 * shared across one harness's reconnects the way the engine's history survives a resume.
 * Consumed waits persist their payload under their name, so a resume replays a finished
 * wait instead of timing out.
 */
class SharedStepper implements TaskStepper {
  readonly persisted = new Map<string, JsonValue>();
  readonly events: { type: string; payload: JsonValue }[] = [];
  async do<T extends JsonValue>(name: string, _c: unknown, fn: () => Promise<T>): Promise<T> {
    const hit = this.persisted.get(name);
    if (hit !== undefined) return hit as T;
    const value = await fn();
    this.persisted.set(name, JSON.parse(JSON.stringify(value)) as JsonValue);
    return value;
  }
  async sleep(): Promise<void> {}
  async waitForEvent<T extends JsonValue>(
    name: string,
    options: { type: string; timeoutMs: number },
  ): Promise<{ payload: T }> {
    const hit = this.persisted.get(name) as { payload: T } | undefined;
    if (hit !== undefined) return { payload: hit.payload };
    const at = this.events.findIndex((e) => e.type === options.type);
    if (at < 0) throw new Error("waitForEvent timed out: no event was posted");
    const [next] = this.events.splice(at, 1);
    this.persisted.set(name, JSON.parse(JSON.stringify({ payload: next?.payload })) as JsonValue);
    return { payload: next?.payload as T };
  }
}

let taskSeq = 0;
async function connectTaskContext(
  options: TaskContextConnectOptions = {},
): Promise<TaskContextHarness> {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  taskSeq += 1;
  const userId = `parity-${taskSeq}-${Date.now()}`;
  const conversationId = `c-${userId}`;
  const taskId = `t-${userId}`;
  const instanceId = `inst-${userId}`;
  await env.DB.prepare("INSERT INTO users (id, display_name, role) VALUES (?, 'P', 'owner')")
    .bind(userId)
    .run();
  const repo = createRepository(env);
  const scoped = repo.forUser(scopeFromSession({ userId }));
  await scoped.chat.open(conversationId, "Parity");
  await scoped.tasks.create({
    id: taskId,
    conversationId,
    workflowInstanceId: instanceId,
    kind: "turn",
    mode: "background",
  });
  await scoped.tasks.markRunning(taskId, options.startedAt ?? Date.now());
  const stepper = new SharedStepper();
  const progressEvents: TaskContextHarness["progressEvents"] = [];
  const budgetCalls: string[] = [];
  const outputIds: string[] = [];
  const outputs = {
    put: async (id: string, value: string) => {
      outputIds.push(id);
      return scoped.stepOutputs.put(id, value);
    },
    get: (id: string) => scoped.stepOutputs.get(id),
  };
  const assistant: AssistantTaskRpc = {
    reserveTaskCall: async (key) => {
      budgetCalls.push(`reserve:${key}`);
      return { maxOutputTokens: 8, reservedMicroUsd: 0 };
    },
    settleTaskCall: async (key) => {
      budgetCalls.push(`settle:${key}`);
    },
    releaseTaskCall: async (key) => {
      budgetCalls.push(`release:${key}`);
    },
    startTask: async (_taskId, budgetMicroUsd) => ({ budgetMicroUsd: budgetMicroUsd ?? 500_000 }),
    endTask: async () => 0,
    allowToolCall: async () => true,
    // Synchronous push: the adapter fires progress without awaiting it.
    taskProgress: (p) => {
      progressEvents.push({ seq: p.seq, type: p.type, payload: p.payload });
      return Promise.resolve();
    },
  };
  const deps: WorkflowTaskContextDeps = {
    stepper,
    taskId,
    instanceId,
    conversationId,
    turnId: "turn1",
    startedAt: options.startedAt ?? Date.now(),
    mode: "background",
    readStatus: async () => (await scoped.tasks.get(taskId))?.status,
    outputs,
    assistant,
    ...(options.secrets ? { secrets: options.secrets } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
  };
  return {
    ctx: createWorkflowTaskContext(deps),
    taskId,
    instanceId,
    cancel: () => scoped.tasks.cancel(taskId).then(() => {}),
    reconnect: () => createWorkflowTaskContext({ ...deps }),
    postEvent: async (type, payload) => {
      stepper.events.push({ type, payload: payload as JsonValue });
    },
    persistedText: async () => JSON.stringify([...stepper.persisted.values()]),
    outputIds: () => outputIds,
    readOutput: async (id) => (await scoped.stepOutputs.get(id))?.text() ?? null,
    progressEvents,
    budgetCalls,
  };
}

taskContextContract("Workflows adapter", connectTaskContext);
