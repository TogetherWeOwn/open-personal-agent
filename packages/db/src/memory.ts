// SPDX-License-Identifier: Apache-2.0
// MemoryService (ADR 0008 #4): the only code that reads or writes the memory tables; the
// scoped-access lint enforces it. Every write passes the trust gate first:
// - trust is `system > user > inferred > external`, set from who is writing, never by the caller;
// - a create, update, merge or delete from a tainted context becomes a `proposed` row (R7 M3-8);
// - so does any write that would replace a memory of higher trust, or save an instruction the user
//   didn't assert (an assistant can't overwrite downwards);
// - secrets are redacted before anything is stored.
// Rows are superseded, never overwritten, and forget is a hard delete (the FTS5 triggers in
// migration 0005 drop the index entries in the same statement).
import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { Db } from "./index";
import { memories, memoryLinks } from "./schema";

export type Trust = (typeof memories.$inferSelect)["trust"];
export type MemoryKind = (typeof memories.$inferSelect)["kind"];
export type MemorySourceKind = (typeof memories.$inferSelect)["source"];
export type Memory = typeof memories.$inferSelect;

/**
 * Who is writing, as the host knows it. `user` is the person on the Memory screen; `assistant`
 * is a tool call, with the turn's taint and whether the user's own message asked for it.
 */
export type MemoryActor =
  | { via: "user" }
  | { via: "assistant"; tainted: boolean; userAsserted: boolean }
  | { via: "system" };

export interface MemorySource {
  source: MemorySourceKind;
  ref?: string;
  excerpt?: string;
  conversationId?: string;
}

/** The `memory.proposed` event payload (m3-spec §5, M3-03). */
export interface Proposal {
  memoryId: string;
  text: string;
  source: MemorySourceKind;
}

export type WriteOutcome =
  | { status: "saved"; memory: Memory }
  | { status: "deleted"; ids: string[] }
  | { status: "proposed"; proposal: Proposal }
  /** A target is missing, someone else's, no longer current, or the proposal has expired. */
  | { status: "not_found" }
  /** The user can't edit a built-in memory. */
  | { status: "forbidden" };

/** Proposals expire to rejected after this; M3-18 makes it a setting. */
export const PROPOSAL_TTL_MS = 14 * 86_400_000;

const RANK: Record<Trust, number> = { system: 3, user: 2, inferred: 1, external: 0 };

export function trustOf(actor: MemoryActor): Trust {
  if (actor.via !== "assistant") return actor.via;
  if (actor.tainted) return "external";
  return actor.userAsserted ? "user" : "inferred";
}

