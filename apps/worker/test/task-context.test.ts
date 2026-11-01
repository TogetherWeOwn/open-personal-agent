// SPDX-License-Identifier: Apache-2.0
// The Workflows TaskContext adapter (M3-12a): cancel discipline (AC3), per-task limits (AC6),
// R2 offload and canary-free persisted outputs (AC4), and reserve/settle over DO RPC against
// the real assistant (AC8). A fake stepper records what a Workflow would persist, so the tests
// assert on the persisted step state itself.
import { applyD1Migrations, type D1Migration, runInDurableObject } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { type JsonValue, TaskCancelledError, TaskLimitError, type TaskStepper } from "@opa/core";
import { createRepository, scopeFromSession } from "@opa/db/repository";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { canaryForms } from "../../../scripts/canary-forms.mjs";
import type { Assistant } from "../src/assistant";
import type { WorkerEnv } from "../src/compose";
import {
  type AssistantTaskRpc,
  createWorkflowTaskContext,
  type WorkflowTaskContextDeps,
} from "../src/task-context";

const env = workerEnv as unknown as WorkerEnv & {
  TEST_MIGRATIONS: D1Migration[];
  OPA_CANARY: string;
};
const canary = env.OPA_CANARY;
const forms = canaryForms(canary);
const leaks = (text: string) => forms.some((f) => text.includes(f));
const repo = createRepository(env);
const alice = repo.forUser(scopeFromSession({ userId: "alice" }));

/** A stepper that persists (and replays) step outputs the way the Workflow engine does. */
class FakeStepper implements TaskStepper {
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
  async waitForEvent<T extends JsonValue>(): Promise<{ payload: T }> {
    return { payload: (this.events.shift()?.payload ?? null) as T };
  }
  persistedText(): string {
    return JSON.stringify([...this.persisted.values()]);
  }
}

const quietAssistant = (): AssistantTaskRpc => ({
  reserveTaskCall: async () => ({ maxOutputTokens: 1024, reservedMicroUsd: 0 }),
  settleTaskCall: async () => {},
  releaseTaskCall: async () => {},
  startTask: async () => ({ budgetMicroUsd: 500_000 }),
  endTask: async () => 0,
  allowToolCall: async () => true,
  taskProgress: async () => {},
});

let taskSeq = 0;
async function context(over: Partial<WorkflowTaskContextDeps> = {}, status = "running") {
  taskSeq += 1;
  const taskId = `task${taskSeq}`;
  await alice.tasks.create({
    id: taskId,
    conversationId: "ca",
    workflowInstanceId: `inst${taskSeq}`,
    kind: "turn",
    mode: "background",
  });
  await alice.tasks.markRunning(taskId, Date.now());
  if (status === "cancelled") await alice.tasks.cancel(taskId);
  const stepper = new FakeStepper();
  const ctx = createWorkflowTaskContext({
    stepper,
    taskId,
    instanceId: `inst${taskSeq}`,
    conversationId: "ca",
    turnId: "turn1",
    startedAt: Date.now(),
    mode: "background",
    readStatus: async () => (await alice.tasks.get(taskId))?.status,
    outputs: alice.stepOutputs,
    assistant: quietAssistant(),
    ...over,
  });
  return { ctx, stepper, taskId };
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare(
    "INSERT INTO users (id, display_name, role) VALUES ('alice', 'A', 'owner')",
  ).run();
  await alice.createConversation("ca", "Alice's");
});

