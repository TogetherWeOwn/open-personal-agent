// SPDX-License-Identifier: Apache-2.0
// The computer lifecycle (M4-02): the owner record, mode-A borrowing with its 60 s idle tail,
// idle/lifetime/task enforcement in the sweep, the provider-orphan leg, and account deletion
// through the provider API — all against a fake driver, since no provider is configured yet.
import {
  MintRefusedError,
  mintCapabilityToken,
  verifyCapabilityToken,
} from "@opa/db/capability-tokens";
import { computerStore } from "@opa/db/computers";
import { deleteUserData } from "@opa/db/deletion";
import { createRepository, scopeFromSession } from "@opa/db/repository";
import type { SqlDatabase } from "@opa/db/system";
import {
  borrowComputer,
  type ComputerDriver,
  sweepComputers,
  touchComputer,
} from "@opa/server/computers";
import { describe, expect, it } from "vitest";
import { count, db, env, freshDatabase } from "./helpers/app";

freshDatabase();

const NOW = 1_750_000_000_000;
const HOUR = 3_600_000;

const scopeOf = (userId: string) => scopeFromSession({ userId });

async function seedUser(userId: string, taskIds: string[] = ["t1"], status = "running") {
  await db
    .prepare("INSERT INTO users (id, display_name, role) VALUES (?, ?, 'owner')")
    .bind(userId, userId)
    .run();
  await db
    .prepare("INSERT INTO conversations (id, user_id) VALUES (?, ?)")
    .bind(`c-${userId}`, userId)
    .run();
  for (const taskId of taskIds) {
    await db
      .prepare(
        "INSERT INTO tasks (id, user_id, conversation_id, kind, mode, status) VALUES (?, ?, ?, 'turn', 'background', ?)",
      )
      .bind(taskId, userId, `c-${userId}`, status)
      .run();
  }
}

const seedComputer = (
  userId: string,
  taskId: string | null,
  overrides: { idleDeadline?: number; lifetimeDeadline?: number; lastUsedAt?: number } = {},
) =>
  computerStore(env)
    .create(
      {
        userId,
        provider: "fake",
        profile: "standard-1",
        providerComputerId: `pc-${userId}-${taskId ?? "unbound"}`,
        taskId,
        disks: ["disk-1"],
        snapshots: ["snap-1"],
      },
      NOW,
    )
    .then(async (row) => {
      if (
        overrides.lastUsedAt !== undefined ||
        overrides.idleDeadline !== undefined ||
        overrides.lifetimeDeadline !== undefined
      ) {
        await db.batch([
          db
            .prepare(
              "UPDATE computers SET last_used_at = ?, idle_deadline = ?, lifetime_deadline = ? WHERE id = ?",
            )
            .bind(
              overrides.lastUsedAt ?? row.lastUsedAt,
              overrides.idleDeadline ?? row.idleDeadline,
              overrides.lifetimeDeadline ?? row.lifetimeDeadline,
              row.id,
            ),
        ]);
      }
      const created = await computerStore(env).get(row.id);
      if (!created) throw new Error("seed computer missing");
      return created;
    });

/** A driver with no provider behind it: records destroys, lists nothing by default. */
function fakeDriver(impl: Partial<ComputerDriver> = {}): ComputerDriver & {
  created: number;
  destroyed: { id: string; resources: unknown }[];
} {
  let created = 0;
  const destroyed: { id: string; resources: unknown }[] = [];
  return {
    get created() {
      return created;
    },
    destroyed,
    create: async () => {
      created += 1;
      return { providerComputerId: `pc-new-${created}` };
    },
    destroy: async (id: string, resources: unknown) => {
      destroyed.push({ id, resources });
      return {};
    },
    list: async () => [],
    ...impl,
  };
}

const spec = (taskId: string) => ({
  taskId,
  provider: "fake",
  profile: "standard-1",
});

const auditActions = (userId: string) =>
  db
    .prepare(
      "SELECT action, target_id, result, detail FROM audit_log WHERE user_id = ? ORDER BY id",
    )
    .bind(userId)
    .all<{ action: string; target_id: string | null; result: string; detail: string | null }>()
    .then((r) => r.results);