/** Common credential shapes, a PEM private key, and card numbers that pass the Luhn check. */
const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|pk|rk)[-_](?:ant-|proj-|live_|test_)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\b(?:password|passwd|passphrase|(?:api|secret)[_ -]?key|(?:access|auth)[_ -]?token)\b(\s*(?:is|[:=])\s*)\S+/gi,
];
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRETS) {
    out = out.replace(pattern, (match, gap?: string) =>
      typeof gap === "string"
        ? `${match.slice(0, match.indexOf(gap))}${gap}[redacted]`
        : "[redacted]",
    );
  }
  return out.replace(CARD, (m) => (luhn(m.replace(/\D/g, "")) ? "[redacted]" : m));
}

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

  /** The row's values; the source's conversation is kept only if it is the user's. */
  const row = (
    fields: Pick<Memory, "kind" | "text" | "trust" | "status" | "op">,
    from: MemorySource,
  ) => ({
    ...fields,
    id: crypto.randomUUID(),
    userId,
    text: redactSecrets(fields.text),
    source: from.source,
    sourceRef: from.ref === undefined ? null : redactSecrets(from.ref),
    sourceExcerpt: from.excerpt === undefined ? null : redactSecrets(from.excerpt),
    conversationId: from.conversationId
      ? sql`(SELECT id FROM conversations WHERE id = ${from.conversationId} AND user_id = ${userId})`
      : null,
    expiresAt: fields.status === "proposed" ? Date.now() + PROPOSAL_TTL_MS : null,
  });

  /**
   * Inserts a row linked to `targets`, or makes an accepted proposal (already linked) current. A
   * current row supersedes its targets in the same batch, all of them or none.
   */
  const write = async (
    change: ReturnType<typeof row> | { id: string; trust: Trust; status: "active" },
    targets: string[],
  ) => {
    const supersede = change.status === "active" && targets.length > 0;
    // A target that stopped being current meanwhile leaves a NULL in a NOT NULL column, so the
    // batch rolls back. `changes()` counts the previous statement's own rows, not trigger writes.
    const guard = <T>(value: T) =>
      supersede ? sql`CASE WHEN changes() = ${targets.length} THEN ${value} END` : value;
    const now = Date.now();
    const statements: BatchItem<"sqlite">[] = [];
    if (supersede) {
      // An accepted proposal supersedes only while it is still a proposal (not rejected meanwhile).
      const pending = sql`EXISTS (SELECT 1 FROM memories p WHERE p.id = ${change.id}
        AND p.user_id = ${userId} AND p.status = 'proposed')`;
      statements.push(
        db
          .update(memories)
          .set({ status: "superseded", updatedAt: now })
          .where(
            and(
              eq(memories.userId, userId),
              eq(memories.status, "active"),
              inIds(memories.id, targets),
              "userId" in change ? undefined : pending,
            ),
          ),
      );
    }
    if ("userId" in change) {
      statements.push(db.insert(memories).values({ ...change, id: guard(change.id) }));
      if (targets.length > 0) {
        statements.push(
          db
            .insert(memoryLinks)
            .select(
              sql`SELECT ${change.id}, value, ${userId} FROM json_each(${JSON.stringify(targets)})`,
            ),
        );
      }
    } else {
      statements.push(
        db
          .update(memories)
          .set({ status: guard("active"), trust: change.trust, expiresAt: null, updatedAt: now })
          .where(and(mine(change.id), eq(memories.status, "proposed"))),
      );
    }
    try {
      await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
    } catch (error) {
      if (supersede && /NOT NULL/i.test(String((error as Error)?.cause ?? error))) return null;
      throw error;
    }
    return (await db.select().from(memories).where(mine(change.id)).limit(1))[0] ?? null;
  };

  /** Hard-deletes memories with their earlier versions and pending proposals about them. */
  const forget = async (ids: string[]): Promise<string[]> => {
    const chain = await db.all<{ id: string }>(sql`
      WITH RECURSIVE chain(id) AS (
        SELECT id FROM memories
          WHERE user_id = ${userId} AND status != 'proposed'
            AND ${inIds(memories.id, ids)}
        UNION
        SELECT l.target_id FROM memory_links l JOIN chain c ON l.memory_id = c.id
          WHERE l.user_id = ${userId}
      )
      SELECT id FROM chain
      UNION
      SELECT l.memory_id FROM memory_links l JOIN memories p ON p.id = l.memory_id
        WHERE l.user_id = ${userId} AND p.status = 'proposed' AND l.target_id IN chain`);
    const doomed = chain.map((r) => r.id);
    if (doomed.length === 0) return [];
    await db.delete(memories).where(and(eq(memories.userId, userId), inIds(memories.id, doomed)));
    return doomed;
  };

  /** The gate. `targets` are the current rows the write replaces or deletes. */
  async function gated(
    actor: MemoryActor,
    op: Memory["op"],
    ids: string[],
    text: string,
    kind: MemoryKind | null,
    from: MemorySource,
  ): Promise<WriteOutcome> {
    const targetIds = [...new Set(ids)];
    if (op === "merge" && targetIds.length < 2) return { status: "not_found" };
    const targets = await active(targetIds);
    if (targets.length !== targetIds.length) return { status: "not_found" };
    const trust = trustOf(actor);
    const resultKind =
      kind ?? (targets.some((t) => t.kind === "instruction") ? "instruction" : "fact");
    const downward = targets.some((t) => RANK[t.trust] > RANK[trust]);
    if (actor.via === "user" && downward && op !== "delete") return { status: "forbidden" };
    const propose =
      actor.via === "assistant" &&
      (actor.tainted ||
        downward ||
        (op !== "delete" && resultKind === "instruction" && RANK[trust] < RANK.user));
    if (!propose && op === "delete") return { status: "deleted", ids: await forget(targetIds) };
    const status = propose ? "proposed" : "active";
    const values = row({ kind: resultKind, text, trust, status, op }, from);
    const saved = await write(values, targetIds);
    if (!saved) return { status: "not_found" };
    return propose
      ? {
          status: "proposed",
          proposal: { memoryId: saved.id, text: saved.text, source: saved.source },
        }
      : { status: "saved", memory: saved };
  }

  return {
    /** Current memories, newest first. */
    list: () =>
      db
        .select()
        .from(memories)
        .where(and(eq(memories.userId, userId), eq(memories.status, "active")))
        .orderBy(desc(memories.createdAt), desc(memories.n)),
    /** Proposals that haven't expired, newest first, each with the IDs it would replace. */
    proposals: async () => {
      const rows = await db
        .select()
        .from(memories)
        .where(
          and(
            eq(memories.userId, userId),
            eq(memories.status, "proposed"),
            gt(memories.expiresAt, Date.now()),
          ),
        )
        .orderBy(desc(memories.createdAt), desc(memories.n));
      const links = await db
        .select({ memoryId: memoryLinks.memoryId, targetId: memoryLinks.targetId })
        .from(memoryLinks)
        .innerJoin(memories, eq(memories.id, memoryLinks.memoryId))
        .where(and(eq(memoryLinks.userId, userId), eq(memories.status, "proposed")));
      return rows.map((r) => ({
        ...r,
        targetIds: links.filter((l) => l.memoryId === r.id).map((l) => l.targetId),
      }));
    },
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
    create: (actor: MemoryActor, text: string, kind: MemoryKind, from: MemorySource) =>
      gated(actor, "create", [], text, kind, from),
    /** Supersedes the memory with a new version. */
    update: (actor: MemoryActor, id: string, text: string, from: MemorySource) =>
      gated(actor, "update", [id], text, null, from),
    /** Supersedes several memories with one. */
    merge: (actor: MemoryActor, ids: string[], text: string, from: MemorySource) =>
      gated(actor, "merge", ids, text, null, from),
    /** Forgets memories: a hard delete from the table and FTS5, earlier versions included. */
    forget: (actor: MemoryActor, ids: string[], from: MemorySource) =>
      gated(actor, "delete", ids, "", null, from),
    /**
     * The user accepts a proposal (M3-15); it is applied as if they had made it, except that a
     * fact keeps the trust of where it came from. An accepted instruction is the user's.
     */
    accept: async (id: string): Promise<WriteOutcome> => {
      const proposal = (
        await db
          .select()
          .from(memories)
          .where(and(mine(id), eq(memories.status, "proposed"), gt(memories.expiresAt, Date.now())))
          .limit(1)
      )[0];
      if (!proposal) return { status: "not_found" };
      const targetIds = (
        await db
          .select({ id: memoryLinks.targetId })
          .from(memoryLinks)
          .where(and(eq(memoryLinks.userId, userId), eq(memoryLinks.memoryId, id)))
      ).map((l) => l.id);
      if ((await active(targetIds)).length !== targetIds.length) return { status: "not_found" };
      if (proposal.op === "delete") return { status: "deleted", ids: await forget(targetIds) };
      const trust = proposal.kind === "instruction" ? "user" : proposal.trust;
      const saved = await write({ id, trust, status: "active" }, targetIds);
      return saved ? { status: "saved", memory: saved } : { status: "not_found" };
    },
    /** The user rejects a proposal: it is deleted, it was never a memory. */
    reject: async (id: string) =>
      (
        await db
          .delete(memories)
          .where(and(mine(id), eq(memories.status, "proposed")))
          .returning({ id: memories.id })
      ).length > 0,
  };
}

export type MemoryService = ReturnType<typeof memoryService>;
