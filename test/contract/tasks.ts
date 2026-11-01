// SPDX-License-Identifier: Apache-2.0
// Contract tests for durable tasks (M3-23b AC3). The Worker project runs them against D1 and
// the Workflows adapter, the Node project against apps/node's SQLite journal and local files
// (`selfhost-parity`). A relative path: this file sits outside every workspace package, as
// `test/contract/storage.ts` does.
import { describe, expect, it } from "vitest";
import {
  TaskCancelledError,
  type TaskContext,
  TaskLimitError,
} from "../../packages/core/src/task-context";
import { createRepository, scopeFromSession } from "../../packages/db/src/repository";

let ids = 0;

/**
 * The `tasks` table and step outputs through the repository, against a migrated database: task
 * lifecycle, scope minting from the row alone (M3-12 AC9), the cancel discipline (AC3) and the
 * per-user output prefix (AC4).
 */
export function taskStoreContract(
  name: string,
  migrated: () => Promise<D1Database>,
  files: () => R2Bucket,
) {
  describe(`${name}: task store contract`, () => {
    async function setup() {
      const DB = await migrated();
      const tag = `task-${++ids}-${Date.now()}`;
      const a = `a-${tag}`;
      const b = `b-${tag}`;
      await DB.prepare(
        "INSERT INTO users (id, display_name, role) VALUES (?, 'A', 'owner'), (?, 'B', 'member')",
      )
        .bind(a, b)
        .run();
      const stub = {} as never;
      const repo = createRepository({ DB, FILES: files() as never, ASSISTANT: stub });
      const alice = repo.forUser(scopeFromSession({ userId: a }));
      const bob = repo.forUser(scopeFromSession({ userId: b }));
      expect(await alice.chat.open(`ca-${tag}`, "A's")).toBe(true);
      expect(await bob.chat.open(`cb-${tag}`, "B's")).toBe(true);
      const make = (id: string, conversationId: string, instanceId = `inst-${id}`) => ({
        id,
        conversationId,
        workflowInstanceId: instanceId,
        kind: "turn",
        mode: "background" as const,
      });
      return { DB, repo, alice, bob, a, b, tag, make };
    }

    it("creates a queued task for the user's own conversation only", async () => {
      const { alice, bob, tag, make } = await setup();
      expect(await alice.tasks.create(make(`t1-${tag}`, `ca-${tag}`))).toBe(true);
      expect(await alice.tasks.create(make(`t2-${tag}`, `cb-${tag}`))).toBe(false);
      const row = await alice.tasks.get(`t1-${tag}`);
      expect(row?.status).toBe("queued");
      expect(await bob.tasks.get(`t1-${tag}`)).toBeUndefined();
    });

    it("mints the scope from the row's user_id, never from a claim about it", async () => {
      const { repo, alice, tag, make } = await setup();
      await alice.tasks.create(make(`t1-${tag}`, `ca-${tag}`));
      const minted = await repo.scopeForTask(`inst-t1-${tag}`);
      expect(minted?.scope.userId).toBe(minted?.task.userId);
      expect(minted?.task.id).toBe(`t1-${tag}`);
      expect(await repo.scopeForTask("inst-nope")).toBeNull();
      expect(await repo.scopeForTask("")).toBeNull();
      expect(await repo.scopeForTask("x".repeat(129))).toBeNull();
    });

    it("refuses to create a task no run could resolve", async () => {
      const { alice, tag, make } = await setup();
      await expect(
        alice.tasks.create({
          ...make(`t9-${tag}`, `ca-${tag}`),
          workflowInstanceId: "x".repeat(129),
        }),
      ).rejects.toThrow(/invalid instance id/);
      expect(await alice.tasks.get(`t9-${tag}`)).toBeUndefined();
    });

    it("runs, saves state and finishes; a terminal row doesn't move again", async () => {
      const { alice, bob, tag, make } = await setup();
      const id = `t1-${tag}`;
      await alice.tasks.create(make(id, `ca-${tag}`));
      expect((await alice.tasks.markRunning(id, 1_000))?.status).toBe("running");
      expect(await bob.tasks.markRunning(id, 2_000)).toBeUndefined();
      expect(await alice.tasks.saveState(id, '{"turn":1}')).toBe(true);
      expect(await alice.tasks.saveState(id, '{"turn":2}', "waiting_for_approval")).toBe(true);
      expect((await alice.tasks.get(id))?.status).toBe("waiting_for_approval");
      expect(await alice.tasks.finish(id, "succeeded")).toBe(true);
      expect((await alice.tasks.get(id))?.finishedAt).not.toBeNull();
      expect(await alice.tasks.saveState(id, '{"turn":3}')).toBe(false);
      expect(await alice.tasks.finish(id, "failed")).toBe(false);
      expect(await alice.tasks.markRunning(id, 3_000)).toBeUndefined();
    });

    it("never lets a cancelled task be overwritten by the run it stopped", async () => {
      const { alice, bob, tag, make } = await setup();
      const id = `t3-${tag}`;
      await alice.tasks.create(make(id, `ca-${tag}`));
      await alice.tasks.markRunning(id, 1_000);
      expect(await bob.tasks.cancel(id)).toBe(false);
      expect(await alice.tasks.cancel(id)).toBe(true);
      expect(await alice.tasks.cancel(id)).toBe(false);
      expect(await alice.tasks.saveState(id, '{"turn":9}')).toBe(false);
      expect(await alice.tasks.finish(id, "succeeded")).toBe(false);
      expect((await alice.tasks.get(id))?.status).toBe("cancelled");
    });

    it("treats budget-limited as a pause, not an ending", async () => {
      const { alice, tag, make } = await setup();
      const id = `t4-${tag}`;
      await alice.tasks.create(make(id, `ca-${tag}`));
      await alice.tasks.markRunning(id, 1_000);
      expect(await alice.tasks.finish(id, "budget_limited")).toBe(true);
      const row = await alice.tasks.get(id);
      expect(row?.finishedAt).toBeNull();
      expect(await alice.tasks.cancel(id)).toBe(true);
    });

    it("keeps step outputs under the user's own prefix", async () => {
      const { alice, bob, a, tag } = await setup();
      await alice.stepOutputs.put(`out-${tag}`, '{"big":true}');
      expect(await files().head(`u/${a}/task-outputs/out-${tag}`)).not.toBeNull();
      expect(await (await alice.stepOutputs.get(`out-${tag}`))?.text()).toBe('{"big":true}');
      expect(await bob.stepOutputs.get(`out-${tag}`)).toBeNull();
      expect(() => bob.stepOutputs.get("../../x/task-outputs/out")).toThrow(/invalid id/);
    });
  });
}

