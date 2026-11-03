// SPDX-License-Identifier: Apache-2.0
// The computer owner-record store (M4-02 AC1, AC4–AC5): deployment-level, like the retention
// and export stores, taking the raw DB binding — scoped code never touches these rows except
// through `scopeForComputer` (minted here, confined by the lint to the lifecycle module) and
// `forUser(scope).computers`. The provider-side id is opaque bookkeeping: every lookup keys on
// the row's own `id`, never on it (T14).
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { revokeTokenAuditStatement, revokeTokenStatements } from "./capability-tokens";
import { openD1 } from "./index";
import { type DataBindings, isId } from "./repository";
import { auditLog, computerSessions, computers, tasks } from "./schema";
import type { SqlDatabase } from "./system";

/** A mode-A borrow reuses the task's computer when the last use is this recent (ADR 0007 #5). */
export const COMPUTER_IDLE_TAIL_MS = 60_000;
/** Defaults the lifecycle requires when a borrow names none (M4-01 AC2, COST-6). */
export const COMPUTER_IDLE_TIMEOUT_DEFAULT_S = 300;
export const COMPUTER_MAX_LIFETIME_DEFAULT_S = 3_600;
/** Deployment-wide cap on live computers (COST-2). */
export const COMPUTER_CONCURRENCY_CAP = 3;

export type ComputerState = typeof computers.$inferSelect.state;
export type ComputerEndReason = NonNullable<typeof computers.$inferSelect.endReason>;
export type ComputerRow = typeof computers.$inferSelect;
export type ComputerSessionRow = typeof computerSessions.$inferSelect;

/** What a borrow files for a computer that does not exist yet. */
export interface NewComputer {
  userId: string;
  provider: string;
  profile: string;
  providerComputerId: string;
  taskId: string | null;
  disks?: string[] | undefined;
  snapshots?: string[] | undefined;
  idleTimeoutSeconds?: number | undefined;
  maxLifetimeSeconds?: number | undefined;
}

/** A provider-side computer as the lifecycle names it for destruction and reports (AC5). */
export interface DestroyReport {
  id: string;
  provider: string;
  profile: string;
  providerComputerId: string;
  disks: string[];
  snapshots: string[];
}

const check = (id: string, what: string): string => {
  if (!isId(id)) throw new Error(`invalid ${what} id`);
  return id;
};

const jsonArray = (names: string[] | undefined): string => JSON.stringify(names ?? []);

const parseNames = (value: string | null): string[] => {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
};

const auditDetail = (
  reason: string,
  provider: string,
  profile: string,
  taskId: string | null,
): Record<string, unknown> => ({ reason, provider, profile, taskId });

const audit = (
  userId: string,
  action: string,
  targetId: string | null,
  detail: Record<string, unknown>,
) => ({
  userId,
  action,
  module: "computers",
  targetId,
  result: "ok" as const,
  detail: JSON.stringify(detail),
});

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error && /UNIQUE constraint failed|unique/i.test(error.message);

