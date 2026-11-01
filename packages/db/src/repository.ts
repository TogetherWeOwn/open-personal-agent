// SPDX-License-Identifier: Apache-2.0
// The scoped repository layer (ADR 0010 D3): the only code that reads the DB, FILES and ASSISTANT
// bindings, derives R2 keys or names Durable Objects. scripts/check-scoped-access.mjs enforces it.
import type { StandingGrant, TaintState, ToolOverride } from "@opa/policy";
import { estimate, findPrice } from "@opa/pricing";
import {
  and,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { AnyD1Database } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
// A separate entry point (`@opa/db/repository`), so this import is not a cycle.
import { openD1, readSchemaVersion } from "./index";
import { memoryService } from "./memory";
import { RETENTION_DEFAULTS, type RetentionSettings, toSettings } from "./retention";
import {
  artifacts,
  attachments,
  auditLog,
  conversations,
  dataExports,
  grants,
  messages,
  modelProviders,
  secrets,
  tasks,
  toolOverrides,
  usage,
  userSettings,
  users,
} from "./schema";

declare const brand: unique symbol;
/** A user's authority over their own rows. `scopeFromSession` and `scopeForAssistant` mint it. */
export type UserScope = { readonly userId: string; readonly [brand]: true };

const issued = new WeakSet<object>();

function issue(userId: string): UserScope {
  const scope = Object.freeze({ userId }) as UserScope;
  issued.add(scope);
  return scope;
}

/** For the session layer only (the lint enforces it), after it has validated the session. */
export function scopeFromSession(session: { readonly userId: string }): UserScope {
  if (!session.userId) throw new Error("session has no user");
  return issue(session.userId);
}

/**
 * For the user's assistant only (the lint allows it in apps/worker/src/assistant.ts). Only
 * `forUser(scope).assistant()` names one `u:<userId>`, so the Durable Object's own name carries
 * the authority of the session that named it (ADR 0002).
 */
export function scopeForAssistant(name: string): UserScope {
  const userId = /^u:(\S+)$/.exec(name)?.[1];
  if (!userId) throw new Error("not a user's assistant");
  return issue(userId);
}

/** One part of a multipart upload, as `complete` wants them back. */
export interface UploadedPart {
  partNumber: number;
  etag: string;
}

/** A stored object's body, as the routes and the assistant read it. */
export interface StoredObject {
  /** The bytes as a stream, so a download is never buffered whole. */
  body: ReadableStream | null;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** The parts of R2 and Durable Object namespaces used here; the Node root supplies its own. */
export interface DataBindings<Stub, Id> {
  DB: AnyD1Database;
  FILES: {
    head(key: string): Promise<unknown>;
    get(key: string): Promise<StoredObject | null>;
    put(
      key: string,
      value: string | ReadableStream,
      options: { httpMetadata: { contentType: string } },
    ): Promise<unknown>;
    delete(key: string): Promise<unknown>;
    /**
     * R2's listing, a page at a time: the allowance meter (COST-5) sums the whole bucket's sizes
     * with it, and the retention sweep (M3-18) lists a prefix by upload time. Absent where the
     * store has none (Node); both then leave those objects alone.
     */
    list?(options: { prefix?: string; cursor?: string; limit?: number }): Promise<{
      objects: { key: string; size: number; uploaded: Date }[];
      truncated: boolean;
      cursor?: string;
    }>;
    /**
     * R2's multipart upload, for streaming a body whose length is not known up front: `put`
     * there takes only a known-length stream. Absent where the store streams any body (Node).
     */
    createMultipartUpload?(
      key: string,
      options: { httpMetadata: { contentType: string } },
    ): Promise<{
      uploadPart(partNumber: number, value: Uint8Array): Promise<UploadedPart>;
      complete(parts: UploadedPart[]): Promise<unknown>;
      abort(): Promise<unknown>;
    }>;
    /**
     * The keys under a prefix, for enumerating the file and task-output stores an export
     * walks (M3-20 AC1). Absent where the store has no listing (Node); the walk then treats
     * the store as empty. The export Workflow runs on Workers, where R2 always lists.
     */
    list?(options: { prefix?: string; cursor?: string; limit?: number }): Promise<{
      objects: { key: string; size: number }[];
      truncated: boolean;
      cursor?: string;
    }>;
  };
  ASSISTANT: { idFromName(name: string): Id; get(id: Id): Stub };
}

/** An attachment row as routes and the thread read it: the sniffed facts, never the R2 key. */
export type AttachmentRow = Pick<
  typeof attachments.$inferSelect,
  "id" | "name" | "mediaType" | "kind" | "sizeBytes" | "sentToModel" | "createdAt"
>;

/** Where a tool's file came from (M3-11): the run that wrote it. The host fills it, never a tool. */
export type ArtifactSource = {
  conversationId?: string | null;
  taskId?: string | null;
  turnId?: string | null;
};

/** An Outputs row: the file's facts and its source run, never the R2 key. */
export type ArtifactRow = Pick<
  typeof artifacts.$inferSelect,
  "id" | "name" | "mediaType" | "sizeBytes" | "conversationId" | "taskId" | "turnId" | "createdAt"
> & { conversationTitle: string | null };

/** The most Outputs rows one list read returns; older ones page with `before`. */
export const ARTIFACT_PAGE = 100;

/** The `user_settings` columns a route may write; the user and timestamps come from here. */
export type SettingsUpdate = Partial<
  Omit<typeof userSettings.$inferInsert, "userId" | "updatedAt">
>;

/** An override change as the audit log records it (M3-02 AC7): the tool, both values, its risk. */
export interface OverrideChange {
  tool: string;
  from: ToolOverride | null;
  to: ToolOverride | null;
  riskClass: string;
}

/** A standing grant as the store keeps it; `id` is what Settings revokes. */
export type StoredGrant = StandingGrant & { id: string; createdAt: number };

/** The `model_providers` columns a route may write. */
export type ProviderValues = Pick<
  typeof modelProviders.$inferInsert,
  "kind" | "providerId" | "baseUrl" | "model" | "keySecretId"
>;

/** R2's smallest multipart part, except the last: an upload streams through in parts this size. */
const PART_BYTES = 5 * 1024 * 1024;

/**
 * Stores a stream body whose length is not known up front: through `FixedLengthStream` where
 * the caller declares it, else a multipart upload in bounded parts — the body is never buffered
 * whole on any path (M3-10 AC1). A store with no multipart (Node) streams any body. R2's `put`
 * takes only a known-length stream, so callers never put a stream directly.
 */
async function putStreamed(
  files: DataBindings<unknown, unknown>["FILES"],
  key: string,
  body: ReadableStream,
  options: { httpMetadata: { contentType: string } },
  knownLength?: number,
): Promise<void> {
  const FixedLengthStream = (
    globalThis as { FixedLengthStream?: new (length: number) => TransformStream }
  ).FixedLengthStream;
  if (knownLength !== undefined && FixedLengthStream) {
    await files.put(key, body.pipeThrough(new FixedLengthStream(knownLength)), options);
    return;
  }
  if (files.createMultipartUpload) {
    const upload = await files.createMultipartUpload(key, options);
    try {
      // R2 wants every part but the last the same size, so each is cut at exactly
      // `PART_BYTES` and a chunk that straddles the cut carries into the next part.
      const parts: UploadedPart[] = [];
      let part = new Uint8Array(PART_BYTES);
      let filled = 0;
      const reader = body.getReader();
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        let chunk = next.value;
        while (chunk.byteLength) {
          const take = Math.min(chunk.byteLength, PART_BYTES - filled);
          part.set(chunk.subarray(0, take), filled);
          filled += take;
          chunk = chunk.subarray(take);
          if (filled === PART_BYTES) {
            parts.push(await upload.uploadPart(parts.length + 1, part));
            part = new Uint8Array(PART_BYTES);
            filled = 0;
          }
        }
      }
      if (filled || !parts.length) {
        parts.push(await upload.uploadPart(parts.length + 1, part.slice(0, filled)));
      }
      await upload.complete(parts);
    } catch (err) {
      await upload.abort().catch(() => {});
      throw err;
    }
    return;
  }
  await files.put(key, body, options);
}

/** A conversation ID comes from the client, so it is checked before it reaches a query. */
export const isId = (id: unknown): id is string =>
  typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);

