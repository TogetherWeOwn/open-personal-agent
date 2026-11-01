// SPDX-License-Identifier: Apache-2.0
// Account deletion (M3-20 AC2–3, m3-ux Flow G): deleting needs a fresh step-up, then leaves
// no row with the `user_id` (including `approvals`), nothing under `u/{userId}/` in R2 and
// no DEK — while the audit trail survives with a null user. Deleting the only owner returns
// the deployment to the unclaimed state; deleting one of two users leaves setup claimed.
import { describe, expect, it } from "vitest";
import {
  Browser,
  claim,
  count,
  db,
  env,
  freshDatabase,
  type passkey,
  sessionHeaders,
} from "./helpers/app";

freshDatabase();

/** Every user-data table: no row may keep the deleted user's id after the delete. */
const USER_TABLES = [
  "sessions",
  "passkeys",
  "recovery_codes",
  "user_keys",
  "secrets",
  "conversations",
  "messages",
  "turn_states",
  "approvals",
  "attachments",
  "usage",
  "model_providers",
  "tasks",
  "exports",
  "artifacts",
  "user_settings",
  "tool_overrides",
  "grants",
  "memories",
  "memory_links",
  "webauthn_challenges",
];

/** A passkey step-up in this session, as the account actions require. */
async function stepUp(br: Browser, key: ReturnType<typeof passkey>) {
  const res = await br.req("/api/auth/step-up/session/options", { body: {} });
  const { options } = await res.json<{ options: { challenge: string } }>();
  return br.req("/api/auth/step-up/session", {
    body: { credential: await key.get(options) },
  });
}

