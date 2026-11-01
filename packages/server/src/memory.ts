// SPDX-License-Identifier: Apache-2.0
// The Memory screen's data (M3-15): notes with their source, trust and dates, search, edit as a
// supersede, delete and bulk delete, the proposals waiting for the user, the `opa-memory-export/v1`
// download and Settings › Memory's "Learn from our chats". Every write goes through
// `MemoryService` as the user (`via: "user"`), so the trust gate and its hard delete stay the
// only path to the tables.
import type { Memory, WriteOutcome } from "@opa/db/memory";
import { createRepository, isId } from "@opa/db/repository";
import { type Context, Hono } from "hono";
import type { AppEnv } from "./env";
import { hasStepUp } from "./session";

type Ctx = Context<AppEnv>;
const userOf = (c: Ctx) => createRepository(c.env).forUser(c.var.session.scope);
const screen = { via: "user" } as const;
const typed = { source: "memory_screen" } as const;

/** The longest note the screen accepts, as `remember` does. */
const MAX_TEXT = 2000;
/** Most notes one bulk delete takes: "Select all" covers every note matching the filter. */
const MAX_BULK = 1000;

/** A note as the screen reads it: never the user id, and the conversation by its title. */
type Titles = Map<string, string | null>;

const view = (m: Memory, titles: Titles) => ({
  id: m.id,
  kind: m.kind,
  text: m.text,
  trust: m.trust,
  /** `update` or `merge` means it has earlier versions. */
  op: m.op,
  source: m.source,
  sourceRef: m.sourceRef,
  sourceExcerpt: m.sourceExcerpt,
  conversation: m.conversationId
    ? { id: m.conversationId, title: titles.get(m.conversationId) ?? null }
    : null,
  createdAt: m.createdAt,
  lastUsedAt: m.lastUsedAt,
  expiresAt: m.expiresAt,
});

async function titlesOf(user: ReturnType<typeof userOf>) {
  return new Map((await user.listConversations()).map((c) => [c.id, c.title]));
}

/** The note text from a body, trimmed; `null` when missing, empty or too long. */
function textOf(body: unknown): string | null {
  const text = (body as { text?: unknown } | null)?.text;
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_TEXT ? trimmed : null;
}

/** A gate outcome as a response: the saved note, or why nothing changed. */
function reply(c: Ctx, outcome: WriteOutcome, titles: Titles) {
  if (outcome.status === "saved") return c.json({ memory: view(outcome.memory, titles) });
  if (outcome.status === "deleted") return c.body(null, 204);
  if (outcome.status === "forbidden") return c.json({ error: "built_in" }, 403);
  // A user's own write is never proposed; anything else means the note changed meanwhile.
  return c.json({ error: "not_found" }, 404);
}

export const memoryRoutes = new Hono<AppEnv>();

memoryRoutes.use(async (c, next) => {
  c.header("Cache-Control", "no-store");
  return next();
});

/** `?q=` searches; without it, every current note, newest first. */
memoryRoutes.get("/", async (c) => {
  const user = userOf(c);
  const q = c.req.query("q")?.trim() ?? "";
  const rows = q ? await user.memory.search(q, 100) : await user.memory.list();
  const titles = await titlesOf(user);
  return c.json({ memories: rows.map((m) => view(m, titles)) });
});

/** Adds a note typed on the Memory screen: the user's own, at `user` trust. */
memoryRoutes.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  const text = textOf(body);
  if (!text) return c.json({ error: "invalid_text" }, 400);
  const kind = body?.kind ?? "fact";
  if (kind !== "fact" && kind !== "instruction") return c.json({ error: "invalid_kind" }, 400);
  const user = userOf(c);
  return reply(c, await user.memory.create(screen, text, kind, typed), await titlesOf(user));
});

/**
 * Proposals waiting for the user, soonest expiry first, each with the current notes it would
 * replace so the screen can show a diff. Expired ones go first: they expire to rejected and are
 * never accepted (M3-15 AC2).
 */
memoryRoutes.get("/proposals", async (c) => {
  const user = userOf(c);
  const expired = await user.memory.expire();
  const proposals = await user.memory.proposals();
  const titles = await titlesOf(user);
  const targets = new Map((await user.memory.list()).map((m) => [m.id, view(m, titles)] as const));
  return c.json({
    expired,
    proposals: proposals
      .map((p) => ({
        ...view(p, titles),
        targets: p.targetIds.flatMap((id) => targets.get(id) ?? []),
      }))
      .sort((a, b) => (a.expiresAt ?? 0) - (b.expiresAt ?? 0)),
  });
});

const decisions = {
  accept: (m: ReturnType<typeof userOf>["memory"], id: string) => m.accept(screen, id),
  "keep-both": (m: ReturnType<typeof userOf>["memory"], id: string) => m.keepBoth(screen, id),
} as const;