describe("mode-A borrowing (AC2)", () => {
  it("creates the task's computer on first borrow, with deadlines and an audit row", async () => {
    await seedUser("u1");
    const driver = fakeDriver();
    const { computer, reused } = await borrowComputer(env, scopeOf("u1"), spec("t1"), driver, NOW);
    expect(reused).toBe(false);
    expect(driver.created).toBe(1);
    expect(computer).toMatchObject({
      userId: "u1",
      provider: "fake",
      profile: "standard-1",
      providerComputerId: "pc-new-1",
      taskId: "t1",
      state: "ready",
    });
    expect(computer.idleDeadline).toBe(NOW + 300_000);
    expect(computer.lifetimeDeadline).toBe(NOW + 3_600_000);
    expect(await auditActions("u1")).toMatchObject([{ action: "computer.create", result: "ok" }]);
  });

  it("reuses the task's computer within the 60 s idle tail without creating", async () => {
    await seedUser("u1");
    const driver = fakeDriver();
    const first = await borrowComputer(env, scopeOf("u1"), spec("t1"), driver, NOW);
    const second = await borrowComputer(env, scopeOf("u1"), spec("t1"), driver, NOW + 59_000);
    expect(second.reused).toBe(true);
    expect(second.computer.id).toBe(first.computer.id);
    expect(driver.created).toBe(1);
    expect(second.computer.lastUsedAt).toBe(NOW + 59_000);
    // No heartbeat audit row: the create and the eventual destroy bracket the session.
    expect((await auditActions("u1")).map((a) => a.action)).toEqual(["computer.create"]);
  });

  it("replaces the task's computer past the tail, destroying the old one first", async () => {
    await seedUser("u1");
    const driver = fakeDriver();
    const first = await borrowComputer(env, scopeOf("u1"), spec("t1"), driver, NOW);
    const second = await borrowComputer(env, scopeOf("u1"), spec("t1"), driver, NOW + 61_000);
    expect(second.reused).toBe(false);
    expect(second.computer.id).not.toBe(first.computer.id);
    expect(driver.destroyed.map((d) => d.id)).toEqual(["pc-new-1"]);
    const ended = await computerStore(env).get(first.computer.id);
    expect(ended?.state).toBe("destroyed");
    expect(ended?.endReason).toBe("replaced");
    expect(await count("computer_sessions", `computer_id = '${first.computer.id}'`)).toBe(1);
  });

  it("destroys another task's computer: one computer per user (D5)", async () => {
    await seedUser("u1", ["t1", "t2"]);
    const driver = fakeDriver();
    const first = await borrowComputer(env, scopeOf("u1"), spec("t1"), driver, NOW);
    const second = await borrowComputer(env, scopeOf("u1"), spec("t2"), driver, NOW + 1_000);
    expect(driver.destroyed.map((d) => d.id)).toEqual([first.computer.providerComputerId]);
    expect((await computerStore(env).get(first.computer.id))?.state).toBe("destroyed");
    expect(second.computer.taskId).toBe("t2");
  });

  it("refuses another user's task and a finished task", async () => {
    await seedUser("u1");
    await seedUser("u2", ["t2"]);
    const driver = fakeDriver();
    await expect(borrowComputer(env, scopeOf("u1"), spec("t2"), driver, NOW)).rejects.toThrow(
      "computer_no_task",
    );
    expect(driver.created).toBe(0);
    await db
      .prepare("UPDATE tasks SET status = 'succeeded', finished_at = ? WHERE id = 't1'")
      .bind(NOW)
      .run();
    await expect(borrowComputer(env, scopeOf("u1"), spec("t1"), driver, NOW)).rejects.toThrow(
      "computer_task_ended",
    );
  });

  it("aborts the borrow when the old computer's provider destroy fails", async () => {
    await seedUser("u1", ["t1", "t2"]);
    const driver = fakeDriver();
    const first = await borrowComputer(env, scopeOf("u1"), spec("t1"), driver, NOW);
    const failing = fakeDriver({
      destroy: async () => {
        throw new Error("provider down");
      },
    });
    await expect(
      borrowComputer(env, scopeOf("u1"), spec("t2"), failing, NOW + 1_000),
    ).rejects.toThrow("computer_replace_failed");
    // Nothing was created on top of the live row: still one live computer, no ledger.
    expect(failing.created).toBe(0);
    expect((await computerStore(env).get(first.computer.id))?.state).toBe("ready");
    expect(await count("computers", "state <> 'destroyed'")).toBe(1);
    expect(await count("computer_sessions")).toBe(0);
  });

  it("racing borrows for one user leave one live computer", async () => {
    await seedUser("u1");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let providerCreates = 0;
    const driver = fakeDriver({
      create: async () => {
        await gate;
        providerCreates += 1;
        return { providerComputerId: `pc-new-${providerCreates}` };
      },
    });
    const both = Promise.all([
      borrowComputer(env, scopeOf("u1"), spec("t1"), driver, NOW),
      borrowComputer(env, scopeOf("u1"), spec("t1"), driver, NOW),
    ]);
    release();
    const [a, b] = await both;
    // One borrow created, the other reused the winner — never two live rows. The
    // loser's provider-side computer is destroyed inline: it never had a D1 row.
    expect([a.reused, b.reused].sort()).toEqual([false, true]);
    expect(a.computer.id).toBe(b.computer.id);
    expect(await count("computers", "state <> 'destroyed'")).toBe(1);
    expect(await count("computer_sessions")).toBe(0);
    const winnerPc = a.computer.providerComputerId;
    expect(driver.destroyed.map((d) => d.id)).toEqual([
      winnerPc === "pc-new-1" ? "pc-new-2" : "pc-new-1",
    ]);
  });

  it("destroys the provisioned computer when the D1 insert fails for another reason", async () => {
    await seedUser("u1");
    const driver = fakeDriver();
    await expect(
      borrowComputer(env, scopeOf("u1"), { ...spec("t1"), idleTimeoutSeconds: 0 }, driver, NOW),
    ).rejects.toThrow("invalid idle timeout");
    // The provider computer was created first, then cleaned up: no row, no leak.
    expect(driver.created).toBe(1);
    expect(driver.destroyed.map((d) => d.id)).toEqual(["pc-new-1"]);
    expect(await count("computers")).toBe(0);
  });

  it("replaces a computer past its idle deadline even within the 60 s tail", async () => {
    await seedUser("u1");
    const driver = fakeDriver();
    const first = await borrowComputer(env, scopeOf("u1"), spec("t1"), driver, NOW);
    await db
      .prepare("UPDATE computers SET idle_deadline = ? WHERE id = ?")
      .bind(NOW + 30_000, first.computer.id)
      .run();
    const second = await borrowComputer(env, scopeOf("u1"), spec("t1"), driver, NOW + 59_000);
    // Within the tail, but the idle deadline already passed: replace, not reuse.
    expect(second.reused).toBe(false);
    expect(second.computer.id).not.toBe(first.computer.id);
    expect(driver.destroyed.map((d) => d.id)).toEqual([first.computer.providerComputerId]);
    expect((await computerStore(env).get(first.computer.id))?.endReason).toBe("replaced");
  });

  it("replaces a computer past its lifetime deadline even within the tail", async () => {
    await seedUser("u1");
    const driver = fakeDriver();
    const first = await borrowComputer(env, scopeOf("u1"), spec("t1"), driver, NOW);
    await db
      .prepare("UPDATE computers SET lifetime_deadline = ? WHERE id = ?")
      .bind(NOW + 30_000, first.computer.id)
      .run();
    // Last use is seconds ago and the idle deadline is fresh, but the lifetime
    // deadline passed: replace, so the sweep does not kill the just-borrowed row.
    const second = await borrowComputer(env, scopeOf("u1"), spec("t1"), driver, NOW + 59_000);
    expect(second.reused).toBe(false);
    expect(second.computer.id).not.toBe(first.computer.id);
    expect(driver.destroyed.map((d) => d.id)).toEqual([first.computer.providerComputerId]);
  });

  it("enforces the deployment-wide concurrency cap before creating", async () => {
    await seedUser("u1");
    await seedUser("u2", ["t2"]);
    await seedUser("u3", ["t3"]);
    await seedUser("u4", ["t4"]);
    const store = computerStore(env);
    // One live computer per user (D5): the cap fills across three users.
    await store.create(
      { userId: "u2", provider: "fake", profile: "s", providerComputerId: "pc-a", taskId: "t2" },
      NOW,
    );
    await store.create(
      { userId: "u3", provider: "fake", profile: "s", providerComputerId: "pc-b", taskId: "t3" },
      NOW,
    );
    await store.create(
      { userId: "u4", provider: "fake", profile: "s", providerComputerId: "pc-c", taskId: "t4" },
      NOW,
    );
    const driver = fakeDriver();
    await expect(borrowComputer(env, scopeOf("u1"), spec("t1"), driver, NOW)).rejects.toThrow(
      "computer_limit",
    );
    expect(driver.created).toBe(0);
    expect(await auditActions("u1")).toEqual([]);
  });
});