/** Seeds one row per user-owned store for `userId`, with bytes in R2 where they live. */
async function seedUser(userId: string) {
  // Row ids are prefixed with the user: two seeded users share this table in one test.
  const id = (name: string) => `${userId}-${name}`;
  const blob = new Uint8Array([1, 2, 3]);
  await db.batch([
    db.prepare("INSERT INTO conversations (id, user_id) VALUES (?, ?)").bind(id("c1"), userId),
    db
      .prepare(
        "INSERT INTO messages (id, user_id, conversation_id, seq, role, content) VALUES (?, ?, ?, 1, 'user', 'hi')",
      )
      .bind(id("m1"), userId, id("c1")),
    db
      .prepare(
        "INSERT INTO turn_states (turn_id, user_id, conversation_id, reply_id, provider_id, model, status, state) VALUES (?, ?, ?, 'r1', 'p', 'm', 'awaiting_approval', '{}')",
      )
      .bind(id("t1"), userId, id("c1")),
    db
      .prepare("INSERT INTO user_keys (user_id, kek_version, wrapped_dek, iv) VALUES (?, 1, ?, ?)")
      .bind(userId, blob, blob),
    db
      .prepare(
        "INSERT INTO secrets (id, user_id, purpose, binding, ciphertext, iv) VALUES (?, ?, 'p', 'b', ?, ?)",
      )
      .bind(id("s1"), userId, blob, blob),
    db
      .prepare(
        "INSERT INTO attachments (id, user_id, conversation_id, name, media_type, kind, size_bytes) VALUES (?, ?, ?, 'f.txt', 'text/plain', 'text', 3)",
      )
      .bind(id("a1"), userId, id("c1")),
    db
      .prepare(
        "INSERT INTO artifacts (id, user_id, name, media_type, size_bytes) VALUES (?, ?, 'out.md', 'text/markdown', 3)",
      )
      .bind(id("f1"), userId),
    db
      .prepare(
        "INSERT INTO tasks (id, user_id, conversation_id, kind, mode, status, workflow_instance_id) VALUES (?, ?, ?, 'turn', 'interactive', 'running', ?)",
      )
      .bind(id("t-active"), userId, id("c1"), id("inst-active")),
    db
      .prepare(
        "INSERT INTO tasks (id, user_id, conversation_id, kind, mode, status, workflow_instance_id) VALUES (?, ?, ?, 'turn', 'interactive', 'succeeded', ?)",
      )
      .bind(id("t-done"), userId, id("c1"), id("inst-done")),
    db
      .prepare("INSERT INTO task_steps (instance_id, name, output) VALUES (?, 's', '{}')")
      .bind(id("inst-active")),
    db
      .prepare("INSERT INTO task_events (instance_id, type, payload) VALUES (?, 'e', '{}')")
      .bind(id("inst-done")),
    db
      .prepare(
        "INSERT INTO memories (id, user_id, kind, text, trust, status, op, source) VALUES (?, ?, 'fact', 'x', 'user', 'active', 'create', 'chat')",
      )
      .bind(id("mem1"), userId),
    db
      .prepare(
        "INSERT INTO memories (id, user_id, kind, text, trust, status, op, source) VALUES (?, ?, 'fact', 'y', 'user', 'active', 'create', 'chat')",
      )
      .bind(id("mem2"), userId),
    db
      .prepare("INSERT INTO memory_links (memory_id, target_id, user_id) VALUES (?, ?, ?)")
      .bind(id("mem1"), id("mem2"), userId),
    db
      .prepare(
        "INSERT INTO exports (id, user_id, workflow_instance_id, status, expires_at) VALUES (?, ?, ?, 'ready', ?)",
      )
      .bind(id("e1"), userId, id("inst-e1"), Date.now() + 3_600_000),
    db
      .prepare(
        "INSERT INTO approvals (batch_id, approval_id, position, user_id, conversation_id, turn_id, tool, tool_call_id, risk, rule, step_up, scopes, canonical, binding_hash, expires_at) VALUES (?, ?, 0, ?, ?, ?, 'web_fetch', ?, 'read', 'ask', 0, '[]', '{}', 'h', ?)",
      )
      .bind(id("b1"), id("a1"), userId, id("c1"), id("t1"), id("c1"), Date.now() + 60_000),
    db
      .prepare(
        "INSERT INTO grants (id, user_id, tool, scope, expires_at) VALUES (?, ?, 'web_fetch', 'hour', ?)",
      )
      .bind(id("g1"), userId, Date.now() + 60_000),
    db
      .prepare("INSERT INTO usage (id, user_id, provider_id, model) VALUES (?, ?, 'p', 'm')")
      .bind(id("u1"), userId),
    db
      .prepare("INSERT INTO model_providers (id, user_id, kind) VALUES (?, ?, 'workers-ai')")
      .bind(id("p1"), userId),
    db.prepare("INSERT INTO user_settings (user_id) VALUES (?)").bind(userId),
    db
      .prepare(
        "INSERT INTO tool_overrides (user_id, tool, decision) VALUES (?, 'web_fetch', 'ask')",
      )
      .bind(userId),
    db
      .prepare(
        "INSERT INTO webauthn_challenges (id_hash, kind, challenge, user_id, expires_at) VALUES (?, 'login', 'c', ?, ?)",
      )
      .bind(id("h1"), userId, Date.now() + 60_000),
    db
      .prepare(
        "INSERT INTO audit_log (user_id, action, module, result) VALUES (?, 'chat.send', 'chat', 'ok')",
      )
      .bind(userId),
  ]);
  await env.FILES.put(`u/${userId}/attachments/${id("a1")}`, "txt", {
    httpMetadata: { contentType: "text/plain" },
  });
  await env.FILES.put(`u/${userId}/files/${id("f1")}`, "md", {
    httpMetadata: { contentType: "text/markdown" },
  });
  await env.FILES.put(`u/${userId}/task-outputs/${id("o1")}`, "{}", {
    httpMetadata: { contentType: "application/json" },
  });
  await env.FILES.put(`u/${userId}/exports/${id("e1")}.zip`, "zip", {
    httpMetadata: { contentType: "application/zip" },
  });
  await env.FILES.put(`u/${userId}/exports/${id("e1")}/staged/conversations.json`, "[]", {
    httpMetadata: { contentType: "application/json" },
  });
}

async function userR2Keys(userId: string): Promise<string[]> {
  if (!env.FILES.list) return [];
  const page = await env.FILES.list({ prefix: `u/${userId}/`, limit: 1000 });
  return page.objects.map((o) => o.key);
}

