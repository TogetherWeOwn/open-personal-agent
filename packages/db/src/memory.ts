// SPDX-License-Identifier: Apache-2.0
// MemoryService (ADR 0008 #4): the only code that reads or writes the memory tables; the
// scoped-access lint enforces it. This part reads; the trust-gated writes follow (M3-14a part 2).
import { and, desc, eq, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { Db } from "./index";
import { memories } from "./schema";

export type Trust = (typeof memories.$inferSelect)["trust"];
export type MemoryKind = (typeof memories.$inferSelect)["kind"];
export type MemorySourceKind = (typeof memories.$inferSelect)["source"];
export type Memory = typeof memories.$inferSelect;

/** FTS5 query syntax from free text: each word quoted and prefix-matched, all of them required. */
export function ftsQuery(text: string): string | null {
  const words = text.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 16) ?? [];
  return words.length > 0 ? words.map((w) => `"${w}"*`).join(" ") : null;
}

/** `column IN ids` as one bound JSON array: D1 allows only 100 bound parameters a query. */
const inIds = (column: SQLiteColumn, ids: string[]) =>
  sql`${column} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`;

export function memoryService(db: Db, userId: string) {
  const mine = (id: string) => and(eq(memories.id, id), eq(memories.userId, userId));
  const active = async (ids: string[]) =>
    ids.length === 0
      ? []
      : db
          .select()
          .from(memories)
          .where(
            and(
              eq(memories.userId, userId),
              eq(memories.status, "active"),
              inIds(memories.id, ids),
            ),
          );

  return {
    /** Current memories, newest first. */
    list: () =>
      db
        .select()
        .from(memories)
        .where(and(eq(memories.userId, userId), eq(memories.status, "active")))
        .orderBy(desc(memories.createdAt), desc(memories.n)),
    /** The user's current memory, or `undefined` when it is missing or someone else's. */
    get: async (id: string) =>
      (
        await db
          .select()
          .from(memories)
          .where(and(mine(id), eq(memories.status, "active")))
          .limit(1)
      )[0],
    /** Current memories matching every word of `text`, best match first (BM25). */
    search: async (text: string, limit = 20): Promise<Memory[]> => {
      const query = ftsQuery(text);
      if (!query) return [];
      const ids = await db.all<{ id: string }>(sql`
        SELECT m.id FROM memories_fts JOIN memories m ON m.n = memories_fts.rowid
        WHERE memories_fts MATCH ${query} AND m.user_id = ${userId} AND m.status = 'active'
        ORDER BY bm25(memories_fts), m.n DESC LIMIT ${limit}`);
      const rows = await active(ids.map((r) => r.id));
      return ids.flatMap(({ id }) => rows.filter((r) => r.id === id));
    },
  };
}

export type MemoryService = ReturnType<typeof memoryService>;
