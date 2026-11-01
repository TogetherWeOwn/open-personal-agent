// SPDX-License-Identifier: Apache-2.0
// The scoped repository layer (ADR 0010 D3): the only code that reads the DB, FILES and ASSISTANT
// bindings, derives R2 keys or names Durable Objects. scripts/check-scoped-access.mjs enforces it.
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { AnyD1Database } from "drizzle-orm/d1";
// A separate entry point (`@opa/db/repository`), so this import is not a cycle.
import { openD1, readSchemaVersion } from "./index";
import { conversations, messages, usage, users } from "./schema";

declare const brand: unique symbol;
/** A user's authority over their own rows. Only `scopeFromSession` and `scopeForAssistant` create one. */
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
           * Pricing joins in M2-21, so cost is 0. A call that never started gets no row.
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
                      id: crypto.randomUUID(),
                      userId,
                      conversationId: turn.conversationId,
                      messageId: turn.replyId,
                      providerId: turn.providerId,
                      model: turn.model,
                      ...turn.usage,
                    }),
                  ]
                : []),
            ]);
          },
        },
        getFile: (id: string) => FILES.get(fileKey(id)),
        putFile: (id: string, value: string, contentType: string) =>
          FILES.put(fileKey(id), value, { httpMetadata: { contentType } }),
      };
    },
  };
}
