// SPDX-License-Identifier: Apache-2.0
// The tasks table and scope minting for Workflows (M3-12 AC3, AC9): a Workflow's authority comes
// from its task row alone, another user's task is invisible, and a cancelled row is never
// overwritten by the run it stopped.
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { createRepository, scopeFromSession } from "@opa/db/repository";
import { beforeAll, describe, expect, it } from "vitest";
import type { WorkerEnv } from "../src/compose";

const env = workerEnv as unknown as WorkerEnv & { TEST_MIGRATIONS: D1Migration[] };
const repo = createRepository(env);
const alice = repo.forUser(scopeFromSession({ userId: "alice" }));
const bob = repo.forUser(scopeFromSession({ userId: "bob" }));

const makeTask = (id: string, conversationId: string, instanceId = `inst-${id}`) => ({
  id,
  conversationId,
  workflowInstanceId: instanceId,
  kind: "turn",
  mode: "background" as const,
});

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare(
    "INSERT INTO users (id, display_name, role) VALUES ('alice', 'A', 'owner'), ('bob', 'B', 'member')",
  ).run();
  await alice.createConversation("ca", "Alice's");
  await bob.createConversation("cb", "Bob's");
});

describe("task rows", () => {
  it("creates a queued task for the user's own conversation only", async () => {
    expect(await alice.tasks.create(makeTask("t1", "ca"))).toBe(true);
    expect(await alice.tasks.create(makeTask("t2", "cb"))).toBe(false); // Bob's conversation
    const row = await alice.tasks.get("t1");
    expect(row?.status).toBe("queued");
    expect(row?.userId).toBe("alice");
    expect(await bob.tasks.get("t1")).toBeUndefined();
  });

  it("mints the scope from the row's user_id, never from a claim about it", async () => {
    const minted = await repo.scopeForTask("inst-t1");
    expect(minted?.scope.userId).toBe("alice");
    expect(minted?.task.id).toBe("t1");
    // The minted scope really is Alice's authority, usable with forUser.
    expect((await repo.forUser(minted?.scope as never).tasks.get("t1"))?.id).toBe("t1");
    // Nothing about the lookup can be steered: unknown or malformed instances mint nothing.
    expect(await repo.scopeForTask("inst-nope")).toBeNull();
    expect(await repo.scopeForTask("")).toBeNull();
    expect(await repo.scopeForTask("bob")).toBeNull();
    expect(await repo.scopeForTask("x".repeat(129))).toBeNull();
  });

  it("refuses to create a task no Workflow instance could resolve", async () => {
    await expect(
      alice.tasks.create({ ...makeTask("t9", "ca"), workflowInstanceId: "x".repeat(129) }),
    ).rejects.toThrow(/invalid instance id/);
    expect(await alice.tasks.get("t9")).toBeUndefined();
  });

  it("runs, saves state and finishes; a terminal row doesn't move again", async () => {
    const running = await alice.tasks.markRunning("t1", 1_000);
    expect(running?.status).toBe("running");
    expect(running?.startedAt).toBe(1_000);
    expect(await bob.tasks.markRunning("t1", 2_000)).toBeUndefined();
    expect(await alice.tasks.saveState("t1", '{"turn":1}')).toBe(true);
    expect(await alice.tasks.saveState("t1", '{"turn":2}', "waiting_for_approval")).toBe(true);
    // Only the two in-flight statuses pass; an ending smuggled past the type is dropped.
    const sneaky = "succeeded" as unknown as "running";
    expect(await alice.tasks.saveState("t1", '{"turn":2}', sneaky)).toBe(true);
    expect((await alice.tasks.get("t1"))?.status).toBe("waiting_for_approval");
    expect((await alice.tasks.get("t1"))?.state).toBe('{"turn":2}');
    expect(await alice.tasks.finish("t1", "succeeded")).toBe(true);
    expect((await alice.tasks.get("t1"))?.finishedAt).not.toBeNull();
    expect(await alice.tasks.saveState("t1", '{"turn":3}')).toBe(false);
    expect(await alice.tasks.finish("t1", "failed")).toBe(false);
    expect(await alice.tasks.markRunning("t1", 3_000)).toBeUndefined();
  });

  it("a cancelled task is never overwritten by the run it stopped", async () => {
    await alice.tasks.create(makeTask("t3", "ca"));
    await alice.tasks.markRunning("t3", 1_000);
    expect(await bob.tasks.cancel("t3")).toBe(false); // not Bob's to cancel
    expect(await alice.tasks.cancel("t3")).toBe(true);
    expect(await alice.tasks.cancel("t3")).toBe(false); // already cancelled
    expect(await alice.tasks.saveState("t3", '{"turn":9}')).toBe(false);
    expect(await alice.tasks.finish("t3", "succeeded")).toBe(false);
    expect(await alice.tasks.markRunning("t3", 4_000)).toBeUndefined();
    expect((await alice.tasks.get("t3"))?.status).toBe("cancelled");
  });

  it("budget-limited is a pause, not an ending", async () => {
    await alice.tasks.create(makeTask("t4", "ca"));
    await alice.tasks.markRunning("t4", 1_000);
    expect(await alice.tasks.finish("t4", "budget_limited")).toBe(true);
    const row = await alice.tasks.get("t4");
    expect(row?.finishedAt).toBeNull();
    expect(await alice.tasks.cancel("t4")).toBe(true); // a paused task can still be cancelled
  });

  it("keeps step outputs under the user's own prefix", async () => {
    await alice.stepOutputs.put("out1", '{"big":true}');
    expect(await env.FILES.head("u/alice/task-outputs/out1")).not.toBeNull();
    expect(await (await alice.stepOutputs.get("out1"))?.text()).toBe('{"big":true}');
    expect(await bob.stepOutputs.get("out1")).toBeNull();
    expect(() => bob.stepOutputs.get("../../alice/task-outputs/out1")).toThrow(/invalid id/);
  });
});
