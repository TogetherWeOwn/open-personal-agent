// SPDX-License-Identifier: Apache-2.0
// Schema v0 (ADR 0004, ADR 0010). Every user-data table carries `user_id NOT NULL`, and its
// indexes lead with `user_id`. Times are Unix epoch milliseconds. Generate migrations with
// `pnpm --filter @opa/db generate`; never edit an applied migration.
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  blob,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch('subsec') * 1000)`;
const createdAt = () => integer("created_at").notNull().default(now);
const userId = () =>
  text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" });

/** One row per applied schema version; the app reads `max(version)`. */
export const schemaVersion = sqliteTable("schema_version", {
  version: integer("version").primaryKey(),
  appliedAt: integer("applied_at").notNull().default(now),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  role: text("role", { enum: ["owner", "member"] }).notNull(),
  createdAt: createdAt(),
  updatedAt: integer("updated_at").notNull().default(now),
});

/** Single row (`id = 1`). Holds `sha256(OPA_SETUP_TOKEN)` as it was at claim time (ADR 0010 D2). */
export const setupState = sqliteTable(
  "setup_state",
  {
    id: integer("id").primaryKey(),
    claimTokenHash: text("claim_token_hash"),
    claimedByUserId: text("claimed_by_user_id").references(() => users.id),
    claimedAt: integer("claimed_at"),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [check("setup_state_single_row", sql`${t.id} = 1`)],
);

/**
 * Every `sha256(OPA_SETUP_TOKEN)` that has claimed or recovered the deployment. A token in here
 * never opens `/setup` again, even if the operator puts it back as the secret.
 */
export const usedSetupTokens = sqliteTable("used_setup_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  usedAt: integer("used_at").notNull().default(now),
});

/** Session IDs are stored only as hashes. 30 days idle, 90 days absolute (ADR 0010 D2). */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: userId(),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: createdAt(),
    lastSeenAt: integer("last_seen_at").notNull().default(now),
    expiresAt: integer("expires_at").notNull(),
    revokedAt: integer("revoked_at"),
    /** The last passkey step-up in this session; account actions need one in the last 5 minutes. */
    stepUpAt: integer("step_up_at"),
  },
  (t) => [index("sessions_user_idx").on(t.userId, t.expiresAt)],
);

/** WebAuthn credentials; `id` is the base64url credential ID. */
export const passkeys = sqliteTable(
  "passkeys",
  {
    id: text("id").primaryKey(),
    userId: userId(),
    webauthnUserId: text("webauthn_user_id").notNull(),
    publicKey: blob("public_key", { mode: "buffer" }).notNull(),
    counter: integer("counter").notNull().default(0),
    transports: text("transports"),
    deviceType: text("device_type", { enum: ["singleDevice", "multiDevice"] }).notNull(),
    backedUp: integer("backed_up", { mode: "boolean" }).notNull().default(false),
    name: text("name"),
    createdAt: createdAt(),
    lastUsedAt: integer("last_used_at"),
  },
  (t) => [index("passkeys_user_idx").on(t.userId)],
);

/**
 * Pending WebAuthn challenges, keyed by the SHA-256 of the browser's challenge cookie. A ceremony
 * consumes its row with `DELETE … RETURNING`, so each challenge works once. `user_id` is the
 * account the ceremony is for; on a claim that account doesn't exist yet, so it has no foreign key.
 * `token_hash` binds a claim or recovery challenge to the setup token it was issued under.
 */
export const webauthnChallenges = sqliteTable(
  "webauthn_challenges",
  {
    idHash: text("id_hash").primaryKey(),
    kind: text("kind", {
      enum: ["claim", "recovery", "recovery_code", "login", "step_up", "step_up_vault_reset"],
    }).notNull(),
    challenge: text("challenge").notNull(),
    userId: text("user_id"),
    tokenHash: text("token_hash"),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [index("webauthn_challenges_expires_idx").on(t.expiresAt)],
);

/** SHA-256 hashes of ≥128-bit recovery codes, compared in constant time (ADR 0010 D2). */
export const recoveryCodes = sqliteTable(
  "recovery_codes",
  {
    id: text("id").primaryKey(),
    userId: userId(),
    codeHash: text("code_hash").notNull(),
    createdAt: createdAt(),
    usedAt: integer("used_at"),
  },
  (t) => [index("recovery_codes_user_idx").on(t.userId, t.codeHash)],
);

/**
 * Each user's DEK, AES-GCM-wrapped under KEK epoch `kek_version` with AAD `(user_id, kek_version)`
 * (`@opa/vault` `aad.ts`). A rotation replaces the DEK, not only its wrap.
 */
export const userKeys = sqliteTable(
  "user_keys",
  {
    userId: userId(),
    kekVersion: integer("kek_version").notNull(),
    wrappedDek: blob("wrapped_dek", { mode: "buffer" }).notNull(),
    iv: blob("iv", { mode: "buffer" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kekVersion] })],
);

/**
 * Envelope-encrypted per-user secrets (ADR 0010 D4). AAD is
 * `(user_id, secret_id, purpose, binding, version)`; `binding` includes the provider's base URL.
 */
export const secrets = sqliteTable(
  "secrets",
  {
    id: text("id").primaryKey(),
    userId: userId(),
    purpose: text("purpose").notNull(),
    binding: text("binding").notNull(),
    version: integer("version").notNull().default(1),
    ciphertext: blob("ciphertext", { mode: "buffer" }).notNull(),
    iv: blob("iv", { mode: "buffer" }).notNull(),
    last4: text("last4"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at").notNull().default(now),
    lastUsedAt: integer("last_used_at"),
  },
  (t) => [index("secrets_user_idx").on(t.userId, t.purpose)],
);

/**
 * Append-only audit trail (ADR 0010 D11). `user_id` is null for deployment-level events, such as
 * a rejected setup claim, and for rows whose user was deleted: deleting a user keeps the trail.
 */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    module: text("module").notNull(),
    targetId: text("target_id"),
    result: text("result", { enum: ["ok", "denied", "error"] }).notNull(),
    detail: text("detail"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_user_idx").on(t.userId, t.createdAt)],
);

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    userId: userId(),
    title: text("title"),
    /** The conversation's own model (M3-06 AC3); null follows the Chat role. */
    modelProvider: text("model_provider").references(() => modelProviders.id, {
      onDelete: "set null",
    }),
    model: text("model"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at").notNull().default(now),
    archivedAt: integer("archived_at"),
  },
  (t) => [index("conversations_user_idx").on(t.userId, t.updatedAt)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    userId: userId(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    role: text("role", { enum: ["user", "assistant", "system", "tool"] }).notNull(),
    status: text("status", { enum: ["complete", "streaming", "interrupted", "error"] })
      .notNull()
      .default("complete"),
    content: text("content").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("messages_user_conversation_idx").on(t.userId, t.conversationId, t.seq)],
);

/**
 * A file the user attached (M3-10). The bytes live in R2 under `u/{userId}/attachments/{id}`
 * (the repository derives the key); this row holds what the server sniffed from its first bytes,
 * never the type or size the client claimed. `message_id` is set when the message carrying it is
 * sent; until then the file belongs to the composer that uploaded it.
 */
export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    userId: userId(),
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    mediaType: text("media_type").notNull(),
    kind: text("kind", { enum: ["image", "pdf", "text"] }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    /**
     * Whether the turn's model received the file, set when the message is sent (M3-10 AC2);
     * null until then. The thread shows the plain wording for a file the model didn't read.
     */
    sentToModel: integer("sent_to_model", { mode: "boolean" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("attachments_user_message_idx").on(t.userId, t.messageId),
    index("attachments_user_created_idx").on(t.userId, t.createdAt),
  ],
);

/**
 * One row per model call (PRD §17). Cost is in millionths of a US dollar, and null when the price
 * table had no price for the model; `cost_source` says whether it was estimated or reported.
 * `price_verified_at` dates the price used, and `neurons` counts Workers AI calls. `task_id`
 * attributes a background task's calls to it (M3-13 AC2, "cost so far"); chat turns keep using
 * `conversation_id`/`message_id`.
 */
export const usage = sqliteTable(
  "usage",
  {
    id: text("id").primaryKey(),
    userId: userId(),
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
    taskId: text("task_id").references((): AnySQLiteColumn => tasks.id, {
      onDelete: "set null",
    }),
    providerId: text("provider_id").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    costMicroUsd: integer("cost_micro_usd"),
    costSource: text("cost_source", { enum: ["estimated", "reported"] }),
    priceVerifiedAt: text("price_verified_at"),
    neurons: integer("neurons"),
    createdAt: createdAt(),
  },
  (t) => [
    index("usage_user_idx").on(t.userId, t.createdAt),
    index("usage_task_idx").on(t.userId, t.taskId),
  ],
);

/**
 * A user's saved model providers (M3-06). The key lives envelope-encrypted in `secrets` (ADR 0010
 * D4), bound to `provider_id` and `base_url`'s origin and path (ADR 0006 #5). The Workers AI starter
 * is a row too, with no URL and no key. `model` is the one saved and tested with it.
 */
export const modelProviders = sqliteTable(
  "model_providers",
  {
    id: text("id").primaryKey(),
    userId: userId(),
    kind: text("kind", { enum: ["openai-chat", "workers-ai"] }).notNull(),
    providerId: text("provider_id"),
    baseUrl: text("base_url"),
    model: text("model"),
    keySecretId: text("key_secret_id").references(() => secrets.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [
    index("model_providers_user_idx").on(t.userId, t.createdAt),
    // Each key belongs to one provider, so removing a provider can remove its key.
    uniqueIndex("model_providers_key_idx").on(t.keySecretId),
  ],
);

const providerRef = (name: string) =>
  text(name).references(() => modelProviders.id, { onDelete: "set null" });

/**
 * A durable run of the agent loop (M3-12): a promoted turn or explicit background work, executed
 * by one Workflow instance (`workflow_instance_id`). The row is the task's authority: the
 * Workflow mints its `UserScope` from `user_id` here, never from its instance params (AC9), and
 * every step re-reads `status` before it acts, so `cancelled` stops the run (AC3). `state` is
 * the loop's resumable state as JSON (history and turn state), written at step boundaries.
 * Status words are the Tasks view vocabulary (M3-13), plus `queued` before the instance starts.
 */
export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    userId: userId(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    workflowInstanceId: text("workflow_instance_id").unique(),
    /** What runs it: `turn` is the builtin loop continuing a conversation's turn. */
    kind: text("kind").notNull(),
    /** Which duration limit applies (M3-12 AC6): 30 minutes interactive, 6 hours background. */
    mode: text("mode", { enum: ["interactive", "background"] }).notNull(),
    status: text("status", {
      enum: [
        "queued",
        "running",
        "waiting_for_approval",
        "budget_limited",
        "succeeded",
        "failed",
        "cancelled",
        "interrupted",
      ],
    })
      .notNull()
      .default("queued"),
    title: text("title"),
    state: text("state"),
    error: text("error"),
    /**
     * Which limit stopped a `budget_limited` task (M3-13 AC1): a money limit (`task_budget`,
     * `daily`, `monthly_hard`) reads "Paused: budget", an execution limit (`calls`, `tools`,
     * `tool_rate`, `steps`, `duration`) reads "Paused: limit". Null for every other status.
     * The enum is type-level only, as with the sibling status column.
     */
    limitKind: text("limit_kind", {
      enum: [
        "task_budget",
        "daily",
        "monthly_hard",
        "calls",
        "tools",
        "tool_rate",
        "steps",
        "duration",
      ],
    }),
    createdAt: createdAt(),
    updatedAt: integer("updated_at").notNull().default(now),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
  },
  (t) => [index("tasks_user_idx").on(t.userId, t.createdAt)],
);

/**
 * The Node step journal (M3-23b): one row per completed step of a task run, keyed by the
 * Workflow instance and the step name. A resumed run replays these rows instead of re-running
 * their functions, the way the Workflow engine replays `step.do` on Cloudflare. Only the Node
 * journal writes here; the tables ship in the shared migration so both roots stay on one schema.
 */
export const taskSteps = sqliteTable(
  "task_steps",
  {
    instanceId: text("instance_id").notNull(),
    name: text("name").notNull(),
    output: text("output").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.instanceId, t.name] })],
);

/**
 * Events the Node journal waits on (M3-23b): `waitForEvent` consumes the oldest matching row
 * for its instance and type, so each event wakes exactly one wait. Producers (approval resume
 * in M3-23a, tests) post with `postTaskEvent`.
 */
export const taskEvents = sqliteTable(
  "task_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    instanceId: text("instance_id").notNull(),
    type: text("type").notNull(),
    payload: text("payload").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("task_events_instance_idx").on(t.instanceId, t.id)],
);

/**
 * One row per user: onboarding answers and the model roles (COST-7). A role names a provider and
 * a model; a null Background role means the cheapest configured one. Embedding has no column
 * until it has a user (ADR 0008).
 */
export const userSettings = sqliteTable("user_settings", {
  userId: userId().primaryKey(),
  about: text("about"),
  chatProvider: providerRef("chat_provider"),
  chatModel: text("chat_model"),
  backgroundProvider: providerRef("background_provider"),
  backgroundModel: text("background_model"),
  onboardedAt: integer("onboarded_at"),
  updatedAt: integer("updated_at").notNull().default(now),
});

/**
 * The user's per-tool decision override (M3-02 AC2, EL fix 9). No row means the SEC-4 default for
 * the tool's risk class. The policy engine enforces its floors whatever the row says.
 */
export const toolOverrides = sqliteTable(
  "tool_overrides",
  {
    userId: userId(),
    tool: text("tool").notNull(),
    decision: text("decision", { enum: ["auto", "ask", "never"] }).notNull(),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.tool] }),
    check("tool_overrides_decision", sql`${t.decision} IN ('auto', 'ask', 'never')`),
  ],
);

/**
 * Standing approvals (M3-02 AC2, M3-07 AC3): this task, an hour, or always for one destination.
 * Created only from an untainted context. A revoked row stays until the user is deleted.
 */
export const grants = sqliteTable(
  "grants",
  {
    id: text("id").primaryKey(),
    userId: userId(),
    tool: text("tool").notNull(),
    scope: text("scope", { enum: ["task", "hour", "destination"] }).notNull(),
    taskId: text("task_id"),
    destination: text("destination"),
    expiresAt: integer("expires_at"),
    createdAt: createdAt(),
    revokedAt: integer("revoked_at"),
  },
  (t) => [
    index("grants_user_tool_idx").on(t.userId, t.tool),
    check(
      "grants_scope_target",
      sql`(${t.scope} = 'task' AND ${t.taskId} IS NOT NULL) OR (${t.scope} = 'hour' AND ${t.expiresAt} IS NOT NULL) OR (${t.scope} = 'destination' AND ${t.destination} IS NOT NULL)`,
    ),
  ],
);

/**
 * Memory (ADR 0008). Only `MemoryService` (`./memory.ts`) reads or writes these tables; the
 * scoped-access lint enforces it. A row's text never changes: an edit inserts a new row that
 * supersedes the old one through `memory_links`. `n` is the rowid the `memories_fts` index
 * (hand-written in migration 0005) points at, so it survives VACUUM; `id` is the public ID.
 */
export const memories = sqliteTable(
  "memories",
  {
    n: integer("n").primaryKey(),
    id: text("id").notNull().unique(),
    userId: userId(),
    kind: text("kind", { enum: ["fact", "instruction"] }).notNull(),
    text: text("text").notNull(),
    trust: text("trust", { enum: ["system", "user", "inferred", "external"] }).notNull(),
    status: text("status", { enum: ["active", "proposed", "superseded"] }).notNull(),
    /** What the row does to the rows it links to; acted on when a proposal is accepted. */
    op: text("op", { enum: ["create", "update", "merge", "delete"] }).notNull(),
    source: text("source", {
      enum: ["memory_screen", "chat", "web", "file", "tool", "system"],
    }).notNull(),
    sourceRef: text("source_ref"),
    sourceExcerpt: text("source_excerpt"),
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: integer("updated_at").notNull().default(now),
    lastUsedAt: integer("last_used_at"),
    /** A proposal expires to rejected after this (M3-15 AC2); null on every other row. */
    expiresAt: integer("expires_at"),
  },
  (t) => [
    uniqueIndex("memories_id_user_idx").on(t.id, t.userId),
    index("memories_user_idx").on(t.userId, t.status, t.createdAt),
  ],
);

/** `memory_id` supersedes (or, as a proposal, would replace) `target_id`. Both are the user's. */
export const memoryLinks = sqliteTable(
  "memory_links",
  {
    memoryId: text("memory_id").notNull(),
    targetId: text("target_id").notNull(),
    userId: userId(),
  },
  (t) => [
    primaryKey({ columns: [t.memoryId, t.targetId] }),
    foreignKey({
      columns: [t.memoryId, t.userId],
      foreignColumns: [memories.id, memories.userId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.targetId, t.userId],
      foreignColumns: [memories.id, memories.userId],
    }).onDelete("cascade"),
    index("memory_links_target_idx").on(t.userId, t.targetId),
  ],
);