describe("DELETE /api/account", () => {
  it("refuses without a fresh step-up, deleting nothing", async () => {
    const { browser, owner } = await claim();
    await seedUser(owner);
    const res = await browser.req("/api/account", { method: "DELETE", body: {} });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "step_up_required" });
    expect(await count("users")).toBe(1);
    expect(await userR2Keys(owner)).toHaveLength(5);
  });

  it("deletes the only owner: no rows, no R2, no DEK, deployment unclaimed", async () => {
    const { browser, key, owner } = await claim();
    await seedUser(owner);
    expect((await stepUp(browser, key)).status).toBe(200);

    const res = await browser.req("/api/account", { method: "DELETE", body: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, unclaimed: true });

    // No row with the user_id remains, in any user-data table.
    for (const table of USER_TABLES) {
      expect([table, await count(table, `user_id = '${owner}'`)]).toEqual([table, 0]);
    }
    // Nothing remains under the user's R2 prefix: files, attachments, task outputs, ZIPs.
    expect(await userR2Keys(owner)).toEqual([]);
    // The only owner is gone, so the deployment is claimable again — but the spent setup
    // token never reopens it, and the audit trail survives without naming a user.
    expect(await count("users")).toBe(0);
    expect(await count("setup_state")).toBe(0);
    expect(await count("used_setup_tokens")).toBe(1);
    const trail = await db
      .prepare("SELECT user_id, action, result FROM audit_log WHERE action = 'account.delete'")
      .all<{ user_id: string | null; action: string; result: string }>();
    expect(trail.results).toHaveLength(1);
    expect(trail.results[0]).toMatchObject({
      user_id: null,
      action: "account.delete",
      result: "ok",
    });
    // The session died with the user, and the claim guard closes the app while unclaimed:
    // the app shows the unclaimed first-run screen, not the login page.
    expect((await browser.req("/api/me")).status).toBe(403);
  });

  it("keeps setup claimed when another user remains", async () => {
    const { browser, key, owner } = await claim();
    await seedUser(owner);
    await db
      .prepare("INSERT INTO users (id, display_name, role) VALUES ('u2', 'B', 'member')")
      .run();
    await seedUser("u2");

    expect((await stepUp(browser, key)).status).toBe(200);
    const res = await browser.req("/api/account", { method: "DELETE", body: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, unclaimed: false });

    // The owner's rows, R2 and DEK are gone; the member's survive untouched.
    for (const table of USER_TABLES) {
      expect([table, await count(table, `user_id = '${owner}'`)]).toEqual([table, 0]);
    }
    expect(await userR2Keys(owner)).toEqual([]);
    expect(await count("users", `id = 'u2'`)).toBe(1);
    expect(await count("conversations", `user_id = 'u2'`)).toBe(1);
    expect(await userR2Keys("u2")).toHaveLength(5);
    // Another user remains, so the deployment stays claimed — with the claim handed to the
    // survivor, promoted so the deployment keeps an owner.
    expect(await count("setup_state")).toBe(1);
    expect(
      await db.prepare("SELECT claimed_by_user_id AS by FROM setup_state").first<string>("by"),
    ).toBe("u2");
    expect(await db.prepare("SELECT role FROM users WHERE id = 'u2'").first<string>("role")).toBe(
      "owner",
    );
  });

  it("stamps a fresh step-up on the member's session the same way", async () => {
    await claim();
    await db
      .prepare("INSERT INTO users (id, display_name, role) VALUES ('u2', 'B', 'member')")
      .run();
    await seedUser("u2");
    const other = await sessionHeaders("u2");
    const member = new Browser();
    const [name = "", value = ""] = (other.cookie.split(";")[0] ?? "").split("=");
    member.cookies.set(name, value);
    await db
      .prepare("UPDATE sessions SET step_up_at = ? WHERE user_id = 'u2'")
      .bind(Date.now())
      .run();

    const res = await member.req("/api/account", { method: "DELETE", body: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, unclaimed: false });
    expect(await count("users", `id = 'u2'`)).toBe(0);
  });
});
