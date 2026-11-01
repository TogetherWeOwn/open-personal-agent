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
import type { BatchItem } from "drizzle-orm/batch";
import type { AnyD1Database } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
// A separate entry point (`@opa/db/repository`), so this import is not a cycle.
import { openD1, readSchemaVersion } from "./index";
import { memoryService } from "./memory";
import { RETENTION_DEFAULTS, type RetentionSettings, toSettings } from "./retention";
import {
  approvals,
  artifacts,
  attachments,
  auditLog,
  conversations,
  dataExports,
  grants,
  messages,
  meters,
  modelProviders,
  secrets,
  tasks,
  toolOverrides,
  turnStates,
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
     * store has none; both then leave those objects alone.
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
     * walks (M3-20 AC1). Absent where the store has no listing; the walk then treats
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
 * A batch ID: the assistant's are `batch_<uuid>`, a task's carry its Workflow instance ID, which
 * can be longer than `isId` allows. Letters, digits, `_` and `-` (a Workflow instance ID's
 * alphabet), so it stays one path segment: no `.`, `..` or percent-escape.
 */
export const isBatchId = (id: unknown): id is string =>
  typeof id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(id);

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
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | null;
}

/** One model call for the ledger. `providerId` is who bills it (`billingProviderId`). */
export interface LedgerCall {
  providerId: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | null;
}

/** Why a saved turn stopped, and so how it can resume (M3-03 AC5). */
export type TurnStatus = "awaiting_approval" | "limit_reached";

/**
 * A stopped turn's row in `turn_states`. `state` is the loop's `TurnState` as JSON: the host
 * owns its shape, the repository only keeps it. `providerId` is who bills the turn's calls.
 */
export interface SavedTurn {
  turnId: string;
  conversationId: string;
  replyId: string;
  providerId: string;
  model: string;
  status: TurnStatus;
  state: string;
}

/** An approval row (M3-07 AC9). Its `nonce` and `stepUp*` columns never leave the server. */
export type ApprovalRow = typeof approvals.$inferSelect;
/** An approval as the host writes it when its turn or task stops: pending, undecided. */
export type NewApproval = Pick<
  typeof approvals.$inferInsert,
  | "batchId"
  | "approvalId"
  | "position"
  | "conversationId"
  | "turnId"
  | "taskId"
  | "tool"
  | "toolCallId"
  | "target"
  | "risk"
  | "rule"
  | "stepUp"
  | "scopes"
  | "taint"
  | "canonical"
  | "bindingHash"
  | "expiresAt"
>;
/** A step-up ceremony in progress on a batch (crypto review W3). */
export type StepUpCeremony = {
  nonce: string;
  digest: string;
  expiresAt: number;
  sessionId: string;
};
/** How an approved call ended: it ran, it failed, or the re-check refused it (M3-07 AC12). */
export type ApprovalOutcome =
  | { status: "executed" | "failed" }
  | { status: "failed"; reason: string }
  | { status: "denied" | "expired"; reason: string };

/** The audit row for an approval change; `action` is NULL, breaking NOT NULL, unless `guard`. */
const approvalAudit = (
  userId: string,
  action: string,
  batchId: string,
  approvalId: string | null,
  result: "ok" | "denied" | "error",
  detail: Record<string, unknown> | null,
  guard?: SQL,
) => ({
  userId,
  action: guard ? sql`CASE WHEN ${guard} THEN ${action} END` : action,
  module: "approvals",
  targetId: approvalId === null ? batchId : `${batchId}/${approvalId}`,
  result,
  detail: detail === null ? null : JSON.stringify(detail),
});