describe("touch and scope (AC1)", () => {
  it("heartbeats the caller's computer and pushes its idle deadline out", async () => {
    await seedUser("u1");
    const driver = fakeDriver();
    const { computer } = await borrowComputer(env, scopeOf("u1"), spec("t1"), driver, NOW);
    const touched = await touchComputer(env, scopeOf("u1"), computer.id, NOW + 10_000);
    expect(touched?.idleDeadline).toBe(NOW + 10_000 + 300_000);
  });

  it("touches nothing for an unknown id, a provider-side id, or another user's row", async () => {
    await seedUser("u1");
    await seedUser("u2", ["t2"]);
    const driver = fakeDriver();
    const { computer } = await borrowComputer(env, scopeOf("u2"), spec("t2"), driver, NOW);
    expect(await touchComputer(env, scopeOf("u1"), "nope", NOW)).toBeNull();
    // The provider-side id is not an identity: it mints nothing and touches nothing.
    expect(await touchComputer(env, scopeOf("u2"), computer.providerComputerId, NOW)).toBeNull();
    expect(await touchComputer(env, scopeOf("u1"), computer.id, NOW)).toBeNull();
    expect((await computerStore(env).get(computer.id))?.lastUsedAt).toBe(NOW);
  });

  it("mints a working scope from the row, and the feed lists live computers only", async () => {
    await seedUser("u1");
    const driver = fakeDriver();
    const { computer } = await borrowComputer(env, scopeOf("u1"), spec("t1"), driver, NOW);
    const repo = createRepository(env);
    const found = await repo.scopeForComputer(computer.id);
    expect(found?.computer.id).toBe(computer.id);
    expect(found?.scope.userId).toBe("u1");
    // The minted scope authorizes, so the feed is the row's own user's.
    if (!found) throw new Error("scope not minted");
    const feed = await repo.forUser(found.scope).computers.list();
    expect(feed.map((c) => c.id)).toEqual([computer.id]);
    expect(await repo.scopeForComputer("nope")).toBeNull();
    // The sweep destroys through the wired driver, so the finished row leaves the feed.
    await sweepComputers(env, driver, NOW + HOUR);
    expect(await repo.forUser(found.scope).computers.list()).toEqual([]);
  });
});

