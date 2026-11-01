// SPDX-License-Identifier: Apache-2.0
// The TaskWorkflow driver (M3-12a): scope minted from the task row alone (AC9), the builtin
// loop driven step by step with budget over DO RPC (AC1, AC8), approval waits that trust D1
// and never the event payload (AC3), cancel stopping later steps, and a canary key that never
// reaches persisted state (AC4). One test also runs through the real Workflow engine binding.
// M3-17: a task's own budget, the hard cap and the tool-call rate pause it with Continue.
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import type { JsonValue, ModelEvent, ModelProvider, ModelRequest, TaskStepper } from "@opa/core";
import { createRepository, scopeFromSession } from "@opa/db/repository";
import type { LoopTool } from "@opa/harness-builtin";
import { beforeAll, describe, expect, it } from "vitest";
import { canaryForms } from "../../../scripts/canary-forms.mjs";
import type { Assistant } from "../src/assistant";
import { compose, type WorkerEnv } from "../src/compose";
import { executeTask, newTaskTurnState } from "../src/task-workflow";

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
const carol = repo.forUser(scopeFromSession({ userId: "carol" }));
const dave = repo.forUser(scopeFromSession({ userId: "dave" }));
const erin = repo.forUser(scopeFromSession({ userId: "erin" }));
const fred = repo.forUser(scopeFromSession({ userId: "fred" }));
/** The user's assistant over DO RPC, as the Workflow and the routes reach it. */
const rpc = (user: typeof alice) => user.assistant() as unknown as DurableObjectStub<Assistant>;

/** `outputTokens` is what the model reports, up to the call's `max_tokens`. */
type Reply = { text?: string; calls?: [name: string, args: unknown][]; outputTokens?: number };