/** Whether a batch failed on an `approvalAudit` guard (nothing changed), not on D1 itself. */
const guardRefused = (e: unknown): boolean => {
  for (let at = e; at instanceof Error; at = at.cause) {
    if (at.message.includes("NOT NULL constraint failed: audit_log.action")) return true;
  }
  return false;
};

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
      /** Adds to a ledger meter's UTC day (M3-16 AC3): one upsert, no read. */
      addToMeter: async (meter: "workflow_steps" | "do_ms", amount: number, at: number) => {
        await db
          .insert(meters)
          .values({ meter, day: at - (at % 86_400_000), amount })
          .onConflictDoUpdate({
            target: [meters.meter, meters.day],
            set: { amount: sql`${meters.amount} + ${amount}` },
          });
      },
      /** A ledger meter's total over the UTC days from `since`. */
      meterTotal: async (meter: "workflow_steps" | "do_ms", since: number) =>
        (
          await db
            .select({ n: sql<number>`coalesce(sum(${meters.amount}), 0)`.mapWith(Number) })
            .from(meters)
            .where(and(eq(meters.meter, meter), gte(meters.day, since - (since % 86_400_000))))
        )[0]?.n ?? 0,
      /** Sets a gauge meter's UTC day to the latest reading (M3-18 AC2): one upsert, no read. */
      setMeter: async (meter: "d1_bytes", amount: number, at: number) => {
        await db
          .insert(meters)
          .values({ meter, day: at - (at % 86_400_000), amount })
          .onConflictDoUpdate({ target: [meters.meter, meters.day], set: { amount } });
      },
      /** A gauge meter's latest recorded reading, or null before the first. */
      latestMeter: async (meter: "d1_bytes") =>
        (
          await db
            .select({ amount: meters.amount })
            .from(meters)
            .where(eq(meters.meter, meter))
            .orderBy(desc(meters.day))
            .limit(1)
        )[0]?.amount ?? null,
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
       * Batch statements putting the caller's still-unlinked uploads on a message, each marked
       * with whether the model received it (M3-10 AC2): only the user's own, still-unlinked
       * uploads move, so a retry can link them again and a dequeue can release them.
       */
      const linkAttachments = (
        conversationId: string,
        userMessageId: string,
        sentToModel: boolean,
        ids: readonly string[],
      ) =>
        ids.length
          ? [
              db
                .update(attachments)
                .set({ messageId: userMessageId, conversationId, sentToModel })
                .where(
                  and(
                    eq(attachments.userId, userId),
                    inArray(attachments.id, [...ids]),
                    isNull(attachments.messageId),
                  ),
                ),
            ]
          : [];
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
            const link = (sentToModel: boolean) =>
              linkAttachments(
                conversationId,
                userMessageId,
                sentToModel,
                linked.filter((f) => f.sentToModel === sentToModel).map((f) => f.id),
              );
            await db.batch([
              message(conversationId, userMessageId, "user", text),
              message(conversationId, replyId, "assistant", ""),
              ...link(true),
              ...link(false),
              db.update(conversations).set({ updatedAt: Date.now() }).where(own(conversationId)),
            ]);
          },
          /**
           * Holds a send that arrived mid-run (M3-09 AC4): opens the conversation when it's new
           * and writes the user's row with its files and its empty reply row, both, so the
           * queued text is already in D1 and visible on reload. The pair keeps the thread's
           * shape — each user row immediately followed by its reply — so the waiting exchange
           * reads where it will settle. `null` when the ID is someone else's.
           */
          enqueue: async (
            conversationId: string,
            title: string,
            text: string,
            pin: { provider: string; model: string } | undefined,
            linked: readonly { id: string; sentToModel: boolean }[] = [],
          ) => {
            const userMessageId = crypto.randomUUID();
            const replyId = crypto.randomUUID();
            const link = (sentToModel: boolean) =>
              linkAttachments(
                conversationId,
                userMessageId,
                sentToModel,
                linked.filter((f) => f.sentToModel === sentToModel).map((f) => f.id),
              );
            if (!(await getConversation(conversationId))) {
              // A conflict is either another user's row or this user's from a concurrent open.
              await createConversation(conversationId, title, pin).catch(() => {});
              if (!(await getConversation(conversationId))) return null;
            }
            await db.batch([
              message(conversationId, userMessageId, "user", text),
              message(conversationId, replyId, "assistant", ""),
              ...link(true),
              ...link(false),
              db.update(conversations).set({ updatedAt: Date.now() }).where(own(conversationId)),
            ]);
            return { messageId: userMessageId, replyId };
          },
          /**
           * Notes a steer that joined its conversation's running turn (M3-09 AC4): only the
           * user's row, since the running turn's reply answers it — there is no reply of its
           * own. The row keeps the steer visible on reload and in later turns' history. `null`
           * when the ID is missing or someone else's.
           */
          steer: async (conversationId: string, text: string) => {
            if (!(await getConversation(conversationId))) return null;
            const userMessageId = crypto.randomUUID();
            await db.batch([
              message(conversationId, userMessageId, "user", text),
              db.update(conversations).set({ updatedAt: Date.now() }).where(own(conversationId)),
            ]);
            return userMessageId;
          },
          /**
           * Starts a queued send's reply (M3-09 AC4): the rows are already stored, so this only
           * marks each file with whether the now-known reading model receives it (M3-10 AC2).
           * `false` when the conversation is missing or someone else's.
           */
          beginReply: async (
            conversationId: string,
            userMessageId: string,
            linked: readonly { id: string; sentToModel: boolean }[] = [],
          ) => {
            if (!(await getConversation(conversationId))) return false;
            const flag = (sentToModel: boolean) => {
              const ids = linked.filter((f) => f.sentToModel === sentToModel).map((f) => f.id);
              return ids.length
                ? [
                    db
                      .update(attachments)
                      .set({ sentToModel })
                      .where(
                        and(
                          eq(attachments.userId, userId),
                          eq(attachments.messageId, checkId(userMessageId)),
                          inArray(attachments.id, [...ids]),
                        ),
                      ),
                  ]
                : [];
            };
            await db.batch([
              db.update(conversations).set({ updatedAt: Date.now() }).where(own(conversationId)),
              ...flag(true),
              ...flag(false),
            ]);
            return true;
          },
          /**
           * Cancels a queued send before it starts (M3-09 AC4): deletes the still-waiting pair —
           * the user row and its still-empty reply — and releases its files back to unlinked, so
           * a resend can link them again. The host dequeues from memory first, so it never names
           * a started turn; the empty-reply guard below is defense in depth. `false` when the
           * rows are already replying, settled, or someone else's.
           */
          dropQueued: async (conversationId: string, messageId: string, replyId: string) => {
            if (!(await getConversation(conversationId))) return false;
            const row = (
              await db
                .select({ id: messages.id })
                .from(messages)
                .where(
                  and(
                    eq(messages.id, checkId(messageId)),
                    eq(messages.conversationId, conversationId),
                    eq(messages.role, "user"),
                    eq(messages.userId, userId),
                  ),
                )
                .limit(1)
            )[0];
            const reply = (
              await db
                .select({ id: messages.id })
                .from(messages)
                .where(
                  and(
                    eq(messages.id, checkId(replyId)),
                    eq(messages.conversationId, conversationId),
                    eq(messages.role, "assistant"),
                    eq(messages.status, "streaming"),
                    eq(messages.userId, userId),
                  ),
                )
                .limit(1)
            )[0];
            if (!row || !reply) return false;
            await db.batch([
              db.delete(messages).where(eq(messages.id, row.id)),
              db.delete(messages).where(eq(messages.id, reply.id)),
              db
                .update(attachments)
                .set({ messageId: null, conversationId: null, sentToModel: false })
                .where(and(eq(attachments.userId, userId), eq(attachments.messageId, row.id))),
            ]);
            return true;
          },
          /**
           * A stopped turn's partial reply so far, still `streaming`: what a tab that loads the
           * conversation while the turn waits to resume reads (M3-03 AC5).
           */
          checkpointReply: async (replyId: string, content: string) => {
            await db
              .update(messages)
              .set({ content })
              .where(and(eq(messages.id, replyId), eq(messages.userId, userId)));
          },
          /**
           * Finishes a reply. The ledger is written per model call as calls end (`usage.record`),
           * so settling only closes the message.
           */
          settle: async (reply: { replyId: string; reply: string }, status: MessageStatus) => {
            await db
              .update(messages)
              .set({ status, content: reply.reply })
              .where(and(eq(messages.id, reply.replyId), eq(messages.userId, userId)));
          },
          /**
           * Settles a reply `interrupted` only while it is still `streaming`, for a recovery that
           * can't tell whether its turn settled first. Returns the reply's status afterwards:
           * `interrupted` if it cut the reply, else the end the turn already gave it.
           */
          interrupt: async (reply: { replyId: string; reply: string }) => {
            const mine = and(eq(messages.id, reply.replyId), eq(messages.userId, userId));
            const [, rows] = await db.batch([
              db
                .update(messages)
                .set({ status: "interrupted", content: reply.reply })
                .where(and(mine, eq(messages.status, "streaming"))),
              db.select({ status: messages.status }).from(messages).where(mine).limit(1),
            ]);
            return rows[0]?.status;
          },
        },
        /**
         * Stopped turns' resumable state (M3-03 AC5). A row exists only while its turn waits
         * for an approval decision or a Continue: saving one is what lets the turn survive the
         * DO's hibernation, eviction and redeploy, and removing it is part of settling.
         */
        turns: {
          /**
           * Saves (or refreshes) a stopped turn; `false` if the conversation isn't the user's,
           * or the row isn't (a `turnId` that ever collided, or came from the caller, can never
           * overwrite another user's row — the scoped conflict update touches nothing).
           */
          save: async (turn: SavedTurn) => {
            if (!(await getConversation(turn.conversationId))) return false;
            const set = { ...turn, updatedAt: Date.now() };
            const rows = await db
              .insert(turnStates)
              .values({ ...set, userId })
              .onConflictDoUpdate({
                target: turnStates.turnId,
                set,
                setWhere: eq(turnStates.userId, userId),
              })
              .returning({ turnId: turnStates.turnId });
            return rows.length > 0;
          },
          /** A stopped turn by ID, or `undefined` when it is missing or someone else's. */
          load: async (turnId: string) =>
            (
              await db
                .select({
                  turnId: turnStates.turnId,
                  conversationId: turnStates.conversationId,
                  replyId: turnStates.replyId,
                  providerId: turnStates.providerId,
                  model: turnStates.model,
                  status: turnStates.status,
                  state: turnStates.state,
                  updatedAt: turnStates.updatedAt,
                })
                .from(turnStates)
                .where(and(eq(turnStates.turnId, turnId), eq(turnStates.userId, userId)))
                .limit(1)
            )[0],
          /**
           * Settles a stopped turn where it is and opens a new reply at the end of the chat, for
           * a late approval (M3-07 AC14): the old reply keeps its text, its saved state goes,
           * and a thread line names the original request before the new, streaming reply.
           * All of it or none, and only for a stopped turn of this conversation with that reply.
           */
          supersede: async (s: {
            old: { turnId: string; replyId: string; reply: string };
            conversationId: string;
            replyId: string;
            line: { id: string; content: string };
          }) => {
            if (!(await getConversation(s.conversationId))) throw new Error("not found");
            // A turn's conversation and reply never change, so this read can't go stale.
            const [old] = await db
              .select({ turnId: turnStates.turnId })
              .from(turnStates)
              .where(
                and(
                  eq(turnStates.turnId, s.old.turnId),
                  eq(turnStates.userId, userId),
                  eq(turnStates.conversationId, s.conversationId),
                  eq(turnStates.replyId, s.old.replyId),
                ),
              )
              .limit(1);
            if (!old) throw new Error("not found");
            await db.batch([
              db
                .update(messages)
                .set({ status: "complete", content: s.old.reply })
                .where(
                  and(
                    eq(messages.id, s.old.replyId),
                    eq(messages.userId, userId),
                    eq(messages.conversationId, s.conversationId),
                  ),
                ),
              db
                .delete(turnStates)
                .where(
                  and(
                    eq(turnStates.turnId, s.old.turnId),
                    eq(turnStates.userId, userId),
                    eq(turnStates.conversationId, s.conversationId),
                  ),
                ),
              message(s.conversationId, s.line.id, "system", s.line.content),
              message(s.conversationId, s.replyId, "assistant", ""),
              db.update(conversations).set({ updatedAt: Date.now() }).where(own(s.conversationId)),
            ]);
          },
          /** Drops a turn's saved state as it settles. Another user's row is untouched. */
          remove: async (turnId: string) => {
            await db
              .delete(turnStates)
              .where(and(eq(turnStates.turnId, turnId), eq(turnStates.userId, userId)));
          },
        },
        /**
         * Approvals (M3-07 AC9). Every change is one conditional write with its audit row in
         * the same batch (AC5): the audit insert names its action only when the write before it
         * changed exactly the rows it should, and a NULL action breaks NOT NULL and rolls the
         * whole batch back. So a second tab, a retried request or a replayed assertion that
         * loses a race changes nothing and leaves no audit row claiming it did.
         */
        approvals: {
          /**
           * Writes a stopped turn's or task's batch, pending. `false` if the conversation (or
           * the task) isn't the user's.
           */
          create: async (items: readonly NewApproval[]) => {
            const [first] = items;
            if (!first) return true;
            // One batch, in one conversation: the ownership check below covers every item.
            if (items.some((i) => i.batchId !== first.batchId)) throw new Error("one batch only");
            if (items.some((i) => i.conversationId !== first.conversationId)) {
              throw new Error("one conversation only");
            }
            if (!(await getConversation(first.conversationId))) return false;
            for (const { taskId } of items) {
              if (taskId === null || taskId === undefined) continue;
              const own = await db
                .select({ id: tasks.id })
                .from(tasks)
                .where(
                  and(
                    eq(tasks.id, taskId),
                    eq(tasks.userId, userId),
                    eq(tasks.conversationId, first.conversationId),
                  ),
                )
                .limit(1);
              if (!own.length) return false;
            }
            const rows = items.map((i) => ({ ...i, userId, status: "pending" as const }));
            await db.insert(approvals).values(rows);
            return true;
          },
          /** A batch's rows in their stored order; empty when it is missing or someone else's. */
          batch: (batchId: string): Promise<ApprovalRow[]> =>
            isBatchId(batchId)
              ? db
                  .select()
                  .from(approvals)
                  .where(and(eq(approvals.batchId, batchId), eq(approvals.userId, userId)))
                  .orderBy(approvals.position)
              : Promise.resolve([]),
          /**
           * Every item that can still take a decision (M3-07 AC8): pending, unexpired, and not
           * on a cancelled or finished task. Each with its conversation's title. At most `limit`
           * batches, never part of one (a decision needs every pending item): the batch that
           * expires soonest first, a batch's items together in their stored order. A batch with
           * a pending item already expired can't take a decision, so none of it is listed.
           */
          pending: (now: number, limit = 100) => {
            const live = and(
              eq(approvals.userId, userId),
              eq(approvals.status, "pending"),
              gt(approvals.expiresAt, now),
              sql`NOT EXISTS (SELECT 1 FROM approvals stale WHERE stale.batch_id = approvals.batch_id AND stale.status = 'pending' AND stale.expires_at <= ${now})`,
              sql`(${approvals.taskId} IS NULL OR EXISTS (SELECT 1 FROM ${tasks} WHERE ${tasks.id} = ${approvals.taskId} AND ${tasks.status} <> 'cancelled' AND ${tasks.finishedAt} IS NULL))`,
            );
            const batch = db
              .select({
                batchId: approvals.batchId,
                soonest: sql<number>`min(${approvals.expiresAt})`.as("soonest"),
                newest: sql<number>`max(${approvals.createdAt})`.as("newest"),
              })
              .from(approvals)
              .where(live)
              .groupBy(approvals.batchId)
              .orderBy(sql`soonest`, sql`newest desc`, approvals.batchId)
              .limit(limit)
              .as("batch");
            return db
              .select({ row: approvals, conversationTitle: conversations.title })
              .from(approvals)
              .innerJoin(batch, eq(batch.batchId, approvals.batchId))
              .innerJoin(conversations, eq(conversations.id, approvals.conversationId))
              .where(live)
              .orderBy(
                sql`${batch.soonest}`,
                sql`${batch.newest} desc`,
                approvals.batchId,
                approvals.position,
              );
          },
          /**
           * Starts a step-up ceremony over the batch's pending items (W3): the nonce, the digest
           * it was issued for, its expiry and the session that asked, on every pending row,
           * replacing any earlier ceremony. `false` unless exactly `pending` items are pending
           * and unexpired, so a batch that changed since the caller read it starts nothing.
           */
          beginStepUp: async (batchId: string, pending: number, c: StepUpCeremony, now: number) => {
            if (pending < 1) return false; // nothing to sign for
            const live = and(
              eq(approvals.batchId, batchId),
              eq(approvals.userId, userId),
              eq(approvals.status, "pending"),
              gt(approvals.expiresAt, now),
            );
            const [update] = await db
              .batch([
                db
                  .update(approvals)
                  .set({
                    nonce: c.nonce,
                    stepUpDigest: c.digest,
                    stepUpExpiresAt: c.expiresAt,
                    stepUpSessionId: c.sessionId,
                  })
                  .where(
                    and(
                      live,
                      sql`(SELECT count(*) FROM approvals WHERE batch_id = ${batchId} AND user_id = ${userId} AND status = 'pending' AND expires_at > ${now}) = ${pending}`,
                    ),
                  ),
                db
                  .insert(auditLog)
                  .values(
                    approvalAudit(
                      userId,
                      "approval.step_up_options",
                      batchId,
                      null,
                      "ok",
                      null,
                      sql`changes() = ${pending}`,
                    ),
                  ),
              ])
              .catch(() => [{ meta: { changes: 0 } }]);
            return update.meta.changes === pending;
          },
          /**
           * Takes the batch's ceremony, burning it whatever happens next (W3): a verify that
           * fails, a replay or a second tab finds nothing. The ceremony is returned only when
           * every row taken carried the same one.
           */
          takeStepUp: async (batchId: string): Promise<StepUpCeremony | null> => {
            const mine = and(eq(approvals.batchId, batchId), eq(approvals.userId, userId));
            const held = await db
              .select({
                nonce: approvals.nonce,
                digest: approvals.stepUpDigest,
                expiresAt: approvals.stepUpExpiresAt,
                sessionId: approvals.stepUpSessionId,
              })
              .from(approvals)
              .where(and(mine, sql`${approvals.nonce} IS NOT NULL`));
            const [first] = held;
            if (!first?.nonce) return null;
            // Burn it: of two takers that read the same nonce, only the one whose update
            // clears it gets the ceremony, and a ceremony begun in between is not this one.
            // (RETURNING shows values after the update, so the read comes first.)
            const cleared = await db
              .update(approvals)
              .set({
                nonce: null,
                stepUpDigest: null,
                stepUpExpiresAt: null,
                stepUpSessionId: null,
              })
              .where(and(mine, eq(approvals.nonce, first.nonce)))
              .returning({ nonce: approvals.nonce });
            const same = held.every(
              (t) =>
                t.nonce === first.nonce &&
                t.digest === first.digest &&
                t.expiresAt === first.expiresAt &&
                t.sessionId === first.sessionId,
            );
            if (!same || cleared.length !== held.length) return null;
            const { nonce, digest, expiresAt, sessionId } = first;
            return digest && expiresAt && sessionId
              ? { nonce, digest, expiresAt, sessionId }
              : null;
          },
          /**
           * Records the user's decisions on pending, unexpired items, all of them or none, each
           * with its audit row. An approval holds only a scope its row offered, and a task's
           * batch is decided only while the task is live. A `grant` (AC3) is written in the same
           * batch, from an untainted row only, so a decision never commits without the grant
           * the user chose. Throws when any item was decided, expired or cancelled since the
           * caller read the batch, asks for a scope it wasn't offered, or grants from a tainted
           * row; nothing is written then.
           */
          decide: async (
            batchId: string,
            decisions: readonly {
              approvalId: string;
              decision: "approve" | "deny";
              scope: "once" | "task" | "hour" | "destination";
              detail: Record<string, unknown>;
              grant?: StandingGrant;
            }[],
            now: number,
          ) => {
            if (!decisions.length) throw new Error("no decisions");
            const statements: BatchItem<"sqlite">[] = [];
            for (const d of decisions) {
              const approve = d.decision === "approve";
              const grant = approve ? d.grant : undefined;
              statements.push(
                db
                  .update(approvals)
                  .set({
                    status: approve ? "approved" : "denied",
                    scope: approve ? d.scope : null,
                    decidedAt: now,
                    nonce: null,
                    stepUpDigest: null,
                    stepUpExpiresAt: null,
                    stepUpSessionId: null,
                  })
                  .where(
                    and(
                      eq(approvals.batchId, batchId),
                      eq(approvals.approvalId, d.approvalId),
                      eq(approvals.userId, userId),
                      eq(approvals.status, "pending"),
                      gt(approvals.expiresAt, now),
                      approve
                        ? sql`EXISTS (SELECT 1 FROM json_each(${approvals.scopes}) WHERE value = ${d.scope})`
                        : undefined,
                      sql`(${approvals.taskId} IS NULL OR EXISTS (SELECT 1 FROM ${tasks} WHERE ${tasks.id} = ${approvals.taskId} AND ${tasks.status} <> 'cancelled' AND ${tasks.finishedAt} IS NULL))`,
                      grant ? isNull(approvals.taint) : undefined,
                    ),
                  ),
                db
                  .insert(auditLog)
                  .values(
                    approvalAudit(
                      userId,
                      approve ? "approval.approve" : "approval.deny",
                      batchId,
                      d.approvalId,
                      "ok",
                      { ...d.detail, scope: approve ? d.scope : null },
                      sql`changes() = 1`,
                    ),
                  ),
              );
              if (grant) {
                // Reached only if the decision above changed its row: its audit row's guard
                // aborts the batch otherwise.
                const id = crypto.randomUUID();
                statements.push(
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
                );
              }
            }
            await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
          },
          /** An audit row about the batch that changes no approval: a refused step-up. */
          audit: async (
            batchId: string,
            action: string,
            result: "ok" | "denied" | "error",
            detail: Record<string, unknown> | null = null,
          ) => {
            await db
              .insert(auditLog)
              .values(approvalAudit(userId, action, batchId, null, result, detail));
          },
          /**
           * Claims an approved call just before it runs (crypto review W3): `approved` to
           * `executing`, while it is unexpired. The row as claimed, or `undefined` if another
           * run claimed it, it was never approved, or it expired: then nothing runs. With its
           * audit row, so a call that never reaches `finish` still shows when it began. Throws
           * when D1 fails, leaving the row as it was.
           */
          claim: async (batchId: string, approvalId: string, now: number) => {
            const [claimed] = await db
              .batch([
                db
                  .update(approvals)
                  .set({ status: "executing" })
                  .where(
                    and(
                      eq(approvals.batchId, batchId),
                      eq(approvals.approvalId, approvalId),
                      eq(approvals.userId, userId),
                      eq(approvals.status, "approved"),
                      gt(approvals.expiresAt, now),
                    ),
                  )
                  .returning(),
                db
                  .insert(auditLog)
                  .values(
                    approvalAudit(
                      userId,
                      "approval.claim",
                      batchId,
                      approvalId,
                      "ok",
                      null,
                      sql`changes() = 1`,
                    ),
                  ),
              ])
              .catch((e: unknown) => {
                // Only a lost claim reads as "nothing to run"; a D1 failure reaches the caller,
                // whose claim step retries or reports that the approval couldn't be checked.
                if (guardRefused(e)) return [[]];
                throw e;
              });
            return claimed[0];
          },
          /**
           * Marks a claimed call as handed to its tool, `executing` to `dispatched`, as the first
           * thing its durable step does (crypto review W3). `false` when the row is past
           * `executing`: an engine crash reran the step after the call may already have acted,
           * so it must not run again. A read may: with `rerun`, a row already `dispatched` is
           * handed to its tool again, so a read's step still retries a transient failure.
           */
          dispatch: async (batchId: string, approvalId: string, rerun = false) => {
            const rows = await db
              .update(approvals)
              .set({ status: "dispatched" })
              .where(
                and(
                  eq(approvals.batchId, batchId),
                  eq(approvals.approvalId, approvalId),
                  eq(approvals.userId, userId),
                  rerun
                    ? inArray(approvals.status, ["executing", "dispatched"])
                    : eq(approvals.status, "executing"),
                ),
              )
              .returning({ approvalId: approvals.approvalId });
            return rows.length === 1;
          },
          /**
           * Ends an approval's life: a claimed or dispatched call `executed` or `failed`; an
           * approved call the re-check refused `denied` (AC12); an undecided one past its expiry
           * `expired`. With its audit row; `false` (and nothing written) if the row wasn't in the
           * state that outcome ends.
           */
          finish: async (batchId: string, approvalId: string, outcome: ApprovalOutcome) => {
            const from: (typeof approvals.$inferSelect.status)[] =
              outcome.status === "executed" || outcome.status === "failed"
                ? ["executing", "dispatched"]
                : outcome.status === "denied"
                  ? ["approved"]
                  : ["pending"];
            const reason = "reason" in outcome ? outcome.reason : null;
            const result =
              outcome.status === "executed"
                ? "ok"
                : outcome.status === "failed"
                  ? "error"
                  : "denied";
            const [update] = await db
              .batch([
                db
                  .update(approvals)
                  .set({
                    status: outcome.status,
                    reason,
                    finishedAt: Date.now(),
                    nonce: null,
                    stepUpDigest: null,
                    stepUpExpiresAt: null,
                    stepUpSessionId: null,
                  })
                  .where(
                    and(
                      eq(approvals.batchId, batchId),
                      eq(approvals.approvalId, approvalId),
                      eq(approvals.userId, userId),
                      inArray(approvals.status, from),
                    ),
                  ),
                db
                  .insert(auditLog)
                  .values(
                    approvalAudit(
                      userId,
                      outcome.status === "expired" ? "approval.expire" : "approval.execute",
                      batchId,
                      approvalId,
                      result,
                      reason === null ? null : { reason },
                      sql`changes() = 1`,
                    ),
                  ),
              ])
              .catch(() => [{ meta: { changes: 0 } }]);
            return update.meta.changes === 1;
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
           * The month's calls by conversation, by task and by day (M3-16 AC2). Titles come from
           * this user's own rows only; a deleted conversation or task, or a call outside one,
           * groups under a null ID. Days come as quarter-hour buckets (`bucket` × 15 min since
           * the epoch), so the caller can place them on any time zone's calendar, DST included.
           */
          breakdowns: async (since: number) => {
            const mine = and(eq(usage.userId, userId), gte(usage.createdAt, since));
            const cost = {
              calls: count(),
              costMicroUsd: sql<number>`coalesce(sum(${usage.costMicroUsd}), 0)`.mapWith(Number),
              unpricedCalls:
                sql<number>`sum(case when ${usage.costSource} is null then 1 else 0 end)`.mapWith(
                  Number,
                ),
            };
            // Quarter hours fit every UTC offset, including the :30 and :45 ones. The time is cast
            // first: the default `created_at` and a bound number can be REAL.
            const bucket = sql<number>`cast(${usage.createdAt} as integer) / 900000`;
            const [byConversation, byTask, byBucket] = await Promise.all([
              db
                .select({ id: conversations.id, title: conversations.title, ...cost })
                .from(usage)
                .leftJoin(
                  conversations,
                  and(eq(conversations.id, usage.conversationId), eq(conversations.userId, userId)),
                )
                .where(mine)
                .groupBy(conversations.id)
                .orderBy(desc(cost.costMicroUsd)),
              db
                .select({ id: tasks.id, title: tasks.title, ...cost })
                .from(usage)
                .leftJoin(tasks, and(eq(tasks.id, usage.taskId), eq(tasks.userId, userId)))
                .where(mine)
                .groupBy(tasks.id)
                .orderBy(desc(cost.costMicroUsd)),
              db
                .select({ bucket: bucket.mapWith(Number), ...cost })
                .from(usage)
                .where(mine)
                .groupBy(bucket)
                .orderBy(bucket),
            ]);
            return { byConversation, byTask, byBucket };
          },
          /**
           * One model call's ledger row (one row per call, PRD §17), written when the call
           * ends. Calls of a chat turn name their conversation and reply; one outside a turn,
           * such as the settings Test button, names neither. With `id`, writing the same call
           * again (a recovery that can't tell whether the first write landed) changes
           * nothing. A task run passes its `taskId`, so the Tasks view can show its spend so
           * far (M3-13 AC2).
           */
          record: async (
            call: LedgerCall & {
              id?: string;
              conversationId?: string;
              messageId?: string;
              taskId?: string;
            },
          ) => {
            await db
              .insert(usage)
              .values({
                ...ledgerValues(call),
                ...(call.id ? { id: call.id } : {}),
                userId,
                conversationId: call.conversationId ?? null,
                messageId: call.messageId ?? null,
                taskId: call.taskId === undefined ? null : checkId(call.taskId),
              })
              .onConflictDoNothing({ target: usage.id });
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
           * Continuing clears the limit kind, which only ever describes a `budget_limited`
           * pause. `false` when it isn't paused. Waking its Workflow is the caller's job.
           */
          resume: async (id: string) =>
            (
              await db
                .update(tasks)
                .set({ status: "running", limitKind: null, updatedAt: Date.now() })
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