describe("the sweep without a provider fails closed (AC3)", () => {
  it("leaves an idle-expired computer live, counts it as an error, and writes no rows", async () => {
    await seedUser("u1");
    const row = await seedComputer("u1", "t1", { idleDeadline: NOW + 1, lastUsedAt: NOW });
    const summary = await sweepComputers(env, undefined, NOW + 2);
    expect(summary).toMatchObject({ idle: 0, lifetime: 0, taskEnded: 0, orphans: 0, errors: 1 });
    // The row stays live with no session, ledger or destroy-audit row: finishing it would
    // strand a billing computer with no owner record.
    expect((await computerStore(env).get(row.id))?.state).toBe("ready");
    expect(await count("computer_sessions")).toBe(0);
    expect((await auditActions("u1")).map((a) => a.action)).toEqual(["computer.create"]);
  });

  it("leaves a lifetime-expired computer live even while it is in use", async () => {
    await seedUser("u1");
    const row = await seedComputer("u1", "t1", {
      lastUsedAt: NOW,
      idleDeadline: NOW + HOUR,
      lifetimeDeadline: NOW + 1,
    });
    const summary = await sweepComputers(env, undefined, NOW + 2);
    expect(summary).toMatchObject({ lifetime: 0, errors: 1 });
    expect((await computerStore(env).get(row.id))?.state).toBe("ready");
    expect(await count("computer_sessions")).toBe(0);
  });

  it("leaves a computer whose task was cancelled live, and spares an unbound one", async () => {
    await seedUser("u1", ["t1"]);
    await seedUser("u2", ["t2"]);
    const bound = await seedComputer("u1", "t1");
    // One live computer per user (D5): the unbound computer belongs to another user.
    const unbound = await seedComputer("u2", null);
    await db
      .prepare("UPDATE tasks SET status = 'cancelled', finished_at = ? WHERE id = 't1'")
      .bind(NOW)
      .run();
    const summary = await sweepComputers(env, undefined, NOW + 1);
    expect(summary).toMatchObject({ taskEnded: 0, errors: 1 });
    expect((await computerStore(env).get(bound.id))?.state).toBe("ready");
    expect((await computerStore(env).get(unbound.id))?.state).toBe("ready");
  });

  it("fails closed without a driver, then destroys the same row once one is wired", async () => {
    await seedUser("u1");
    const row = await seedComputer("u1", "t1", { idleDeadline: NOW + 1, lastUsedAt: NOW });
    const closed = await sweepComputers(env, undefined, NOW + 2);
    expect(closed).toMatchObject({ idle: 0, errors: 1 });
    expect((await computerStore(env).get(row.id))?.state).toBe("ready");
    expect(await count("computer_sessions")).toBe(0);
    // With a driver wired, the existing sweep behaviour is unchanged.
    const driver = fakeDriver();
    const open = await sweepComputers(env, driver, NOW + 3);
    expect(open).toMatchObject({ idle: 1, errors: 0 });
    expect(driver.destroyed.map((d) => d.id)).toEqual([row.providerComputerId]);
    expect((await computerStore(env).get(row.id))?.endReason).toBe("idle");
  });

  it("leaves a live computer alone and writes no audit rows for it", async () => {
    await seedUser("u1");
    await seedComputer("u1", "t1");
    const summary = await sweepComputers(env, undefined, NOW + 1);
    expect(summary).toEqual({ idle: 0, lifetime: 0, taskEnded: 0, orphans: 0, errors: 0 });
    expect((await auditActions("u1")).map((a) => a.action)).toEqual(["computer.create"]);
  });
});