export interface TaskContextConnectOptions {
  secrets?: readonly string[];
  limits?: { steps?: number; durationMs?: number };
  startedAt?: number;
}

/**
 * One root's wiring for the port contract: a fresh task row with a context over it. `reconnect`
 * returns a new context object over the same task and instance — a crash-resume — which must
 * replay persisted steps instead of re-running them.
 */
export interface TaskContextHarness {
  ctx: TaskContext;
  taskId: string;
  instanceId: string;
  /** Cancels the task's real row, the way the Tasks view does. */
  cancel(): Promise<void>;
  reconnect(): TaskContext;
  /** Posts an event the context's waiter consumes. */
  postEvent(type: string, payload: unknown): Promise<void>;
  /** The persisted step state as text: small when offloaded, holding stops. */
  persistedText(): Promise<string>;
  /** Offloaded output ids recorded through the outputs port, in put order. */
  outputIds(): string[];
  readOutput(id: string): Promise<string | null>;
  progressEvents: { seq: number; type: string; payload: unknown }[];
  budgetCalls: string[];
}

/**
 * The `TaskContext` port (M3-12 AC1, AC3, AC4, AC6, AC8) against both runtimes: every step runs
 * once and replays after a resume, a cancelled task's step does nothing, stops persist as the
 * step's output, limits stop the run, large outputs offload, secrets never persist, and budget
 * and progress cross to the assistant. The engine-specific paths (Workflow replay, the SQLite
 * retry loop) keep their own unit tests beside each adapter.
 */
