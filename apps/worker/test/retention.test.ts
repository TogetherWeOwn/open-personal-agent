// SPDX-License-Identifier: Apache-2.0
// Retention (COST-10, M3-18): the settings, the daily sweep with its counts (AC1), the reconciler's
// upload collection (AC2), and the rule that a chat with a live task is never deleted (AC3).
import { createRepository, scopeFromSession } from "@opa/db/repository";
import { DAY_MS, LIVE_TASK_STATUSES, retentionStore } from "@opa/db/retention";
import { runRetention } from "@opa/server/retention";
import { describe, expect, it } from "vitest";
import { claim, count, db, env, freshDatabase } from "./helpers/app";

freshDatabase();

const repo = createRepository(env);
const NOW = Date.UTC(2026, 10, 1, 12);
const OLD = NOW - 100 * DAY_MS;
// The sweep reads only D1 and R2: no Durable Object namespace is even passed (AC2).
const store = () => retentionStore({ DB: env.DB, FILES: env.FILES });

async function user(id: string) {
  await db
    .prepare("INSERT INTO users (id, display_name, role) VALUES (?, ?, 'member')")
    .bind(id, id)
    .run();
  return repo.forUser(scopeFromSession({ userId: id }));
}

/** A chat last touched `at`, with one message from then. */
async function chat(userId: string, id: string, at: number) {
  await db.batch([
    db
      .prepare(
        "INSERT INTO conversations (id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
      .bind(id, userId, at, at),
    db
      .prepare(
        "INSERT INTO messages (id, user_id, conversation_id, seq, role, content, created_at) VALUES (?, ?, ?, 1, 'user', 'hi', ?)",
      )
      .bind(`${id}-m`, userId, id, at),
  ]);
}

async function task(
  userId: string,
  id: string,
  conversationId: string,
  status: string,
  state?: string,
) {
  await db
    .prepare(
      "INSERT INTO tasks (id, user_id, conversation_id, workflow_instance_id, kind, mode, status, state, created_at, finished_at) VALUES (?, ?, ?, ?, 'turn', 'background', ?, ?, ?, ?)",
    )
    .bind(id, userId, conversationId, `inst-${id}`, status, state ?? null, OLD, OLD)
    .run();
}

const setRetention = (userId: string, messageDays: number, toolDays = 30, inboxDays = 14) =>
  db
    .prepare(
      "INSERT INTO user_settings (user_id, message_retention_days, tool_output_retention_days, memory_inbox_days) VALUES (?, ?, ?, ?)",
    )
    .bind(userId, messageDays, toolDays, inboxDays)
    .run();

/** A write from a tainted context becomes a suggestion (R7 M3-8). */
const tainted = { via: "assistant", tainted: true, userAsserted: false } as const;

const sweepRows = async () =>
  (
    await db
      .prepare(
        "SELECT user_id, result, detail FROM audit_log WHERE action = 'retention.sweep' ORDER BY id",
      )
      .all<{ user_id: string | null; result: string; detail: string }>()
  ).results.map((r) => ({ userId: r.user_id, result: r.result, ...JSON.parse(r.detail) }));

describe("retention settings", () => {
  it("shows the defaults, saves a change with an audit row, and refuses out-of-range days", async () => {
    const { browser } = await claim();
    const res = await browser.req("/api/settings/retention");
    expect(await res.json()).toMatchObject({
      messageDays: null,
      toolOutputDays: 30,
      memoryInboxDays: 14,
      defaults: { messageDays: null, toolOutputDays: 30, memoryInboxDays: 14 },
    });

    const put = (body: unknown) => browser.req("/api/settings/retention", { method: "PUT", body });
    const saved = await put({ messageDays: 90, toolOutputDays: null });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      messageDays: 90,
      toolOutputDays: null,
      memoryInboxDays: 14,
    });
    const audit = await db
      .prepare("SELECT detail FROM audit_log WHERE action = 'settings.retention'")
      .first<string>("detail");
    expect(JSON.parse(audit as string)).toEqual({
      from: { messageDays: null, toolOutputDays: 30, memoryInboxDays: 14 },
      to: { messageDays: 90, toolOutputDays: null, memoryInboxDays: 14 },
    });

    for (const body of [
      { messageDays: 3 },
      { messageDays: 1.5 },
      { memoryInboxDays: null },
      { memoryInboxDays: 91 },
      { toolOutputDays: "30" },
    ]) {
      expect((await put(body)).status).toBe(400);
    }
    expect(
      (await (await browser.req("/api/settings/retention")).json<{ messageDays: number }>())
        .messageDays,
    ).toBe(90);
    expect(await count("audit_log", "action = 'settings.retention'")).toBe(1);
  });

  it("dates memory suggestions by the inbox setting, now and after a change", async () => {
    const { browser, owner } = await claim();
    const memory = repo.forUser(scopeFromSession({ userId: owner })).memory;
    await memory.create(tainted, "likes tea", "fact", { source: "chat" });
    // Days until expiry; created_at comes from D1's clock and the first date from the Worker's.
    const days = async () => {
      const r = await db
        .prepare("SELECT created_at AS c, expires_at AS e FROM memories WHERE status = 'proposed'")
        .first<{ c: number; e: number }>();
      return ((r?.e ?? 0) - (r?.c ?? 0)) / DAY_MS;
    };
    expect(await days()).toBeCloseTo(14, 5);

    await browser.req("/api/settings/retention", { method: "PUT", body: { memoryInboxDays: 3 } });
    expect(await days()).toBe(3);

    // One already past its date stays expired when the inbox grows: it is never revived.
    await db.prepare("UPDATE memories SET expires_at = ? WHERE status = 'proposed'").bind(1).run();
    await browser.req("/api/settings/retention", { method: "PUT", body: { memoryInboxDays: 30 } });
    expect(
      await db.prepare("SELECT expires_at AS e FROM memories WHERE status = 'proposed'").first("e"),
    ).toBe(1);
  });

  it("keeps both of two saves made from the same reading when they change different fields", async () => {
    const { owner } = await claim();
    const settings = repo.forUser(scopeFromSession({ userId: owner })).settings;
    const before = await settings.retention();
    await settings.saveRetention(before, { ...before, messageDays: 30 });
    await settings.saveRetention(before, { ...before, memoryInboxDays: 3 });
    expect(await settings.retention()).toEqual({
      messageDays: 30,
      toolOutputDays: 30,
      memoryInboxDays: 3,
    });
  });
});

