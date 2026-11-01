// SPDX-License-Identifier: Apache-2.0
// Conversations, messages and the usage ledger in D1, the durable truth (ADR 0002). Every query
// is filtered by the user the store was opened for, so one user can never read or write another's
// rows, even with a guessed ID.
import type { ModelMessage, ModelUsage } from "@opa/core";

/** Conversation IDs come from the client, so they are checked before they reach SQL. */
export const isConversationId = (id: unknown): id is string =>
  typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);

export type MessageStatus = "complete" | "streaming" | "interrupted" | "error";

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  status: MessageStatus;
  content: string;
  createdAt: number;
}

export function chatStore(db: D1Database, userId: string) {
  return {
    listConversations: async () =>
      (
        await db
          .prepare(
            `SELECT id, title, updated_at AS updatedAt FROM conversations
             WHERE user_id = ? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 200`,
          )
          .bind(userId)
          .all<{ id: string; title: string | null; updatedAt: number }>()
      ).results,

    /** The conversation's messages oldest first, or `null` when it is missing or not the user's. */
    async listMessages(conversationId: string): Promise<StoredMessage[] | null> {
      const [owner, rows] = await db.batch<StoredMessage & { n?: number }>([
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

    /** The model context: every finished message, oldest first. */
    async history(conversationId: string): Promise<ModelMessage[]> {
      const { results } = await db
        .prepare(
          `SELECT role, content FROM messages WHERE user_id = ? AND conversation_id = ?
           AND role IN ('user', 'assistant') AND content != '' ORDER BY seq`,
        )
        .bind(userId, conversationId)
        .all<ModelMessage>();
      return results;
    },

    /** Appends a message after the conversation's last one and bumps `updated_at`. */
    async append(
      conversationId: string,
      message: { id: string; role: "user" | "assistant"; status: MessageStatus; content: string },
    ) {
      await db.batch([
        db
          .prepare(
            `INSERT INTO messages (id, user_id, conversation_id, seq, role, status, content)
             SELECT ?1, ?2, ?3, coalesce(max(seq), 0) + 1, ?4, ?5, ?6 FROM messages
             WHERE conversation_id = ?3`,
          )
          .bind(message.id, userId, conversationId, message.role, message.status, message.content),
        db
          .prepare("UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?")
          .bind(Date.now(), conversationId, userId),
      ]);
    },

    finish: (messageId: string, status: MessageStatus, content: string) =>
      db
        .prepare("UPDATE messages SET status = ?, content = ? WHERE id = ? AND user_id = ?")
        .bind(status, content, messageId, userId)
        .run(),

    /** Marks every reply still streaming as interrupted, after an eviction cut its turn short. */
    interruptStreaming: () =>
      db
        .prepare(
          "UPDATE messages SET status = 'interrupted' WHERE user_id = ? AND status = 'streaming'",
        )
        .bind(userId)
        .run(),

    /** One ledger row per model call (ADR 0006). Pricing joins in M2-21, so cost is 0. */
    recordUsage: (row: {
      conversationId: string;
      messageId: string;
      providerId: string;
      model: string;
      usage: ModelUsage | null;
    }) =>
      db
        .prepare(
          `INSERT INTO usage (id, user_id, conversation_id, message_id, provider_id, model,
           input_tokens, output_tokens, cached_input_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          userId,
          row.conversationId,
          row.messageId,
          row.providerId,
          row.model,
          row.usage?.inputTokens ?? 0,
          row.usage?.outputTokens ?? 0,
          row.usage?.cachedInputTokens ?? 0,
        )
        .run(),
  };
}

export type ChatStore = ReturnType<typeof chatStore>;
