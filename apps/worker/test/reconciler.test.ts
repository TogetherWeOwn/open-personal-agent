// SPDX-License-Identifier: Apache-2.0
// The `*/10` reconciler (M3-18 AC2): approval expiry in D1 without waking a Durable Object, and
// one tick that runs every part, where one part failing doesn't stop the others.
import { expireApprovals, reconcile, reconcilerParts } from "@opa/server/reconciler";
import { describe, expect, it } from "vitest";
import { count, db, env, freshDatabase } from "./helpers/app";

freshDatabase();

const NOW = Date.now();
const HOUR = 3_600_000;

async function seed() {
  await db.batch([
    db.prepare("INSERT INTO users (id, display_name, role) VALUES ('u1', 'u1', 'owner')"),
    db.prepare("INSERT INTO users (id, display_name, role) VALUES ('u2', 'u2', 'member')"),
    ...["u1", "u2"].map((u) =>
      db.prepare("INSERT INTO conversations (id, user_id) VALUES (?, ?)").bind(`c-${u}`, u),
    ),
    ...(
      [
        ["t-due", "u1", "waiting_for_approval"],
        ["t-later", "u1", "waiting_for_approval"],
        ["t-u2", "u2", "waiting_for_approval"],
      ] as const
    ).map(([id, u, status]) =>
      db
        .prepare(
          "INSERT INTO tasks (id, user_id, conversation_id, workflow_instance_id, kind, mode, status) VALUES (?, ?, ?, ?, 'turn', 'background', ?)",
        )
        .bind(id, u, `c-${u}`, `inst-${id}`, status),
    ),
  ]);
}

/** One approval of a batch of its own, on a turn unless `taskId`. */
const approval = (
  id: string,
  userId: string,
  expiresAt: number,
  { taskId = null as string | null, status = "pending" } = {},
) =>
  db
    .prepare(
      `INSERT INTO approvals (batch_id, approval_id, position, user_id, conversation_id, turn_id, task_id, tool, tool_call_id, risk, rule, step_up, scopes, canonical, binding_hash, expires_at, status, nonce)
       VALUES (?, ?, 0, ?, ?, ?, ?, 'send', ?, 'consequential', 'default_consequential', 0, '["once"]', '{}', 'h', ?, ?, 'n')`,
    )
    .bind(
      `b-${id}`,
      `appr_${id}`,
      userId,
      `c-${userId}`,
      taskId ? null : `turn-${id}`,
      taskId,
      id,
      expiresAt,
      status,
    )
    .run();

const statuses = async () =>
  Object.fromEntries(
    (
      await db
        .prepare("SELECT approval_id, status, nonce FROM approvals ORDER BY approval_id")
        .all<{ approval_id: string; status: string; nonce: string | null }>()
    ).results.map((r) => [r.approval_id, `${r.status}${r.nonce ? "+nonce" : ""}`]),
  );

const taskStatus = (id: string) =>
  db.prepare("SELECT status FROM tasks WHERE id = ?").bind(id).first<string>("status");

describe("approval expiry", () => {
  it("expires every user's pending approvals past expiry, with audit rows, and cancels their tasks", async () => {
    await seed();
    await approval("turn-due", "u1", NOW - 1);
    await approval("task-due", "u1", NOW - HOUR, { taskId: "t-due" });
    await approval("task-later", "u1", NOW + HOUR, { taskId: "t-later" });
    await approval("u2-due", "u2", NOW - 1, { taskId: "t-u2" });
    // Decided before it expired: an approved call's claim checks the expiry itself.
    await approval("approved", "u1", NOW - 1, { status: "approved" });

    // Only the database is passed: no Durable Object namespace, so none can wake.
    await expireApprovals({ DB: env.DB }, NOW);

    expect(await statuses()).toEqual({
      appr_approved: "approved+nonce",
      "appr_task-due": "expired",
      "appr_task-later": "pending+nonce",
      "appr_turn-due": "expired",
      "appr_u2-due": "expired",
    });
    expect(await taskStatus("t-due")).toBe("cancelled");
    expect(await taskStatus("t-u2")).toBe("cancelled");
    expect(await taskStatus("t-later")).toBe("waiting_for_approval");
    const audit = await db
      .prepare(
        "SELECT user_id, target_id, result, detail FROM audit_log WHERE action = 'approval.expire' ORDER BY target_id",
      )
      .all();
    expect(audit.results).toEqual([
      {
        user_id: "u1",
        target_id: "b-task-due/appr_task-due",
        result: "denied",
        detail: '{"reason":"expired"}',
      },
      {
        user_id: "u1",
        target_id: "b-turn-due/appr_turn-due",
        result: "denied",
        detail: '{"reason":"expired"}',
      },
      {
        user_id: "u2",
        target_id: "b-u2-due/appr_u2-due",
        result: "denied",
        detail: '{"reason":"expired"}',
      },
    ]);

    // The next tick finds nothing new and writes nothing.
    await expireApprovals({ DB: env.DB }, NOW + 1);
    expect(await count("audit_log", "action = 'approval.expire'")).toBe(3);
  });

  it("leaves a task that is no longer waiting as it is", async () => {
    await seed();
    await db.prepare("UPDATE tasks SET status = 'running' WHERE id = 't-due'").run();
    await approval("task-due", "u1", NOW - 1, { taskId: "t-due" });
    await expireApprovals({ DB: env.DB }, NOW);
    expect(await statuses()).toEqual({ "appr_task-due": "expired" });
    expect(await taskStatus("t-due")).toBe("running");
  });
});

describe("one reconciler tick", () => {
  /** What each part leaves behind, so a test can tell which ran. */
  async function dueWork() {
    await seed();
    await approval("turn-due", "u1", NOW - 1);
    await db
      .prepare(
        "INSERT INTO exports (id, user_id, workflow_instance_id, status, expires_at) VALUES ('e1', 'u1', 'inst-e1', 'ready', ?)",
      )
      .bind(NOW - 1)
      .run();
  }
  const ran = async () => ({
    approvals: (await statuses())["appr_turn-due"],
    exports: await db.prepare("SELECT status FROM exports WHERE id = 'e1'").first("status"),
    retention: await count("audit_log", "action = 'retention.sweep' AND user_id IS NULL"),
  });

  it("runs rotation, the allowance warning, the export sweep, retention and approval expiry", async () => {
    expect(Object.keys(reconcilerParts).sort()).toEqual([
      "allowances",
      "approvals",
      "exports",
      "retention",
      "rotation",
    ]);
    await dueWork();
    await Promise.all(reconcile(env, NOW));
    expect(await ran()).toEqual({ approvals: "expired", exports: "expired", retention: 1 });
  });

  it("runs the other parts when one throws or rejects", async () => {
    await dueWork();
    const settled = await Promise.allSettled(
      reconcile(Promise.resolve(env), NOW, {
        ...reconcilerParts,
        rotation: async () => {
          throw new Error("vault down");
        },
        allowances: () => Promise.reject(new TypeError("no owner")),
      }),
    );
    // Each part logs its own failure: none rejects the tick's `waitUntil`.
    expect(settled.every((s) => s.status === "fulfilled")).toBe(true);
    expect(await ran()).toEqual({ approvals: "expired", exports: "expired", retention: 1 });
  });

  it("logs every part's failure when the environment can't be composed", async () => {
    const settled = await Promise.allSettled(reconcile(Promise.reject(new Error("no keys")), NOW));
    expect(settled.map((s) => s.status)).toEqual(Array(5).fill("fulfilled"));
  });
});
