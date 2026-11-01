// SPDX-License-Identifier: Apache-2.0
// Retention (COST-10, M3-18): the user's settings, the daily sweep that applies them, and the
// reconciler's garbage collection of temporary R2 objects. The sweep reads D1 and R2 only, so it
// never wakes a Durable Object, and it records what it removed as audit rows (AC1). A chat with a
// task that is still queued, running, waiting or paused is never deleted (AC3).
import { and, eq, inArray, isNotNull, isNull, lt, notExists, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { openD1 } from "./index";
import { memoryService } from "./memory";
import type { DataBindings } from "./repository";
import {
  attachments,
  auditLog,
  conversations,
  messages,
  tasks,
  userSettings,
  users,
} from "./schema";

export const DAY_MS = 86_400_000;

/** What the user sets; `null` keeps that data forever. */
export interface RetentionSettings {
  /** A chat with no new message for this many days is deleted. */
  messageDays: number | null;
  /** Tool outputs in finished tasks are removed after this many days. */
  toolOutputDays: number | null;
  /** Unconfirmed memory suggestions expire to rejected after this many days. */
  memoryInboxDays: number;
}

export const RETENTION_DEFAULTS: RetentionSettings = {
  messageDays: null,
  toolOutputDays: 30,
  memoryInboxDays: 14,
};

/** The accepted range of each setting, in days. */
export const RETENTION_BOUNDS = {
  messageDays: { min: 7, max: 3650 },
  toolOutputDays: { min: 1, max: 3650 },
  memoryInboxDays: { min: 1, max: 90 },
} as const;

/** The stored row: `0` is how the columns say "forever". */
export const toSettings = (row: {
  messageRetentionDays: number;
  toolOutputRetentionDays: number;
  memoryInboxDays: number;
}): RetentionSettings => ({
  messageDays: row.messageRetentionDays || null,
  toolOutputDays: row.toolOutputRetentionDays || null,
  memoryInboxDays: row.memoryInboxDays,
});

/** Task statuses whose run may still continue: their chat is never swept (AC3). */
export const LIVE_TASK_STATUSES = [
  "queued",
  "running",
  "waiting_for_approval",
  "budget_limited",
] as const;
const ENDED_TASK_STATUSES = ["succeeded", "failed", "cancelled", "interrupted"] as const;

/** What one sweep removed for one user. */
export interface SweepCounts {
  conversations: number;
  toolOutputs: number;
  proposals: number;
  stepOutputs: number;
}

/** Rows a statement deletes or rewrites at once; a sweep repeats it up to `SWEEP_ROUNDS` times. */
export const SWEEP_BATCH = 100;
const SWEEP_ROUNDS = 10;
/** Task states are rewritten in memory, so fewer at a time. */
const STATE_BATCH = 25;
/** An upload no message took after this long was abandoned in the composer. */
export const UPLOAD_TTL_MS = DAY_MS;
/** Slack for the clocks of R2 and the Worker when comparing an object's age with a task's. */
const CLOCK_SLACK_MS = 3_600_000;

export const sweepAction = "retention.sweep";

/** The tool messages' content in a task's saved state, replaced by a line that says why. */
export function removeToolOutputs(state: string, days: number): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(state);
  } catch {
    return null;
  }
  const note = `[Removed after ${days} days by your tool-output retention setting.]`;
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) for (const item of value) walk(item);
    else if (value && typeof value === "object") {
      const o = value as Record<string, unknown>;
      if (o.role === "tool" && typeof o.content === "string") o.content = note;
      for (const v of Object.values(o)) walk(v);
    }
  };
  walk(parsed);
  return JSON.stringify(parsed);
}

type Bindings = Pick<DataBindings<unknown, unknown>, "DB" | "FILES">;

