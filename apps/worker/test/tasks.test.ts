// SPDX-License-Identifier: Apache-2.0
// The tasks table and scope minting for Workflows (M3-12 AC3, AC9): a Workflow's authority comes
// from its task row alone, another user's task is invisible, and a cancelled row is never
// overwritten by the run it stopped.
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { createRepository, scopeFromSession } from "@opa/db/repository";
import { beforeAll, describe, expect, it, vi } from "vitest";
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

  it("records which limit stopped a budget-limited task, and clears it on success", async () => {
    await alice.tasks.create(makeTask("t10", "ca"));
    await alice.tasks.markRunning("t10", 1_000);
    expect(await alice.tasks.finish("t10", "budget_limited", "too many tools", "tools")).toBe(true);
    expect((await alice.tasks.get("t10"))?.limitKind).toBe("tools");
    // A paused task resumes: succeeding clears the kind and stamps the end.
    expect(await alice.tasks.finish("t10", "succeeded")).toBe(true);
    const done = await alice.tasks.get("t10");
    expect(done?.limitKind).toBeNull();
    expect(done?.finishedAt).not.toBeNull();
  });

  it("a repeated pause finish keeps the pause timestamp stable", async () => {
    await alice.tasks.create(makeTask("t14", "ca"));
    await alice.tasks.markRunning("t14", 1_000);
    expect(await alice.tasks.finish("t14", "budget_limited", undefined, "calls")).toBe(true);
    const pausedAt = (await alice.tasks.get("t14"))?.updatedAt ?? 0;
    expect((await alice.tasks.get("t14"))?.status).toBe("budget_limited");
    // The 7-day pause wait times out with no Continue; the run's end writes the same pause
    // again. The timestamp must not move, or the Tasks view's elapsed clock (frozen at the
    // pause) would count the idle wait as run time.
    const later = vi.spyOn(Date, "now").mockReturnValue(pausedAt + 7 * 86_400_000);
    try {
      expect(await alice.tasks.finish("t14", "budget_limited", undefined, "calls")).toBe(true);
    } finally {
      later.mockRestore();
    }
    expect((await alice.tasks.get("t14"))?.updatedAt).toBe(pausedAt);
    // A pause under a different kind still moves the row.
    expect(await alice.tasks.finish("t14", "budget_limited", undefined, "duration")).toBe(true);
    expect((await alice.tasks.get("t14"))?.limitKind).toBe("duration");
  });

  it("clears the limit kind when a paused task resumes or is cancelled", async () => {
    await alice.tasks.create(makeTask("t13", "ca"));
    await alice.tasks.markRunning("t13", 1_000);
    expect(await alice.tasks.finish("t13", "budget_limited", "too many calls", "calls")).toBe(true);
    expect((await alice.tasks.get("t13"))?.limitKind).toBe("calls");
    // Resuming moves back to running, so the pause's kind no longer describes the row.
    const resumed = await alice.tasks.markRunning("t13", 2_000);
    expect(resumed?.status).toBe("running");
    expect(resumed?.limitKind).toBeNull();
    expect(await alice.tasks.finish("t13", "budget_limited", "too slow", "duration")).toBe(true);
    // Cancelling ends it, so the kind clears with the move to cancelled.
    expect(await alice.tasks.cancel("t13")).toBe(true);
    const cancelled = await alice.tasks.get("t13");
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.limitKind).toBeNull();
  });

  it("lists runs with their conversation and spend, and filters them", async () => {
    await alice.tasks.create({ ...makeTask("t11", "ca"), title: "Report" });
    await alice.tasks.create(makeTask("t12", "ca"));
    const call = {
      providerId: "openai",
      model: "gpt-4.1-mini",
      usage: { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 0, reasoningTokens: 0 },
    };
    await alice.usage.record({ ...call, taskId: "t11" });
    await alice.usage.record({ ...call, taskId: "t11" });
    await alice.usage.record({
      providerId: "unpriced-vendor",
      model: "mystery",
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
      taskId: "t11",
    }); // no price on file: counted, but missing from the subtotal
    await alice.usage.record(call); // a chat turn: no task, so no run may claim it
    // Another user's call can't attach to the task at all (TWO-427 L-4): the owner
    // trigger refuses the write (drizzle wraps the abort as a failed query), so no
    // foreign spend can leak into the subtotal.
    await expect(bob.usage.record({ ...call, taskId: "t11" })).rejects.toThrow(
      /Failed query: insert into "usage"/,
    );
    await expect(alice.usage.record({ ...call, taskId: "../x" })).rejects.toThrow(/invalid id/);

    const listed = await alice.tasks.list();
    const report = listed.find((t) => t.id === "t11");
    expect(report).toMatchObject({
      title: "Report",
      conversationId: "ca",
      conversationTitle: "Alice's",
      kind: "turn",
      mode: "background",
      status: "queued",
      limitKind: null,
      calls: 3,
      unpricedCalls: 1,
    });
    expect(typeof report?.costMicroUsd).toBe("number");
    // No calls yet reads as zero calls and unknown cost, never as nulls.
    expect(listed.find((t) => t.id === "t12")).toMatchObject({
      calls: 0,
      unpricedCalls: 0,
      costMicroUsd: null,
    });
    // Newest first.
    expect(listed[0]?.createdAt).toBeGreaterThanOrEqual(listed.at(-1)?.createdAt ?? 0);

    const details = await alice.tasks.details("t11");
    expect(details).toMatchObject({
      id: "t11",
      calls: 3,
      unpricedCalls: 1,
      conversationTitle: "Alice's",
    });
    expect(details?.costMicroUsd).toBe(report?.costMicroUsd);
    // A task with no usage reads as zero calls and zero unpriced, like the list.
    expect(await alice.tasks.details("t12")).toMatchObject({ calls: 0, unpricedCalls: 0 });
    expect(await alice.tasks.details("missing")).toBeUndefined();
    expect(await bob.tasks.details("t11")).toBeUndefined(); // someone else's run

    expect((await alice.tasks.list({ status: ["queued", "bogus"] })).map((t) => t.id)).toContain(
      "t11",
    ); // unknown statuses are ignored
    expect((await alice.tasks.list({ status: ["running"] })).some((t) => t.id === "t11")).toBe(
      false,
    );
    expect(await alice.tasks.list({ since: Date.now() + 3_600_000 })).toEqual([]);
    expect(await alice.tasks.list({ until: 0 })).toEqual([]);
    expect(await alice.tasks.list({ limit: 1 })).toHaveLength(1);
    expect(await alice.tasks.list({ limit: 0 })).toHaveLength(1); // clamped to one
    expect((await alice.tasks.list({ limit: 500 })).length).toBeGreaterThan(1); // clamped to 200
  });

  it("files a queued row with no Workflow instance yet", async () => {
    // What the `task` tool files: no instance until promotion creates it (M3-12b).
    await alice.tasks.create({
      id: "t20",
      conversationId: "ca",
      kind: "turn",
      mode: "background",
      title: "Later",
    });
    const row = await alice.tasks.get("t20");
    expect(row?.status).toBe("queued");
    expect(row?.workflowInstanceId).toBeNull();
    await expect(
      alice.tasks.create({ ...makeTask("t21", "ca"), workflowInstanceId: "x".repeat(129) }),
    ).rejects.toThrow(/invalid instance id/);
  });
});