export function taskContextContract(
  name: string,
  connect: (options?: TaskContextConnectOptions) => Promise<TaskContextHarness>,
) {
  const SECRET = "parity-canary-secret-0123456789abcdef";

  describe(`${name}: TaskContext contract`, () => {
    it("runs each step once and replays it after a resume", async () => {
      const h = await connect();
      let runs = 0;
      expect(
        await h.ctx.step("s1", async () => {
          runs += 1;
          return { n: 1 };
        }),
      ).toEqual({ n: 1 });
      expect(runs).toBe(1);
      expect(
        await h.reconnect().step("s1", async () => {
          runs += 1;
          return { n: 2 };
        }),
      ).toEqual({ n: 1 });
      expect(runs).toBe(1);
    });

    it("keys idempotency as instanceId:stepName and refuses a reused name", async () => {
      const h = await connect();
      expect(await h.ctx.step("llm:1", async (k) => k)).toBe(`${h.instanceId}:llm:1`);
      await expect(h.ctx.step("llm:1", async () => "again")).rejects.toThrow(/already used/);
    });

    it("never runs a cancelled task's step, sleep or wait", async () => {
      const h = await connect();
      await h.cancel();
      let ran = false;
      await expect(
        h.ctx.step("s1", async () => {
          ran = true;
          return "x";
        }),
      ).rejects.toBeInstanceOf(TaskCancelledError);
      expect(ran).toBe(false);
      await expect(h.ctx.sleep("nap", 5)).rejects.toBeInstanceOf(TaskCancelledError);
      await expect(h.ctx.waitForEvent("w", { type: "t", timeoutMs: 5 })).rejects.toBeInstanceOf(
        TaskCancelledError,
      );
    });

    it("lets a mid-step cancel finish, then stops and replays the stop", async () => {
      const h = await connect();
      const first = await h.ctx.step("s1", async () => {
        await h.cancel();
        return "finished";
      });
      expect(first).toBe("finished");
      let ran = false;
      await expect(
        h.ctx.step("s2", async () => {
          ran = true;
          return "x";
        }),
      ).rejects.toBeInstanceOf(TaskCancelledError);
      expect(ran).toBe(false);
      expect(await h.persistedText()).toContain("stopped");
      ran = false;
      await expect(
        h.reconnect().step("s2", async () => {
          ran = true;
          return "x";
        }),
      ).rejects.toBeInstanceOf(TaskCancelledError);
      expect(ran).toBe(false);
    });

    it("returns a step's value as-is even when it looks like a persisted marker", async () => {
      const h = await connect();
      const lookalike = { stopped: "cancelled", ref: "x" } as const;
      expect(await h.ctx.step("s1", async () => lookalike)).toEqual(lookalike);
    });

    it("stops at the step and duration limits without running", async () => {
      const stepped = await connect({ limits: { steps: 2 } });
      await stepped.ctx.step("a", async () => 1);
      await stepped.ctx.sleep("b", 1);
      let ran = false;
      const steps = await stepped.ctx
        .step("c", async () => {
          ran = true;
          return 3;
        })
        .catch((e: unknown) => e);
      expect(steps).toBeInstanceOf(TaskLimitError);
      expect((steps as TaskLimitError).kind).toBe("steps");
      expect(ran).toBe(false);
      const timed = await connect({
        limits: { durationMs: 1_000 },
        startedAt: Date.now() - 5_000,
      });
      ran = false;
      const duration = await timed.ctx
        .step("a", async () => {
          ran = true;
          return 1;
        })
        .catch((e: unknown) => e);
      expect(duration).toBeInstanceOf(TaskLimitError);
      expect((duration as TaskLimitError).kind).toBe("duration");
      expect(ran).toBe(false);
    });

    it("offloads an output over 1 MiB and reads it back", async () => {
      const h = await connect();
      const big = "x".repeat(1024 * 1024 + 10);
      expect(await h.ctx.step("big", async () => big)).toBe(big);
      expect((await h.persistedText()).length).toBeLessThan(1000);
      expect(h.outputIds().length).toBeGreaterThan(0);
      const stored = await h.readOutput(h.outputIds()[0] ?? "");
      expect(stored?.length).toBeGreaterThan(1024 * 1024);
      expect(stored ? (JSON.parse(stored) as string) : null).toBe(big);
    });

    it("redacts the guarded secret from persisted, offloaded and progress output", async () => {
      const h = await connect({ secrets: [SECRET] });
      const out = await h.ctx.step("small", async () => ({
        note: `the key is ${SECRET}, ok`,
        nested: [SECRET],
        [SECRET]: "as a key",
      }));
      expect(JSON.stringify(out)).not.toContain(SECRET);
      expect(await h.persistedText()).not.toContain(SECRET);
      const big = `${"y".repeat(1024 * 1024)}${SECRET}`;
      expect(await h.ctx.step("big", async () => big)).not.toContain(SECRET);
      for (const id of h.outputIds()) {
        expect(await h.readOutput(id)).not.toContain(SECRET);
      }
      h.ctx.progress({ type: "note", payload: `saw ${SECRET} here` });
      expect(JSON.stringify(h.progressEvents)).not.toContain(SECRET);
    });

    it("passes budget calls through with the step's idempotency key", async () => {
      const h = await connect();
      const out = await h.ctx.step("llm:1", async (key) => {
        expect(key).toBe(`${h.instanceId}:llm:1`);
        const reservation = await h.ctx.budget.reserve(key, "openai", "gpt-4.1", 2000);
        expect(reservation?.maxOutputTokens).toBeGreaterThan(0);
        await h.ctx.budget.settle(key, "openai", "gpt-4.1", {
          inputTokens: 1,
          outputTokens: 1,
          cachedInputTokens: 0,
        });
        await h.ctx.budget.release(`${h.instanceId}:other`);
        return "called";
      });
      expect(out).toBe("called");
      expect(h.budgetCalls).toEqual([
        `reserve:${h.instanceId}:llm:1`,
        `settle:${h.instanceId}:llm:1`,
        `release:${h.instanceId}:other`,
      ]);
    });

    it("emits progress with incrementing sequence numbers", async () => {
      const h = await connect();
      h.ctx.progress({ type: "step.started", payload: { stepId: "s1" } });
      h.ctx.progress({ type: "step.completed", payload: { stepId: "s1" } });
      expect(h.progressEvents).toEqual([
        { seq: 1, type: "step.started", payload: { stepId: "s1" } },
        { seq: 2, type: "step.completed", payload: { stepId: "s1" } },
      ]);
    });

    it("sleeps, and waits for a posted event or throws when none arrives", async () => {
      const h = await connect();
      await h.ctx.sleep("nap", 5);
      await h.postEvent("approval", { decision: "approve" });
      expect(await h.ctx.waitForEvent("w", { type: "approval", timeoutMs: 2000 })).toEqual({
        payload: { decision: "approve" },
      });
      await expect(
        h.ctx.waitForEvent("w2", { type: "never-posted", timeoutMs: 20 }),
      ).rejects.toThrow();
    });

    it("replays a consumed wait after a resume instead of timing out", async () => {
      const h = await connect();
      await h.postEvent("approval", { decision: "approve" });
      expect(await h.ctx.waitForEvent("w", { type: "approval", timeoutMs: 2000 })).toEqual({
        payload: { decision: "approve" },
      });
      // A reconnected context over the same task and instance — a crash-resume — replays
      // the consumed approval instead of waiting on an event that is already gone.
      expect(await h.reconnect().waitForEvent("w", { type: "approval", timeoutMs: 50 })).toEqual({
        payload: { decision: "approve" },
      });
    });
  });
}
