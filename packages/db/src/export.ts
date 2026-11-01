// SPDX-License-Identifier: Apache-2.0
// The data export's item walk and finish (M3-20 AC1), shared with the deletion walk (M3-20b):
// one staged file per item type (one per conversation for messages, so threads never share
// Worker memory), each a Workflow step, then the staged files stream into the
// final ZIP in one multipart upload. Staged keys are deterministic and R2 puts overwrite
// atomically, so a step rerun writes identical bytes — replay-safe. Item metadata goes out as
// single JSON files (its lists are already materialized from D1); only attachment bytes and
// the ZIP itself stream, so the archive is never in Worker memory or a step output. Nothing
// staged or zipped holds secret material: settings omit the key ids, grants and task state
// carry none (task outputs are redacted for secrets at write time, M3-12 AC4).
import { and, asc, eq, gt, lte, ne, or } from "drizzle-orm";
import { writeZip } from "./export-zip";
import { openD1 } from "./index";
import { type createRepository, type DataBindings, isId } from "./repository";
import { dataExports } from "./schema";

type ScopedUser = ReturnType<ReturnType<typeof createRepository>["forUser"]>;

/**
 * Every item type the export carries (m3-spec §5 M3-20 AC1), one staged file each — and the set
 * M3-20b's deletion walks. `artifacts` covers both R2 object stores with no D1 index: the tool
 * artifacts under `files/` and the offloaded task outputs under `task-outputs/`.
 */
export const EXPORT_ITEM_TYPES = [
  "conversations",
  "messages",
  "memories",
  "tasks",
  "approvals",
  "artifacts",
  "attachments",
  "settings",
  "usage",
  "audit",
] as const;
export type ExportItemType = (typeof EXPORT_ITEM_TYPES)[number];

/** An empty body for objects R2 reports with none. */
const emptyBody = () => new ReadableStream<Uint8Array>({ start: (c) => c.close() });

/**
 * Stages one item type's files under the export's staged directory. Reads only through the
 * scoped repository — including `memory`, never the memory tables directly (ADR 0008 #4).
 */
export async function stageExportItem(
  user: ScopedUser,
  exportId: string,
  type: ExportItemType,
  now: () => number = Date.now,
): Promise<void> {
  const put = (name: string, value: unknown) =>
    user.exports.putStaged(exportId, name, JSON.stringify(value), "application/json");
  switch (type) {
    case "conversations":
      await put("conversations.json", await user.listConversations());
      return;
    case "messages": {
      // One staged file per conversation, not one array of every thread: a large account's
      // threads never sit in Worker memory together — each thread streams out on its own.
      // The full thread, model-switch lines included: the export is the user's record.
      for (const conversation of await user.listConversations()) {
        const thread = await user.chat.listThread(conversation.id);
        if (thread) await put(`messages/${conversation.id}.json`, { thread });
      }
      return;
    }
    case "memories":
      // Every row and proposal, whatever the status: superseded versions and expired
      // proposals are still the user's retained data, and revoked or expired grants are
      // likewise answered by the grant and revoke rows in audit.json, not hidden.
      await put("memories.json", {
        memories: await user.memory.all(),
        proposals: await user.memory.allProposals(),
      });
      return;
    case "tasks":
      await put("tasks.json", await user.tasks.listForExport());
      return;
    case "approvals":
      await put("approvals.json", {
        grants: await user.policy.grants(now()),
        // A Map stringifies to `{}`; the export holds the entries.
        overrides: Object.fromEntries(await user.policy.overrides()),
      });
      return;
    case "artifacts": {
      const manifest: {
        files: { name: string; size: number }[];
        taskOutputs: { name: string; size: number }[];
      } = {
        files: [],
        taskOutputs: [],
      };
      for (const store of user.exports.artifactStores()) {
        const entries = store.dir === "artifacts/files" ? manifest.files : manifest.taskOutputs;
        for (const object of await user.exports.listPrefix(store.prefix)) {
          const name = object.key.slice(store.prefix.length);
          const stored = await user.exports.getObject(object.key);
          await user.exports.putStaged(
            exportId,
            `${store.dir}/${name}`,
            stored?.body ?? emptyBody(),
            "application/octet-stream",
          );
          entries.push({ name, size: object.size });
        }
      }
      await put("artifacts.json", manifest);
      return;
    }
    case "attachments": {
      const rows = await user.attachments.list();
      for (const row of rows) {
        const stored = await user.attachments.getObject(row.id);
        await user.exports.putStaged(
          exportId,
          `attachments/${row.id}`,
          stored?.body ?? emptyBody(),
          row.mediaType,
        );
      }
      await put("attachments.json", rows);
      return;
    }
    case "settings":
      await put("settings.json", (await user.settings.get()) ?? null);
      return;
    case "usage":
      await put("usage.json", await user.usage.list());
      return;
    case "audit":
      await put("audit.json", await user.audit.list());
      return;
  }
}