describe("the sweep with a provider (AC3, COST-6)", () => {
  it("destroys provider orphans no D1 row claims, and records each", async () => {
    await seedUser("u1");
    const row = await seedComputer("u1", "t1");
    // The provider lists the live row's own computer too: claimed after the listing,
    // it is not mistaken for an orphan.
    const driver = fakeDriver({
      list: async () => [
        { providerComputerId: "pc-ghost" },
        { providerComputerId: row.providerComputerId },
      ],
    });
    const summary = await sweepComputers(env, driver, NOW + 1);
    expect(summary.orphans).toBe(1);
    expect(driver.destroyed.map((d) => d.id).sort()).toEqual(["pc-ghost"]);
    expect((await computerStore(env).get(row.id))?.state).toBe("ready");
    const swept = await db
      .prepare("SELECT target_id, result FROM audit_log WHERE action = 'computer.swept'")
      .all<{ target_id: string; result: string }>();
    expect(swept.results).toEqual([{ target_id: "pc-ghost", result: "ok" }]);
  });

  it("a provider destroy that throws leaves the row live for the next tick", async () => {
    await seedUser("u1");
    const row = await seedComputer("u1", "t1", { idleDeadline: NOW + 1 });
    const driver = fakeDriver({
      destroy: async () => {
        throw new Error("provider down");
      },
    });
    const summary = await sweepComputers(env, driver, NOW + 2);
    expect(summary).toMatchObject({ idle: 0, errors: 1 });
    expect((await computerStore(env).get(row.id))?.state).toBe("ready");
    expect(await count("computer_sessions")).toBe(0);
  });

  it("enforces the D1 deadlines even when the provider listing fails", async () => {
    await seedUser("u1");
    const row = await seedComputer("u1", "t1", { idleDeadline: NOW + 1 });
    const driver = fakeDriver({
      list: async () => {
        throw new Error("provider down");
      },
    });
    const summary = await sweepComputers(env, driver, NOW + 2);
    expect(summary).toMatchObject({ idle: 1, errors: 1 });
    expect((await computerStore(env).get(row.id))?.state).toBe("destroyed");
  });
});

