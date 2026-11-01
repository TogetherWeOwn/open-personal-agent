// SPDX-License-Identifier: Apache-2.0
// MemoryService (ADR 0008 #4): the only code that reads or writes the memory tables; the
// scoped-access lint enforces it. Every write passes the trust gate first:
// - trust is `system > user > inferred > external`, set from who is writing, never by the caller;
// - a create, update, merge or delete from a tainted context becomes a `proposed` row (R7 M3-8);
// - so does any write that would replace a memory of higher trust, or save an instruction the user
//   didn't assert (an assistant can't overwrite downwards);
// - secrets are redacted before anything is stored.
// Rows are superseded, never overwritten, and forget is a hard delete (the FTS5 triggers in
// migration 0006 drop the index entries in the same statement).
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
  /** Nobody but the system replaces a built-in memory. */
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

/**
 * FTS5 query syntax from free text: each word quoted and prefix-matched, all of them required. A
 * word keeps its combining marks, as the tokenizer does, so "re\u0301sume\u0301" stays one word.
 */
export function ftsQuery(text: string): string | null {
  const words =
    text
      .normalize("NFC")
      .match(/[\p{L}\p{M}\p{N}_]+/gu)
      ?.slice(0, 16) ?? [];
  return words.length > 0 ? words.map((w) => `"${w}"*`).join(" ") : null;
}

/** RRF fusion constant (M3-14 AC4): each ranking contributes 1/(k + rank), ranks 1-based. */
export const RECALL_RRF_K = 60;
/** Candidates the FTS ranking contributes to the fusion. */
export const RECALL_CANDIDATES = 100;
/** Default token budget a recall packs to. */
export const DEFAULT_RECALL_BUDGET_TOKENS = 2000;
/** Most memories one recall returns, whatever the budget. */
export const RECALL_MAX_MEMORIES = 25;

/** Rough token weight for packing: four characters to the token, at least one. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Fuse the FTS and recency orders with reciprocal rank fusion: every id scores 1/(k + rank)
 * from each order it appears in, ranks 1-based. Pure, so the contract pins the SQL while the
 * unit tests pin the math.
 */
export function fuseRanks(fts: string[], recency: string[], k = RECALL_RRF_K): Map<string, number> {
  const scores = new Map<string, number>();
  for (const order of [fts, recency]) {
    for (const [i, id] of order.entries()) {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
    }
  }
  return scores;
}

