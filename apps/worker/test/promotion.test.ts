// SPDX-License-Identifier: Apache-2.0
// Promotion (M3-12b AC2): a turn that runs past about 2 minutes, or whose tool asks to, moves to a
// TaskWorkflow at a step boundary. The task runs on from the turn's own state, writes the same
// reply and settles it, and the conversation sees `task.promoted` and then the turn's end. An
// approval never promotes; a turn that can't move goes on in the DO; an eviction mid-promotion
// hands the turn to its task rather than interrupting it.
import { runInDurableObject } from "cloudflare:test";
import type { HarnessEvent, JsonValue, ModelEvent, ModelProvider, TaskStepper } from "@opa/core";
import { createRepository, scopeFromSession } from "@opa/db/repository";
import type { LoopTool, Promotion } from "@opa/harness-builtin";
import { ToolRegistry } from "@opa/policy";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Assistant } from "../src/assistant";
import { compose, type WorkerEnv } from "../src/compose";
import { executeTask } from "../src/task-workflow";
import { workerApp } from "../src/worker-app";
import {
  type Browser,
  claim,
  count,
  db,
  env,
  freshDatabase,
  ORIGIN,
  SOCKET_WAIT,
} from "./helpers/app";

freshDatabase();
afterEach(() => vi.restoreAllMocks());

const USAGE = { inputTokens: 12, outputTokens: 3, cachedInputTokens: 0, reasoningTokens: 0 };
type Reply = { text?: string; calls?: [name: string, args: unknown][] };

/** A model that answers each call with the next reply after `ms`, counting its calls. */
function replying(replies: Reply[], ms = 0) {
  const prefix = crypto.randomUUID().slice(0, 8); // call IDs unique across models, as upstream
  let ids = 0;
  let at = 0;
  const provider: ModelProvider = {
    id: "scripted",
    listModels: async () => [],
    capabilities: () => ({ tools: true, usageInStream: true }),
    async *stream(): AsyncGenerator<ModelEvent> {
      const reply = replies[Math.min(at++, replies.length - 1)] ?? { text: "done" };
      if (ms) await new Promise((r) => setTimeout(r, ms));
      if (reply.text) yield { type: "text.delta", text: reply.text };
      for (const [name, args] of reply.calls ?? []) {
        yield {
          type: "tool_call",
          toolCall: { id: `call_${prefix}_${++ids}`, name, arguments: JSON.stringify(args) },
        };
      }
      yield { type: "usage", usage: USAGE };
      yield { type: "done", finishReason: reply.calls ? "tool_calls" : "stop" };
    },
  };
  return { provider, calls: () => at };
}

/** A tool that takes `ms`, then returns, asking to run on as a task when given `promote`. */
function slowTool(name: string, ms: number, promote?: Promotion): LoopTool {
  return {
    manifest: {
      name,
      description: `The ${name} tool.`,
      inputSchema: {
        type: "object",
        properties: { q: { type: "string", minLength: 1 } },
        required: ["q"],
        additionalProperties: false,
      },
      riskClass: promote ? "write_reversible" : "read",
      destinations: [],
      scopes: [],
    },
    execute: async () => {
      await new Promise((r) => setTimeout(r, ms));
      const out = { ok: true, content: `${name} ok`, context: { kind: "system" as const } };
      return promote ? { ...out, promote } : out;
    },
  };
}

const assistantOf = (userId: string) => env.ASSISTANT.get(env.ASSISTANT.idFromName(`u:${userId}`));

/** The instances the DO asks for, kept instead of run, so the test runs each one itself. */
type Created = { id: string; params: { taskId: string } };
async function setUp(
  userId: string,
  provider: ModelProvider,
  tools: LoopTool[],
  over: { promoteAfterMs?: number; failCreate?: boolean } = {},
) {
  const created: Created[] = [];
  await runInDurableObject(assistantOf(userId), (i: Assistant) => {
    i.resolveModel = async () => ({ provider, model: "test-model", apiKey: null });
    i.resolveTools = () => {
      const registry = new ToolRegistry<LoopTool>();
      for (const t of tools) registry.register(t);
      return { tools: registry, policy: () => ({}) };
    };
    i.promoteAfterMs = over.promoteAfterMs ?? 60_000;
    i.taskWorkflows = () =>
      ({
        create: async (options: Created) => {
          if (over.failCreate) throw new Error("no Workflows here");
          created.push(options);
        },
        get: async () => {
          throw new Error("no such instance");
        },
      }) as unknown as Pick<Workflow, "create" | "get">;
  });
  return created;
}