describe("finish (COST-9)", () => {
  it("revokes tokens at the provider/sweep finish boundary without ending the task or another computer", async () => {
    await seedUser("u1");
    await seedUser("u2", ["t2"]);
    const doomed = await seedComputer("u1", "t1", { idleDeadline: NOW + 1 });
    const spared = await seedComputer("u2", "t2");
    const sqlDb = db as unknown as SqlDatabase;
    const options = {
      userId: "u1",
      taskId: "t1",
      computerId: doomed.id,
      aud: "tool_gateway",
      now: NOW,
    };
    const first = await mintCapabilityToken(sqlDb, options);
    const other = await mintCapabilityToken(sqlDb, {
      ...options,
      userId: "u2",
      taskId: "t2",
      computerId: spared.id,
    });
    const verify = (token: string) =>
      verifyCapabilityToken(sqlDb, { token, expectedAud: "tool_gateway", now: NOW + 2 });
    const failed = await sweepComputers(
      env,
      fakeDriver({
        destroy: async () => {
          throw new Error("provider down");
        },
      }),
      NOW + 2,
    );
    expect(failed.errors).toBe(1);
    expect(await verify(first.token)).not.toBeNull();
    const driver = fakeDriver();
    expect((await sweepComputers(env, driver, NOW + 2)).idle).toBe(1);
    expect(driver.destroyed.map((d) => d.id)).toEqual([doomed.providerComputerId]);
    expect(await verify(first.token)).toBeNull();
    expect(await verify(other.token)).not.toBeNull();
    await expect(mintCapabilityToken(sqlDb, options)).rejects.toBeInstanceOf(MintRefusedError);
    expect(
      await db.prepare("SELECT status, token_epoch FROM tasks WHERE id = 't1'").first(),
    ).toMatchObject({ status: "running", token_epoch: 0 });
    expect(
      await db
        .prepare("SELECT revoked_reason FROM capability_tokens WHERE id = ?")
        .bind(first.id)
        .first(),
    ).toEqual({ revoked_reason: "idle" });
    expect(await count("computer_sessions")).toBe(1);
  });

  it("a racing second finish writes no second ledger row", async () => {
    await seedUser("u1");
    const row = await seedComputer("u1", "t1");
    const store = computerStore(env);
    expect(await store.finish(row.id, "idle", NOW)).not.toBeNull();
    expect(await store.finish(row.id, "idle", NOW)).toBeNull();
    expect(await count("computer_sessions", `computer_id = '${row.id}'`)).toBe(1);
    expect((await computerStore(env).get(row.id))?.endReason).toBe("idle");
  });
});

describe("account deletion (AC5)", () => {
  it("destroys the user's computers, disks and snapshots through the provider API and names them", async () => {
    await seedUser("u1");
    const destroyed: { providerComputerId: string; disks: string[]; snapshots: string[] }[] = [];
    const store = computerStore(env);
    const row = await store.create(
      {
        userId: "u1",
        provider: "fake",
        profile: "standard-1",
        providerComputerId: "pc-1",
        taskId: "t1",
        disks: ["disk-1"],
        snapshots: ["snap-1"],
      },
      NOW,
    );
    const result = await deleteUserData(env, "u1", NOW + 1, {
      destroyComputer: async (target) => {
        destroyed.push(target);
      },
    });
    expect(destroyed).toEqual([
      { providerComputerId: "pc-1", disks: ["disk-1"], snapshots: ["snap-1"] },
    ]);
    expect(result?.computers).toEqual([
      {
        id: row.id,
        provider: "fake",
        profile: "standard-1",
        providerComputerId: "pc-1",
        disks: ["disk-1"],
        snapshots: ["snap-1"],
      },
    ]);
    // The cascade takes the finished rows with the user.
    expect(await count("computers")).toBe(0);
    expect(await count("computer_sessions")).toBe(0);
    const trail = await db
      .prepare("SELECT detail FROM audit_log WHERE action = 'account.delete'")
      .first<string>("detail");
    expect(JSON.parse(trail ?? "{}")).toMatchObject({ unclaimed: true, computers: ["pc-1"] });
  });

  it("refuses when computers exist but no destroyer is wired, and when the provider fails", async () => {
    await seedUser("u1");
    await seedComputer("u1", "t1");
    await expect(deleteUserData(env, "u1", NOW)).rejects.toThrow("computer destroy unavailable");
    expect(await count("computers")).toBe(1);
    await expect(
      deleteUserData(env, "u1", NOW, {
        destroyComputer: async () => {
          throw new Error("provider down");
        },
      }),
    ).rejects.toThrow("provider down");
    // Fail closed: the row is still live, with no session or destroy audit behind it.
    expect(await count("computers", "state <> 'destroyed'")).toBe(1);
    expect(await count("computer_sessions")).toBe(0);
  });
});