/** What a recall returns. `tainted` tells the host to taint the context (M3-02 AC3). */
export interface RecallResult {
  memories: Memory[];
  /** Any retrieved memory is below user trust (`inferred` or `external`). */
  tainted: boolean;
  /** The packed memories' estimated tokens, never over the budget. */
  tokens: number;
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
          .where(and(mine(change.id), eq(memories.status, "proposed")))
          .returning({ id: memories.id }),
      );
    }
    try {
      const results = await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
      // An accept whose proposal was accepted or rejected meanwhile activates nothing.
      if (!("userId" in change) && (results.at(-1) as unknown[]).length === 0) return null;
    } catch (error) {
      if (supersede && /NOT NULL/i.test(String((error as Error)?.cause ?? error))) return null;
      throw error;
    }
    return (await db.select().from(memories).where(mine(change.id)).limit(1))[0] ?? null;
  };

  /**
   * Hard-deletes current memories with their earlier versions and pending proposals about them,
   * in one statement: nothing if any of `ids` stopped being current meanwhile, or if `proposalId`
   * (an accepted delete proposal) is no longer pending. Returns the deleted IDs, or `null`.
   */
  const forget = async (ids: string[], proposalId?: string): Promise<string[] | null> => {
    const pending =
      proposalId === undefined
        ? sql`1`
        : sql`EXISTS (SELECT 1 FROM memories p WHERE p.id = ${proposalId} AND p.user_id = ${userId}
            AND p.status = 'proposed' AND p.expires_at > ${Date.now()})`;
    const deleted = await db.all<{ id: string }>(sql`
      WITH RECURSIVE
        anchor(id) AS (
          SELECT id FROM memories
            WHERE user_id = ${userId} AND status = 'active' AND ${inIds(memories.id, ids)}
        ),
        chain(id) AS (
          SELECT id FROM anchor WHERE (SELECT count(*) FROM anchor) = ${ids.length} AND ${pending}
          UNION
          SELECT l.target_id FROM memory_links l JOIN chain c ON l.memory_id = c.id
            WHERE l.user_id = ${userId}
        )
      DELETE FROM memories
        WHERE user_id = ${userId} AND (id IN chain OR (status = 'proposed' AND id IN (
          SELECT memory_id FROM memory_links WHERE user_id = ${userId} AND target_id IN chain)))
      RETURNING id`);
    return deleted.length > 0 ? deleted.map((r) => r.id) : null;
  };

  const deleted = (ids: string[] | null): WriteOutcome =>
    ids ? { status: "deleted", ids } : { status: "not_found" };

  /** Built-in memories can be forgotten, never replaced: not even through an accepted proposal. */
  const builtIn = (op: Memory["op"], targets: Memory[]) =>
    op !== "delete" && targets.some((t) => t.trust === "system");

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
    const least = { create: 0, update: 1, merge: 2, delete: 1 }[op];
    if (targetIds.length < least) return { status: "not_found" };
    const targets = await active(targetIds);
    if (targets.length !== targetIds.length) return { status: "not_found" };
    const trust = trustOf(actor);
    const resultKind =
      kind ?? (targets.some((t) => t.kind === "instruction") ? "instruction" : "fact");
    if (actor.via !== "system" && builtIn(op, targets)) return { status: "forbidden" };
    const downward = targets.some((t) => RANK[t.trust] > RANK[trust]);
    const propose =
      actor.via === "assistant" &&
      (actor.tainted ||
        downward ||
        (op !== "delete" && resultKind === "instruction" && RANK[trust] < RANK.user));
    if (!propose && op === "delete") return deleted(await forget(targetIds));
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
    /** Current memories matching every word of `text`, best match first (BM25), at most 100. */
    search: async (text: string, limit = 20): Promise<Memory[]> => {
      const query = ftsQuery(text);
      if (!query) return [];
      // SQLite reads a negative LIMIT as none.
      const cap = Math.min(Math.max(Math.trunc(limit) || 1, 1), 100);
      const ids = await db.all<{ id: string }>(sql`
        SELECT m.id FROM memories_fts JOIN memories m ON m.n = memories_fts.rowid
        WHERE memories_fts MATCH ${query} AND m.user_id = ${userId} AND m.status = 'active'
        ORDER BY bm25(memories_fts), m.n DESC LIMIT ${cap}`);
      const rows = new Map((await active(ids.map((r) => r.id))).map((r) => [r.id, r]));
      return ids.flatMap(({ id }) => rows.get(id) ?? []);
    },
    /**
     * Recall (M3-14 AC4): FTS5 matches re-ranked by recency and fused with RRF (k=60), packed to
     * a token budget, newest first on ties. Read-only with no model call on the path: two indexed
     * queries and one fetch by id. Only FTS matches can surface; recency never promotes a memory
     * the query didn't match. `tainted` is set when any retrieved memory is below user trust.
     */
    recall: async (
      text: string,
      opts?: { budget?: number; limit?: number },
    ): Promise<RecallResult> => {
      const empty: RecallResult = { memories: [], tainted: false, tokens: 0 };
      const query = ftsQuery(text);
      if (!query) return empty;
      const budget = opts?.budget ?? DEFAULT_RECALL_BUDGET_TOKENS;
      const limit = Math.min(
        Math.max(Math.trunc(opts?.limit ?? RECALL_MAX_MEMORIES) || 1, 1),
        RECALL_MAX_MEMORIES,
      );
      const ids = await db.all<{ id: string }>(sql`
        SELECT m.id FROM memories_fts JOIN memories m ON m.n = memories_fts.rowid
        WHERE memories_fts MATCH ${query} AND m.user_id = ${userId} AND m.status = 'active'
        ORDER BY bm25(memories_fts), m.n DESC LIMIT ${RECALL_CANDIDATES}`);
      const rows = await active(ids.map((r) => r.id));
      if (rows.length === 0) return empty;
      const byId = new Map(rows.map((r) => [r.id, r]));
      const ftsOrder = ids.map((r) => r.id).filter((id) => byId.has(id));
      const recencyOrder = [...rows]
        .sort((a, b) => b.createdAt - a.createdAt || b.n - a.n)
        .map((r) => r.id);
      const scores = fuseRanks(ftsOrder, recencyOrder);
      const fused = [...byId.values()].sort(
        (a, b) =>
          (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) ||
          b.createdAt - a.createdAt ||
          b.n - a.n,
      );
      const memories: Memory[] = [];
      let tokens = 0;
      for (const m of fused) {
        if (memories.length >= limit) break;
        const cost = estimateTokens(m.text);
        if (tokens + cost > budget) break;
        memories.push(m);
        tokens += cost;
      }
      return {
        memories,
        tainted: memories.some((m) => m.trust !== "system" && m.trust !== "user"),
        tokens,
      };
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
     * fact keeps the trust of where it came from. An accepted instruction is the user's. Only the
     * user can accept: an assistant-minted service must not promote its own proposal.
     */
    accept: async (actor: MemoryActor, id: string): Promise<WriteOutcome> => {
      if (actor.via !== "user") return { status: "forbidden" };
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
      const targets = await active(targetIds);
      if (targets.length !== targetIds.length) return { status: "not_found" };
      if (builtIn(proposal.op, targets)) return { status: "forbidden" };
      if (proposal.op === "delete") {
        return targetIds.length > 0
          ? deleted(await forget(targetIds, id))
          : { status: "not_found" };
      }
      const trust = proposal.kind === "instruction" ? "user" : proposal.trust;
      const saved = await write({ id, trust, status: "active" }, targetIds);
      return saved ? { status: "saved", memory: saved } : { status: "not_found" };
    },
    /** The user rejects a proposal: it is deleted, it was never a memory. Only the user can. */
    reject: async (actor: MemoryActor, id: string) =>
      actor.via === "user" &&
      (
        await db
          .delete(memories)
          .where(and(mine(id), eq(memories.status, "proposed")))
          .returning({ id: memories.id })
      ).length > 0,
  };
}

export type MemoryService = ReturnType<typeof memoryService>;
