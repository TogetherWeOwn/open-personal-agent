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
// Ordering: purge R2 first, stop the work, purge again, then one D1 batch. The first
// purge throws before any row moves, so a store without a listing (or an unreadable one)
// refuses the delete with the account and its work intact; active tasks go cancelled and
// running exports fail before the second purge, so a run the best-effort termination
// misses still finds a terminal row at its next step and stops without writing
// (tasks M3-12 AC3, exports M3-20 AC1). The second pass catches what a step already past
// its re-read wrote between the first purge and the stop. What this function must not do
// is the last purge itself: the route terminates the stopped runs' Workflow instances
// first (a step still running can otherwise write under the prefix afterwards), and only
// then calls `purgeDeletedUserFiles`, which retries the pass in place — a transient store
// failure between the batch and the last pass must not strand objects with no user row
// left to retry through. Object deletes are idempotent, so a D1 failure between the
// purges still retries clean. R2 has no transactions, so a final pass that keeps failing
// after its retries surfaces `delete_failed` instead of claiming success with objects
// possibly left behind; without a listing the purge cannot prove the prefix empty, so
// the delete refuses rather than strand objects.
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
 * The last pass over the user's prefix, after the route has terminated the stopped runs'
 * Workflow instances. Retries in place: the user row is already gone by the time this runs,
 * so a transient store failure must be ridden out here — no later request can retry through
 * a user that no longer exists. Throws the last error when every attempt fails, so the
 * route answers `delete_failed` instead of claiming success with objects possibly left.
 */
export async function purgeDeletedUserFiles(
  bindings: Pick<DataBindings<unknown, unknown>, "FILES">,
  userId: string,
  attempts = 3,
): Promise<void> {
  if (!isId(userId)) throw new Error("invalid user id");
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await purgeUserPrefix(bindings.FILES, userId);
      return;
    } catch (error) {
      last = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
  throw last;
}

/**
 * Deletes the user's account and everything it owns. Returns `null` when the user does not
 * exist, so the route answers 404. Throws when the R2 purge cannot run, before any row moves.
 * Stops short of the final purge: the caller terminates `taskInstances`/`exportInstances`
 * first, then finishes with `purgeDeletedUserFiles`, so nothing still running can write
 * under the prefix after the last pass.
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

  // The still-active runs, for the best-effort termination after the batch. Both snapshots
  // run before anything moves: the export rows go terminal in the stop below, so reading them
  // after would find nothing left to terminate.
  const ownedTasks = await db
    .select({ instanceId: tasks.workflowInstanceId, status: tasks.status })
    .from(tasks)
    .where(eq(tasks.userId, userId));
  const taskInstances = ownedTasks.flatMap((t) =>
    t.instanceId && (ACTIVE_TASK as readonly string[]).includes(t.status) ? [t.instanceId] : [],
  );
  const ownedExports = await db
    .select({ instanceId: dataExports.workflowInstanceId })
    .from(dataExports)
    .where(and(eq(dataExports.userId, userId), eq(dataExports.status, "running")));
  const exportInstances = ownedExports.flatMap((r) => (r.instanceId ? [r.instanceId] : []));

  // Every object under the user's prefix: files, attachments, task outputs, export ZIPs and
  // staged item files. One listing covers all four stores; nothing under `u/{userId}/` survives.
  // First, before any row moves, so an unreadable store refuses with work and account intact.
  await purgeUserPrefix(bindings.FILES, userId);

  // Stop the work: a run the termination misses still finds a terminal row at its next step
  // and stops without writing, so nothing lands under the prefix after the purge below.
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

  // Second purge: catches what an active step wrote between the first purge and the stop.
  await purgeUserPrefix(bindings.FILES, userId);

  // Fresh task snapshot after the purges, so a run that started in between still has its
  // journals deleted below.
  const freshTasks = await db
    .select({ instanceId: tasks.workflowInstanceId })
    .from(tasks)
    .where(eq(tasks.userId, userId));
  const instanceIds = freshTasks.flatMap((t) => (t.instanceId ? [t.instanceId] : []));

  // The cascade from the user row takes every user-data table (sessions, passkeys, DEKs,
  // secrets, conversations and their messages, approvals, attachments rows, usage, providers,
  // tasks, exports rows, artifacts, settings, overrides, grants, memories and their links —
  // the FTS triggers follow the memory cascade). What it cannot reach goes first, in the same
  // batch: the owner reference would otherwise block the user delete, and the audit row lands
  // with a null user and no target, so the trail survives without naming the deleted account.
  // A running export row the stop above failed is already terminal; its ZIP and staged files
  // are gone in the purges above, and its Workflow — terminated best-effort by the route from
  // the pre-stop snapshot — finds no scope and stops.
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

  return { unclaimed, taskInstances, exportInstances };
}
