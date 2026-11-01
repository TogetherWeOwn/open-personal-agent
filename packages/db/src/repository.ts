// SPDX-License-Identifier: Apache-2.0
// The scoped repository layer (ADR 0010 D3): the only code that reads the DB, FILES and ASSISTANT
// bindings, derives R2 keys or names Durable Objects. scripts/check-scoped-access.mjs enforces it.
import { estimate, findPrice } from "@opa/pricing";
import { and, count, desc, eq, gte, inArray, type SQL, sql } from "drizzle-orm";
import type { AnyD1Database } from "drizzle-orm/d1";
// A separate entry point (`@opa/db/repository`), so this import is not a cycle.
import { openD1, readSchemaVersion } from "./index";
import { memoryService } from "./memory";
import {
  conversations,
  messages,
  modelProviders,
  secrets,
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

/** The `model_providers` columns a route may write. */
export type ProviderValues = Pick<
  typeof modelProviders.$inferInsert,
  "kind" | "providerId" | "baseUrl" | "model" | "keySecretId"
>;

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
          /** Pins the conversation to a model, or back to the Chat role with `null`. */
          setModel: async (
            conversationId: string,
            pick: { provider: string; model: string } | null,
          ) => {
            const set = { modelProvider: pick?.provider ?? null, model: pick?.model ?? null };
            const done = await db
              .update(conversations)
              .set(set)
              .where(own(conversationId))
              .returning({ id: conversations.id });
            return done.length > 0;
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
        /** Memory behind its trust gate (ADR 0008): the only way to the memory tables. */
        memory: memoryService(db, userId),
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
          update: async (id: string, values: Partial<ProviderValues>) => {
            await db
              .update(modelProviders)
              .set({ ...values, updatedAt: Date.now() })
              .where(ownProvider(id));
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
        getFile: (id: string) => FILES.get(fileKey(id)),
        putFile: (id: string, value: string, contentType: string) =>
          FILES.put(fileKey(id), value, { httpMetadata: { contentType } }),
      };
    },
  };
}
