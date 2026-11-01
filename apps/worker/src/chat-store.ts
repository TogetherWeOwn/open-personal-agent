// SPDX-License-Identifier: Apache-2.0
// Conversations, messages and the usage ledger in D1, the durable truth (ADR 0002). Every query
// is filtered by the user the store was opened for, so one user can never read or write another's
// rows, even with a guessed ID.
import type { ModelUsage } from "@opa/core";
import { IDLE_MS } from "./session";

/** Conversation IDs come from the client, so they are checked before they reach SQL. */
export const isConversationId = (id: unknown): id is string =>
  typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);

export type MessageStatus = "complete" | "streaming" | "interrupted" | "error";

/** A running turn: also its eviction checkpoint, so it is plain JSON. */
export interface TurnRecord {
  conversationId: string;
  turnId: string;
  replyId: string;
  providerId: string;
  model: string;
  reply: string;
  usage: ModelUsage | null;
}

export function chatStore(db: D1Database, userId: string) {
  return {
    /** The conversation's messages oldest first, or `null` when it is missing or not the user's. */
    async listMessages(conversationId: string) {
      type Row = { id: string; role: "user" | "assistant"; status: MessageStatus; content: string };
      const [owner, rows] = await db.batch<Row & { createdAt: number; n?: number }>([
        db
          .prepare("SELECT count(*) AS n FROM conversations WHERE id = ? AND user_id = ?")
          .bind(conversationId, userId),
        db
          .prepare(
            `SELECT id, role, status, content, created_at AS createdAt FROM messages
             WHERE user_id = ? AND conversation_id = ? AND role IN ('user', 'assistant')
             ORDER BY seq`,
          )
          .bind(userId, conversationId),
      ]);
      return owner?.results[0]?.n ? (rows?.results ?? []) : null;
    },

    /**
     * Creates the conversation on its first message. Returns `false` when the ID already belongs
     * to someone else, so a client can't append to a conversation it doesn't own.
     */
    async openConversation(conversationId: string, title: string): Promise<boolean> {
      await db
        .prepare(
          "INSERT INTO conversations (id, user_id, title) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING",
        )
        .bind(conversationId, userId, title)
        .run();
      const owner = await db
        .prepare("SELECT user_id FROM conversations WHERE id = ?")
        .bind(conversationId)
        .first<string>("user_id");
      return owner === userId;
    },

    /** Appends a message after the conversation's last one and bumps `updated_at`. */
    async append(conversationId: string, id: string, role: "user" | "assistant", content = "") {
      await db.batch([
        db
          .prepare(
            `INSERT INTO messages (id, user_id, conversation_id, seq, role, status, content)
             SELECT ?1, ?2, ?3, coalesce(max(seq), 0) + 1, ?4, ?5, ?6 FROM messages
             WHERE conversation_id = ?3`,
          )
          // A user message is complete when written; a reply streams until `settle`.
          .bind(
            id,
            userId,
            conversationId,
            role,
            role === "user" ? "complete" : "streaming",
            content,
          ),
        db
          .prepare("UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?")
          .bind(Date.now(), conversationId, userId),
      ]);
    },

    /** Whether the session a socket was opened with is still live, as the session guard rules. */
    sessionLive: async (sessionId: string) =>
      (await db
        .prepare(
          `SELECT 1 AS ok FROM sessions WHERE id = ? AND user_id = ? AND revoked_at IS NULL
           AND expires_at > ?3 AND last_seen_at > ?3 - ?4`,
        )
        .bind(sessionId, userId, Date.now(), IDLE_MS)
        .first("ok")) === 1,

    /**
     * Finishes a reply and writes the call's usage ledger row (ADR 0006) in one transaction.
     * Pricing joins in M2-21, so cost is 0. The reply row may not exist yet after an early
     * eviction, so the ledger row then has no message.
     */
    settle: (turn: TurnRecord, status: MessageStatus) =>
      db.batch([
        db
          .prepare("UPDATE messages SET status = ?, content = ? WHERE id = ? AND user_id = ?")
          .bind(status, turn.reply, turn.replyId, userId),
        db
          .prepare(
            `INSERT INTO usage (id, user_id, conversation_id, message_id, provider_id, model,
             input_tokens, output_tokens, cached_input_tokens)
             VALUES (?, ?2, ?, (SELECT id FROM messages WHERE id = ? AND user_id = ?2), ?, ?, ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            userId,
            turn.conversationId,
            turn.replyId,
            turn.providerId,
            turn.model,
            turn.usage?.inputTokens ?? 0,
            turn.usage?.outputTokens ?? 0,
            turn.usage?.cachedInputTokens ?? 0,
          ),
      ]),
  };
}

export type ChatStore = ReturnType<typeof chatStore>;
