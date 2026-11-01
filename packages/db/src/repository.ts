// SPDX-License-Identifier: Apache-2.0
// The scoped repository layer (ADR 0010 D3): the only code that reads the DB, FILES and ASSISTANT
// bindings, derives R2 keys or names Durable Objects. scripts/check-scoped-access.mjs enforces it.
import type { StandingGrant, TaintState, ToolOverride } from "@opa/policy";
import { estimate, findPrice } from "@opa/pricing";
import { and, count, desc, eq, gt, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { AnyD1Database } from "drizzle-orm/d1";
// A separate entry point (`@opa/db/repository`), so this import is not a cycle.
import { openD1, readSchemaVersion } from "./index";
import {
  auditLog,
  conversations,
  grants,
  messages,
  secrets,
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

/** The parts of R2 and Durable Object namespaces used here; the Node root supplies its own. */
export interface DataBindings<Stub, Id> {
  DB: AnyD1Database;
  FILES: {
    head(key: string): Promise<unknown>;
    get(key: string): Promise<{ text(): Promise<string> } | null>;
    put(
      key: string,
      value: string,
      options: { httpMetadata: { contentType: string } },
    ): Promise<unknown>;
  };
  ASSISTANT: { idFromName(name: string): Id; get(id: Id): Stub };
}

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

/** A conversation ID comes from the client, so it is checked before it reaches a query. */
export const isId = (id: unknown): id is string =>
  typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);

/** The check also keeps a key inside the user's R2 prefix. */
function checkId(id: string): string {
  if (!isId(id)) throw new Error("invalid id");
  return id;
}

export type MessageStatus = "complete" | "streaming" | "interrupted" | "error";

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
    },

    forUser(scope: UserScope) {
      if (!issued.has(scope)) throw new Error("scope was not issued by the session layer");
      const { userId } = scope;
      const fileKey = (id: string) => `u/${userId}/files/${checkId(id)}`;
      const own = (id: string) => and(eq(conversations.id, id), eq(conversations.userId, userId));
      /** `undefined` when the row is missing or someone else's: answer 404 for both. */
      const getConversation = async (id: string) =>
        (await db.select().from(conversations).where(own(id)).limit(1))[0];
      const createConversation = async (id: string, title: string | null = null) => {
        await db.insert(conversations).values({ id: checkId(id), userId, title });
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
          /** The conversation's messages oldest first, or `null` when it isn't the user's. */
          listMessages: async (conversationId: string) =>
            (await getConversation(conversationId))
              ? db
                  .select({
                    id: messages.id,
                    role: sql<"user" | "assistant">`${messages.role}`, // the filter below
                    status: messages.status,
                    content: messages.content,
                    createdAt: messages.createdAt,
                  })
                  .from(messages)
                  .where(
                    and(
                      eq(messages.conversationId, conversationId),
                      eq(messages.userId, userId),
                      inArray(messages.role, ["user", "assistant"]),
                    ),
                  )
                  .orderBy(messages.seq)
              : null,
          /** Creates the conversation on its first message; `false` if the ID is someone else's. */
          open: async (id: string, title: string) => {
            if (await getConversation(id)) return true;
            // A conflict is either another user's row or this user's from a concurrent open.
            await createConversation(id, title).catch(() => {});
            return (await getConversation(id)) !== undefined;
          },
          /** Writes the user's message and the empty streaming reply after it, both or neither. */
          startTurn: async (conversationId: string, text: string, replyId: string) => {
            const message = (id: string, role: "user" | "assistant", content: string) =>
              db.insert(messages).values({
                id,
                userId,
                conversationId,
                seq: sql`(SELECT coalesce(max(seq), 0) + 1 FROM messages WHERE conversation_id = ${conversationId})`,
                role,
                status: role === "user" ? "complete" : "streaming",
                content,
              });
            await db.batch([
              message(crypto.randomUUID(), "user", text),
              message(replyId, "assistant", ""),
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
          /** A call outside a chat turn, such as the settings Test button. */
          record: async (call: LedgerCall) => {
            await db.insert(usage).values({ ...ledgerValues(call), userId });
          },
        },
        /** Onboarding answers and the chat model (M2-15). The key itself is in `secrets`. */
        settings: {
          get: async () =>
            (
              await db
                .select({
                  displayName: users.displayName,
                  about: userSettings.about,
                  modelKind: userSettings.modelKind,
                  providerId: userSettings.providerId,
                  baseUrl: userSettings.baseUrl,
                  model: userSettings.model,
                  keySecretId: userSettings.modelKeySecretId,
                  onboardedAt: userSettings.onboardedAt,
                  keyLast4: secrets.last4,
                  keyUpdatedAt: secrets.updatedAt,
                  keyLastUsedAt: secrets.lastUsedAt,
                })
                .from(users)
                .leftJoin(userSettings, eq(userSettings.userId, users.id))
                .leftJoin(
                  secrets,
                  and(eq(secrets.id, userSettings.modelKeySecretId), eq(secrets.userId, users.id)),
                )
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
           * is `denied` for a loosening refused without a step-up: only the audit row is written.
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
        getFile: (id: string) => FILES.get(fileKey(id)),
        putFile: (id: string, value: string, contentType: string) =>
          FILES.put(fileKey(id), value, { httpMetadata: { contentType } }),
      };
    },
  };
}