/** Accept (`accept`), keep both (`keep-both`) or reject (`reject`) one proposal. */
memoryRoutes.post("/proposals/:id/:decision", async (c) => {
  const id = c.req.param("id");
  const decision = c.req.param("decision");
  if (!isId(id)) return c.json({ error: "not_found" }, 404);
  const user = userOf(c);
  if (decision === "reject") {
    return (await user.memory.reject(screen, id))
      ? c.body(null, 204)
      : c.json({ error: "not_found" }, 404);
  }
  if (decision !== "accept" && decision !== "keep-both") return c.json({ error: "not_found" }, 404);
  return reply(c, await decisions[decision](user.memory, id), await titlesOf(user));
});

/**
 * The `opa-memory-export/v1` download. Export is an account action, so like M3-20's it needs the
 * 5-minute passkey step-up on top of the session: a stolen cookie alone can't take everything.
 */
memoryRoutes.get("/export", async (c) => {
  if (!hasStepUp(c.var.session)) return c.json({ error: "step_up_required" }, 403);
  const { rows, links } = await userOf(c).memory.dump();
  const exportedAt = new Date().toISOString();
  c.header(
    "Content-Disposition",
    `attachment; filename="memory-${exportedAt.slice(0, 10)}.opa-memory.json"`,
  );
  const supersedes = new Map<string, string[]>();
  for (const l of links)
    supersedes.set(l.memoryId, [...(supersedes.get(l.memoryId) ?? []), l.targetId]);
  return c.json({
    format: "opa-memory-export/v1",
    exportedAt,
    memories: rows.map((m) => ({
      id: m.id,
      kind: m.kind,
      text: m.text,
      trust: m.trust,
      status: m.status,
      source: m.source,
      sourceRef: m.sourceRef,
      sourceExcerpt: m.sourceExcerpt,
      conversationId: m.conversationId,
      createdAt: new Date(m.createdAt).toISOString(),
      lastUsedAt: m.lastUsedAt === null ? null : new Date(m.lastUsedAt).toISOString(),
      supersedes: supersedes.get(m.id) ?? [],
    })),
  });
});

/**
 * Body `{ ids }`. One statement when every note is still current. Otherwise the notes that
 * changed meanwhile fail and the rest are forgotten in a second statement, so a stale ID costs
 * a fixed number of queries, never one per note.
 */
memoryRoutes.post("/delete", async (c) => {
  const ids = (await c.req.json().catch(() => null))?.ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BULK || !ids.every(isId)) {
    return c.json({ error: "invalid_ids" }, 400);
  }
  const memory = userOf(c).memory;
  const unique = [...new Set<string>(ids)];
  if ((await memory.forget(screen, unique, typed)).status === "deleted") {
    return c.json({ deleted: unique, failed: [] });
  }
  const current = new Set((await memory.list()).map((m) => m.id));
  const live = unique.filter((id) => current.has(id));
  // A note that changed between the two reads fails the whole second statement; the user retries.
  const ok = live.length > 0 && (await memory.forget(screen, live, typed)).status === "deleted";
  return c.json({
    deleted: ok ? live : [],
    failed: ok ? unique.filter((id) => !current.has(id)) : unique,
  });
});

/** Earlier versions of a note, newest first. */
memoryRoutes.get("/:id/versions", async (c) => {
  const id = c.req.param("id");
  if (!isId(id)) return c.json({ error: "not_found" }, 404);
  const user = userOf(c);
  const titles = await titlesOf(user);
  return c.json({ versions: (await user.memory.versions(id)).map((m) => view(m, titles)) });
});

/** Edit: supersedes the note with the user's text, which makes it theirs (`user` trust). */
memoryRoutes.put("/:id", async (c) => {
  const id = c.req.param("id");
  if (!isId(id)) return c.json({ error: "not_found" }, 404);
  const text = textOf(await c.req.json().catch(() => null));
  if (!text) return c.json({ error: "invalid_text" }, 400);
  const user = userOf(c);
  return reply(c, await user.memory.update(screen, id, text, typed), await titlesOf(user));
});

/** Forgets one note and its earlier versions: a hard delete (M3-14 AC5). */
memoryRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  if (!isId(id)) return c.json({ error: "not_found" }, 404);
  return reply(c, await userOf(c).memory.forget(screen, [id], typed), new Map());
});

/** Settings › Memory (M3-15 AC5). Mounted at `/api/settings/memory`. */
export const memorySettings = new Hono<AppEnv>();

memorySettings.use(async (c, next) => {
  c.header("Cache-Control", "no-store");
  return next();
});

memorySettings.get("/", async (c) => {
  const row = await userOf(c).settings.get();
  // No settings row yet reads as the default: on.
  return c.json({ learnFromChats: row?.learnFromChats ?? true });
});

/** Body `{ learnFromChats: boolean }`. */
memorySettings.put("/", async (c) => {
  const value = (await c.req.json().catch(() => null))?.learnFromChats;
  if (typeof value !== "boolean") return c.json({ error: "invalid_setting" }, 400);
  await userOf(c).settings.save({ learnFromChats: value });
  return c.json({ learnFromChats: value });
});
