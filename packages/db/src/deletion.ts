// SPDX-License-Identifier: Apache-2.0
// Account deletion (M3-20 AC2–3, m3-ux Flow G): after it, no row carries the `user_id`
// (including `approvals`), nothing remains under `u/{userId}/` in R2, and no DEK remains.
// Deleting the only owner returns the deployment to the unclaimed state, so the next claim
// needs a fresh `setup_token` rotation — and says so first (the route answers `unclaimed`).
//
// The walk mirrors the export's item types (`EXPORT_ITEM_TYPES` in `./export`): every table
// the export reads is user-keyed with `onDelete: "cascade"`, so one `DELETE FROM users` takes
// them all, and the full-text triggers follow the memory cascade. What the
// cascade cannot reach is deleted explicitly: the journal tables (keyed by Workflow instance,
// no `user_id`) and claim challenges (no foreign key). `setup_state` needs care either way —
// its owner reference has no `onDelete`, so the claim is cleared before the user row goes when
// nobody remains, and handed to a survivor when somebody does. `used_setup_tokens` stays: a
// spent token must never reopen `/setup` again.
//
// Ordering: R2 first, then one D1 batch. R2 has no transactions, so a failed object delete
// aborts before any row moves and a retry finds the rows still there; a D1 failure after a
// finished R2 purge still retries clean, because object deletes are idempotent. Running task
// and export Workflows are terminated by the route after the batch (row first, terminate
// best-effort, as the task cancel route): their rows are gone or terminal, so a run the
// terminate misses still finds no scope and stops.
import { and, eq, inArray, ne } from "drizzle-orm";
import { openD1 } from "./index";
import { type DataBindings, isId } from "./repository";
import {
  auditLog,
  setupState,
  taskEvents,
  taskSteps,
  tasks,
  users,
  webauthnChallenges,
} from "./schema";

/** Task states a deletion stops: everything that is not already terminal. */
const ACTIVE_TASK = ["queued", "running", "waiting_for_approval", "budget_limited"] as const;

/** What the route needs after the batch: the reset flag and the runs to terminate. */
export interface DeletionResult {
  /** True when no users remain and the deployment is claimable again. */
  unclaimed: boolean;
  /** Workflow instances of the user's still-active tasks, for best-effort termination. */
  terminatedInstances: string[];
}

/**
 * Deletes the user's account and everything it owns. Returns `null` when the user does not
 * exist, so the route answers 404. Throws when an R2 delete fails, before any row moves.
 */
export async function deleteUserData(
  bindings: Pick<DataBindings<unknown, unknown>, "DB" | "FILES">,
  userId: string,
  now: number = Date.now(),
): Promise<DeletionResult | null> {
  if (!isId(userId)) throw new Error("invalid user id");
  const db = openD1(bindings.DB);

  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return null;

  const remaining = await db
    .select({ id: users.id, role: users.role, createdAt: users.createdAt })
    .from(users)
    .where(ne(users.id, userId));
  const unclaimed = remaining.length === 0;

  // Deleting the claim holder with survivors around hands setup to one of them: a remaining
  // owner first, else the oldest account — promoted, so the deployment keeps an owner and the
  // recovery join in `system.ts` still finds one. Deleting anyone else leaves the claim alone.
  const [setup] = await db.select({ by: setupState.claimedByUserId }).from(setupState).limit(1);
  const successor =
    setup && !unclaimed && setup.by === userId
      ? (remaining.find((r) => r.role === "owner") ??
        [...remaining].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))[0])
      : undefined;
  const promote = successor !== undefined && !remaining.some((r) => r.role === "owner");

  const ownedTasks = await db
    .select({ instanceId: tasks.workflowInstanceId, status: tasks.status })
    .from(tasks)
    .where(eq(tasks.userId, userId));
  const instanceIds = ownedTasks.flatMap((t) => (t.instanceId ? [t.instanceId] : []));
  const terminatedInstances = ownedTasks.flatMap((t) =>
    t.instanceId && (ACTIVE_TASK as readonly string[]).includes(t.status) ? [t.instanceId] : [],
  );

  // Every object under the user's prefix: files, attachments, task outputs, export ZIPs and
  // staged item files. One listing covers all four stores; nothing under `u/{userId}/` survives.
  const prefix = `u/${userId}/`;
  if (bindings.FILES.list) {
    let cursor: string | undefined;
    const keys: string[] = [];
    for (;;) {
      const page = await bindings.FILES.list({
        prefix,
        limit: 1000,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const object of page.objects) keys.push(object.key);
      if (!page.truncated) break;
      cursor = page.cursor;
    }
    for (const key of keys.sort()) await bindings.FILES.delete(key);
  }

  // The cascade from the user row takes every user-data table (sessions, passkeys, DEKs,
  // secrets, conversations and their messages, approvals, attachments rows, usage, providers,
  // tasks, exports rows, artifacts, settings, overrides, grants, memories and their links —
  // the FTS triggers follow the memory cascade). What it cannot reach goes first, in the same
  // batch: the owner reference would otherwise block the user delete, and the audit row lands
  // with a null user so the trail survives without naming one.
  await db.batch([
    db
      .update(tasks)
      .set({ status: "cancelled", finishedAt: now, updatedAt: now })
      .where(and(eq(tasks.userId, userId), inArray(tasks.status, [...ACTIVE_TASK]))),
    ...(instanceIds.length > 0
      ? [
          db.delete(taskSteps).where(inArray(taskSteps.instanceId, instanceIds)),
          db.delete(taskEvents).where(inArray(taskEvents.instanceId, instanceIds)),
        ]
      : []),
    db.delete(webauthnChallenges).where(eq(webauthnChallenges.userId, userId)),
    // A running export row of the user cascades with the user row below; its ZIP and staged
    // files are already gone from the purge above, and its Workflow finds no scope and stops.
    // The claim moves before the user row goes: the reference has no `onDelete`, so deleting
    // the holder first would violate it.
    ...(unclaimed ? [db.delete(setupState)] : []),
    ...(successor
      ? [db.update(setupState).set({ claimedByUserId: successor.id, updatedAt: now })]
      : []),
    ...(promote && successor
      ? [db.update(users).set({ role: "owner", updatedAt: now }).where(eq(users.id, successor.id))]
      : []),
    db.delete(users).where(eq(users.id, userId)),
    db.insert(auditLog).values({
      userId: null,
      action: "account.delete",
      module: "account",
      targetId: userId,
      result: "ok",
      detail: JSON.stringify({ unclaimed }),
    }),
  ]);

  return { unclaimed, terminatedInstances };
}
