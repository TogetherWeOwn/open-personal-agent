// SPDX-License-Identifier: Apache-2.0
// Conversations, messages and the usage ledger, chat's durable truth (ADR 0002). Every query is
// filtered by the scope's user, so a guessed ID never reaches another user's rows (ADR 0010 D3).
import type { UserScope } from "./repository";
import type { SqlDatabase } from "./system";

/** Conversation IDs come from the client, so they are checked before they reach SQL. */
export const isConversationId = (id: unknown): id is string =>
  typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);

export type MessageStatus = "complete" | "streaming" | "interrupted" | "error";
type Message = { id: string; role: "user" | "assistant"; status: MessageStatus; content: string };

/** A running turn: also its eviction checkpoint, so it is plain JSON. */
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

export function chatStore({ DB: db }: { DB: SqlDatabase }, { userId }: UserScope) {
  return {
    /** The conversation's messages oldest first, or `null` when it is missing or not the user's. */
    async listMessages(conversationId: string) {
      // An owned conversation yields at least one row; with no messages, a row of nulls.
      const { results } = await db
        .prepare(
          `SELECT m.id, m.role, m.status, m.content, m.created_at AS createdAt FROM conversations c
           LEFT JOIN messages m ON m.conversation_id = c.id AND m.user_id = c.user_id
           AND m.role IN ('user', 'assistant') WHERE c.id = ? AND c.user_id = ? ORDER BY m.seq`,
        )
        .bind(conversationId, userId)
        .all<Message & { createdAt: number }>();
      return results.length ? results.filter((m) => m.id !== null) : null;
    },

    /**
     * Creates the conversation on its first message. On a conflict the no-op update runs, and so
     * returns a row, only for the owner: `false` means the ID is someone else's.
     */
    openConversation: async (conversationId: string, title: string) =>
      (await db
        .prepare(
          `INSERT INTO conversations (id, user_id, title) VALUES (?, ?, ?) ON CONFLICT(id)
           DO UPDATE SET updated_at = updated_at WHERE user_id = excluded.user_id RETURNING id`,
        )
        .bind(conversationId, userId, title)
        .first()) !== null,

    /** Writes the user's message and the empty streaming reply after it, both or neither. */
    startTurn(conversationId: string, text: string, replyId: string) {
      const insert = db.prepare(
        `INSERT INTO messages (id, user_id, conversation_id, seq, role, status, content)
         SELECT ?1, ?2, ?3, coalesce(max(seq), 0) + 1, ?4, ?5, ?6 FROM messages
         WHERE conversation_id = ?3`,
      );
      return db.batch([
        insert.bind(crypto.randomUUID(), userId, conversationId, "user", "complete", text),
        insert.bind(replyId, userId, conversationId, "assistant", "streaming", ""),
        db
          .prepare("UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?")
          .bind(Date.now(), conversationId, userId),
      ]);
    },

    /** Whether one of the user's sessions is still live, by the session guard's rules. */
    sessionLive: async (sessionId: string, now: number, idleSince: number) =>
      (await db
        .prepare(
          `SELECT 1 AS ok FROM sessions WHERE id = ? AND user_id = ? AND revoked_at IS NULL
           AND expires_at > ? AND last_seen_at > ?`,
        )
        .bind(sessionId, userId, now, idleSince)
        .first()) !== null,

    /**
     * Finishes a reply and writes the call's usage ledger row (ADR 0006) in one transaction.
     * Pricing joins in M2-21, so cost is 0. A call that never started gets no row.
     */
    settle: (turn: TurnRecord, status: MessageStatus) =>
      db.batch([
        db
          .prepare("UPDATE messages SET status = ?, content = ? WHERE id = ? AND user_id = ?")
          .bind(status, turn.reply, turn.replyId, userId),
        ...(turn.called ? [ledgerRow(db, userId, turn)] : []),
      ]),
  };
}

function ledgerRow(db: SqlDatabase, userId: string, turn: TurnRecord) {
  return db
    .prepare(
      `INSERT INTO usage (id, user_id, conversation_id, message_id, provider_id, model,
       input_tokens, output_tokens, cached_input_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    );
}