describe("the daily sweep", () => {
  it("deletes idle chats but never one with a live task, a newer message or a reply streaming", async () => {
    await user("u1");
    await setRetention("u1", 30);
    await chat("u1", "idle", OLD);
    await chat("u1", "recent", NOW - DAY_MS);
    await chat("u1", "done-task", OLD);
    await task("u1", "t-done", "done-task", "succeeded");
    for (const status of LIVE_TASK_STATUSES) {
      await chat("u1", `live-${status}`, OLD);
      await task("u1", `t-${status}`, `live-${status}`, status);
    }
    // The chat's row looks idle but a message came in since: kept.
    await chat("u1", "busy", OLD);
    await db
      .prepare(
        "INSERT INTO messages (id, user_id, conversation_id, seq, role, content, created_at) VALUES ('busy-2', 'u1', 'busy', 2, 'user', 'again', ?)",
      )
      .bind(NOW - DAY_MS)
      .run();
    await chat("u1", "streaming", OLD);
    await db.prepare("UPDATE messages SET status = 'streaming' WHERE id = 'streaming-m'").run();
    // Another user keeps everything: their default is forever.
    await user("u2");
    await chat("u2", "theirs", OLD);

    const totals = await store().sweep(NOW);
    expect(totals).toMatchObject({ conversations: 2, users: 2, failed: 0 });
    const left = (
      await db.prepare("SELECT id FROM conversations ORDER BY id").all<{ id: string }>()
    ).results.map((r) => r.id);
    expect(left).toEqual(
      [
        "busy",
        "recent",
        "streaming",
        "theirs",
        ...LIVE_TASK_STATUSES.map((s) => `live-${s}`),
      ].sort(),
    );
    // The ended task and both chats' messages went with them.
    expect(await count("tasks", "id = 't-done'")).toBe(0);
    expect(await count("messages", "conversation_id IN ('idle', 'done-task')")).toBe(0);
    expect(await sweepRows()).toEqual([
      {
        userId: "u1",
        result: "ok",
        conversations: 2,
        toolOutputs: 0,
        proposals: 0,
        stepOutputs: 0,
      },
      {
        userId: null,
        result: "ok",
        conversations: 2,
        toolOutputs: 0,
        proposals: 0,
        stepOutputs: 0,
        users: 2,
        failed: 0,
      },
    ]);
  });

  it("deletes a chat whose turn stopped and has waited past the setting, with its saved state", async () => {
    await user("u1");
    await setRetention("u1", 30);
    // Two turns stopped at an approval, their replies still streaming: one stopped long ago and
    // was never answered, the other stopped yesterday.
    for (const [id, at] of [
      ["abandoned", OLD],
      ["waiting", NOW - DAY_MS],
    ] as const) {
      await chat("u1", id, OLD);
      await db.batch([
        db.prepare("UPDATE messages SET status = 'streaming' WHERE id = ?").bind(`${id}-m`),
        db
          .prepare(
            "INSERT INTO turn_states (turn_id, user_id, conversation_id, reply_id, provider_id, model, status, state, updated_at) VALUES (?, 'u1', ?, ?, 'p', 'm', 'awaiting_approval', '{}', ?)",
          )
          .bind(`turn-${id}`, id, `${id}-m`, at),
      ]);
    }

    expect(await store().sweep(NOW)).toMatchObject({ conversations: 1, failed: 0 });
    const left = await db.prepare("SELECT id FROM conversations").all<{ id: string }>();
    expect(left.results.map((r) => r.id)).toEqual(["waiting"]);
    expect(await count("turn_states", "turn_id = 'turn-abandoned'")).toBe(0);
    expect(await count("turn_states", "turn_id = 'turn-waiting'")).toBe(1);
  });

  it("keeps a chat with an approval still waiting for the user, which has no task row (AC3)", async () => {
    await user("u1");
    await setRetention("u1", 30);
    // Both look abandoned: an old stopped turn, its reply still streaming. One's approval still
    // waits (a decision resumes it); the other's expired and no reconciler tick has marked it.
    for (const [id, expiresAt] of [
      ["pending", NOW + DAY_MS],
      ["lapsed", NOW - 1],
    ] as const) {
      await chat("u1", id, OLD);
      await db.batch([
        db.prepare("UPDATE messages SET status = 'streaming' WHERE id = ?").bind(`${id}-m`),
        db
          .prepare(
            "INSERT INTO turn_states (turn_id, user_id, conversation_id, reply_id, provider_id, model, status, state, updated_at) VALUES (?, 'u1', ?, ?, 'p', 'm', 'awaiting_approval', '{}', ?)",
          )
          .bind(`turn-${id}`, id, `${id}-m`, OLD),
        db
          .prepare(
            `INSERT INTO approvals (batch_id, approval_id, position, user_id, conversation_id, turn_id, tool, tool_call_id, risk, rule, step_up, scopes, canonical, binding_hash, expires_at)
             VALUES (?, 'appr_c1', 0, 'u1', ?, ?, 'send', 'c1', 'consequential', 'default_consequential', 0, '["once"]', '{}', 'h', ?)`,
          )
          .bind(`b-${id}`, id, `turn-${id}`, expiresAt),
      ]);
    }

    expect(await store().sweep(NOW)).toMatchObject({ conversations: 1, failed: 0 });
    const left = await db.prepare("SELECT id FROM conversations").all<{ id: string }>();
    expect(left.results.map((r) => r.id)).toEqual(["pending"]);
  });

  it("removes tool outputs from tasks that ended past the setting, once", async () => {
    await user("u1");
    await setRetention("u1", 0, 7);
    await chat("u1", "c", NOW);
    const state = JSON.stringify({
      history: [
        { role: "user", content: "look it up" },
        { role: "tool", toolCallId: "a", content: "secret page text" },
      ],
      turn: { messages: [{ role: "tool", toolCallId: "b", content: "more output" }] },
    });
    await task("u1", "ended", "c", "failed", state);
    await task("u1", "running", "c", "running", state);
    await db
      .prepare("UPDATE tasks SET finished_at = ? WHERE id = 'running'")
      .bind(NOW - DAY_MS)
      .run();

    expect((await store().sweep(NOW)).toolOutputs).toBe(1);
    const saved = JSON.parse(
      (await db
        .prepare("SELECT state FROM tasks WHERE id = 'ended'")
        .first<string>("state")) as string,
    );
    const note = "[Removed after 7 days by your tool-output retention setting.]";
    expect(saved.history).toEqual([
      { role: "user", content: "look it up" },
      { role: "tool", toolCallId: "a", content: note },
    ]);
    expect(saved.turn.messages[0].content).toBe(note);
    expect(await db.prepare("SELECT state FROM tasks WHERE id = 'running'").first("state")).toBe(
      state,
    );
    expect((await store().sweep(NOW + DAY_MS)).toolOutputs).toBe(0);
  });

  it("expires memory suggestions past the inbox setting to rejected", async () => {
    const u1 = await user("u1");
    await setRetention("u1", 0, 30, 2);
    await u1.memory.create(tainted, "old idea", "fact", { source: "chat" });
    expect((await store().sweep(Date.now() + DAY_MS)).proposals).toBe(0);
    expect((await store().sweep(Date.now() + 3 * DAY_MS)).proposals).toBe(1);
    expect(await count("memories")).toBe(0);
  });

  it("collects offloaded step outputs no live task could replay", async () => {
    const u1 = await user("u1");
    await chat("u1", "c", NOW);
    await u1.stepOutputs.put("s1", "{}");
    // A queued task created before the object was written still needs it.
    await task("u1", "q", "c", "queued");
    await db
      .prepare("UPDATE tasks SET created_at = ? WHERE id = 'q'")
      .bind(Date.now() - DAY_MS)
      .run();
    const later = Date.now() + 2 * 3_600_000;
    expect((await store().sweep(later)).stepOutputs).toBe(0);
    expect(await env.FILES.head("u/u1/task-outputs/s1")).not.toBeNull();

    await db.prepare("UPDATE tasks SET status = 'succeeded' WHERE id = 'q'").run();
    expect((await store().sweep(later)).stepOutputs).toBe(1);
    expect(await env.FILES.head("u/u1/task-outputs/s1")).toBeNull();
  });

  it("runs once a UTC day from the reconciler, which also collects abandoned uploads", async () => {
    const u1 = await user("u1");
    await setRetention("u1", 30);
    await chat("u1", "idle", OLD);
    // A file sent with a message is kept; an upload no message took is collected after a day.
    for (const [id, at] of [
      ["sent", OLD],
      ["abandoned", Date.now() - 2 * DAY_MS],
      ["fresh", Date.now()],
    ] as const) {
      await env.FILES.put(`u/u1/attachments/${id}`, "x");
      await u1.attachments.create({
        id,
        name: id,
        mediaType: "text/plain",
        kind: "text",
        sizeBytes: 1,
      });
      await db.prepare("UPDATE attachments SET created_at = ? WHERE id = ?").bind(at, id).run();
    }
    await chat("u1", "keep", Date.now());
    await db.prepare("UPDATE attachments SET message_id = 'keep-m' WHERE id = 'sent'").run();

    await runRetention({ DB: env.DB, FILES: env.FILES });
    expect(await count("conversations", "id = 'idle'")).toBe(0);
    expect(
      (await db.prepare("SELECT id FROM attachments ORDER BY id").all<{ id: string }>()).results,
    ).toEqual([{ id: "fresh" }, { id: "sent" }]);
    expect(await env.FILES.head("u/u1/attachments/abandoned")).toBeNull();
    expect(await env.FILES.head("u/u1/attachments/sent")).not.toBeNull();

    // A second tick the same day doesn't sweep again.
    await chat("u1", "idle2", OLD);
    await runRetention({ DB: env.DB, FILES: env.FILES });
    expect(await count("conversations", "id = 'idle2'")).toBe(1);
    expect(await count("audit_log", "action = 'retention.sweep' AND user_id IS NULL")).toBe(1);
    // The next day's first tick does.
    await runRetention({ DB: env.DB, FILES: env.FILES }, Date.now() + DAY_MS);
    expect(await count("conversations", "id = 'idle2'")).toBe(0);
  });

  it("records what a user's sweep removed before a later step failed", async () => {
    await user("u1");
    await setRetention("u1", 30);
    await chat("u1", "idle", OLD);
    const list = () => Promise.reject(new Error("R2 is down"));
    const broken = retentionStore({
      DB: env.DB,
      FILES: Object.assign(Object.create(env.FILES), { list }),
    });
    expect(await broken.sweep(NOW)).toMatchObject({ conversations: 1, failed: 1 });
    expect(await sweepRows()).toEqual([
      {
        userId: "u1",
        result: "error",
        conversations: 1,
        toolOutputs: 0,
        proposals: 0,
        stepOutputs: 0,
      },
      expect.objectContaining({ userId: null, result: "error", conversations: 1, failed: 1 }),
    ]);
  });

  it("keeps an abandoned upload's row when its object can't be deleted, for the next tick", async () => {
    const u1 = await user("u1");
    await env.FILES.put("u/u1/attachments/a1", "x");
    await u1.attachments.create({
      id: "a1",
      name: "a1",
      mediaType: "text/plain",
      kind: "text",
      sizeBytes: 1,
    });
    const del = () => Promise.reject(new Error("R2 is down"));
    const broken = retentionStore({
      DB: env.DB,
      FILES: Object.assign(Object.create(env.FILES), { delete: del }),
    });
    const later = Date.now() + 2 * DAY_MS;
    expect(await broken.collectUploads(later)).toBe(0);
    expect(await count("attachments", "id = 'a1'")).toBe(1);
    expect(await store().collectUploads(later)).toBe(1);
    expect(await env.FILES.head("u/u1/attachments/a1")).toBeNull();
  });
});