/**
 * Whether `error` is a uniqueness refusal from the store. D1 reports the violated constraint
 * in the cause, under drizzle's "Failed query" wrapper — so a racing insert that loses a
 * partial unique index reads as one, and the caller can answer what the check would have.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (/unique constraint failed/i.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}

/** The bound `scopeForTask` accepts, so a row it could never resolve is never written. */
const isInstanceId = (id: unknown): id is string =>
  typeof id === "string" && id.length >= 1 && id.length <= 128;

/** The check also keeps a key inside the user's R2 prefix. */
function checkId(id: string): string {
  if (!isId(id)) throw new Error("invalid id");
  return id;
}

export type MessageStatus = "complete" | "streaming" | "interrupted" | "error";

/** One `search_history` match: a window of the message around the text that matched. */
export type HistoryHit = {
  conversationId: string;
  conversationTitle: string | null;
  messageId: string;
  role: "user" | "assistant";
  snippet: string;
  createdAt: number;
};

/** A task row (M3-12): the durable run's authority and state. */
export type TaskRow = typeof tasks.$inferSelect;
/** An export row (M3-20): the durable run's authority, size and expiry. */
export type ExportRow = typeof dataExports.$inferSelect;
/** Export rows the run moves through; anything else ends it (a step that finds one stops). */
export const EXPORT_TERMINAL_STATUSES = ["ready", "failed", "expired"] as const;
export type TaskStatus = TaskRow["status"];
/** Statuses a task never leaves; a step that finds one does nothing (M3-12 AC3). */
export const TASK_TERMINAL_STATUSES = ["succeeded", "failed", "cancelled", "interrupted"] as const;
/** Statuses from which a task may still be cancelled. */
const TASK_CANCELLABLE_STATUSES = [
  "queued",
  "running",
  "waiting_for_approval",
  "budget_limited",
] as const satisfies readonly TaskStatus[];
/**
 * Which limit stopped a `budget_limited` task (M3-13 AC1). Money limits read "Paused: budget",
 * execution limits read "Paused: limit". `steps`/`duration` are the per-task limits (M3-12 AC6);
 * the rest are the `limit.reached` kinds (M3-03 AC8).
 */
export const TASK_LIMIT_KINDS = [
  "task_budget",
  "daily",
  "monthly_hard",
  "calls",
  "tools",
  "tool_rate",
  "steps",
  "duration",
] as const satisfies readonly NonNullable<TaskRow["limitKind"]>[];
export type TaskLimitKind = (typeof TASK_LIMIT_KINDS)[number];
/** A `budget_limited` stop by one of these reads "Paused: limit", never "budget" (M3-13 AC1). */
export const isExecutionLimit = (kind: TaskLimitKind): boolean =>
  kind === "calls" ||
  kind === "tools" ||
  kind === "tool_rate" ||
  kind === "steps" ||
  kind === "duration";