describe("cancel discipline (AC3)", () => {
  it("a step of an already-cancelled task never runs its function", async () => {
    const { ctx } = await context({}, "cancelled");
    const ran = vi.fn(async () => "done" as const);
    await expect(ctx.step("s1", ran)).rejects.toBeInstanceOf(TaskCancelledError);
    expect(ran).not.toHaveBeenCalled();
  });

  it("a cancel that lands mid-step lets it finish, then no later step starts", async () => {
    const { ctx, taskId } = await context();
    const first = await ctx.step("s1", async () => {
      await alice.tasks.cancel(taskId); // the cancel arrives while s1 is in flight
      return "finished";
    });
    expect(first).toBe("finished");
    const ran = vi.fn(async () => "done" as const);
    await expect(ctx.step("s2", ran)).rejects.toBeInstanceOf(TaskCancelledError);
    expect(ran).not.toHaveBeenCalled();
  });

  it("a stop persists as the step's output, so the engine neither retries nor re-reads it", async () => {
    const { ctx, stepper } = await context({}, "cancelled");
    await expect(ctx.step("s1", async () => "done")).rejects.toBeInstanceOf(TaskCancelledError);
    expect(stepper.persisted.get("s1")).toEqual({ stopped: "cancelled" });
  });

  it("a cancelled task neither sleeps nor waits", async () => {
    const { ctx, stepper } = await context({}, "cancelled");
    const waited = vi.spyOn(stepper, "waitForEvent");
    const slept = vi.spyOn(stepper, "sleep");
    await expect(ctx.sleep("nap", 1_000)).rejects.toBeInstanceOf(TaskCancelledError);
    await expect(
      ctx.waitForEvent("approval", { type: "approval", timeoutMs: 1_000 }),
    ).rejects.toBeInstanceOf(TaskCancelledError);
    expect(slept).not.toHaveBeenCalled();
    expect(waited).not.toHaveBeenCalled();
  });

  it("returns a step's value as-is even when it looks like an adapter marker", async () => {
    const { ctx } = await context();
    const lookalike = { stopped: "cancelled", ref: "x", __opaStepOutputRef: "y" } as const;
    expect(await ctx.step("s1", async () => lookalike)).toEqual(lookalike);
  });

  it("gives each step its idempotency key and refuses a reused name", async () => {
    const { ctx } = await context();
    const key = await ctx.step("llm:1", async (k) => k);
    expect(key).toBe(ctx.idempotencyKey("llm:1"));
    expect(key).toBe(`${ctx.instanceId}:llm:1`);
    await expect(ctx.step("llm:1", async () => "again")).rejects.toThrow(/already used/);
  });
});

describe("per-task limits (AC6)", () => {
  it("stops at the step limit without running the step", async () => {
    const { ctx } = await context({ limits: { steps: 2 } });
    await ctx.step("a", async () => 1);
    await ctx.sleep("b", 1);
    const ran = vi.fn(async () => 3);
    const err = await ctx.step("c", ran).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TaskLimitError);
    expect((err as TaskLimitError).kind).toBe("steps");
    expect(ran).not.toHaveBeenCalled();
  });

  it("stops a task past its duration at the next step boundary", async () => {
    const { ctx } = await context({ startedAt: Date.now() - 31 * 60_000, mode: "interactive" });
    const ran = vi.fn(async () => 1);
    const err = await ctx.step("a", ran).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TaskLimitError);
    expect((err as TaskLimitError).kind).toBe("duration");
    expect(ran).not.toHaveBeenCalled();
  });
});

describe("step outputs (AC4)", () => {
  it("offloads an output over 1 MiB to R2 and persists only a reference", async () => {
    const { ctx, stepper } = await context();
    const big = "x".repeat(1024 * 1024 + 10);
    const out = await ctx.step("big", async () => big);
    expect(out).toBe(big); // the caller still gets the value
    expect(stepper.persistedText().length).toBeLessThan(200); // the persisted state does not
    const listed = await env.FILES.list({ prefix: "u/alice/task-outputs/" });
    expect(listed.objects.length).toBeGreaterThan(0);
    const stored = await env.FILES.get(listed.objects[0]?.key as string);
    expect((await stored?.text())?.length).toBeGreaterThan(1024 * 1024);
  });

  it("persisted outputs, inline and offloaded, contain no canary secret", async () => {
    const { ctx, stepper } = await context({ secrets: [canary] });
    const small = await ctx.step("small", async () => ({
      note: `the key is ${canary}, ok`,
      nested: [canary],
      [canary]: "as a key",
    }));
    expect(leaks(JSON.stringify(small))).toBe(false);
    const big = `${"y".repeat(1024 * 1024)}${canary}`;
    const out = await ctx.step("big", async () => big);
    expect(leaks(out)).toBe(false);
    expect(leaks(stepper.persistedText())).toBe(false);
    const listed = await env.FILES.list({ prefix: "u/alice/task-outputs/" });
    for (const { key } of listed.objects) {
      expect(leaks((await (await env.FILES.get(key))?.text()) ?? ""), key).toBe(false);
    }
  });
});

