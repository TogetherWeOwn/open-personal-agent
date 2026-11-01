// SPDX-License-Identifier: Apache-2.0
// The approvals table and its store (M3-07 AC5, AC9, AC13; crypto review W3): every change is one
// conditional write with its audit row, scoped to the user, and a compromise signal expires
// every pending approval.
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { createRepository, type NewApproval, scopeFromSession } from "@opa/db/repository";
import { systemStore } from "@opa/db/system";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkerEnv } from "../src/compose";

const env = workerEnv as unknown as WorkerEnv & { TEST_MIGRATIONS: D1Migration[] };
const db = env.DB;
const repo = createRepository(env);
const alice = repo.forUser(scopeFromSession({ userId: "alice" }));
const bob = repo.forUser(scopeFromSession({ userId: "bob" }));

const item = (approvalId: string, position: number, over: Partial<NewApproval> = {}) =>
  ({
    batchId: "batch_1",
    approvalId,
    position,
    conversationId: "c1",
    turnId: "turn-1",
    taskId: null,
    tool: "send",
    toolCallId: approvalId.replace("appr_", ""),
    target: null,
    risk: "consequential",
    rule: "default_consequential",
    stepUp: false,
    scopes: '["once"]',
    taint: null,
    canonical: "{}",
    bindingHash: `hash-${approvalId}`,
    expiresAt: Date.now() + 60_000,
    ...over,
  }) satisfies NewApproval;

const status = (approvalId: string, batchId = "batch_1") =>
  db
    .prepare("SELECT status FROM approvals WHERE batch_id = ? AND approval_id = ?")
    .bind(batchId, approvalId)
    .first<string>("status");
const audits = (action: string) =>
  db
    .prepare("SELECT count(*) AS n FROM audit_log WHERE action = ?")
    .bind(action)
    .first<number>("n");
const ceremony = { nonce: "n1", digest: "d1", expiresAt: Date.now() + 60_000, sessionId: "s1" };

beforeAll(async () => {
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await db.batch(
    ["approvals", "tasks", "conversations", "audit_log", "users"].map((t) =>
      db.prepare(`DELETE FROM ${t}`),
    ),
  );
  await db
    .prepare(
      "INSERT INTO users (id, display_name, role) VALUES ('alice', 'A', 'owner'), ('bob', 'B', 'member')",
    )
    .run();
  await alice.createConversation("c1");
  await bob.createConversation("c2");
});