/** Deployment-level: it reads every user's settings and touches no user's data but by them. */
export function retentionStore({ DB, FILES }: Bindings) {
  const db = openD1(DB);
  const attachmentKey = (userId: string, id: string) => `u/${userId}/attachments/${id}`;

  /** Deletes the user's chats idle since `cutoff`, never one with a live task or reply. */
  const sweepConversations = async (userId: string, cutoff: number) => {
    let total = 0;
    for (let round = 0; round < SWEEP_ROUNDS; round++) {
      const stale = db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.userId, userId),
            lt(conversations.updatedAt, cutoff),
            notExists(
              db
                .select({ x: sql`1` })
                .from(tasks)
                .where(
                  and(
                    eq(tasks.conversationId, conversations.id),
                    inArray(tasks.status, [...LIVE_TASK_STATUSES]),
                  ),
                ),
            ),
            notExists(
              db
                .select({ x: sql`1` })
                .from(messages)
                .where(
                  and(
                    eq(messages.conversationId, conversations.id),
                    or(sql`${messages.createdAt} >= ${cutoff}`, eq(messages.status, "streaming")),
                  ),
                ),
            ),
          ),
        )
        .limit(SWEEP_BATCH);
      // One statement: a task started after the check above can't slip between it and the
      // delete. Messages and tasks go by cascade; the chat's files lose their message and are
      // collected as abandoned uploads.
      const gone = await db
        .delete(conversations)
        .where(and(eq(conversations.userId, userId), inArray(conversations.id, stale)))
        .returning({ id: conversations.id });
      total += gone.length;
      if (gone.length < SWEEP_BATCH) break;
    }
    return total;
  };

  /** Replaces the tool outputs in the user's tasks that ended before `cutoff`. */
  const sweepToolOutputs = async (userId: string, cutoff: number, days: number, now: number) => {
    let total = 0;
    for (let round = 0; round < SWEEP_ROUNDS; round++) {
      const rows = await db
        .select({ id: tasks.id, state: tasks.state })
        .from(tasks)
        .where(
          and(
            eq(tasks.userId, userId),
            inArray(tasks.status, [...ENDED_TASK_STATUSES]),
            lt(tasks.finishedAt, cutoff),
            isNull(tasks.outputsRemovedAt),
            isNotNull(tasks.state),
          ),
        )
        .limit(STATE_BATCH);
      if (!rows.length) break;
      const statements: BatchItem<"sqlite">[] = rows.map((row) => {
        const state = removeToolOutputs(row.state ?? "", days);
        return db
          .update(tasks)
          .set({ ...(state === null ? {} : { state }), outputsRemovedAt: now })
          .where(
            and(eq(tasks.id, row.id), eq(tasks.userId, userId), isNull(tasks.outputsRemovedAt)),
          );
      });
      await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
      total += rows.length;
      if (rows.length < STATE_BATCH) break;
    }
    return total;
  };

  /**
   * Deletes the user's offloaded step outputs (M3-12 AC4) older than every task that could still
   * replay them. Their keys don't name a task, so age decides. Where the store can't list (Node),
   * nothing is collected.
   */
  const sweepStepOutputs = async (userId: string, now: number) => {
    if (!FILES.list) return 0;
    const [oldest] = await db
      .select({ at: sql<number | null>`min(${tasks.createdAt})` })
      .from(tasks)
      .where(and(eq(tasks.userId, userId), inArray(tasks.status, [...LIVE_TASK_STATUSES])));
    const before = Math.min(oldest?.at ?? now, now) - CLOCK_SLACK_MS;
    let removed = 0;
    let cursor: string | undefined;
    do {
      const page = await FILES.list({
        prefix: `u/${userId}/task-outputs/`,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      for (const object of page.objects) {
        if (object.uploaded.getTime() >= before) continue;
        await FILES.delete(object.key);
        removed++;
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return removed;
  };

  return {
    /** Whether a sweep has run since `since`: the sweep's deployment row says so. */
    sweptSince: async (since: number) =>
      (
        await db
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(
            and(
              isNull(auditLog.userId),
              eq(auditLog.action, sweepAction),
              sql`${auditLog.createdAt} >= ${since}`,
            ),
          )
          .limit(1)
      ).length > 0,

    /**
     * Applies every user's settings once (AC1). Each user with something removed gets an audit
     * row with the counts; one deployment row records the totals and marks the day as swept.
     * A user whose sweep fails is counted and retried tomorrow; the others still run.
     */
    sweep: async (now: number) => {
      const rows = await db
        .select({
          userId: users.id,
          messageRetentionDays: sql<number>`coalesce(${userSettings.messageRetentionDays}, 0)`,
          toolOutputRetentionDays: sql<number>`coalesce(${userSettings.toolOutputRetentionDays}, ${RETENTION_DEFAULTS.toolOutputDays})`,
          memoryInboxDays: sql<number>`coalesce(${userSettings.memoryInboxDays}, ${RETENTION_DEFAULTS.memoryInboxDays})`,
        })
        .from(users)
        .leftJoin(userSettings, eq(userSettings.userId, users.id));
      const totals: SweepCounts = {
        conversations: 0,
        toolOutputs: 0,
        proposals: 0,
        stepOutputs: 0,
      };
      let failed = 0;
      for (const row of rows) {
        const { userId } = row;
        const settings = toSettings(row);
        // Filled step by step, so a later step that throws still leaves the earlier deletions
        // in the user's audit row and the totals.
        const counts: SweepCounts = {
          conversations: 0,
          toolOutputs: 0,
          proposals: 0,
          stepOutputs: 0,
        };
        let result: "ok" | "error" = "ok";
        try {
          if (settings.messageDays) {
            counts.conversations = await sweepConversations(
              userId,
              now - settings.messageDays * DAY_MS,
            );
          }
          if (settings.toolOutputDays) {
            counts.toolOutputs = await sweepToolOutputs(
              userId,
              now - settings.toolOutputDays * DAY_MS,
              settings.toolOutputDays,
              now,
            );
          }
          counts.proposals = await memoryService(db, userId).expire(now);
          counts.stepOutputs = await sweepStepOutputs(userId, now);
        } catch {
          result = "error";
          failed++;
        }
        for (const k of Object.keys(totals) as (keyof SweepCounts)[]) totals[k] += counts[k];
        if (result === "error" || Object.values(counts).some((n) => n > 0)) {
          await db.insert(auditLog).values({
            userId,
            action: sweepAction,
            module: "retention",
            result,
            detail: JSON.stringify(counts),
          });
        }
      }
      await db.insert(auditLog).values({
        userId: null,
        action: sweepAction,
        module: "retention",
        result: failed ? "error" : "ok",
        detail: JSON.stringify({ ...totals, users: rows.length, failed }),
      });
      return { ...totals, users: rows.length, failed };
    },

    /**
     * The reconciler's R2 collection (AC2): uploads no message took within a day, including the
     * files of chats the sweep deleted. The row goes first, on the same condition, so a file sent
     * meanwhile keeps its bytes; a row whose object can't be deleted is put back for the next
     * tick. Returns how many were removed.
     */
    collectUploads: async (now: number) => {
      const stale = await db
        .delete(attachments)
        .where(
          inArray(
            attachments.id,
            db
              .select({ id: attachments.id })
              .from(attachments)
              .where(
                and(isNull(attachments.messageId), lt(attachments.createdAt, now - UPLOAD_TTL_MS)),
              )
              .limit(SWEEP_BATCH),
          ),
        )
        .returning();
      let removed = 0;
      for (const row of stale) {
        try {
          await FILES.delete(attachmentKey(row.userId, row.id));
          removed++;
        } catch {
          // Put the row back, so the next tick finds the bytes again.
          await db.insert(attachments).values(row).onConflictDoNothing();
        }
      }
      return removed;
    },
  };
}