export function computerStore(bindings: Pick<DataBindings<unknown, unknown>, "DB">) {
  const db = openD1(bindings.DB);
  const tokenDb = bindings.DB as unknown as SqlDatabase;

  /**
   * Ends a live computer whatever ended it: the row moves to `destroyed`, one session row
   * lands in the ledger (COST-9), and the destroy is audited with its reason (AC4). `null`
   * when the row was already destroyed — a racing tick writes nothing twice.
   *
   * One D1 batch claims the row and writes the ledger and audit together, from a prior
   * read: if the batch fails, the row is still live and the next tick retries whole. The
   * ledger's one-row-per-computer index makes a racing second finish fail the batch
   * instead of ledgering twice, and the guarded `SELECT` inserts write nothing when the
   * claim matched no row. A row found already destroyed but ledger-less (a batch that
   * failed between an old two-step claim and its writes) is healed here, once.
   */
  const finish = async (
    id: string,
    reason: ComputerEndReason,
    now: number,
  ): Promise<{ computer: ComputerRow; session: ComputerSessionRow } | null> => {
    const [row] = await db
      .select()
      .from(computers)
      .where(eq(computers.id, check(id, "computer")))
      .limit(1);
    if (!row) return null;
    const revoke = (endReason: ComputerEndReason) => [
      ...revokeTokenStatements(tokenDb, {
        userId: row.userId,
        computerId: row.id,
        reason: endReason,
        now,
      }),
      revokeTokenAuditStatement(tokenDb, {
        userId: row.userId,
        targetId: row.id,
        action: "capability_token.revoke_computer",
        reason: endReason,
        now,
        onlyIfRevoked: true,
      }),
    ];
    if (row.state === "destroyed") {
      const [existing] = await db
        .select({ id: computerSessions.id })
        .from(computerSessions)
        .where(eq(computerSessions.computerId, row.id))
        .limit(1);
      const healedReason = row.endReason ?? reason;
      if (existing) {
        // Historical finishes may predate token integration, even with a complete ledger.
        await tokenDb.batch(revoke(healedReason));
        return null;
      }
      const healedEndedAt = row.endedAt ?? now;
      const healed: ComputerSessionRow = {
        id: crypto.randomUUID(),
        userId: row.userId,
        computerId: row.id,
        taskId: row.taskId,
        provider: row.provider,
        profile: row.profile,
        providerComputerId: row.providerComputerId,
        startedAt: row.createdAt,
        endedAt: healedEndedAt,
        endReason: healedReason,
        createdAt: now,
      };
      await tokenDb.batch([
        ...revoke(healedReason),
        db.$client
          .prepare(
            `INSERT INTO computer_sessions (id, user_id, computer_id, task_id, provider, profile,
               provider_computer_id, started_at, ended_at, end_reason, created_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM computer_sessions WHERE computer_id = ?)`,
          )
          .bind(
            healed.id,
            healed.userId,
            healed.computerId,
            healed.taskId,
            healed.provider,
            healed.profile,
            healed.providerComputerId,
            healed.startedAt,
            healed.endedAt,
            healed.endReason,
            healed.createdAt,
            healed.computerId,
          ),
        db.$client
          .prepare(
            `INSERT INTO audit_log (user_id, action, module, target_id, result, detail)
             SELECT ?, 'computer.destroyed', 'computers', ?, 'ok', ?
             WHERE NOT EXISTS (SELECT 1 FROM audit_log
               WHERE action = 'computer.destroyed' AND target_id = ?)`,
          )
          .bind(
            healed.userId,
            healed.computerId,
            JSON.stringify(
              auditDetail(healedReason, healed.provider, healed.profile, healed.taskId),
            ),
            healed.computerId,
          ),
      ]);
      return { computer: row, session: healed };
    }
    const session: ComputerSessionRow = {
      id: crypto.randomUUID(),
      userId: row.userId,
      computerId: row.id,
      taskId: row.taskId,
      provider: row.provider,
      profile: row.profile,
      providerComputerId: row.providerComputerId,
      startedAt: row.createdAt,
      endedAt: now,
      endReason: reason,
      createdAt: now,
    };
    let changed: number;
    try {
      const [updated] = await tokenDb.batch([
        db.$client
          .prepare(
            `UPDATE computers SET state = 'destroyed', ended_at = ?, end_reason = ?,
               updated_at = ? WHERE id = ? AND state <> 'destroyed'`,
          )
          .bind(now, reason, now, row.id),
        ...revoke(reason),
        db.$client
          .prepare(
            `INSERT INTO computer_sessions (id, user_id, computer_id, task_id, provider, profile,
               provider_computer_id, started_at, ended_at, end_reason, created_at)
             SELECT ?, user_id, id, task_id, provider, profile, provider_computer_id,
               created_at, ?, ?, ? FROM computers
             WHERE id = ? AND state = 'destroyed' AND ended_at = ? AND end_reason = ?
             AND NOT EXISTS (SELECT 1 FROM computer_sessions WHERE computer_id = ?)`,
          )
          .bind(
            session.id,
            session.endedAt,
            session.endReason,
            session.createdAt,
            row.id,
            now,
            reason,
            row.id,
          ),
        db.$client
          .prepare(
            `INSERT INTO audit_log (user_id, action, module, target_id, result, detail)
             SELECT user_id, 'computer.destroyed', 'computers', ?, 'ok', ? FROM computers
             WHERE id = ?
             AND NOT EXISTS (SELECT 1 FROM audit_log
               WHERE action = 'computer.destroyed' AND target_id = ?)`,
          )
          .bind(
            row.id,
            JSON.stringify(auditDetail(reason, row.provider, row.profile, row.taskId)),
            row.id,
            row.id,
          ),
      ]);
      changed = updated?.meta.changes ?? 0;
    } catch (error) {
      // A racing finish ledgered this computer first: the one-row-per-computer index
      // rejects ours, rolling the batch back. Nothing was destroyed by us.
      if (isUniqueViolation(error)) return null;
      throw error;
    }
    if (changed === 0) return null;
    return {
      computer: { ...row, state: "destroyed", endedAt: now, endReason: reason, updatedAt: now },
      session,
    };
  };

  return {
    /** By the row's own id only — never by the provider-side id (T14). */
    get: async (id: string): Promise<ComputerRow | null> =>
      (
        await db
          .select()
          .from(computers)
          .where(eq(computers.id, check(id, "computer")))
          .limit(1)
      )[0] ?? null,

    /** Every live computer, whoever owns it: the sweep and the running list read this. */
    listActive: (): Promise<ComputerRow[]> =>
      db
        .select()
        .from(computers)
        .where(ne(computers.state, "destroyed"))
        .orderBy(desc(computers.createdAt)),

    listActiveForUser: (userId: string): Promise<ComputerRow[]> =>
      db
        .select()
        .from(computers)
        .where(and(eq(computers.userId, check(userId, "user")), ne(computers.state, "destroyed")))
        .orderBy(desc(computers.createdAt)),

    countActive: async (): Promise<number> =>
      (
        await db
          .select({ id: computers.id })
          .from(computers)
          .where(ne(computers.state, "destroyed"))
      ).length,

    /**
     * Live computers with their task's status beside them, for the sweep: one query, so a
     * task that ended since the last tick is seen in the same tick that destroys for it.
     */
    activeWithTasks: (): Promise<
      { computer: ComputerRow; taskStatus: string | null; taskUserId: string | null }[]
    > =>
      db
        .select({
          computer: computers,
          taskStatus: tasks.status,
          taskUserId: tasks.userId,
        })
        .from(computers)
        .leftJoin(tasks, eq(tasks.id, computers.taskId))
        .where(ne(computers.state, "destroyed")),

    create: async (input: NewComputer, now: number): Promise<ComputerRow> => {
      const idleTimeoutSeconds = input.idleTimeoutSeconds ?? COMPUTER_IDLE_TIMEOUT_DEFAULT_S;
      const maxLifetimeSeconds = input.maxLifetimeSeconds ?? COMPUTER_MAX_LIFETIME_DEFAULT_S;
      if (!Number.isInteger(idleTimeoutSeconds) || idleTimeoutSeconds <= 0) {
        throw new Error("invalid idle timeout");
      }
      if (!Number.isInteger(maxLifetimeSeconds) || maxLifetimeSeconds <= 0) {
        throw new Error("invalid max lifetime");
      }
      const id = crypto.randomUUID();
      const row = {
        id,
        userId: check(input.userId, "user"),
        provider: input.provider,
        profile: input.profile,
        providerComputerId: input.providerComputerId,
        taskId: input.taskId === null ? null : check(input.taskId, "task"),
        disks: jsonArray(input.disks),
        snapshots: jsonArray(input.snapshots),
        idleTimeoutSeconds,
        maxLifetimeSeconds,
        state: "ready" as const,
        lastUsedAt: now,
        idleDeadline: now + idleTimeoutSeconds * 1000,
        lifetimeDeadline: now + maxLifetimeSeconds * 1000,
        createdAt: now,
        updatedAt: now,
      };
      await db.batch([
        db.insert(computers).values(row),
        db.insert(auditLog).values([
          audit(row.userId, "computer.create", id, {
            provider: row.provider,
            profile: row.profile,
            taskId: row.taskId,
          }),
        ]),
      ]);
      const [created] = await db.select().from(computers).where(eq(computers.id, id)).limit(1);
      if (!created) throw new Error("computer create failed");
      return created;
    },

    /**
     * A tool call used the computer: stamp the use and push the idle deadline out by the
     * row's own idle timeout — not by the borrow's 60 s reuse tail, which only decides
     * whether a borrow reuses the row at all. `null` when it is already gone, so the caller
     * borrows anew. Heartbeats write no audit row; the create and the eventual destroy
     * bracket the session (AC4).
     */
    heartbeat: async (id: string, now: number): Promise<ComputerRow | null> =>
      (
        await db
          .update(computers)
          .set({
            lastUsedAt: now,
            idleDeadline: sql`${now} + ${computers.idleTimeoutSeconds} * 1000`,
            updatedAt: now,
          })
          .where(and(eq(computers.id, check(id, "computer")), eq(computers.state, "ready")))
          .returning()
      )[0] ?? null,

    /** Ends a live computer whatever ended it; see `finish` above. */
    finish,

    /**
     * A provider-listed computer no D1 row knows (or no live row claims): nothing to finish,
     * so the sweep is recorded as its own audit row with the provider-side id it acted on
     * (AC3 "records what it did", COST-6).
     */
    sweptOrphan: async (providerComputerId: string, now: number): Promise<void> => {
      await db.insert(auditLog).values([
        {
          userId: null,
          action: "computer.swept",
          module: "computers",
          targetId: providerComputerId,
          result: "ok",
          detail: JSON.stringify({ reason: "swept", providerComputerId, sweptAt: now }),
        },
      ]);
    },

    /**
     * Destroys a user's live computers through the provider API for account deletion (AC5):
     * provider destroy first, then the row finishes, so a provider failure refuses the delete
     * with the row still live instead of stranding a billing computer with no record of it.
     * Returns what to name in the deletion report.
     */
    destroyUserComputers: async (
      userId: string,
      destroy: (target: {
        providerComputerId: string;
        disks: string[];
        snapshots: string[];
      }) => Promise<unknown>,
      now: number,
    ): Promise<DestroyReport[]> => {
      const live = await db
        .select()
        .from(computers)
        .where(and(eq(computers.userId, check(userId, "user")), ne(computers.state, "destroyed")));
      const destroyed: DestroyReport[] = [];
      for (const row of live.sort((a, b) => (a.id < b.id ? -1 : 1))) {
        const disks = parseNames(row.disks);
        const snapshots = parseNames(row.snapshots);
        await destroy({ providerComputerId: row.providerComputerId, disks, snapshots });
        // One ledger row per session: `finish` returns null when the sweep already
        // destroyed the row, so a racing tick never ledgers it twice — skip those.
        const done = await finish(row.id, "deleted", now);
        if (!done) continue;
        destroyed.push({
          id: done.computer.id,
          provider: done.computer.provider,
          profile: done.computer.profile,
          providerComputerId: done.computer.providerComputerId,
          disks,
          snapshots,
        });
      }
      return destroyed;
    },
  };
}

export type ComputerStore = ReturnType<typeof computerStore>;