/** A stepper that records step outputs, as the engine would, and never waits. */
class Stepper implements TaskStepper {
  readonly persisted = new Map<string, JsonValue>();
  async do<T extends JsonValue>(name: string, _config: unknown, fn: () => Promise<T>) {
    const hit = this.persisted.get(name);
    if (hit !== undefined) return hit as T;
    const value = await fn();
    this.persisted.set(name, JSON.parse(JSON.stringify(value)) as JsonValue);
    return value;
  }
  async sleep() {}
  async waitForEvent<T extends JsonValue>(): Promise<{ payload: T }> {
    return { payload: null as T };
  }
}

/** Runs a promoted turn's instance through the real driver, on a scripted model. */
async function runTask(instanceId: string, provider: ModelProvider, stepper = new Stepper()) {
  const raw = env as unknown as WorkerEnv;
  await executeTask(
    raw,
    await compose(raw),
    {
      resolveModel: async () => ({ provider, model: "test-model", apiKey: null }),
      taskTools: [],
    },
    instanceId,
    stepper,
  );
  return stepper;
}

async function openTab(br: Browser) {
  const cookie = [...br.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await workerApp.request(
    `${ORIGIN}/api/chat`,
    { headers: { upgrade: "websocket", origin: ORIGIN, cookie } },
    br.bindings,
  );
  const ws = res.webSocket;
  if (!ws) throw new Error(`no socket: ${res.status}`);
  ws.accept();
  const events: HarnessEvent[] = [];
  ws.addEventListener("message", (e) => events.push(JSON.parse(e.data as string)));
  const until = (type: HarnessEvent["type"], n = 1) =>
    vi.waitFor(
      () => expect(events.filter((e) => e.type === type).length).toBeGreaterThanOrEqual(n),
      SOCKET_WAIT,
    );
  const send = (conversationId: string, text: string) =>
    ws.send(JSON.stringify({ type: "chat.send", conversationId, text }));
  return { events, until, send };
}

const stored = async (br: Browser, id: string) =>
  (
    await (
      await br.req(`/api/conversations/${id}/messages`)
    ).json<{ messages: { content: string; status: string }[] }>()
  ).messages;

const taskRow = (id: string) =>
  db
    .prepare(
      "SELECT status, kind, mode, title, workflow_instance_id, state FROM tasks WHERE id = ?",
    )
    .bind(id)
    .first<{
      status: string;
      kind: string;
      mode: string;
      title: string | null;
      workflow_instance_id: string;
      state: string;
    }>();

const promotedId = (events: HarnessEvent[]) => {
  const e = events.find((x) => x.type === "task.promoted");
  if (e?.type !== "task.promoted") throw new Error("no task.promoted");
  return e.payload.taskId;
};

describe("promotion at a step boundary (M3-12 AC2)", () => {
  it("moves a turn past its time to a task, which writes and settles the same reply", async () => {
    const { browser, owner } = await claim();
    const model = replying([
      { text: "Checking.", calls: [["slow", { q: "x" }]] },
      { text: "All done" },
    ]);
    const created = await setUp(owner, model.provider, [slowTool("slow", 60)], {
      promoteAfterMs: 30,
    });
    const tab = await openTab(browser);
    tab.send("conv-long", "Dig into it");
    await tab.until("task.promoted");
    const taskId = promotedId(tab.events);
    // The boundary came after the tool's step: the model was called once, here.
    expect(model.calls()).toBe(1);
    const promoted = tab.events.find((e) => e.type === "task.promoted");
    const started = tab.events.find((e) => e.type === "turn.started");
    expect(promoted?.turnId).toBe(started?.turnId);
    expect(tab.events.map((e) => e.type)).not.toContain("turn.completed");

    const row = await taskRow(taskId);
    expect(row).toMatchObject({ status: "queued", kind: "turn", mode: "interactive" });
    expect(created).toEqual([{ id: row?.workflow_instance_id, params: { taskId } }]);
    const state = JSON.parse(row?.state ?? "{}");
    expect(state.turnId).toBe(started?.turnId);
    expect(state.replyId).toBe(started?.type === "turn.started" && started.payload.messageId);
    expect(state.turn.messages.map((m: { role: string }) => m.role)).toEqual(["assistant", "tool"]);
    // The reply waits for the task, as far as the DO wrote it.
    expect((await stored(browser, "conv-long")).at(-1)).toMatchObject({
      content: "Checking.",
      status: "streaming",
    });

    // The chat is the task's until it ends: a second send is refused, not interleaved.
    tab.send("conv-long", "And another thing");
    await vi.waitFor(
      () => expect(tab.events.some((e) => e.type === "turn.failed" && e.seq === 0)).toBe(true),
      SOCKET_WAIT,
    );

    const task = replying([{ text: "All done" }]);
    await runTask(row?.workflow_instance_id ?? "", task.provider);
    expect((await taskRow(taskId))?.status).toBe("succeeded");
    expect((await stored(browser, "conv-long")).at(-1)).toMatchObject({
      content: "Checking.\n\nAll done",
      status: "complete",
    });
    // Both calls are on the reply's ledger: the DO's, then the task's.
    expect(await count("usage", "conversation_id = 'conv-long'")).toBe(2);
    await tab.until("turn.completed");
    // The task's end frees the chat for the next send.
    tab.send("conv-long", "Thanks");
    await tab.until("turn.completed", 2);
  });

  it("promotes when a tool asks, as background work under its title", async () => {
    const { browser, owner } = await claim();
    const model = replying([{ calls: [["task", { q: "report" }]] }, { text: "Filed" }]);
    await setUp(owner, model.provider, [
      slowTool("task", 0, { mode: "background", title: "Weekly report" }),
    ]);
    const tab = await openTab(browser);
    tab.send("conv-task", "Do the report in the background");
    await tab.until("task.promoted");
    expect(await taskRow(promotedId(tab.events))).toMatchObject({
      mode: "background",
      title: "Weekly report",
    });
    // The task's state doesn't ask again: it is a task already.
    expect(
      JSON.parse((await taskRow(promotedId(tab.events)))?.state ?? "{}").turn,
    ).not.toHaveProperty("promotion");
  });

  it("never promotes at an approval: the turn stops in D1 as before", async () => {
    const { browser, owner } = await claim();
    const send = slowTool("send", 60);
    send.manifest.riskClass = "consequential";
    // The turn is past its time by the end of the model's call, and stops at the approval then.
    const model = replying([{ calls: [["send", { q: "hi" }]] }], 60);
    const created = await setUp(owner, model.provider, [send], { promoteAfterMs: 20 });
    const tab = await openTab(browser);
    tab.send("conv-appr", "Send it");
    await tab.until("approval.requested");
    expect(tab.events.map((e) => e.type)).not.toContain("task.promoted");
    expect(created).toEqual([]);
    expect(await count("tasks")).toBe(0);
  });

  it("goes on in the DO when the task can't start, and doesn't try again", async () => {
    const { browser, owner } = await claim();
    const model = replying([
      { text: "One.", calls: [["slow", { q: "x" }]] },
      { text: "Two.", calls: [["slow", { q: "y" }]] },
      { text: "Done" },
    ]);
    await setUp(owner, model.provider, [slowTool("slow", 40)], {
      promoteAfterMs: 20,
      failCreate: true,
    });
    const tab = await openTab(browser);
    tab.send("conv-stay", "Go");
    await tab.until("turn.completed");
    expect(tab.events.map((e) => e.type)).not.toContain("task.promoted");
    expect(model.calls()).toBe(3);
    // The one row it wrote ended failed; no run will pick it up.
    const rows = await db.prepare("SELECT status FROM tasks").all<{ status: string }>();
    expect(rows.results).toEqual([{ status: "failed" }]);
    expect((await stored(browser, "conv-stay")).at(-1)).toMatchObject({
      content: "One.\n\nTwo.\n\nDone",
      status: "complete",
    });
  });
});

describe("an eviction mid-promotion", () => {
  const checkpoint = (owner: string, turnId: string, replyId: string, taskId: string) => ({
    name: "chat-turn",
    snapshot: {
      conversationId: "conv-mid",
      turnId,
      replyId,
      providerId: "scripted",
      model: "test-model",
      reply: "Half",
      wrote: true,
      holds: [],
      callStarted: true,
      callRecorded: true,
      callUsage: null,
      promoting: { taskId, instanceId: `task-${taskId}` },
      owner,
    },
  });

  it("hands the turn to its task once the row exists, starting the instance", async () => {
    const { browser, owner } = await claim();
    const created = await setUp(owner, replying([{ text: "x" }]).provider, []);
    const user = createRepository(env).forUser(scopeFromSession({ userId: owner }));
    await user.chat.open("conv-mid", "Mid", undefined);
    await user.chat.startTurn("conv-mid", "Go", "reply-mid", []);
    const taskId = crypto.randomUUID();
    await user.tasks.create({
      id: taskId,
      conversationId: "conv-mid",
      workflowInstanceId: `task-${taskId}`,
      kind: "turn",
      mode: "interactive",
      state: "{}",
    });
    await runInDurableObject(assistantOf(owner), (i: Assistant) =>
      i.onFiberRecovered(checkpoint(owner, "turn-mid", "reply-mid", taskId) as never),
    );
    expect(created).toEqual([{ id: `task-${taskId}`, params: { taskId } }]);
    expect((await stored(browser, "conv-mid")).at(-1)?.status).toBe("streaming");
  });

  it("interrupts the turn as usual when no task row was written", async () => {
    const { browser, owner } = await claim();
    const created = await setUp(owner, replying([{ text: "x" }]).provider, []);
    const user = createRepository(env).forUser(scopeFromSession({ userId: owner }));
    await user.chat.open("conv-mid", "Mid", undefined);
    await user.chat.startTurn("conv-mid", "Go", "reply-mid2", []);
    await runInDurableObject(assistantOf(owner), (i: Assistant) =>
      i.onFiberRecovered(
        checkpoint(owner, "turn-mid2", "reply-mid2", crypto.randomUUID()) as never,
      ),
    );
    expect(created).toEqual([]);
    expect((await stored(browser, "conv-mid")).at(-1)).toMatchObject({
      content: "Half",
      status: "interrupted",
    });
  });
});

describe("a promoted turn's end", () => {
  /** Promotes a turn through its tool, returning the task and the tab watching it. */
  async function promote(convId: string) {
    const { browser, owner } = await claim();
    const model = replying([{ text: "Started.", calls: [["task", { q: "x" }]] }]);
    const created = await setUp(owner, model.provider, [
      slowTool("task", 0, { mode: "background" }),
    ]);
    const tab = await openTab(browser);
    tab.send(convId, "Go");
    await tab.until("task.promoted");
    const taskId = promotedId(tab.events);
    const user = createRepository(env).forUser(scopeFromSession({ userId: owner }));
    return { browser, tab, taskId, user, instanceId: created[0]?.id ?? "" };
  }

  it("cuts the reply and ends the turn when the task is cancelled before it runs", async () => {
    const { browser, tab, taskId, user, instanceId } = await promote("conv-cancel");
    expect(await user.tasks.cancel(taskId)).toBe(true);
    const model = replying([{ text: "never" }]);
    await runTask(instanceId, model.provider);
    expect(model.calls()).toBe(0);
    expect((await stored(browser, "conv-cancel")).at(-1)).toMatchObject({
      content: "Started.",
      status: "interrupted",
    });
    await tab.until("turn.cancelled");
  });

  it("settles the reply as failed and says why when the model call fails", async () => {
    const { browser, tab, instanceId } = await promote("conv-fail");
    const failing: ModelProvider = {
      ...replying([]).provider,
      // biome-ignore lint/correctness/useYield: a model that fails before it says anything
      async *stream(): AsyncGenerator<ModelEvent> {
        throw new Error("upstream down");
      },
    };
    await runTask(instanceId, failing);
    expect((await stored(browser, "conv-fail")).at(-1)).toMatchObject({
      content: "Started.",
      status: "error",
    });
    await tab.until("turn.failed");
  });
});

describe("a promoted turn's progress and persistence (M3-12 AC5, AC8; §17 Persistence)", () => {
  /** A tab that reconnects mid-turn and asks for what it missed after `afterSeq`. */
  async function resumeTab(br: Browser, conversationId: string, turnId: string, afterSeq: number) {
    const cookie = [...br.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await workerApp.request(
      `${ORIGIN}/api/chat?resume=1`,
      { headers: { upgrade: "websocket", origin: ORIGIN, cookie } },
      br.bindings,
    );
    const ws = res.webSocket;
    if (!ws) throw new Error(`no socket: ${res.status}`);
    ws.accept();
    const events: HarnessEvent[] = [];
    ws.addEventListener("message", (e) => events.push(JSON.parse(e.data as string)));
    ws.send(JSON.stringify({ type: "resume", conversationId, turnId, afterSeq }));
    return events;
  }

  /**
   * A stepper whose engine goes away right after the named step ran, before it was recorded: the
   * run never hears back, as a process replaced by a deploy doesn't.
   */
  class Redeployed extends Stepper {
    constructor(private readonly dieAt: string) {
      super();
    }
    gone = false;
    override async do<T extends JsonValue>(name: string, config: unknown, fn: () => Promise<T>) {
      if (this.gone) return new Promise<T>(() => {});
      if (name !== this.dieAt) return super.do(name, config, fn);
      await fn();
      this.gone = true;
      return new Promise<T>(() => {});
    }
    /** The engine after the redeploy: the same recorded steps, run on from there. */
    next(): Stepper {
      const fresh = new Stepper();
      for (const [k, v] of this.persisted) fresh.persisted.set(k, v);
      return fresh;
    }
  }

  it("logs the task's events in the turn under the conversation's seq, once each", async () => {
    const { browser, owner } = await claim();
    const model = replying([{ text: "Started.", calls: [["task", { q: "x" }]] }]);
    const created = await setUp(owner, model.provider, [
      slowTool("task", 0, { mode: "background" }),
    ]);
    const tab = await openTab(browser);
    tab.send("conv-log", "Go");
    await tab.until("task.promoted");
    const promoted = tab.events.find((e) => e.type === "task.promoted");
    if (!promoted) throw new Error("no task.promoted");
    const instanceId = created[0]?.id ?? "";

    // The task runs, and runs again from its record, as a Workflow replay does.
    const task = replying([{ text: "Finished" }]);
    const stepper = await runTask(instanceId, task.provider);
    await tab.until("turn.completed");
    await runTask(instanceId, task.provider, stepper).catch(() => {});
    const later = tab.events.filter((e) => e.seq > promoted.seq);
    // Numbered on from the DO's own events, gapless, with no frame twice.
    expect(later.map((e) => e.seq)).toEqual(later.map((_, i) => promoted.seq + 1 + i));
    expect(later.every((e) => e.turnId === promoted.turnId && !("taskId" in e))).toBe(true);
    expect(later.filter((e) => e.type === "message.delta")).toHaveLength(1);
    expect(later.at(-1)?.type).toBe("turn.completed");
    // Once the turn has ended it is D1's, and its frames have left the log.
    const replayed = await resumeTab(browser, "conv-log", promoted.turnId, 0);
    await new Promise((r) => setTimeout(r, 200));
    expect(replayed).toEqual([]);
  });

  it("replays a running task's events to a tab that reconnects", async () => {
    const { browser, owner } = await claim();
    const model = replying([{ text: "Started.", calls: [["task", { q: "x" }]] }]);
    const created = await setUp(owner, model.provider, [
      slowTool("task", 0, { mode: "background" }),
    ]);
    const tab = await openTab(browser);
    tab.send("conv-replay", "Go");
    await tab.until("task.promoted");
    const promoted = tab.events.find((e) => e.type === "task.promoted");
    if (!promoted) throw new Error("no task.promoted");
    // The task stops at its next segment's approval, so the turn is still open.
    const send = slowTool("send", 0);
    send.manifest.riskClass = "consequential";
    const raw = env as unknown as WorkerEnv;
    // The task waits on its approval as the engine would: for as long as it takes.
    const waiting = new (class extends Stepper {
      override waitForEvent<T extends JsonValue>(): Promise<{ payload: T }> {
        return new Promise(() => {});
      }
    })();
    void executeTask(
      raw,
      await compose(raw),
      {
        resolveModel: async () => ({
          provider: replying([{ text: "Asking.", calls: [["send", { q: "hi" }]] }]).provider,
          model: "test-model",
          apiKey: null,
        }),
        taskTools: [send],
      },
      created[0]?.id ?? "",
      waiting,
    ).catch(() => {});
    await tab.until("approval.requested");
    const replayed = await resumeTab(browser, "conv-replay", promoted.turnId, promoted.seq);
    await vi.waitFor(
      () => expect(replayed.map((e) => e.type)).toContain("approval.requested"),
      SOCKET_WAIT,
    );
    expect(replayed.map((e) => e.seq)).toEqual(
      tab.events
        .filter((e) => e.seq > promoted.seq && e.seq <= (replayed.at(-1)?.seq ?? 0))
        .map((e) => e.seq),
    );
  });

  it("§17 Persistence: a promoted task survives a forced DO eviction and a redeploy, and completes", async () => {
    const { browser, owner } = await claim();
    const model = replying([{ text: "Started.", calls: [["slow", { q: "x" }]] }]);
    const created = await setUp(owner, model.provider, [slowTool("slow", 60)], {
      promoteAfterMs: 30,
    });
    const tab = await openTab(browser);
    tab.send("conv-persist", "Write the long report");
    await tab.until("task.promoted");
    const taskId = promotedId(tab.events);
    const instanceId = created[0]?.id ?? "";

    // The DO is evicted: its memory and its sockets are gone, the task is in D1.
    await runInDurableObject(assistantOf(owner), (_, state) => state.abort()).catch(() => {});
    expect((await taskRow(taskId))?.status).toBe("queued");

    // A redeploy lands mid-task: the engine dies after the task's first model call ran.
    const calls = { n: 0 };
    const counted: ModelProvider = {
      ...replying([]).provider,
      async *stream(req) {
        calls.n += 1;
        yield* replying([{ text: "The report." }]).provider.stream(req);
      },
    };
    const first = new Redeployed("llm:1");
    void runTask(instanceId, counted, first);
    await vi.waitFor(() => expect(first.gone).toBe(true), SOCKET_WAIT);
    expect((await taskRow(taskId))?.status).toBe("running");

    // The new version replays the recorded steps and runs on; a tab reconnects meanwhile.
    const back = await openTab(browser);
    await runTask(instanceId, counted, first.next());
    expect((await taskRow(taskId))?.status).toBe("succeeded");
    // The step that died ran its call once more (at-least-once); nothing recorded ran again.
    expect(calls.n).toBe(2);
    expect((await stored(browser, "conv-persist")).at(-1)).toMatchObject({
      content: "Started.\n\nThe report.",
      status: "complete",
    });
    await back.until("turn.completed");
    // The chat is free again, on the DO that came back.
    await setUp(owner, replying([{ text: "Welcome" }]).provider, []);
    back.send("conv-persist", "Thanks");
    await back.until("turn.completed", 2);
  });
});