/**
 * Streams every staged object into the final ZIP through one multipart upload, then completes
 * it. Returns the archive's byte size for the ready row. A failure aborts the upload: a
 * half-written ZIP must never complete, and its parts must not linger as an orphan.
 */
export async function buildExportZip(
  user: ScopedUser,
  exportId: string,
  now: () => number = Date.now,
): Promise<{ bytes: number; entries: number }> {
  const prefix = user.exports.stagedPrefix(exportId);
  const staged = await user.exports.listPrefix(prefix);
  const upload = await user.exports.createZipUpload(exportId);
  try {
    return await writeZip(
      (async function* () {
        for (const object of staged) {
          const stored = await user.exports.getObject(object.key);
          yield { name: object.key.slice(prefix.length), body: stored?.body ?? emptyBody() };
        }
      })(),
      upload,
      now(),
    );
  } catch (error) {
    await upload.abort().catch(() => {});
    throw error;
  }
}

/** Rows reconciled per sweep batch: a few deletes and one query each, well inside a cron's CPU. */
export const SWEEP_BATCH = 100;
/** Batches walked per sweep tick: enough to pass a stuck batch, few enough for the cron. */
export const SWEEP_MAX_BATCHES = 5;

/**
 * The export reconciler (M3-20 AC1), on the Worker's 10-minute cron: rows past their expiry —
 * ready ones, failed ones, and runs that never finished — lose their R2 objects and move to
 * `expired`. R2 deletes are idempotent (a failed run's ZIP was never built; staged files may
 * already be gone), and the row moves only while still unexpired-state, so a row that finished
 * in the same window is never clobbered. A row whose objects fail to delete stays for the next
 * tick rather than move and orphan them. The row stays as the user's history. Returns how many
 * rows moved; a tick that fails midway leaves the rest for the next one.
 */
export async function sweepExports(
  bindings: Pick<DataBindings<unknown, unknown>, "DB" | "FILES">,
  now: () => number = Date.now,
): Promise<{ expired: number }> {
  const db = openD1(bindings.DB);
  const at = now();
  let expired = 0;
  // Keyset cursor over (expiresAt, id): a batch of rows whose deletes keep failing stays
  // eligible for the next tick, but the cursor walks past it within this tick, so later rows
  // are still reached — one stuck batch can never starve the rest past the batch limit.
  let cursor: { expiresAt: number; id: string } | undefined;
  for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch++) {
    const stale = await db
      .select({
        id: dataExports.id,
        userId: dataExports.userId,
        expiresAt: dataExports.expiresAt,
      })
      .from(dataExports)
      .where(
        and(
          ne(dataExports.status, "expired"),
          lte(dataExports.expiresAt, at),
          cursor === undefined
            ? undefined
            : or(
                gt(dataExports.expiresAt, cursor.expiresAt),
                and(eq(dataExports.expiresAt, cursor.expiresAt), gt(dataExports.id, cursor.id)),
              ),
        ),
      )
      .orderBy(asc(dataExports.expiresAt), asc(dataExports.id))
      .limit(SWEEP_BATCH);
    if (stale.length === 0) break;
    for (const row of stale) {
      cursor = { expiresAt: row.expiresAt, id: row.id };
      // Keys are built only from checked ids; a row that fails the check is skipped, never thrown.
      if (!isId(row.id) || !isId(row.userId)) continue;
      const dir = `u/${row.userId}/exports/${row.id}`;
      let cleaned = true;
      const remove = (key: string) =>
        bindings.FILES.delete(key).catch(() => {
          cleaned = false;
        });
      await remove(`${dir}.zip`);
      if (bindings.FILES.list) {
        let listCursor: string | undefined;
        for (;;) {
          const page = await bindings.FILES.list({
            prefix: `${dir}/staged/`,
            limit: 1000,
            ...(listCursor === undefined ? {} : { cursor: listCursor }),
          }).catch(() => null);
          if (!page) {
            cleaned = false;
            break;
          }
          for (const object of page.objects) await remove(object.key);
          if (!page.truncated) break;
          listCursor = page.cursor;
        }
      }
      // A failed delete leaves the row for the next tick: moved rows never come back, and
      // their files would be orphaned with nothing left to sweep them.
      if (!cleaned) continue;
      const moved = await db
        .update(dataExports)
        .set({ status: "expired" })
        .where(and(eq(dataExports.id, row.id), ne(dataExports.status, "expired")))
        .returning({ id: dataExports.id });
      if (moved.length > 0) expired += 1;
    }
    if (stale.length < SWEEP_BATCH) break;
  }
  return { expired };
}