describe("the approvals store", () => {
  it("writes a batch only into the user's own conversation and reads it back in order", async () => {
    expect(await alice.approvals.create([item("appr_b", 1), item("appr_a", 0)])).toBe(true);
    expect((await alice.approvals.batch("batch_1")).map((r) => r.approvalId)).toEqual([
      "appr_a",
      "appr_b",
    ]);
    // Bob can't write into Alice's conversation, nor read her batch (AC9 isolation).
    expect(await bob.approvals.create([item("appr_x", 0, { batchId: "batch_2" })])).toBe(false);
    expect(await bob.approvals.batch("batch_1")).toEqual([]);
    expect(await count("approvals")).toBe(2);
  });

  it("needs exactly one context: a turn or a task", async () => {
    await expect(alice.approvals.create([item("appr_a", 0, { turnId: null })])).rejects.toThrow();
  });

  it("decides pending items all or none, each with its audit row (AC5)", async () => {
    await alice.approvals.create([item("appr_a", 0), item("appr_b", 1)]);
    const now = Date.now();
    const d = (approvalId: string, decision: "approve" | "deny") => ({
      approvalId,
      decision,
      scope: "once" as const,
      detail: { tool: "send" },
    });
    await alice.approvals.decide("batch_1", [d("appr_a", "approve"), d("appr_b", "deny")], now);
    expect([await status("appr_a"), await status("appr_b")]).toEqual(["approved", "denied"]);
    expect([await audits("approval.approve"), await audits("approval.deny")]).toEqual([1, 1]);
    // A second decision, a retry or another tab, changes nothing and audits nothing.
    await expect(alice.approvals.decide("batch_1", [d("appr_a", "deny")], now)).rejects.toThrow();
    expect(await status("appr_a")).toBe("approved");
    expect(await audits("approval.deny")).toBe(1);
    // Bob can't decide Alice's items.
    await alice.approvals.create([item("appr_c", 0, { batchId: "batch_3" })]);
    await expect(bob.approvals.decide("batch_3", [d("appr_c", "approve")], now)).rejects.toThrow();
    expect(await status("appr_c", "batch_3")).toBe("pending");
  });

  it("refuses to decide an expired item", async () => {
    await alice.approvals.create([item("appr_a", 0, { expiresAt: Date.now() - 1 })]);
    const decision = { approvalId: "appr_a", decision: "approve", scope: "once", detail: {} };
    await expect(
      alice.approvals.decide("batch_1", [decision as never], Date.now()),
    ).rejects.toThrow();
    expect(await status("appr_a")).toBe("pending");
  });

  it("runs a step-up ceremony once: begin, take burns it, a second take finds nothing (W3)", async () => {
    await alice.approvals.create([item("appr_a", 0), item("appr_b", 1)]);
    const now = Date.now();
    // The caller's count must match what is pending, or nothing is written.
    expect(await alice.approvals.beginStepUp("batch_1", 1, ceremony, now)).toBe(false);
    expect(await alice.approvals.beginStepUp("batch_1", 2, ceremony, now)).toBe(true);
    expect(await bob.approvals.takeStepUp("batch_1")).toBeNull();
    expect(await alice.approvals.takeStepUp("batch_1")).toEqual(ceremony);
    expect(await alice.approvals.takeStepUp("batch_1")).toBeNull();
    // A new ceremony replaces the old one.
    await alice.approvals.beginStepUp("batch_1", 2, ceremony, now);
    await alice.approvals.beginStepUp("batch_1", 2, { ...ceremony, nonce: "n2" }, now);
    expect((await alice.approvals.takeStepUp("batch_1"))?.nonce).toBe("n2");
    // A decision clears the ceremony too.
    await alice.approvals.beginStepUp("batch_1", 2, ceremony, now);
    const approve = { decision: "approve", scope: "once", detail: {} } as const;
    await alice.approvals.decide("batch_1", [{ approvalId: "appr_a", ...approve }], now);
    const left = await db
      .prepare("SELECT count(*) AS n FROM approvals WHERE nonce IS NOT NULL")
      .first<number>("n");
    expect(left).toBe(1); // appr_b is still pending with it; appr_a's is gone
  });

  it("claims an approved call once, before it expires, and records how it ended (AC12)", async () => {
    await alice.approvals.create([item("appr_a", 0), item("appr_b", 1)]);
    const now = Date.now();
    const approve = { decision: "approve", scope: "once", detail: {} } as const;
    await alice.approvals.decide(
      "batch_1",
      [
        { approvalId: "appr_a", ...approve },
        { approvalId: "appr_b", ...approve },
      ],
      now,
    );
    expect(await bob.approvals.claim("batch_1", "appr_a", now)).toBeUndefined();
    expect((await alice.approvals.claim("batch_1", "appr_a", now))?.status).toBe("executing");
    expect(await alice.approvals.claim("batch_1", "appr_a", now)).toBeUndefined();
    expect(await alice.approvals.finish("batch_1", "appr_a", { status: "executed" })).toBe(true);
    expect(await status("appr_a")).toBe("executed");
    // Denied at the re-check: from approved, with its reason, on the row and in the log.
    const denied = { status: "denied", reason: "override_never" } as const;
    expect(await alice.approvals.finish("batch_1", "appr_b", denied)).toBe(true);
    expect(await status("appr_b")).toBe("denied");
    expect(await audits("approval.execute")).toBe(2);
    // Nothing ends twice.
    expect(await alice.approvals.finish("batch_1", "appr_b", denied)).toBe(false);
    expect(await audits("approval.execute")).toBe(2);
    // Past its expiry an approved call can't be claimed.
    await alice.approvals.create([item("appr_c", 0, { batchId: "batch_4" })]);
    await alice.approvals.decide("batch_4", [{ approvalId: "appr_c", ...approve }], now);
    expect(await alice.approvals.claim("batch_4", "appr_c", now + 120_000)).toBeUndefined();
  });

  it("expires every pending approval on a compromise signal, and cancels tasks waiting (AC13)", async () => {
    await db
      .prepare(
        "INSERT INTO tasks (id, user_id, conversation_id, kind, mode, status) VALUES ('t1', 'alice', 'c1', 'chat', 'background', 'waiting_for_approval')",
      )
      .run();
    await alice.approvals.create([item("appr_a", 0)]);
    await alice.approvals.create([
      item("appr_t", 0, { batchId: "batch_t", turnId: null, taskId: "t1" }),
    ]);
    await bob.approvals.create([item("appr_b", 0, { batchId: "batch_b", conversationId: "c2" })]);
    await alice.approvals.beginStepUp("batch_1", 1, ceremony, Date.now());
    await systemStore(env).sessions.revokeAll("alice", Date.now());
    expect(await status("appr_a")).toBe("expired");
    expect(await status("appr_t", "batch_t")).toBe("expired");
    expect(await status("appr_b", "batch_b")).toBe("pending"); // another user's stays
    const task = await db.prepare("SELECT status FROM tasks WHERE id = 't1'").first("status");
    expect(task).toBe("cancelled");
    const nonces = await db
      .prepare("SELECT count(*) AS n FROM approvals WHERE nonce IS NOT NULL")
      .first<number>("n");
    expect(nonces).toBe(0);
    expect(await audits("approval.expire_all")).toBe(1);
  });
});

const count = (table: string) =>
  db.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>("n");