describe("budget and progress over DO RPC (AC8)", () => {
  const assistantOf = () => alice.assistant() as unknown as AssistantTaskRpc;

  it("reserves and settles through the user's own assistant", async () => {
    const { ctx, stepper } = await context({ assistant: assistantOf() });
    await ctx.budget.start(); // a task's calls draw on its budget, reserved as it starts
    const result = await ctx.step("llm:1", async (key) => {
      const reservation = await ctx.budget.reserve(key, "openai", "gpt-4.1", 2000);
      expect("maxOutputTokens" in reservation && reservation.maxOutputTokens).toBeGreaterThan(0);
      await ctx.budget.settle(key, "openai", "gpt-4.1", {
        inputTokens: 1000,
        outputTokens: 500,
        cachedInputTokens: 0,
      });
      return "called";
    });
    expect(result).toBe("called");
    expect(leaks(stepper.persistedText())).toBe(false);
  });

  it("a retry's re-reserve charges the earlier hold instead of double-spending the day", async () => {
    const rpc = assistantOf();
    const spent = () =>
      runInDurableObject(
        alice.assistant(),
        (instance: Assistant) =>
          (
            instance as unknown as {
              ctx: { storage: { kv: { get(k: string): { spentMicroUsd: number } } } };
            }
          ).ctx.storage.kv.get("spend").spentMicroUsd,
      );
    const before = await spent().catch(() => 0);
    const first = await rpc.reserveTaskCall("inst:llm", "openai", "gpt-4.1", 2000, {});
    // The step "crashes" after reserving; the retry reserves the same key again.
    const second = await rpc.reserveTaskCall("inst:llm", "openai", "gpt-4.1", 2000, {});
    expect(second).toHaveProperty("maxOutputTokens");
    expect((await spent()) - before).toBe("reservedMicroUsd" in first && first.reservedMicroUsd);
    await rpc.releaseTaskCall("inst:llm");
  });

  it("broadcasts progress to the user's tabs in the v1 envelope, closing ended sessions first", async () => {
    await runInDurableObject(alice.assistant(), async (instance: Assistant) => {
      const sent: string[] = [];
      const ended = { state: { sessionId: "sess-ended" }, close: vi.fn() };
      const raw = instance as unknown as {
        broadcast: (m: string) => void;
        getConnections: () => Iterable<unknown>;
      };
      raw.broadcast = (m) => sent.push(m);
      raw.getConnections = () => [ended];
      await instance.taskProgress({
        conversationId: "ca",
        turnId: "turn1",
        taskId: "taskX",
        seq: 7,
        type: "step.started",
        payload: { stepId: "s1", label: "Thinking" },
      });
      expect(ended.close).toHaveBeenCalledWith(4401, "unauthenticated");
      // The SDK broadcasts its own startup message too; ours is the one in the v1 envelope.
      const ours = sent.map((m) => JSON.parse(m)).filter((m) => m.v === 1);
      expect(ours).toHaveLength(1);
      expect(ours[0]).toMatchObject({
        v: 1,
        seq: 7,
        sessionId: "ca",
        turnId: "turn1",
        taskId: "taskX",
        type: "step.started",
      });
    });
  });

  it("broadcasts progress in arrival order while a tab recheck is pending", async () => {
    await runInDurableObject(alice.assistant(), async (instance: Assistant) => {
      const sent: string[] = [];
      const raw = instance as unknown as {
        broadcast: (m: string) => void;
        getConnections: () => Iterable<unknown>;
      };
      raw.broadcast = (m) => sent.push(m);
      raw.getConnections = () => [{ state: { sessionId: "sess-ended" }, close: vi.fn() }];
      const event = (seq: number, type: string) => ({
        conversationId: "ca",
        turnId: "turn1",
        taskId: "taskY",
        seq,
        type,
        payload: { stepId: "s1" },
      });
      // The first call rechecks the tabs (a D1 read); the second, inside the 30s window, doesn't.
      await Promise.all([
        instance.taskProgress(event(1, "step.started")),
        instance.taskProgress(event(2, "step.completed")),
      ]);
      const ours = sent.map((m) => JSON.parse(m)).filter((m) => m.taskId === "taskY");
      expect(ours.map((m) => m.seq)).toEqual([1, 2]);
    });
  });
});