/** Every status a task row can hold, for validating the Tasks list filter (M3-13 AC1). */
const TASK_STATUSES: readonly TaskStatus[] = [
  "queued",
  "running",
  "waiting_for_approval",
  "budget_limited",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
];
/** One Tasks list row (M3-13 AC1–2): the run, its conversation and its spend so far. */
export interface TaskListItem {
  id: string;
  title: string | null;
  conversationId: string;
  conversationTitle: string | null;
  kind: string;
  mode: TaskRow["mode"];
  status: TaskStatus;
  limitKind: TaskLimitKind | null;
  error: string | null;
  costMicroUsd: number | null;
  /** Calls with no price on file; their cost is missing from `costMicroUsd` (as Usage does). */
  unpricedCalls: number;
  calls: number;
  createdAt: number;
  /** A paused task's last write is its pause, so the view can freeze its elapsed clock there. */
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

/** A running chat turn: also its eviction checkpoint, so it is plain JSON. */
export interface TurnRecord {
  conversationId: string;
  turnId: string;
  replyId: string;
  providerId: string;
  model: string;
  reply: string;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | null;
  /** The model call has started, so the messages exist and the call belongs in the ledger. */
  called: boolean;
}

/** One model call for the ledger. `providerId` is who bills it (`billingProviderId`). */
export type LedgerCall = Pick<TurnRecord, "providerId" | "model" | "usage">;

/** A call's ledger values, priced from the table; the cost columns stay null without a price. */
function ledgerValues({ providerId, model, usage: counts }: LedgerCall) {
  const price = findPrice(providerId, model);
  const row = { id: crypto.randomUUID(), providerId, model, ...counts };
  if (!price || !counts) return row;
  const { costMicroUsd, neurons } = estimate(price, counts);
  const costSource = "estimated" as const;
  return { ...row, costMicroUsd, neurons, costSource, priceVerifiedAt: price.verifiedAt };
}

export function createRepository<Stub, Id>({ DB, FILES, ASSISTANT }: DataBindings<Stub, Id>) {
  const db = openD1(DB);
  return {
    /**
     * For the Workflow entrypoint only (the lint enforces it): the scope of the user whose task
     * row names this Workflow instance, with the row itself (M3-12 AC9). The Workflow's instance
     * params are never consulted — they are data, not authority — so a parameter naming another
     * user mints nothing. `null` when no task row claims the instance.
     */
    scopeForTask: async (
      instanceId: string,
    ): Promise<{ scope: UserScope; task: TaskRow } | null> => {
      if (!isInstanceId(instanceId)) return null;
      const [task] = await db
        .select()
        .from(tasks)
        .where(eq(tasks.workflowInstanceId, instanceId))
        .limit(1);
      return task ? { scope: issue(task.userId), task } : null;
    },
    /**
     * For the export Workflow entrypoint only: the scope of the user whose exports row names
     * this Workflow instance, with the row itself. The same authority rule as `scopeForTask`
     * (M3-12 AC9) over the exports table, which carries the expiry and size a task row has no
     * room for: instance params are never consulted, so a parameter naming another user mints
     * nothing. `null` when no exports row claims the instance.
     */
    scopeForExport: async (
      instanceId: string,
    ): Promise<{ scope: UserScope; export: ExportRow } | null> => {
      if (!isInstanceId(instanceId)) return null;
      const [row] = await db
        .select()
        .from(dataExports)
        .where(eq(dataExports.workflowInstanceId, instanceId))
        .limit(1);
      return row ? { scope: issue(row.userId), export: row } : null;
    },
    /** Deployment-level checks that read no user's data. */
    deployment: {
      schemaVersion: () => readSchemaVersion(db),
      /** A HEAD on a key outside every user's prefix that never exists. */
      probeStorage: () => FILES.head("health/probe"),
      /** A fixed name outside the `u:<userId>` space. */
      healthObject: () => ASSISTANT.get(ASSISTANT.idFromName("health")),
      /**
       * Workers AI neurons all users' calls used since `since`: one total, no rows. The free
       * allowance is the Cloudflare account's, so one user's share would overstate what is left.
       */
      workersAiNeurons: async (since: number) =>
        (
          await db
            .select({ n: sql<number>`coalesce(sum(${usage.neurons}), 0)`.mapWith(Number) })
            .from(usage)
            .where(gte(usage.createdAt, since))
        )[0]?.n ?? 0,
      /**
       * The database's size in bytes (M3-16 AC3): D1 reports it with every result as
       * `meta.size_after`; Node's SQLite doesn't, so there it is pages × page size.
       */
      databaseBytes: async () => {
        const raw = DB as unknown as {
          prepare(sql: string): {
            run(): Promise<{ meta: { size_after?: number } }>;
            first<T>(column: string): Promise<T | null>;
          };
        };
        const { meta } = await raw.prepare("SELECT 1").run();
        if (typeof meta.size_after === "number") return meta.size_after;
        const pages = (await raw.prepare("PRAGMA page_count").first<number>("page_count")) ?? 0;
        const size = (await raw.prepare("PRAGMA page_size").first<number>("page_size")) ?? 0;
        return pages * size;
      },
      /**
       * What the file store holds, in bytes: every object, whoever wrote it (uploads, saved
       * outputs, offloaded step outputs, exports). Where the store can't list (Node), the sum of
       * the attachment rows' sizes stands in.
       */
      fileBytes: async () => {
        if (FILES.list) {
          let bytes = 0;
          let cursor: string | undefined;
          do {
            const page = await FILES.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
            for (const object of page.objects) bytes += object.size;
            cursor = page.truncated ? page.cursor : undefined;
          } while (cursor);
          return bytes;
        }
        return (
          (
            await db
              .select({
                n: sql<number>`coalesce(sum(${attachments.sizeBytes}), 0)`.mapWith(Number),
              })
              .from(attachments)
          )[0]?.n ?? 0
        );
      },
      /**
       * The owner's assistant, for deployment-wide notices only the owner sees (the allowance
       * warnings, COST-5); `null` before the claim.
       */
      ownerAssistant: async () => {
        const owner = (
          await db.select({ id: users.id }).from(users).where(eq(users.role, "owner")).limit(1)
        )[0];
        return owner ? ASSISTANT.get(ASSISTANT.idFromName(`u:${owner.id}`)) : null;
      },
    },

    forUser(scope: UserScope) {
      if (!issued.has(scope)) throw new Error("scope was not issued by the session layer");
      const { userId } = scope;
      const fileKey = (id: string) => `u/${userId}/files/${checkId(id)}`;
      const memory = memoryService(db, userId);
      const attachmentKey = (id: string) => `u/${userId}/attachments/${checkId(id)}`;
      const exportZipKey = (id: string) => `u/${userId}/exports/${checkId(id)}.zip`;
      const exportStagedPrefix = (id: string) => `u/${userId}/exports/${checkId(id)}/staged/`;
      /**
       * One staged item file's key, under the export's own directory. Each path segment is
       * flattened to safe characters (R2 keys are opaque, so `..` could never escape, but a
       * staged tree with dot segments parses badly), keeping the key under the prefix.
       */
      const exportStagedKey = (id: string, name: string) =>
        `${exportStagedPrefix(id)}${name
          .split("/")
          .map((part) => part.replace(/[^A-Za-z0-9._-]/g, "_"))
          .map((part) => (/^\.+$/.test(part) || part === "" ? "_" : part))
          .join("/")}`;
      /**
       * Every key under a prefix, in order, following cursors. `[]` where the store has no
       * listing (Node); the export Workflow runs on Workers, where R2 always lists.
       * The prefix must stay inside the user's namespace, like `getObject`: a caller can
       * only name its own objects, never another user's.
       */
      const listR2Prefix = async (prefix: string): Promise<{ key: string; size: number }[]> => {
        if (!prefix.startsWith(`u/${userId}/`)) throw new Error("invalid prefix");
        if (!FILES.list) return [];
        const keys: { key: string; size: number }[] = [];
        let cursor: string | undefined;
        for (;;) {
          const page = await FILES.list({
            prefix,
            limit: 1000,
            ...(cursor === undefined ? {} : { cursor }),
          });
          for (const o of page.objects) keys.push({ key: o.key, size: o.size });
          if (!page.truncated) break;
          cursor = page.cursor;
        }
        return keys.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      };
      const own = (id: string) => and(eq(conversations.id, id), eq(conversations.userId, userId));
      /** `undefined` when the row is missing or someone else's: answer 404 for both. */
      const getConversation = async (id: string) =>
        (await db.select().from(conversations).where(own(id)).limit(1))[0];
      const ownProvider = (id: string) =>
        and(eq(modelProviders.id, id), eq(modelProviders.userId, userId));
      const providerRows = (where?: SQL) =>
        db
          .select({
            id: modelProviders.id,
            kind: modelProviders.kind,
            providerId: modelProviders.providerId,
            baseUrl: modelProviders.baseUrl,
            model: modelProviders.model,
            keySecretId: modelProviders.keySecretId,
            createdAt: modelProviders.createdAt,
            keyLast4: secrets.last4,
            keyCreatedAt: secrets.createdAt,
            keyUpdatedAt: secrets.updatedAt,
            keyLastUsedAt: secrets.lastUsedAt,
          })
          .from(modelProviders)
          .leftJoin(
            secrets,
            and(eq(secrets.id, modelProviders.keySecretId), eq(secrets.userId, userId)),
          )
          .where(and(eq(modelProviders.userId, userId), where));
      /** The next message of a conversation; only a reply starts out streaming. */
      const message = (
        conversationId: string,
        id: string,
        role: "user" | "assistant" | "system",
        content: string,
      ) =>
        db.insert(messages).values({
          id,
          userId,
          conversationId,
          seq: sql`(SELECT coalesce(max(seq), 0) + 1 FROM messages WHERE conversation_id = ${conversationId})`,
          role,
          status: role === "assistant" ? "streaming" : "complete",
          content,
        });
      /**
       * A conversation's rows with the given roles, oldest first, each with its files' sniffed
       * facts (M3-10). Only a user row has files; the others get `[]`.
       */
      const thread = async <Role extends "user" | "assistant" | "system">(
        conversationId: string,
        roles: Role[],
      ) => {
        const rows = await db
          .select({
            id: messages.id,
            role: sql<Role>`${messages.role}`, // the filter below
            status: messages.status,
            content: messages.content,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, conversationId),
              eq(messages.userId, userId),
              inArray(messages.role, roles),
            ),
          )
          .orderBy(messages.seq);
        const files = rows.length
          ? await db
              .select({
                id: attachments.id,
                messageId: attachments.messageId,
                name: attachments.name,
                mediaType: attachments.mediaType,
                kind: attachments.kind,
                sizeBytes: attachments.sizeBytes,
                sentToModel: attachments.sentToModel,
                createdAt: attachments.createdAt,
              })
              .from(attachments)
              // Found through their messages, not by a list of message IDs: D1 binds at most
              // 100 parameters a query, which a long chat would pass.
              .innerJoin(messages, eq(messages.id, attachments.messageId))
              .where(
                and(
                  eq(attachments.userId, userId),
                  eq(messages.conversationId, conversationId),
                  eq(messages.userId, userId),
                ),
              )
              .orderBy(attachments.createdAt)
          : [];
        return rows.map((row) => ({
          ...row,
          attachments: files
            .filter((f) => f.messageId === row.id)
            .map(({ messageId: _m, ...file }) => file),
        }));
      };
      const createConversation = async (
        id: string,
        title: string | null = null,
        pin?: { provider: string; model: string },
      ) => {
        const model = { modelProvider: pin?.provider ?? null, model: pin?.model ?? null };
        await db.insert(conversations).values({ id: checkId(id), userId, title, ...model });
      };
      const artifactRows = () =>
        db
          .select({
            id: artifacts.id,
            name: artifacts.name,
            mediaType: artifacts.mediaType,
            sizeBytes: artifacts.sizeBytes,
            conversationId: artifacts.conversationId,
            taskId: artifacts.taskId,
            turnId: artifacts.turnId,
            createdAt: artifacts.createdAt,
            conversationTitle: conversations.title,
          })
          .from(artifacts)
          .leftJoin(
            conversations,
            and(eq(conversations.id, artifacts.conversationId), eq(conversations.userId, userId)),
          );
      /**
       * Stores a tool's file and its Outputs row in one call (M3-11): the object first, then the
       * row, and the object is removed again if the row can't be written — so every file a tool
       * wrote is listed, and nothing listed is missing. The source must be the user's own.
       */
      const saveArtifact = async (input: {
        id: string;
        name: string;
        mediaType: string;
        content: string;
        source: ArtifactSource;
      }) => {
        const { conversationId = null, taskId = null, turnId = null } = input.source;
        if (conversationId !== null && !(await getConversation(conversationId)))
          throw new Error("not the user's conversation");
        if (taskId !== null) {
          const own = isId(taskId)
            ? await db
                .select({ id: tasks.id })
                .from(tasks)
                .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
                .limit(1)
            : [];
          if (!own.length) throw new Error("not the user's task");
        }
        const key = fileKey(input.id);
        const sizeBytes = new TextEncoder().encode(input.content).length;
        // The row first: a taken ID fails here, before the put could overwrite that file's bytes.
        await db.insert(artifacts).values({
          id: input.id,
          userId,
          conversationId,
          taskId,
          turnId,
          name: input.name,
          mediaType: input.mediaType,
          sizeBytes,
        });
        try {
          await FILES.put(key, input.content, { httpMetadata: { contentType: input.mediaType } });
        } catch (err) {
          await db
            .delete(artifacts)
            .where(eq(artifacts.id, input.id))
            .catch(() => {});
          throw err;
        }
      };
      return {
        /** The user's own `users` row; `undefined` if it was deleted. */
        profile: async () =>
          (
            await db
              .select({ id: users.id, displayName: users.displayName, role: users.role })
              .from(users)
              .where(eq(users.id, userId))
              .limit(1)
          )[0],
        /** The user's assistant (ADR 0002), named from the session, never from client input. */
        assistant: () => ASSISTANT.get(ASSISTANT.idFromName(`u:${userId}`)),
        listConversations: () =>
          db
            .select()
            .from(conversations)
            .where(eq(conversations.userId, userId))
            .orderBy(desc(conversations.updatedAt)),
        getConversation,
        createConversation,
        chat: {
          /**
           * The conversation's messages oldest first, or `null` when it isn't the user's. This is
           * the model context, so it never holds the thread's model-switch lines.
           */
          listMessages: async (conversationId: string) =>
            (await getConversation(conversationId))
              ? thread(conversationId, ["user", "assistant"])
              : null,
          /**
           * What the chat shows: its messages and the `system` lines that record each model switch
           * between them, oldest first. `null` when it isn't the user's.
           */
          listThread: async (conversationId: string) =>
            (await getConversation(conversationId))
              ? thread(conversationId, ["user", "assistant", "system"])
              : null,
          /**
           * The caller's own messages containing `query` (M3-08 AC2), newest first. The query is
           * matched literally (LIKE's wildcards are escaped), and the conversation join is bound
           * to the same `user_id`, so a row can never surface through someone else's conversation.
           * Case-insensitively for A–Z only: SQLite LIKE has no Unicode folding, so other scripts
           * match exactly as typed (the tool description says so).
           */
          searchHistory: (query: string, limit: number): Promise<HistoryHit[]> => {
            const like = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
            return db
              .select({
                conversationId: messages.conversationId,
                conversationTitle: conversations.title,
                messageId: messages.id,
                role: sql<"user" | "assistant">`${messages.role}`, // the filter below
                snippet: sql<string>`substr(${messages.content}, max(1, instr(lower(${messages.content}), lower(${query})) - 80), 240)`,
                createdAt: messages.createdAt,
              })
              .from(messages)
              .innerJoin(
                conversations,
                and(
                  eq(conversations.id, messages.conversationId),
                  eq(conversations.userId, userId),
                ),
              )
              .where(
                and(
                  eq(messages.userId, userId),
                  inArray(messages.role, ["user", "assistant"]),
                  sql`${messages.content} LIKE ${like} ESCAPE '\\'`,
                ),
              )
              .orderBy(desc(messages.createdAt))
              .limit(Math.min(Math.max(Math.trunc(limit) || 1, 1), 50));
          },
          /** Creates the conversation on its first message; `false` if the ID is someone else's. */
          /** Opens a conversation, creating it, with its own model if one is given, when it's new. */
          open: async (id: string, title: string, pin?: { provider: string; model: string }) => {
            if (await getConversation(id)) return true;
            // A conflict is either another user's row or this user's from a concurrent open.
            await createConversation(id, title, pin).catch(() => {});
            return (await getConversation(id)) !== undefined;
          },
          /**
           * Pins the conversation to a model, or back to the Chat role with `null`. A `line` is the
           * thread's record of the switch, written with the pin or not at all.
           */
          setModel: async (
            conversationId: string,
            pick: { provider: string; model: string } | null,
            line?: { id: string; content: string },
          ) => {
            if (!(await getConversation(conversationId))) return false;
            const set = { modelProvider: pick?.provider ?? null, model: pick?.model ?? null };
            const update = db.update(conversations).set(set).where(own(conversationId));
            if (!line) await update;
            else await db.batch([update, message(conversationId, line.id, "system", line.content)]);
            return true;
          },
          /**
           * Writes the user's message and the empty streaming reply after it, both or neither,
           * and puts the message's files on it, each marked with whether the model received it
           * (M3-10 AC2): only the user's own, still-unlinked uploads move.
           */
          startTurn: async (
            conversationId: string,
            text: string,
            replyId: string,
            linked: readonly { id: string; sentToModel: boolean }[] = [],
          ) => {
            const userMessageId = crypto.randomUUID();
            const link = (sentToModel: boolean) => {
              const ids = linked.filter((f) => f.sentToModel === sentToModel).map((f) => f.id);
              return ids.length
                ? [
                    db
                      .update(attachments)
                      .set({ messageId: userMessageId, conversationId, sentToModel })
                      .where(
                        and(
                          eq(attachments.userId, userId),
                          inArray(attachments.id, ids),
                          isNull(attachments.messageId),
                        ),
                      ),
                  ]
                : [];
            };
            await db.batch([
              message(conversationId, userMessageId, "user", text),
              message(conversationId, replyId, "assistant", ""),
              ...link(true),
              ...link(false),
              db.update(conversations).set({ updatedAt: Date.now() }).where(own(conversationId)),
            ]);
          },
          /**
           * Finishes a reply and writes the call's usage ledger row (ADR 0006) in one transaction.
           * A call that never started gets no row.
           */
          settle: async (turn: TurnRecord, status: MessageStatus) => {
            await db.batch([
              db
                .update(messages)
                .set({ status, content: turn.reply })
                .where(and(eq(messages.id, turn.replyId), eq(messages.userId, userId))),
              ...(turn.called
                ? [
                    db.insert(usage).values({
                      ...ledgerValues(turn),
                      userId,
                      conversationId: turn.conversationId,
                      messageId: turn.replyId,
                    }),
                  ]
                : []),
            ]);
          },
        },
        /** The ledger the Usage page reads (PRD §17). */
        usage: {
          /** Calls since `since`, per provider, model and cost source; one query. */
          totals: (since: number) =>
            db
              .select({
                providerId: usage.providerId,
                model: usage.model,
                costSource: usage.costSource,
                calls: count(),
                inputTokens: sql<number>`sum(${usage.inputTokens})`.mapWith(Number),
                outputTokens: sql<number>`sum(${usage.outputTokens})`.mapWith(Number),
                costMicroUsd: sql<number | null>`sum(${usage.costMicroUsd})`.mapWith(Number),
                priceVerifiedAt: sql<string | null>`min(${usage.priceVerifiedAt})`,
              })
              .from(usage)
              .where(and(eq(usage.userId, userId), gte(usage.createdAt, since)))
              .groupBy(usage.providerId, usage.model, usage.costSource)
              .orderBy(usage.providerId, usage.model),
          /**
           * A call outside a chat turn, such as the settings Test button. A task run passes
           * its `taskId`, so the Tasks view can show its spend so far (M3-13 AC2).
           */
          record: async (call: LedgerCall & { taskId?: string }) => {
            await db.insert(usage).values({
              ...ledgerValues(call),
              userId,
              taskId: call.taskId === undefined ? null : checkId(call.taskId),
            });
          },
          /** Every ledger row, oldest first, for the data export (M3-20 AC1). */
          list: () =>
            db.select().from(usage).where(eq(usage.userId, userId)).orderBy(usage.createdAt),
        },
        /** Memory behind its trust gate (ADR 0008): the only way to the memory tables. */
        memory,
        /** Onboarding answers and the model roles (M2-15, M3-06). */
        settings: {
          get: async () =>
            (
              await db
                .select({
                  displayName: users.displayName,
                  about: userSettings.about,
                  chatProvider: userSettings.chatProvider,
                  chatModel: userSettings.chatModel,
                  backgroundProvider: userSettings.backgroundProvider,
                  backgroundModel: userSettings.backgroundModel,
                  onboardedAt: userSettings.onboardedAt,
                  learnFromChats: userSettings.learnFromChats,
                })
                .from(users)
                .leftJoin(userSettings, eq(userSettings.userId, users.id))
                .where(eq(users.id, userId))
                .limit(1)
            )[0],
          save: async (values: SettingsUpdate) => {
            const set = { ...values, updatedAt: Date.now() };
            await db
              .insert(userSettings)
              .values({ ...set, userId })
              .onConflictDoUpdate({ target: userSettings.userId, set });
          },
          rename: async (displayName: string) => {
            await db
              .update(users)
              .set({ displayName, updatedAt: Date.now() })
              .where(eq(users.id, userId));
          },
          keyUsed: async (secretId: string) => {
            await db
              .update(secrets)
              .set({ lastUsedAt: Date.now() })
              .where(and(eq(secrets.id, secretId), eq(secrets.userId, userId)));
          },
          /** Retention (COST-10, M3-18 AC1); the defaults until the user changes one. */
          retention: async (): Promise<RetentionSettings> => {
            const row = (
              await db
                .select({
                  messageRetentionDays: userSettings.messageRetentionDays,
                  toolOutputRetentionDays: userSettings.toolOutputRetentionDays,
                  memoryInboxDays: userSettings.memoryInboxDays,
                })
                .from(userSettings)
                .where(eq(userSettings.userId, userId))
                .limit(1)
            )[0];
            return row ? toSettings(row) : { ...RETENTION_DEFAULTS };
          },
          /**
           * Saves retention with its audit row (old and new values) and, for a new memory-inbox
           * expiry, the pending suggestions dated again from when each was made: all or none.
           * Only the changed fields are written, so two saves of different fields both stand.
           */
          saveRetention: async (from: RetentionSettings, to: RetentionSettings) => {
            const columns = {
              messageRetentionDays: to.messageDays ?? 0,
              toolOutputRetentionDays: to.toolOutputDays ?? 0,
              memoryInboxDays: to.memoryInboxDays,
            };
            const set = {
              ...(from.messageDays !== to.messageDays && {
                messageRetentionDays: columns.messageRetentionDays,
              }),
              ...(from.toolOutputDays !== to.toolOutputDays && {
                toolOutputRetentionDays: columns.toolOutputRetentionDays,
              }),
              ...(from.memoryInboxDays !== to.memoryInboxDays && {
                memoryInboxDays: columns.memoryInboxDays,
              }),
              updatedAt: Date.now(),
            };
            const save = [
              db
                .insert(userSettings)
                .values({ ...columns, userId, updatedAt: set.updatedAt })
                .onConflictDoUpdate({ target: userSettings.userId, set }),
              db.insert(auditLog).values({
                userId,
                action: "settings.retention",
                module: "settings",
                result: "ok",
                detail: JSON.stringify({ from, to }),
              }),
            ] as const;
            await (from.memoryInboxDays !== to.memoryInboxDays
              ? db.batch([...save, memory.redate()])
              : db.batch(save));
          },
        },
        /** The per-tool overrides and standing grants the policy engine reads (M3-02). */
        policy: {
          /** Each tool's override; a tool with none is missing from the map. */
          overrides: async () =>
            new Map(
              (
                await db
                  .select({ tool: toolOverrides.tool, decision: toolOverrides.decision })
                  .from(toolOverrides)
                  .where(eq(toolOverrides.userId, userId))
              ).map((r) => [r.tool, r.decision]),
            ),
          /**
           * Sets or clears one tool's override and writes its audit row, both or neither. `result`
           * is `denied` for a refused change (a loosening without a step-up, or an irreversible
           * tool to `auto`): only the audit row is written.
           */
          setOverride: async (change: OverrideChange, result: "ok" | "denied" = "ok") => {
            const { tool, to } = change;
            const audit = db.insert(auditLog).values({
              userId,
              action: "policy.override",
              module: "policy",
              targetId: tool,
              result,
              detail: JSON.stringify(change),
            });
            if (result === "denied") return void (await audit);
            const own = and(eq(toolOverrides.userId, userId), eq(toolOverrides.tool, tool));
            const set = { decision: to as ToolOverride, updatedAt: Date.now() };
            await db.batch([
              to === null
                ? db.delete(toolOverrides).where(own)
                : db
                    .insert(toolOverrides)
                    .values({ userId, tool, ...set })
                    .onConflictDoUpdate({
                      target: [toolOverrides.userId, toolOverrides.tool],
                      set,
                    }),
              audit,
            ]);
          },
          /** Grants not revoked and not expired at `now`, newest first; all tools unless `tool`. */
          grants: async (now: number, tool?: string): Promise<StoredGrant[]> => {
            const rows = await db
              .select()
              .from(grants)
              .where(
                and(
                  eq(grants.userId, userId),
                  tool === undefined ? undefined : eq(grants.tool, tool),
                  isNull(grants.revokedAt),
                  or(isNull(grants.expiresAt), gt(grants.expiresAt, now)),
                ),
              )
              .orderBy(desc(grants.createdAt));
            return rows.map((g) => ({
              id: g.id,
              tool: g.tool,
              scope: g.scope,
              createdAt: g.createdAt,
              ...(g.taskId === null ? {} : { taskId: g.taskId }),
              ...(g.destination === null ? {} : { destination: g.destination }),
              ...(g.expiresAt === null ? {} : { expiresAt: g.expiresAt }),
            }));
          },
          /**
           * Stores a standing grant and its audit row. Refused from a tainted context (M3-02 AC2):
           * the context's taint is a required argument, so no caller can skip the check.
           */
          grant: async (grant: StandingGrant, context: TaintState) => {
            if (context.taint !== "trusted") throw new Error("grant from a tainted context");
            const id = crypto.randomUUID();
            await db.batch([
              db.insert(grants).values({
                id,
                userId,
                tool: grant.tool,
                scope: grant.scope,
                taskId: grant.taskId ?? null,
                destination: grant.destination ?? null,
                expiresAt: grant.expiresAt ?? null,
              }),
              db.insert(auditLog).values({
                userId,
                action: "policy.grant",
                module: "policy",
                targetId: id,
                result: "ok",
                detail: JSON.stringify(grant),
              }),
            ]);
            return id;
          },
          /** Revokes one of the user's own live grants; `false` if it is missing or someone else's. */
          revoke: async (id: string) => {
            // One transaction, as a session revoke: `changes()` is the update's row count, so the
            // audit row records what the update did.
            const [update] = await db.batch([
              db
                .update(grants)
                .set({ revokedAt: Date.now() })
                .where(and(eq(grants.id, id), eq(grants.userId, userId), isNull(grants.revokedAt))),
              db.insert(auditLog).values({
                userId,
                action: "policy.revoke",
                module: "policy",
                targetId: checkId(id),
                result: sql`CASE WHEN changes() > 0 THEN 'ok' ELSE 'denied' END`,
              }),
            ]);
            return update.meta.changes > 0;
          },
        },
        /**
         * The user's own audit trail, oldest first, for the data export (M3-20 AC1) and the
         * activity log: deployment-level rows (`user_id` null) belong to nobody's export.
         */
        audit: {
          list: () =>
            db.select().from(auditLog).where(eq(auditLog.userId, userId)).orderBy(auditLog.id),
        },
        /**
         * Saved model providers (M3-06). A foreign key proves only that a row exists, so every
         * read here also matches the user: a role or conversation can never name another's key.
         */
        providers: {
          /** Oldest first, each with its key's last 4 and dates (SEC-7), never the key. */
          list: () => providerRows().orderBy(modelProviders.createdAt),
          /** `undefined` when the row is missing or someone else's. */
          get: async (id: string) =>
            isId(id) ? (await providerRows(eq(modelProviders.id, id)).limit(1))[0] : undefined,
          add: async (values: ProviderValues) => {
            const id = crypto.randomUUID();
            await db.insert(modelProviders).values({ ...values, id, userId });
            return id;
          },
          /**
           * A new model also moves the roles and conversations that were on the old one, so a
           * listing never shows one model while calls go to another. Other picks stay.
           */
          update: async (id: string, values: Partial<ProviderValues>) => {
            const old = (await providerRows(eq(modelProviders.id, id)).limit(1))[0];
            if (!old) return;
            const { model } = values;
            const moved = model && old.model && model !== old.model ? old.model : null;
            const on = (provider: SQLiteColumn, column: SQLiteColumn, owner: SQLiteColumn) =>
              and(eq(owner, userId), eq(provider, id), eq(column, moved as string));
            const { chatProvider, chatModel, backgroundProvider, backgroundModel } = userSettings;
            await db.batch([
              db
                .update(modelProviders)
                .set({ ...values, updatedAt: Date.now() })
                .where(ownProvider(id)),
              ...(moved && model
                ? [
                    db
                      .update(userSettings)
                      .set({ chatModel: model })
                      .where(on(chatProvider, chatModel, userSettings.userId)),
                    db
                      .update(userSettings)
                      .set({ backgroundModel: model })
                      .where(on(backgroundProvider, backgroundModel, userSettings.userId)),
                    db
                      .update(conversations)
                      .set({ model })
                      .where(
                        on(conversations.modelProvider, conversations.model, conversations.userId),
                      ),
                  ]
                : []),
            ]);
          },
          /** Removes the row and its key; roles and conversations naming it fall back. */
          remove: async (id: string) => {
            const row = (await providerRows(eq(modelProviders.id, id)).limit(1))[0];
            if (!row) return false;
            await db.batch([
              db.delete(modelProviders).where(ownProvider(id)),
              ...(row.keySecretId
                ? [
                    db
                      .delete(secrets)
                      .where(and(eq(secrets.id, row.keySecretId), eq(secrets.userId, userId))),
                  ]
                : []),
            ]);
            return true;
          },
        },
        /**
         * Attached files (M3-10): the row is created only after the object is stored, and every
         * read matches the user, so another user's file ID reads as missing.
         */
        attachments: {
          /**
           * Streams an upload to the user's prefix; the caller sniffs and bounds it first.
           * R2's `put` takes only a known-length stream, so a declared length goes through
           * workerd's `FixedLengthStream` where the runtime offers one, and an undeclared one
           * through a multipart upload in bounded parts — the whole file is never in memory
           * on any path (M3-10 AC1). A store with no multipart (Node) streams any body.
           */
          putObject: async (
            id: string,
            body: ReadableStream<Uint8Array>,
            contentType: string,
            knownLength?: number,
          ) =>
            putStreamed(
              FILES,
              attachmentKey(id),
              body,
              { httpMetadata: { contentType } },
              knownLength,
            ),
          /** The stored bytes, or `null` when the object is gone. */
          getObject: (id: string) => FILES.get(attachmentKey(id)),
          /** Removes a stored object whose row was never (or is no longer) written. */
          removeObject: (id: string) => FILES.delete(attachmentKey(id)),
          create: async (values: {
            id: string;
            name: string;
            mediaType: string;
            kind: "image" | "pdf" | "text";
            sizeBytes: number;
          }) => {
            await db.insert(attachments).values({ ...values, id: checkId(values.id), userId });
          },
          /** `undefined` when the row is missing or someone else's: answer 404 for both. */
          get: async (id: string): Promise<AttachmentRow | undefined> =>
            isId(id)
              ? (
                  await db
                    .select({
                      id: attachments.id,
                      name: attachments.name,
                      mediaType: attachments.mediaType,
                      kind: attachments.kind,
                      sizeBytes: attachments.sizeBytes,
                      sentToModel: attachments.sentToModel,
                      createdAt: attachments.createdAt,
                    })
                    .from(attachments)
                    .where(and(eq(attachments.id, id), eq(attachments.userId, userId)))
                    .limit(1)
                )[0]
              : undefined,
          /** The user's own rows among `ids`, in upload order; foreign IDs are simply absent. */
          getMany: async (ids: readonly string[]): Promise<AttachmentRow[]> =>
            ids.length
              ? db
                  .select({
                    id: attachments.id,
                    name: attachments.name,
                    mediaType: attachments.mediaType,
                    kind: attachments.kind,
                    sizeBytes: attachments.sizeBytes,
                    sentToModel: attachments.sentToModel,
                    createdAt: attachments.createdAt,
                  })
                  .from(attachments)
                  .where(and(eq(attachments.userId, userId), inArray(attachments.id, [...ids])))
                  .orderBy(attachments.createdAt)
              : [],
          /**
           * Every attachment row, oldest first, each with the message carrying it, for the data
           * export (M3-20 AC1). The bytes stay in R2; the export's finish step streams them.
           */
          list: () =>
            db
              .select({
                id: attachments.id,
                name: attachments.name,
                mediaType: attachments.mediaType,
                kind: attachments.kind,
                sizeBytes: attachments.sizeBytes,
                sentToModel: attachments.sentToModel,
                conversationId: attachments.conversationId,
                messageId: attachments.messageId,
                createdAt: attachments.createdAt,
              })
              .from(attachments)
              .where(eq(attachments.userId, userId))
              .orderBy(attachments.createdAt),
          /** Deletes the row and its object; `false` when it isn't the user's. */
          remove: async (id: string) => {
            if (!isId(id)) return false;
            const gone = await db
              .delete(attachments)
              .where(and(eq(attachments.id, id), eq(attachments.userId, userId)))
              .returning({ id: attachments.id });
            if (!gone.length) return false;
            await FILES.delete(attachmentKey(id));
            return true;
          },
        },
        /**
         * Durable task runs (M3-12). Every write is one conditional update on the row's current
         * status, so a cancel that lands mid-step is never overwritten by the run it stops: the
         * run's next write simply matches no row and reports `false`.
         */
        tasks: {
          /**
           * `false` when the conversation isn't the user's. The row starts `queued`. A row the
           * `task` tool files has no Workflow instance yet (promotion creates it in M3-12b),
           * so the instance id is optional and stays null until then.
           */
          create: async (input: {
            id: string;
            conversationId: string;
            workflowInstanceId?: string | null;
            kind: string;
            mode: TaskRow["mode"];
            title?: string | null;
            state?: string | null;
          }): Promise<boolean> => {
            if (input.workflowInstanceId != null && !isInstanceId(input.workflowInstanceId))
              throw new Error("invalid instance id");
            if (!(await getConversation(input.conversationId))) return false;
            await db.insert(tasks).values({
              id: checkId(input.id),
              userId,
              conversationId: input.conversationId,
              workflowInstanceId: input.workflowInstanceId ?? null,
              kind: input.kind,
              mode: input.mode,
              title: input.title ?? null,
              state: input.state ?? null,
            });
            return true;
          },
          /** The user's task row; `undefined` when it is missing or someone else's. */
          get: async (id: string) =>
            (
              await db
                .select()
                .from(tasks)
                .where(and(eq(tasks.id, id), eq(tasks.userId, userId)))
                .limit(1)
            )[0],
          /** Every task row, oldest first, for the data export (M3-20 AC1). */
          listForExport: () =>
            db.select().from(tasks).where(eq(tasks.userId, userId)).orderBy(tasks.createdAt),
          /**
           * The Tasks list (M3-13 AC1–2): newest first, with each run's conversation title and
           * spend so far. Filters are all optional; unknown statuses are ignored, and the limit
           * is clamped (1–200, default 50).
           */
          list: async (
            filter: {
              status?: readonly string[] | undefined;
              since?: number | undefined;
              until?: number | undefined;
              limit?: number | undefined;
            } = {},
          ): Promise<TaskListItem[]> => {
            const cost = db
              .select({
                taskId: usage.taskId,
                costMicroUsd: sql<number | null>`sum(${usage.costMicroUsd})`.as("cost_micro_usd"),
                unpriced: sql<
                  number | null
                >`sum(case when ${usage.costMicroUsd} is null then 1 else 0 end)`.as("unpriced"),
                calls: count().as("calls"),
              })
              .from(usage)
              .where(and(eq(usage.userId, userId), isNotNull(usage.taskId)))
              .groupBy(usage.taskId)
              .as("cost");
            const statuses = (filter.status ?? []).filter((s): s is TaskStatus =>
              (TASK_STATUSES as readonly string[]).includes(s),
            );
            const limit = Math.min(
              200,
              Math.max(1, Number.isSafeInteger(filter.limit) ? (filter.limit as number) : 50),
            );
            const rows = await db
              .select({
                id: tasks.id,
                title: tasks.title,
                conversationId: tasks.conversationId,
                conversationTitle: conversations.title,
                kind: tasks.kind,
                mode: tasks.mode,
                status: tasks.status,
                limitKind: tasks.limitKind,
                error: tasks.error,
                costMicroUsd: cost.costMicroUsd,
                unpriced: cost.unpriced,
                calls: cost.calls,
                createdAt: tasks.createdAt,
                updatedAt: tasks.updatedAt,
                startedAt: tasks.startedAt,
                finishedAt: tasks.finishedAt,
              })
              .from(tasks)
              .innerJoin(conversations, eq(conversations.id, tasks.conversationId))
              .leftJoin(cost, eq(cost.taskId, tasks.id))
              .where(
                and(
                  eq(tasks.userId, userId),
                  ...(statuses.length ? [inArray(tasks.status, statuses)] : []),
                  ...(Number.isSafeInteger(filter.since)
                    ? [gte(tasks.createdAt, filter.since as number)]
                    : []),
                  ...(Number.isSafeInteger(filter.until)
                    ? [lte(tasks.createdAt, filter.until as number)]
                    : []),
                ),
              )
              .orderBy(desc(tasks.createdAt))
              .limit(limit);
            // No calls yet reads as zero calls and unknown cost, never as nulls.
            return rows.map(({ unpriced, ...row }) => ({
              ...row,
              calls: row.calls ?? 0,
              unpricedCalls: unpriced ?? 0,
            }));
          },
          /** One Tasks row with its conversation and spend; `undefined` when missing or foreign. */
          details: async (id: string): Promise<TaskListItem | undefined> => {
            if (!isId(id)) return undefined;
            const [row] = await db
              .select({
                id: tasks.id,
                title: tasks.title,
                conversationId: tasks.conversationId,
                conversationTitle: conversations.title,
                kind: tasks.kind,
                mode: tasks.mode,
                status: tasks.status,
                limitKind: tasks.limitKind,
                error: tasks.error,
                costMicroUsd: sql<number | null>`sum(${usage.costMicroUsd})`.as("cost_micro_usd"),
                // The left join's null usage row is not a call: without it a task with no
                // usage would report one unpriced call alongside zero calls.
                unpriced: sql<
                  number | null
                >`sum(case when ${usage.id} is not null and ${usage.costMicroUsd} is null then 1 else 0 end)`.as(
                  "unpriced",
                ),
                calls: count(usage.id).as("calls"),
                createdAt: tasks.createdAt,
                updatedAt: tasks.updatedAt,
                startedAt: tasks.startedAt,
                finishedAt: tasks.finishedAt,
              })
              .from(tasks)
              .innerJoin(conversations, eq(conversations.id, tasks.conversationId))
              .leftJoin(usage, and(eq(usage.taskId, tasks.id), eq(usage.userId, userId)))
              .where(and(eq(tasks.id, id), eq(tasks.userId, userId)))
              .groupBy(tasks.id)
              .limit(1);
            // A task with no calls still counts zero, never null; the cost stays null then.
            if (!row) return row;
            const { unpriced, ...rest } = row;
            return { ...rest, calls: Number(rest.calls), unpricedCalls: Number(unpriced ?? 0) };
          },
          /**
           * Moves a task to `running`, stamping `started_at` the first time. Resuming clears a
           * previous limit kind, which only ever describes a `budget_limited` pause. Returns
           * the row as updated, or `undefined` when it was already terminal (a cancelled task
           * never runs).
           */
          markRunning: async (id: string, now: number) =>
            (
              await db
                .update(tasks)
                .set({
                  status: "running",
                  limitKind: null,
                  startedAt: sql`coalesce(${tasks.startedAt}, ${now})`,
                  updatedAt: now,
                })
                .where(
                  and(
                    eq(tasks.id, id),
                    eq(tasks.userId, userId),
                    notInArray(tasks.status, [...TASK_TERMINAL_STATUSES]),
                  ),
                )
                .returning()
            )[0],
          /**
           * Persists the loop's state at a step boundary, with a move between the two in-flight
           * statuses when one is given. Endings go through `finish` or `cancel`, which stamp
           * them. `false` when the task is cancelled or terminal: its steps write nothing.
           */
          saveState: async (
            id: string,
            state: string,
            status?: "running" | "waiting_for_approval",
          ) =>
            (
              await db
                .update(tasks)
                .set({
                  state,
                  updatedAt: Date.now(),
                  ...(status === "running" || status === "waiting_for_approval" ? { status } : {}),
                })
                .where(
                  and(
                    eq(tasks.id, id),
                    eq(tasks.userId, userId),
                    notInArray(tasks.status, [...TASK_TERMINAL_STATUSES]),
                  ),
                )
                .returning({ id: tasks.id })
            ).length > 0,
          /**
           * Ends a task that is still active. `false` when it had already ended or was
           * cancelled. A `budget_limited` ending records which limit stopped it, so the Tasks
           * view reads "Paused: limit" for an execution limit and "Paused: budget" for money
           * (M3-13 AC1); other endings clear it.
           */
          finish: async (
            id: string,
            status: "succeeded" | "failed" | "budget_limited" | "interrupted",
            error?: string,
            limitKind?: TaskLimitKind | null,
          ) => {
            const now = Date.now();
            const nextKind = status === "budget_limited" ? (limitKind ?? null) : null;
            // A pause writes `budget_limited` when it starts waiting, and the run's end writes
            // the same pause again when the 7-day wait times out with no Continue. Re-stamping
            // `updatedAt` there would move the pause timestamp, and the Tasks view freezes its
            // elapsed clock at `updatedAt` — so the wait would read as run time. Only the
            // pause repeats: a repeated terminal ending still falls through to the update,
            // which matches no row and reports `false` ("already ended").
            const current = (
              await db
                .select({ status: tasks.status, limitKind: tasks.limitKind })
                .from(tasks)
                .where(and(eq(tasks.id, id), eq(tasks.userId, userId)))
                .limit(1)
            )[0];
            if (
              current?.status === "budget_limited" &&
              status === "budget_limited" &&
              (current.limitKind ?? null) === nextKind
            )
              return true;
            return (
              (
                await db
                  .update(tasks)
                  .set({
                    status,
                    error: error ?? null,
                    limitKind: nextKind,
                    // A budget-limited task is paused, not finished: it may be continued.
                    ...(status === "budget_limited" ? {} : { finishedAt: now }),
                    updatedAt: now,
                  })
                  .where(
                    and(
                      eq(tasks.id, id),
                      eq(tasks.userId, userId),
                      notInArray(tasks.status, [...TASK_TERMINAL_STATUSES]),
                    ),
                  )
                  .returning({ id: tasks.id })
              ).length > 0
            );
          },
          /**
           * Continue on a task paused by a limit (M3-17 AC1): `budget_limited` back to `running`.
           * `false` when it isn't paused. Waking its Workflow is the caller's job.
           */
          resume: async (id: string) =>
            (
              await db
                .update(tasks)
                .set({ status: "running", updatedAt: Date.now() })
                .where(
                  and(
                    eq(tasks.id, id),
                    eq(tasks.userId, userId),
                    eq(tasks.status, "budget_limited"),
                  ),
                )
                .returning({ id: tasks.id })
            ).length > 0,
          /**
           * Sets `cancelled` on an active task. Cancelling clears the limit kind, which only
           * ever describes a `budget_limited` pause. Terminating its Workflow is the
           * caller's job.
           */
          cancel: async (id: string) => {
            const now = Date.now();
            return (
              (
                await db
                  .update(tasks)
                  .set({ status: "cancelled", limitKind: null, finishedAt: now, updatedAt: now })
                  .where(
                    and(
                      eq(tasks.id, id),
                      eq(tasks.userId, userId),
                      inArray(tasks.status, [...TASK_CANCELLABLE_STATUSES]),
                    ),
                  )
                  .returning({ id: tasks.id })
              ).length > 0
            );
          },
        },
        /**
         * Data exports (M3-20 AC1). The R2 keys are derived, never stored: the final ZIP at
         * `key`, the item files the run stages at `stagedKey`, both under the user's prefix so
         * no export can name another user's objects (and M3-20b's deletion walks the prefix).
         */
        exports: {
          /** The final ZIP's key; `checkId` keeps it inside the user's exports prefix. */
          key: exportZipKey,
          /** One staged item file's key, under the export's own directory. */
          stagedKey: exportStagedKey,
          /** The export's directory: the final ZIP beside it is not staged, so it is excluded. */
          stagedPrefix: exportStagedPrefix,
          /** Every key under a prefix, in order, following cursors (`[]` without a listing). */
          listPrefix: listR2Prefix,
          /**
           * The user's other R2 stores the export's artifacts step walks (and M3-20b's deletion
           * walks): the tool artifacts under `files/` and the offloaded task outputs under
           * `task-outputs/`, both opaque objects with no D1 index, each with its ZIP directory.
           */
          artifactStores: () =>
            [
              { prefix: `u/${userId}/files/`, dir: "artifacts/files" },
              { prefix: `u/${userId}/task-outputs/`, dir: "artifacts/task-outputs" },
            ] as const,
          /**
           * One of the user's R2 objects as a stream, by full key: a staged file, an
           * attachment, or an object from a store the export walks. `null` when it is gone;
           * keys outside the user's prefix are rejected, so no call names another's objects.
           */
          getObject: (key: string) => {
            if (!key.startsWith(`u/${userId}/`)) throw new Error("invalid key");
            return FILES.get(key);
          },
          /**
           * Stages one item file under the export's directory. Bodies stream through, never
           * buffer: a string for the JSON manifests, a stream for attachment and artifact bytes
           * (through a multipart upload — R2's `put` takes only a known-length stream).
           */
          putStaged: (
            id: string,
            name: string,
            body: string | ReadableStream,
            contentType: string,
          ) => {
            const key = exportStagedKey(id, name);
            const options = { httpMetadata: { contentType } };
            return typeof body === "string"
              ? FILES.put(key, body, options)
              : putStreamed(FILES, key, body, options);
          },
          /** Deletes the export's staged files once the ZIP is built (or the run failed). */
          removeStaged: async (id: string) => {
            for (const object of await listR2Prefix(exportStagedPrefix(id)))
              await FILES.delete(object.key);
          },
          /**
           * A multipart upload for the final ZIP. Throws where the store streams any body
           * (Node): an export only ever runs on Workers, where R2 always offers it.
           */
          createZipUpload: async (id: string) => {
            const create = FILES.createMultipartUpload;
            if (!create) throw new Error("multipart upload is unavailable");
            // Bound to FILES: the binding's methods reject a detached call.
            return create.call(FILES, exportZipKey(id), {
              httpMetadata: { contentType: "application/zip" },
            });
          },
          /**
           * Creates the row a run fills; the instance id names it for `scopeForExport`. `false`
           * when the instance already names a row, so a retry or a racing second POST claims
           * nothing new; anything else (a real database failure) still throws.
           */
          create: async (input: {
            id: string;
            workflowInstanceId: string;
            expiresAt: number;
          }): Promise<boolean> => {
            if (!isInstanceId(input.workflowInstanceId)) throw new Error("invalid instance id");
            try {
              await db.insert(dataExports).values({
                id: checkId(input.id),
                userId,
                workflowInstanceId: input.workflowInstanceId,
                expiresAt: input.expiresAt,
              });
            } catch (error) {
              const [claimed] = await db
                .select({ id: dataExports.id })
                .from(dataExports)
                .where(eq(dataExports.workflowInstanceId, input.workflowInstanceId))
                .limit(1);
              if (!claimed) throw error;
              return false;
            }
            return true;
          },
          /** The user's export row; `undefined` when it is missing or someone else's. */
          get: async (id: string) =>
            isId(id)
              ? (
                  await db
                    .select()
                    .from(dataExports)
                    .where(and(eq(dataExports.id, id), eq(dataExports.userId, userId)))
                    .limit(1)
                )[0]
              : undefined,
          /** Every export row, newest first, for the status list. */
          list: () =>
            db
              .select()
              .from(dataExports)
              .where(eq(dataExports.userId, userId))
              .orderBy(desc(dataExports.createdAt)),
          /** The still-running row, if any: the UI's "already being made" state (m3-ux §3.11). */
          running: async () =>
            (
              await db
                .select()
                .from(dataExports)
                .where(and(eq(dataExports.userId, userId), eq(dataExports.status, "running")))
                .orderBy(desc(dataExports.createdAt))
                .limit(1)
            )[0],
          /**
           * Marks a running export ready. `false` when it had already ended, or when its
           * expiry had passed: a late finish never turns a past-expiry row ready, even if
           * the expiry landed between the caller's re-read and this conditional update.
           */
          finishReady: async (id: string, sizeBytes: number, now: number) =>
            (
              await db
                .update(dataExports)
                .set({ status: "ready", sizeBytes, readyAt: now })
                .where(
                  and(
                    eq(dataExports.id, id),
                    eq(dataExports.userId, userId),
                    eq(dataExports.status, "running"),
                    gt(dataExports.expiresAt, now),
                  ),
                )
                .returning({ id: dataExports.id })
            ).length > 0,
          /** Marks a running export failed, keeping the reason; `false` when it had ended. */
          finishFailed: async (id: string, error: string) =>
            (
              await db
                .update(dataExports)
                .set({ status: "failed", error: error.slice(0, 500) })
                .where(
                  and(
                    eq(dataExports.id, id),
                    eq(dataExports.userId, userId),
                    eq(dataExports.status, "running"),
                  ),
                )
                .returning({ id: dataExports.id })
            ).length > 0,
          /**
           * Moves a running export to expired, for a finish that finds its row past expiry: a
           * past-expiry row must never turn ready. `false` when it had already ended. (The
           * sweep moves rows of any status with its own update; this is the running-only guard.)
           */
          finishExpired: async (id: string) =>
            (
              await db
                .update(dataExports)
                .set({ status: "expired" })
                .where(
                  and(
                    eq(dataExports.id, id),
                    eq(dataExports.userId, userId),
                    eq(dataExports.status, "running"),
                  ),
                )
                .returning({ id: dataExports.id })
            ).length > 0,
          /** Deletes the final ZIP, for a finish that expired before it could turn ready. */
          removeZip: (id: string) => FILES.delete(`u/${userId}/exports/${checkId(id)}.zip`),
        },
        /**
         * Step outputs too large to persist inline (M3-12 AC4), under their own prefix so they
         * never appear among the user's files. IDs are content-free (a hash of the step's
         * idempotency key), derived by the caller.
         */
        stepOutputs: {
          put: (id: string, value: string) =>
            FILES.put(`u/${userId}/task-outputs/${checkId(id)}`, value, {
              httpMetadata: { contentType: "application/json" },
            }),
          get: (id: string) => FILES.get(`u/${userId}/task-outputs/${checkId(id)}`),
        },
        getFile: (id: string) => FILES.get(fileKey(id)),
        /**
         * The built-in tools' file ports (M3-08 AC3), bound to the run that writes: whatever a
         * tool saves joins Outputs with that run as its source (M3-11).
         */
        files: (source: ArtifactSource) => ({
          getFile: (id: string) => FILES.get(fileKey(id)),
          putFile: (id: string, content: string, mediaType: string, name: string) =>
            saveArtifact({ id, name, mediaType, content, source }),
        }),
        /**
         * Outputs (M3-11): the files tools wrote. Every read matches the user, so another
         * user's artifact ID reads as missing.
         */
        artifacts: {
          save: saveArtifact,
          /**
           * Newest first, a page at a time; `conversationId` narrows to one chat's files. The
           * cursor is the last row's `createdAt` and `id`, matching the sort, so a page that ends
           * inside a same-millisecond tie still reaches the rest of it.
           */
          list: async (
            options: { conversationId?: string; before?: number; beforeId?: string } = {},
          ): Promise<ArtifactRow[]> =>
            artifactRows()
              .where(
                and(
                  eq(artifacts.userId, userId),
                  options.conversationId !== undefined
                    ? eq(artifacts.conversationId, options.conversationId)
                    : undefined,
                  options.before === undefined
                    ? undefined
                    : options.beforeId === undefined
                      ? lt(artifacts.createdAt, options.before)
                      : or(
                          lt(artifacts.createdAt, options.before),
                          and(
                            eq(artifacts.createdAt, options.before),
                            lt(artifacts.id, options.beforeId),
                          ),
                        ),
                ),
              )
              .orderBy(desc(artifacts.createdAt), desc(artifacts.id))
              .limit(ARTIFACT_PAGE),
          /** `undefined` when the row is missing or someone else's: answer 404 for both. */
          get: async (id: string): Promise<ArtifactRow | undefined> =>
            isId(id)
              ? (
                  await artifactRows()
                    .where(and(eq(artifacts.id, id), eq(artifacts.userId, userId)))
                    .limit(1)
                )[0]
              : undefined,
          /** The stored bytes, or `null` when the object is gone. */
          getObject: (id: string) => FILES.get(fileKey(id)),
          /**
           * Deletes the object, then the row; `false` when it isn't the user's. The row goes last
           * so a failed object delete leaves the file listed, and the delete can be retried.
           */
          remove: async (id: string) => {
            if (!isId(id)) return false;
            const own = await db
              .select({ id: artifacts.id })
              .from(artifacts)
              .where(and(eq(artifacts.id, id), eq(artifacts.userId, userId)))
              .limit(1);
            if (!own.length) return false;
            await FILES.delete(fileKey(id));
            await db
              .delete(artifacts)
              .where(and(eq(artifacts.id, id), eq(artifacts.userId, userId)));
            return true;
          },
        },
      };
    },
  };
}
