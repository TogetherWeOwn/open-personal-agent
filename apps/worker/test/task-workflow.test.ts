// SPDX-License-Identifier: Apache-2.0
// The TaskWorkflow driver (M3-12a): scope minted from the task row alone (AC9), the builtin
// loop driven step by step with budget over DO RPC (AC1, AC8), approval waits that trust D1
// and never the event payload (AC3), cancel stopping later steps, and a canary key that never
// reaches persisted state (AC4). One test also runs through the real Workflow engine binding.
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import type { JsonValue, ModelEvent, ModelProvider, ModelRequest, TaskStepper } from "@opa/core";
import { createRepository, scopeFromSession } from "@opa/db/repository";
import { type LoopTool, resolveApprovals } from "@opa/harness-builtin";
import { beforeAll, describe, expect, it } from "vitest";
import { canaryForms } from "../../../scripts/canary-forms.mjs";
import { compose, type WorkerEnv } from "../src/compose";
import { executeTask, needsPostFinishProgress, newTaskTurnState } from "../src/task-workflow";

const env = workerEnv as unknown as WorkerEnv & {
  TEST_MIGRATIONS: D1Migration[];
  OPA_CANARY: string;
  TASK_WORKFLOW: Workflow;
};
const canary = env.OPA_CANARY;
const forms = canaryForms(canary);
const leaks = (text: string) => forms.some((f) => text.includes(f));
const repo = createRepository(env);
const alice = repo.forUser(scopeFromSession({ userId: "alice" }));
const bob = repo.forUser(scopeFromSession({ userId: "bob" }));

type Reply = { text?: string; calls?: [name: string, args: unknown][] };

/** A model that answers call n with replies[n], counting how often it really streamed. */
function scripted(replies: Reply[]) {
  let streams = 0;
  let ids = 0;
  const provider: ModelProvider = {
    id: "mock",
    listModels: async () => [],
    capabilities: () => ({ tools: true, usageInStream: true }),
    async *stream(_req: ModelRequest): AsyncIterable<ModelEvent> {
      streams += 1;
      const reply = replies[streams - 1] ?? { text: "done" };
      if (reply.text) yield { type: "text.delta", text: reply.text };
      for (const [name, args] of reply.calls ?? []) {
        yield {
          type: "tool_call",
          toolCall: { id: `call_${++ids}`, name, arguments: JSON.stringify(args) },
        };
      }
      yield {
        type: "usage",
        usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, reasoningTokens: 0 },
      };
      yield { type: "done", finishReason: reply.calls ? "tool_calls" : "stop" };
    },
  };
  return { provider, streams: () => streams };
}

const tool = (
  name: string,
  riskClass: LoopTool["manifest"]["riskClass"],
  run: () => Promise<{ ok: boolean; content: string }>,
): LoopTool & { calls: number } => {
  const t = {
    calls: 0,
    manifest: {
      name,
      description: `The ${name} tool.`,
      inputSchema: {
        type: "object" as const,
        properties: { q: { type: "string", minLength: 1 } },
        required: ["q"],
        additionalProperties: false,
      },
      riskClass,
      destinations: [],
      scopes: [],
    },
    async execute() {
      t.calls += 1;
      return { ...(await run()), context: { kind: "system" as const } };
    },
  };
  return t;
};

/** A stepper that persists step outputs, and runs scripted side effects on each wait. */
class FakeStepper implements TaskStepper {
  readonly persisted = new Map<string, JsonValue>();
  readonly configs = new Map<string, unknown>();
  waits = 0;
  constructor(private readonly onWait: ((n: number) => Promise<JsonValue>)[] = []) {}
  async do<T extends JsonValue>(name: string, config: unknown, fn: () => Promise<T>): Promise<T> {
    this.configs.set(name, config);
    const hit = this.persisted.get(name);
    if (hit !== undefined) return hit as T;
    const value = await fn();
    this.persisted.set(name, JSON.parse(JSON.stringify(value)) as JsonValue);
    return value;
  }
  async sleep(): Promise<void> {}
  async waitForEvent<T extends JsonValue>(): Promise<{ payload: T }> {
    this.waits += 1;
    const effect = this.onWait[this.waits - 1];
    return { payload: ((await effect?.(this.waits)) ?? null) as T };
  }
  persistedText(): string {
    return JSON.stringify([...this.persisted.values()]);
  }
}

let seq = 0;
async function makeTask(user = alice, conversationId = "ca", kind = "turn") {
  seq += 1;
  const taskId = `task${seq}`;
  const instanceId = `inst${seq}`;
  const state = newTaskTurnState([{ role: "user", content: "hello" }], `turn${seq}`);
  await user.tasks.create({
    id: taskId,
    conversationId,
    workflowInstanceId: instanceId,
    kind,
    mode: "background",
    state: JSON.stringify(state),
  });
  return { taskId, instanceId };
}

