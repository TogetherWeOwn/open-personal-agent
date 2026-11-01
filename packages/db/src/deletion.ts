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
// Ordering: stop the work first, purge R2, then one D1 batch, then purge again. Active tasks
// go cancelled and running exports fail before any object moves, so a run the best-effort
// termination misses still finds a terminal row at its next step and stops without writing
// (tasks M3-12 AC3, exports M3-20 AC1). The final pass catches what a step already past its
// re-read wrote between the two purges — object deletes are idempotent, so a D1 failure
// between the purges still retries clean. R2 has no transactions, so a failed object delete
// throws before any row moves and a retry finds the rows still there; without a listing the
// purge cannot prove the prefix empty, so the delete refuses rather than strand objects.
import { and, eq, inArray, ne } from "drizzle-orm";
import { openD1 } from "./index";
import { type DataBindings, isId } from "./repository";
import {
  auditLog,
  dataExports,
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
  /** Workflow instances of the user's stopped task runs, for best-effort termination. */
  taskInstances: string[];
  /** Workflow instances of the user's failed export runs, for best-effort termination. */
  exportInstances: string[];
}

/**
 * What the deletion screen shows before the passkey ceremony: whether deleting this account
 * returns the deployment to the unclaimed first-run screen. `null` when the user is gone.
 */
export async function deletionPreview(
  bindings: Pick<DataBindings<unknown, unknown>, "DB">,
  userId: string,
): Promise<{ isOnlyOwner: boolean } | null> {
  if (!isId(userId)) throw new Error("invalid user id");
  const db = openD1(bindings.DB);
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return null;
  const [other] = await db
    .select({ id: users.id })
    .from(users)
    .where(ne(users.id, userId))
    .limit(1);
  return { isOnlyOwner: other === undefined };
}

/** Removes every object under the user's prefix, failing closed without a listing. */
async function purgeUserPrefix(
  files: DataBindings<unknown, unknown>["FILES"],
  userId: string,
): Promise<void> {
  if (typeof files.list !== "function") throw new Error("account deletion needs object listing");
  const prefix = `u/${userId}/`;
  const keys: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await files.list({
      prefix,
      limit: 1000,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const object of page.objects) keys.push(object.key);
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  // The keys are collected first so deletes never run under an open listing.
  for (const key of keys.sort()) await files.delete(key);
}

/**
 * Deletes the user's account and everything it owns. Returns `null` when the user does not
 * exist, so the route answers 404. Throws when the R2 purge cannot run, before any row moves.
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

  // The still-active runs, for the best-effort termination after the batch.
  const ownedTasks = await db
    .select({ instanceId: tasks.workflowInstanceId, status: tasks.status })
    .from(tasks)
    .where(eq(tasks.userId, userId));
  const taskInstances = ownedTasks.flatMap((t) =>
    t.instanceId && (ACTIVE_TASK as readonly string[]).includes(t.status) ? [t.instanceId] : [],
  );

  // Stop the work first: a run the termination misses still finds a terminal row at its next
  // step and stops without writing, so nothing lands under the prefix after the purge.
  await db.batch([
    db
      .update(tasks)
      .set({ status: "cancelled", finishedAt: now, updatedAt: now })
      .where(and(eq(tasks.userId, userId), inArray(tasks.status, [...ACTIVE_TASK]))),
    db
      .update(dataExports)
      .set({ status: "failed", error: "account deleted" })
      .where(and(eq(dataExports.userId, userId), eq(dataExports.status, "running"))),
  ]);

  // Every object under the user's prefix: files, attachments, task outputs, export ZIPs and
  // staged item files. One listing covers all four stores; nothing under `u/{userId}/` survives.
  await purgeUserPrefix(bindings.FILES, userId);

  // Fresh snapshot after the purge, so a run that started in between still has its journals
  // deleted and its export instance terminated below.
  const freshTasks = await db
    .select({ instanceId: tasks.workflowInstanceId })
    .from(tasks)
    .where(eq(tasks.userId, userId));
  const instanceIds = freshTasks.flatMap((t) => (t.instanceId ? [t.instanceId] : []));
  const runningExports = await db
    .select({ instanceId: dataExports.workflowInstanceId })
    .from(dataExports)
    .where(and(eq(dataExports.userId, userId), eq(dataExports.status, "running")));
  const exportInstances = runningExports.flatMap((r) => (r.instanceId ? [r.instanceId] : []));

  // The cascade from the user row takes every user-data table (sessions, passkeys, DEKs,
  // secrets, conversations and their messages, approvals, attachments rows, usage, providers,
  // tasks, exports rows, artifacts, settings, overrides, grants, memories and their links —
  // the FTS triggers follow the memory cascade). What it cannot reach goes first, in the same
  // batch: the owner reference would otherwise block the user delete, and the audit row lands
  // with a null user and no target, so the trail survives without naming the deleted account.
  // A running export row the stop above failed is already terminal; its ZIP and staged files
  // are gone from the purge above, and its Workflow finds no scope and stops.
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
      result: "ok",
      detail: JSON.stringify({ unclaimed }),
    }),
  ]);

  // The final pass: a step already past its row re-read may have written after the first
  // purge, and an export Workflow is never terminated before here. Deletes are idempotent.
  await purgeUserPrefix(bindings.FILES, userId);

  return { unclaimed, taskInstances, exportInstances };
}
