// SPDX-License-Identifier: Apache-2.0
// The data export's item walk and finish (M3-20 AC1), shared with the deletion walk (M3-20b):
// one staged file per item type, each a Workflow step, then the staged files stream into the
// final ZIP in one multipart upload. Staged keys are deterministic and R2 puts overwrite
// atomically, so a step rerun writes identical bytes — replay-safe. Item metadata goes out as
// single JSON files (its lists are already materialized from D1); only attachment bytes and
// the ZIP itself stream, so the archive is never in Worker memory or a step output. Nothing
// staged or zipped holds secret material: settings omit the key ids, grants and task state
// carry none (task outputs are redacted for secrets at write time, M3-12 AC4).
import { and, eq, lte, ne } from "drizzle-orm";
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
      const all: { conversationId: string; thread: unknown }[] = [];
      for (const conversation of await user.listConversations()) {
        // The full thread, model-switch lines included: the export is the user's record.
        const thread = await user.chat.listThread(conversation.id);
        if (thread) all.push({ conversationId: conversation.id, thread });
      }
      await put("messages.json", all);
      return;
    }
    case "memories":
      await put("memories.json", {
        memories: await user.memory.list(),
        proposals: await user.memory.proposals(),
      });
      return;
    case "tasks":
      await put("tasks.json", await user.tasks.list());
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
 * it. Returns the archive's byte size for the ready row. A failure leaves the upload
 * uncompleted for the caller to abort: a half-written ZIP must never complete.
 */
export async function buildExportZip(
  user: ScopedUser,
  exportId: string,
  now: () => number = Date.now,
): Promise<{ bytes: number; entries: number }> {
  const prefix = user.exports.stagedPrefix(exportId);
  const staged = await user.exports.listPrefix(prefix);
  const upload = await user.exports.createZipUpload(exportId);
  return writeZip(
    (async function* () {
      for (const object of staged) {
        const stored = await user.exports.getObject(object.key);
        yield { name: object.key.slice(prefix.length), body: stored?.body ?? emptyBody() };
      }
    })(),
    upload,
    now(),
  );
}

/** Rows reconciled per sweep tick: a few deletes and one batch each, well inside a cron's CPU. */
export const SWEEP_BATCH = 100;

/**
 * The export reconciler (M3-20 AC1), on the Worker's 10-minute cron: rows past their expiry —
 * ready ones, failed ones, and runs that never finished — lose their R2 objects and move to
 * `expired`. R2 deletes are idempotent (a failed run's ZIP was never built; staged files may
 * already be gone), and the row moves only while still unexpired-state, so a row that finished
 * in the same window is never clobbered. The row stays as the user's history. Returns how many
 * rows moved; a tick that fails midway leaves the rest for the next one.
 */
export async function sweepExports(
  bindings: Pick<DataBindings<unknown, unknown>, "DB" | "FILES">,
  now: () => number = Date.now,
): Promise<{ expired: number }> {
  const db = openD1(bindings.DB);
  const stale = await db
    .select({ id: dataExports.id, userId: dataExports.userId })
    .from(dataExports)
    .where(and(ne(dataExports.status, "expired"), lte(dataExports.expiresAt, now())))
    .limit(SWEEP_BATCH);
  let expired = 0;
  for (const row of stale) {
    // Keys are built only from checked ids; a row that fails the check is skipped, never thrown.
    if (!isId(row.id) || !isId(row.userId)) continue;
    const dir = `u/${row.userId}/exports/${row.id}`;
    await bindings.FILES.delete(`${dir}.zip`).catch(() => {});
    if (bindings.FILES.list) {
      let cursor: string | undefined;
      for (;;) {
        const page = await bindings.FILES.list({
          prefix: `${dir}/staged/`,
          limit: 1000,
          ...(cursor === undefined ? {} : { cursor }),
        }).catch(() => null);
        if (!page) break;
        for (const object of page.objects) await bindings.FILES.delete(object.key).catch(() => {});
        if (!page.truncated) break;
        cursor = page.cursor;
      }
    }
    const moved = await db
      .update(dataExports)
      .set({ status: "expired" })
      .where(and(eq(dataExports.id, row.id), ne(dataExports.status, "expired")))
      .returning({ id: dataExports.id });
    if (moved.length > 0) expired += 1;
  }
  return { expired };
}