/** Runs one instance with a scripted model whose key is the canary. */
async function run(
  replies: Reply[],
  instanceId: string,
  stepper: FakeStepper,
  tools: LoopTool[] = [],
  over: { used?: () => Promise<void>; now?: () => number; picks?: unknown[] } = {},
) {
  const { provider, streams } = scripted(replies);
  const resolved = {
    provider,
    model: "gpt-4.1",
    apiKey: canary,
    billingId: "openai",
    ...(over.used ? { used: over.used } : {}),
  };
  const promise = executeTask(
    env,
    await compose(env),
    {
      resolveModel: async (_env, _scope, _caller, pick) => {
        over.picks?.push(pick);
        return resolved;
      },
      taskTools: tools,
    },
    instanceId,
    stepper,
    over.now,
  );
  return { promise, streams };
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare(
    "INSERT INTO users (id, display_name, role) VALUES ('alice', 'A', 'owner'), ('bob', 'B', 'member')",
  ).run();
  await alice.createConversation("ca", "Alice's");
  await bob.createConversation("cb", "Bob's");
});

describe("task workflow", () => {
  it("runs a turn on its conversation's model and other work on the Background role", async () => {
    const picks: unknown[] = [];
    for (const kind of ["turn", "background"]) {
      const { instanceId } = await makeTask(alice, "ca", kind);
      const { promise } = await run([{ text: "ok" }], instanceId, new FakeStepper(), [], { picks });
      await promise;
    }
    expect(picks).toEqual([{ conversationId: "ca" }, { role: "background" }]);
  });

  it("runs a turn to succeeded, with the key nowhere in persisted state", async () => {
    const { taskId, instanceId } = await makeTask();
    const stepper = new FakeStepper();
    const { promise, streams } = await run([{ text: `all done ${canary}` }], instanceId, stepper);
    await promise;
    const row = await alice.tasks.get(taskId);
    expect(row?.status).toBe("succeeded");
    expect(streams()).toBe(1);
    expect(leaks(stepper.persistedText())).toBe(false);
    expect(leaks(row?.state ?? "")).toBe(false);
    expect(JSON.parse(row?.state ?? "{}").turn.messages.at(-1).content).toContain("all done");
    const totals = await alice.usage.totals(0);
    expect(totals.reduce((s, t) => s + t.calls, 0)).toBeGreaterThan(0);
  });

  it("takes identity from the instance's row alone, touching no other user's task", async () => {
    const mine = await makeTask(alice, "ca");
    const theirs = await makeTask(bob, "cb");
    // executeTask receives no params at all; the entrypoint passes only the instanceId.
    const { promise } = await run([{ text: "hi" }], mine.instanceId, new FakeStepper());
    await promise;
    expect((await alice.tasks.get(mine.taskId))?.status).toBe("succeeded");
    expect((await bob.tasks.get(theirs.taskId))?.status).toBe("queued");
  });

  it("refuses an instance no task row names", async () => {
    const { promise } = await run([], "inst-unknown", new FakeStepper());
    await expect(promise).rejects.toThrow(/no task row/);
  });

  it("a task cancelled before it starts never calls the model", async () => {
    const { taskId, instanceId } = await makeTask();
    await alice.tasks.cancel(taskId);
    const { promise, streams } = await run([{ text: "hi" }], instanceId, new FakeStepper());
    await promise;
    expect(streams()).toBe(0);
    expect((await alice.tasks.get(taskId))?.status).toBe("cancelled");
  });

  it("a cancel mid-run stops every later step and is never overwritten", async () => {
    const { taskId, instanceId } = await makeTask();
    const canceller = tool("fetch", "read", async () => {
      await alice.tasks.cancel(taskId);
      return { ok: true, content: "page" };
    });
    const { promise, streams } = await run(
      [{ calls: [["fetch", { q: "x" }]] }, { text: "more" }],
      instanceId,
      new FakeStepper(),
      [canceller],
    );
    await promise;
    expect(canceller.calls).toBe(1); // the in-flight step finished
    expect(streams()).toBe(1); // the next model call never started
    expect((await alice.tasks.get(taskId))?.status).toBe("cancelled");
  });

  it("waits for approval, ignores the event payload and re-reads the decision from D1", async () => {
    const { taskId, instanceId } = await makeTask();
    let statusWhenSent: string | undefined;
    const send = tool("send", "consequential", async () => {
      statusWhenSent = (await alice.tasks.get(taskId))?.status;
      return { ok: true, content: "sent" };
    });
    const stepper = new FakeStepper([
      // A payload that claims approval while D1 still says pending: nothing may run from it.
      async () => ({ decision: "approve", scope: "once" }) as JsonValue,
      // The second wake: the decision has been written to D1 (what M3-07's route will do).
      async () => {
        const row = await alice.tasks.get(taskId);
        const state = JSON.parse(row?.state ?? "{}");
        const batchId = state.turn.pending.batchId as string;
        const approvalId = state.turn.pending.items[0].approvalId as string;
        resolveApprovals(
          state.turn,
          batchId,
          [{ approvalId, decision: "approve", scope: "once" }],
          Date.now(),
        );
        await alice.tasks.saveState(taskId, JSON.stringify(state));
        return null;
      },
    ]);
    const { promise, streams } = await run(
      [{ calls: [["send", { q: "x" }]] }, { text: "done" }],
      instanceId,
      stepper,
      [send],
    );
    await promise;
    expect(stepper.waits).toBe(2); // the lying payload sent it back to waiting
    expect(send.calls).toBe(1); // the gated tool ran once, after the D1 decision
    expect(statusWhenSent).toBe("running"); // back from waiting_for_approval once it resumed
    // A write that acted must not act again on a retry; only reads retry.
    const toolStep = [...stepper.configs.entries()].find(([n]) => n.startsWith("tool:"));
    expect(toolStep?.[1]).toMatchObject({ retries: { limit: 0 } });
    expect(streams()).toBe(2);
    expect((await alice.tasks.get(taskId))?.status).toBe("succeeded");
  });

  it("bookkeeping that fails after the hold never repeats the model call", async () => {
    const { taskId, instanceId } = await makeTask();
    const { promise, streams } = await run([{ text: "hi" }], instanceId, new FakeStepper(), [], {
      used: async () => {
        throw new Error("D1 hiccup");
      },
    });
    await promise;
    expect(streams()).toBe(1);
    expect((await alice.tasks.get(taskId))?.status).toBe("succeeded");
  });

  it("a task that runs out of time mid-turn ends budget-limited, not failed", async () => {
    const { taskId, instanceId } = await makeTask();
    let skew = 0;
    const slow = tool("fetch", "read", async () => {
      skew = 7 * 3_600_000; // the background limit is 6 h
      return { ok: true, content: "page" };
    });
    const { promise, streams } = await run(
      [{ calls: [["fetch", { q: "x" }]] }, { text: "more" }],
      instanceId,
      new FakeStepper(),
      [slow],
      { now: () => Date.now() + skew },
    );
    await promise;
    expect(streams()).toBe(1); // the next model step's guard stopped it
    expect((await alice.tasks.get(taskId))?.status).toBe("budget_limited");
  });

  it("records the duration kind when time runs out, for the Tasks view's Paused label", async () => {
    const { taskId, instanceId } = await makeTask();
    let skew = 0;
    const slow = tool("fetch", "read", async () => {
      skew = 7 * 3_600_000; // the background limit is 6 h
      return { ok: true, content: "page" };
    });
    const { promise } = await run(
      [{ calls: [["fetch", { q: "x" }]] }, { text: "more" }],
      instanceId,
      new FakeStepper(),
      [slow],
      { now: () => Date.now() + skew },
    );
    await promise;
    const row = await alice.tasks.get(taskId);
    expect(row?.status).toBe("budget_limited");
    expect(row?.limitKind).toBe("duration");
  });

  it("only the daily-cap stop needs a post-finish progress event", () => {
    // A loop-emitted limit was already forwarded while draining the loop; emitting it again
    // would notify every tab twice. Only the daily-cap stop originates post-finish.
    expect(needsPostFinishProgress(undefined)).toBe(false);
    expect(needsPostFinishProgress({ kind: "calls", detail: "8 calls" })).toBe(false);
    expect(needsPostFinishProgress({ kind: "steps", detail: "too many steps" })).toBe(false);
    expect(needsPostFinishProgress({ kind: "daily", detail: "daily spend cap" })).toBe(true);
  });

  it("records the loop's kind when the turn exhausts its model calls", async () => {
    const { taskId, instanceId } = await makeTask();
    const fetch = tool("fetch", "read", async () => ({ ok: true, content: "page" }));
    const calls = [["fetch", { q: "x" }]] as [string, unknown][];
    const replies: Reply[] = Array.from({ length: 9 }, () => ({ calls }));
    const { promise, streams } = await run(replies, instanceId, new FakeStepper(), [fetch]);
    await promise;
    expect(streams()).toBe(8); // the ninth call never started
    const row = await alice.tasks.get(taskId);
    expect(row?.status).toBe("budget_limited");
    expect(row?.limitKind).toBe("calls");
  });

  it("runs through the real Workflow binding", async () => {
    seq += 1;
    const taskId = `task${seq}`;
    const instanceId = `inst-engine-${seq}`;
    await alice.tasks.create({
      id: taskId,
      conversationId: "ca",
      workflowInstanceId: instanceId,
      kind: "turn",
      mode: "background",
      state: "not json", // fails before any model is needed
    });
    await env.TASK_WORKFLOW.create({ id: instanceId, params: { taskId } });
    const deadline = Date.now() + 10_000;
    let status: string | undefined;
    while (Date.now() < deadline && status !== "failed") {
      status = (await alice.tasks.get(taskId))?.status;
      if (status !== "failed") await new Promise((r) => setTimeout(r, 100));
    }
    expect(status).toBe("failed");
  });
});