/** A model that answers call n with replies[n], counting how often it really streamed. */
function scripted(replies: Reply[]) {
  let streams = 0;
  let ids = 0;
  const provider: ModelProvider = {
    id: "mock",
    listModels: async () => [],
    capabilities: () => ({ tools: true, usageInStream: true }),
    async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
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
        usage: {
          inputTokens: 10,
          outputTokens: Math.min(reply.outputTokens ?? 5, req.maxOutputTokens ?? 5),
          cachedInputTokens: 0,
          reasoningTokens: 0,
        },
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

/** A stepper whose engine dies right after the named step's body ran, before it is recorded. */
class CrashingStepper extends FakeStepper {
  #dead = false;
  constructor(
    private readonly crashAt: string,
    onWait: ((n: number) => Promise<JsonValue>)[] = [],
  ) {
    super(onWait);
  }
  override async do<T extends JsonValue>(
    name: string,
    config: unknown,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (this.#dead) throw new Error("the engine is down");
    if (name !== this.crashAt) return super.do(name, config, fn);
    await fn();
    this.#dead = true;
    throw new Error("the engine crashed mid-step");
  }
}

/** A stepper that retries a failed step body once, unless its config allows no retries. */
class RetryingStepper extends FakeStepper {
  override async do<T extends JsonValue>(
    name: string,
    config: unknown,
    fn: () => Promise<T>,
  ): Promise<T> {
    const once = (config as { retries?: { limit: number } } | undefined)?.retries?.limit === 0;
    return super.do(name, config, once ? fn : () => fn().catch(() => fn()));
  }
}

let seq = 0;
async function makeTask(
  user = alice,
  conversationId = "ca",
  kind = "turn",
  budgetMicroUsd?: number,
) {
  seq += 1;
  const taskId = `task${seq}`;
  const instanceId = `inst${seq}`;
  const state = {
    ...newTaskTurnState([{ role: "user", content: "hello" }], `turn${seq}`),
    ...(budgetMicroUsd ? { budgetMicroUsd } : {}),
  };
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
    "INSERT INTO users (id, display_name, role) VALUES ('alice', 'A', 'owner'), ('bob', 'B', 'member'), ('carol', 'C', 'member'), ('dave', 'D', 'member'), ('erin', 'E', 'member'), ('fred', 'F', 'member')",
  ).run();
  await alice.createConversation("ca", "Alice's");
  await bob.createConversation("cb", "Bob's");
  await carol.createConversation("cc", "Carol's");
  await dave.createConversation("cd", "Dave's");
  await erin.createConversation("ce", "Erin's");
  await fred.createConversation("cf", "Fred's");
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
    // The ledger rows name the task and its conversation, for the Usage breakdowns.
    const { byTask } = await alice.usage.breakdowns(0, 0);
    expect(byTask.map((t) => t.id)).toContain(taskId);
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
      // The second wake: the decision is in the batch's D1 rows (what the approvals route
      // writes), bound to this task.
      async () => {
        const row = await alice.tasks.get(taskId);
        // The early wake left it waiting, where a compromise signal looks for it (AC13).
        expect(row?.status).toBe("waiting_for_approval");
        const state = JSON.parse(row?.state ?? "{}");
        batchId = state.turn.pending.batchId as string;
        const approvalId = state.turn.pending.items[0].approvalId as string;
        const [stored] = await alice.approvals.batch(batchId);
        expect(stored).toMatchObject({ taskId, turnId: null, status: "pending" });
        const decision = { approvalId, decision: "approve", scope: "once", detail: {} } as const;
        await alice.approvals.decide(batchId, [decision], Date.now());
        return null;
      },
    ]);
    let batchId = "";
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
    // The claim and the call's end are on the row (M3-07 AC12).
    expect((await alice.approvals.batch(batchId))[0]?.status).toBe("executed");
  });

  it("never runs an approved call twice when a crash reruns its step (crypto review W3)", async () => {
    const { taskId, instanceId } = await makeTask();
    const send = tool("send", "consequential", async () => ({ ok: true, content: "sent" }));
    let batchId = "";
    const approve = async () => {
      const state = JSON.parse((await alice.tasks.get(taskId))?.state ?? "{}");
      batchId = state.turn.pending.batchId as string;
      const approvalId = state.turn.pending.items[0].approvalId as string;
      const decision = { approvalId, decision: "approve", scope: "once", detail: {} } as const;
      await alice.approvals.decide(batchId, [decision], Date.now());
      return null;
    };
    // The first run claims the approval, sends, and the engine dies before the step is recorded.
    const crashed = new CrashingStepper("tool:1", [approve]);
    const first = await run([{ calls: [["send", { q: "x" }]] }], instanceId, crashed, [send]);
    await first.promise.catch(() => {});
    expect(send.calls).toBe(1);
    expect((await alice.approvals.batch(batchId))[0]?.status).toBe("dispatched");
    // The engine replays the instance: every recorded step returns its record, and the tool
    // step's body runs a second time.
    const replay = new FakeStepper();
    for (const [name, value] of crashed.persisted) replay.persisted.set(name, value);
    const second = await run([{ text: "done" }], instanceId, replay, [send]);
    await second.promise;
    expect(send.calls).toBe(1); // not sent again
    const toolResult = JSON.stringify(JSON.parse((await alice.tasks.get(taskId))?.state ?? "{}"));
    expect(toolResult).toContain("its outcome is unknown");
    const [row] = await alice.approvals.batch(batchId);
    expect(row).toMatchObject({ status: "failed", reason: "outcome_unknown" });
    expect((await alice.tasks.get(taskId))?.status).toBe("succeeded");
  });

  it("retries an approved read whose first attempt failed", async () => {
    const { taskId, instanceId } = await makeTask();
    // An untrusted result first, so the egress read after it asks (floor_tainted_egress).
    const peek = tool("peek", "read", async () => ({ ok: true, content: "page" }));
    const untrusted = { ...peek, execute: async () => ({ ok: true, content: "page" }) };
    const fetch = tool("fetch", "read", async () => {
      if (fetch.calls === 1) throw new Error("connection reset");
      return { ok: true, content: "fetched" };
    });
    const egress = [{ id: "web", kind: "third_party" as const, dataEgress: true }];
    const fetchTool = { ...fetch, manifest: { ...fetch.manifest, destinations: egress } };
    fetchTool.execute = fetch.execute.bind(fetch);
    let batchId = "";
    const approve = async () => {
      const state = JSON.parse((await alice.tasks.get(taskId))?.state ?? "{}");
      batchId = state.turn.pending.batchId as string;
      const approvalId = state.turn.pending.items[0].approvalId as string;
      const decision = { approvalId, decision: "approve", scope: "once", detail: {} } as const;
      await alice.approvals.decide(batchId, [decision], Date.now());
      return null;
    };
    const stepper = new RetryingStepper([approve]);
    const replies: Reply[] = [
      { calls: [["peek", { q: "x" }]] },
      { calls: [["fetch", { q: "y" }]] },
      { text: "done" },
    ];
    const { promise } = await run(replies, instanceId, stepper, [untrusted, fetchTool]);
    await promise;
    expect(fetch.calls).toBe(2);
    const state = JSON.stringify(JSON.parse((await alice.tasks.get(taskId))?.state ?? "{}"));
    expect(state).toContain("fetched");
    expect(state).not.toContain("its outcome is unknown");
    expect((await alice.approvals.batch(batchId))[0]?.status).toBe("executed");
  });

  it("a task offering a third party's tool is tainted by its description (R7 §5.9)", async () => {
    const { taskId, instanceId } = await makeTask();
    // Never called: only its description, which a third party wrote, reaches the model.
    const lookup = tool("lookup", "read", async () => ({ ok: true, content: "x" }));
    const offered: LoopTool = { ...lookup, author: "third_party" };
    const fetch = tool("fetch", "read", async () => ({ ok: true, content: "fetched" }));
    const egress = [{ id: "web", kind: "third_party" as const, dataEgress: true }];
    const fetchTool = { ...fetch, manifest: { ...fetch.manifest, destinations: egress } };
    fetchTool.execute = fetch.execute.bind(fetch);
    let batchId = "";
    const approve = async () => {
      // The egress read asks (floor_tainted_egress) instead of running silently.
      expect(fetch.calls).toBe(0);
      const state = JSON.parse((await alice.tasks.get(taskId))?.state ?? "{}");
      expect(JSON.stringify(state.turn.taint)).toContain("lookup description");
      batchId = state.turn.pending.batchId as string;
      const approvalId = state.turn.pending.items[0].approvalId as string;
      const decision = { approvalId, decision: "approve", scope: "once", detail: {} } as const;
      await alice.approvals.decide(batchId, [decision], Date.now());
      return null;
    };
    const stepper = new FakeStepper([approve]);
    const replies: Reply[] = [{ calls: [["fetch", { q: "y" }]] }, { text: "done" }];
    const { promise } = await run(replies, instanceId, stepper, [offered, fetchTool]);
    await promise;
    expect(stepper.waits).toBe(1);
    expect(fetch.calls).toBe(1);
    expect((await alice.approvals.batch(batchId))[0]?.status).toBe("executed");
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

  it("a replay after the expiry takes the early wake's recorded branch, back to waiting", async () => {
    const { instanceId } = await makeTask();
    const send = tool("send", "consequential", async () => ({ ok: true, content: "sent" }));
    // An early wake (no decision yet) reads the batch as pending and goes back to waiting; the
    // engine dies as the next wake starts.
    const first = new CrashingStepper("task:load:2");
    const replies: Reply[] = [{ calls: [["send", { q: "x" }]] }, { text: "done" }];
    const crashed = await run(replies, instanceId, first, [send]);
    await crashed.promise.catch(() => {});
    expect(first.waits).toBe(2);
    // Replayed a day later, past the approval's expiry: the cached pending rows were read at
    // the early wake, so the replay must wait again there, not expire the batch.
    const replay = new FakeStepper();
    for (const [name, value] of first.persisted) replay.persisted.set(name, value);
    const day = 86_400_000;
    // Started as late, so the task's own run-time limit isn't what stops the replay.
    const start = replay.persisted.get("task:start") as { startedAt: number };
    replay.persisted.set("task:start", { ...start, startedAt: start.startedAt + day });
    const later = await run(replies, instanceId, replay, [send], { now: () => Date.now() + day });
    await later.promise.catch(() => {});
    expect(replay.waits).toBe(2);
    expect(send.calls).toBe(0);
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
    const row = await alice.tasks.get(taskId);
    expect(row?.status).toBe("budget_limited");
    // The run has ended, so Continue must not be offered for it.
    expect(JSON.parse(row?.state ?? "{}").paused).toMatchObject({ kind: "duration", final: true });
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

  it("records the limit kind while the pause waits, for the Tasks view's Paused label", async () => {
    // The pause step writes the kind to the row (the same kind the loop's end writes again),
    // so the Tasks view reads "Paused: limit" for the whole wait, not just after it.
    const { taskId, instanceId } = await makeTask();
    const fetch = tool("fetch", "read", async () => ({ ok: true, content: "page" }));
    const calls = [["fetch", { q: "x" }]] as [string, unknown][];
    const replies: Reply[] = Array.from({ length: 9 }, () => ({ calls }));
    let pausedKind: unknown;
    const stepper = new FakeStepper([
      async () => {
        pausedKind = (await alice.tasks.get(taskId))?.limitKind;
        return null;
      },
    ]);
    const { promise } = await run(replies, instanceId, stepper, [fetch]);
    await promise;
    expect(pausedKind).toBe("calls");
    const row = await alice.tasks.get(taskId);
    expect(row?.status).toBe("budget_limited");
    expect(row?.limitKind).toBe("calls");
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

describe("task limits (M3-17)", () => {
  const fetchTool = () => tool("fetch", "read", async () => ({ ok: true, content: "page" }));
  // Every reply calls a tool, so the loop keeps calling the model; each uses its whole max_tokens.
  const busy = (n: number): Reply[] =>
    Array.from({ length: n }, () => ({ calls: [["fetch", { q: "x" }]], outputTokens: 4096 }));

  it("stops a $0.10 task at its budget as budget-limited, then Continue raises it once (A-Co2)", async () => {
    const { taskId, instanceId } = await makeTask(alice, "ca", "turn", 100_000);
    let raisedTwice: boolean | undefined;
    const stepper = new FakeStepper([
      async () => {
        // Paused at the limit: what the Continue route does, then the wake-up.
        expect((await alice.tasks.get(taskId))?.status).toBe("budget_limited");
        const paused = JSON.parse((await alice.tasks.get(taskId))?.state ?? "{}").paused;
        expect(paused).toEqual({ kind: "task_budget", detail: "$0.10 task budget" });
        expect(await rpc(alice).raiseTask(taskId)).toBe(true);
        raisedTwice = await rpc(alice).raiseTask(taskId);
        expect(await alice.tasks.resume(taskId)).toBe(true);
        return null;
      },
    ]);
    const { promise, streams } = await run([...busy(3), { text: "done" }], instanceId, stepper, [
      fetchTool(),
    ]);
    await promise;
    expect(raisedTwice).toBe(false);
    expect(stepper.waits).toBe(1);
    // Three calls fit in $0.10 at gpt-4.1's price; the fourth ran after Continue.
    expect(streams()).toBe(4);
    expect((await alice.tasks.get(taskId))?.status).toBe("succeeded");
    // The budget was settled at the end.
    expect(await rpc(alice).taskBudget(taskId)).toBeNull();
  });

  it("a paused task that nobody continues stays budget-limited when its wait ends", async () => {
    const { taskId, instanceId } = await makeTask(alice, "ca", "turn", 100_000);
    const stepper = new FakeStepper(); // the wait times out
    const { promise, streams } = await run([...busy(5)], instanceId, stepper, [fetchTool()]);
    await promise;
    expect(streams()).toBe(3);
    expect((await alice.tasks.get(taskId))?.status).toBe("budget_limited");
  });

  it("pauses background tasks at the monthly hard cap, which only Continue or a new month lifts", async () => {
    // Dave has spent past a $0.01 hard cap this month (a chat call, charged in full).
    await rpc(dave).setSpending({ hardCapMicroUsd: 10_000 });
    await rpc(dave).reserveTaskCall("chat-call", "openai", "gpt-4.1", 2000, {});
    await rpc(dave).settleTaskCall("chat-call", "openai", "gpt-4.1", null);
    const { taskId, instanceId } = await makeTask(dave, "cd", "background");
    let pausedAs: unknown;
    // While it waits, the row says why; then the user presses Stop.
    const stepper = new FakeStepper([
      async () => {
        const row = await dave.tasks.get(taskId);
        pausedAs = [row?.status, JSON.parse(row?.state ?? "{}").paused?.kind];
        await dave.tasks.cancel(taskId);
        return null;
      },
    ]);
    const { promise, streams } = await run([{ text: "hi" }], instanceId, stepper);
    await promise;
    expect(streams()).toBe(0);
    expect(pausedAs).toEqual(["budget_limited", "monthly_hard"]);
    expect(stepper.waits).toBe(1);
    expect((await dave.tasks.get(taskId))?.status).toBe("cancelled");
    expect(await rpc(dave).taskBudget(taskId)).toBeNull(); // settled on the way out
  });

  it("a replay on a later day takes the path the paused run took", async () => {
    // Erin's day is spent: every call is refused at the daily cap.
    await rpc(erin).setSpending({ dailyCapMicroUsd: 10_000 });
    await rpc(erin).reserveTaskCall("chat", "openai", "gpt-4.1", 2000, {});
    await rpc(erin).settleTaskCall("chat", "openai", "gpt-4.1", null);
    const { taskId, instanceId } = await makeTask(erin, "ce", "background");
    const DAY = 86_400_000;
    let clock = Date.now();
    // The first pause's wait runs out past midnight, so the cap lifts on its own; the call is
    // refused again (the assistant's day hasn't turned), and during that pause the user stops it.
    const stepper = new FakeStepper([
      async () => {
        clock += DAY;
        return null;
      },
      async () => {
        await erin.tasks.cancel(taskId);
        return null;
      },
    ]);
    const first = await run([{ text: "hi" }], instanceId, stepper, [], { now: () => clock });
    await first.promise;
    expect(stepper.waits).toBe(2);
    const steps = [...stepper.persisted.keys()];
    expect(steps.filter((n) => n.startsWith("task:pause:"))).toHaveLength(2);
    expect((await erin.tasks.get(taskId))?.status).toBe("cancelled");
    // The engine replays the same instance two days later: every step comes back from storage,
    // so no new step runs and the run ends where it ended.
    clock += 2 * DAY;
    const replay = new FakeStepper();
    for (const [k, v] of stepper.persisted) replay.persisted.set(k, v);
    const again = await run([{ text: "hi" }], instanceId, replay, [], { now: () => clock });
    await again.promise;
    expect([...replay.persisted.keys()]).toEqual(steps);
    expect(again.streams()).toBe(0);
  });

  it("waits out a hard-cap pause longer than one wait, in turns, until the month turns", async () => {
    await rpc(fred).setSpending({ hardCapMicroUsd: 10_000 });
    await rpc(fred).reserveTaskCall("chat", "openai", "gpt-4.1", 2000, {});
    await rpc(fred).settleTaskCall("chat", "openai", "gpt-4.1", null);
    const { taskId, instanceId } = await makeTask(fred, "cf", "background");
    let clock = Date.UTC(2026, 10, 2); // paused on 2 November; the cap lifts on 1 December
    const week = async (n: number) => {
      clock += 7 * 86_400_000;
      if (n === 5) await rpc(fred).setSpending({ hardCapMicroUsd: null }); // so the retry runs
      return null;
    };
    const stepper = new FakeStepper([1, 2, 3, 4, 5].map((n) => () => week(n)));
    const { promise, streams } = await run([{ text: "done" }], instanceId, stepper, [], {
      now: () => clock,
    });
    await promise;
    // 9, 16, 23 and 30 November are still before the reset; 7 December is past it.
    expect(stepper.waits).toBe(5);
    expect(streams()).toBe(1);
    expect((await fred.tasks.get(taskId))?.status).toBe("succeeded");
  });

  it("runs an approved call even past the minute's tool limit", async () => {
    const { taskId, instanceId } = await makeTask(carol, "cc");
    const send = tool("send", "consequential", async () => ({ ok: true, content: "sent" }));
    let batchId = "";
    const approve = async () => {
      const state = JSON.parse((await carol.tasks.get(taskId))?.state ?? "{}");
      batchId = state.turn.pending.batchId as string;
      const approvalId = state.turn.pending.items[0].approvalId as string;
      const decision = { approvalId, decision: "approve", scope: "once", detail: {} } as const;
      await carol.approvals.decide(batchId, [decision], Date.now());
      // The minute fills up while the task waits for the decision.
      for (let i = 0; i < 60; i++) await rpc(carol).allowToolCall();
      return null;
    };
    const { promise } = await run(
      [{ calls: [["send", { q: "x" }]] }, { text: "done" }],
      instanceId,
      new FakeStepper([approve]),
      [send],
    );
    await promise;
    expect(send.calls).toBe(1);
    expect((await carol.approvals.batch(batchId))[0]?.status).toBe("executed");
    expect((await carol.tasks.get(taskId))?.status).toBe("succeeded");
  });

  it("refuses the 61st tool call in a minute without running it, as slow-down (COST-2)", async () => {
    for (let i = 0; i < 60; i++) await rpc(carol).allowToolCall();
    const fetch = fetchTool();
    const { taskId, instanceId } = await makeTask(carol, "cc");
    const { promise } = await run(
      [{ calls: [["fetch", { q: "x" }]] }, { text: "done" }],
      instanceId,
      new FakeStepper(),
      [fetch],
    );
    await promise;
    expect(fetch.calls).toBe(0);
    const row = await carol.tasks.get(taskId);
    expect(row?.status).toBe("budget_limited");
    const state = JSON.parse(row?.state ?? "{}");
    expect(state.paused).toMatchObject({ kind: "tool_rate" });
    expect(JSON.stringify(state.turn.messages)).toContain("too many tool calls");
  });
});
