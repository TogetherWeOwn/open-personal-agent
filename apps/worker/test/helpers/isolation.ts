// SPDX-License-Identifier: Apache-2.0
// The data-isolation harness (M3-21a): two users, each with one of every item type, and a
// snapshot of everything one of them owns, for the state diff. A card that adds an item type
// seeds it here and adds its routes' cases to isolation.test.ts (M3-21 AC7).
import { env as workerEnv } from "cloudflare:workers";
import { createRepository, scopeFromSession } from "@opa/db/repository";
import { compose, type WorkerEnv } from "../../src/compose";
import type { Env } from "../../src/env";
import { workerApp as app } from "../../src/worker-app";
import { db, env, ORIGIN, sessionHeaders } from "./app";

/** The Worker's env with a working vault, so a model credential is really encrypted. */
const bindings: Promise<Env> = compose({
  ...env,
  OPA_MASTER_KEY: btoa("i".repeat(32)),
} as unknown as WorkerEnv);
const FILES = (workerEnv as unknown as { FILES: R2Bucket }).FILES;

export const BASE_URL = "https://api.openai.com/v1";

/** One user's seeded items. */
export interface Seeded {
  name: string;
  id: string;
  headers: Record<string, string>;
  /** The session `headers` signs in with. */
  session: string;
  /** Another live session of the user's, for the route that revokes one. */
  spareSession: string;
  conversation: string;
  message: string;
  memory: string;
  /** A second note, for the route that forgets one after another has edited the first. */
  spareMemory: string;
  /** A memory suggestion waiting for the user. */
  proposal: string;
  task: string;
  attachment: string;
  artifact: string;
  provider: string;
  secret: string;
  grant: string;
  usage: string;
  /** The plaintext of the user's model key, which no response may carry. */
  apiKey: string;
  /** Every ID and every piece of content above: none may reach another user. */
  markers: string[];
}

/** Sends `METHOD path` as `user` (no cookie for `null`): JSON for `body`, as is for `raw`. */
export async function as(
  user: Pick<Seeded, "headers"> | null,
  method: string,
  path: string,
  init: { body?: unknown; raw?: BodyInit; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { origin: ORIGIN, ...user?.headers, ...init.headers };
  let body: BodyInit | null = init.raw ?? null;
  if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers["content-type"] = "application/json";
  }
  return app.request(`${ORIGIN}${path}`, { method, headers, body }, await bindings);
}

/** Empties every table the harness writes; deleting the users cascades to their rows. */
export async function wipe() {
  const tables = "setup_state audit_log task_events task_steps webauthn_challenges users";
  await db.batch(tables.split(" ").map((t) => db.prepare(`DELETE FROM ${t}`)));
}

/**
 * Seeds `name` with a conversation and its messages, a memory, a paused task, an attachment and
 * an artifact in R2, a model provider with an encrypted key, a grant, a usage row and two sessions. The provider
 * and the attachment go through their routes, so the vault and R2 paths are the real ones.
 */
export async function seed(name: string, role: "owner" | "member"): Promise<Seeded> {
  const id = crypto.randomUUID();
  const tag = `${name}-${id.slice(0, 8)}`;
  await db
    .prepare("INSERT INTO users (id, display_name, role) VALUES (?, ?, ?)")
    .bind(id, `Isolation ${tag}`, role)
    .run();
  if (role === "owner") {
    await db
      .prepare("INSERT INTO setup_state (id, claimed_by_user_id) VALUES (1, ?)")
      .bind(id)
      .run();
  }
  const headers = await sessionHeaders(id);
  const session = (await db
    .prepare("SELECT id FROM sessions WHERE user_id = ?")
    .bind(id)
    .first<string>("id")) as string;
  // A second session, signed in elsewhere: the one revoking it tests, so `session` stays live.
  await sessionHeaders(id);
  const spareSession = (await db
    .prepare("SELECT id FROM sessions WHERE user_id = ? AND id != ?")
    .bind(id, session)
    .first<string>("id")) as string;
  const user = { headers };

  const apiKey = `sk-isolation-${tag}-0123456789abcdef`;
  const saved = await as(user, "POST", "/api/settings/providers", {
    body: { kind: "openai-chat", providerId: "openai", baseUrl: BASE_URL, model: "gpt-4o", apiKey },
  });
  if (saved.status !== 201) throw new Error(`provider: ${saved.status} ${await saved.text()}`);
  const provider = (await saved.json<{ id: string }>()).id;
  const secret = (await db
    .prepare("SELECT key_secret_id FROM model_providers WHERE id = ?")
    .bind(provider)
    .first<string>("key_secret_id")) as string;

  const fileText = `attachment of ${tag}`;
  const uploaded = await as(user, "POST", "/api/attachments", {
    raw: fileText,
    headers: { "x-file-name": `${tag}.txt`, "content-type": "text/plain" },
  });
  if (uploaded.status !== 201) throw new Error(`attachment: ${uploaded.status}`);
  const attachment = (await uploaded.json<{ id: string }>()).id;

  const [conversation, message, memory, spareMemory, proposal, task, grant, usage] = Array.from(
    { length: 8 },
    () => crypto.randomUUID(),
  ) as [string, string, string, string, string, string, string, string];
  const run = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values);
  await db.batch([
    run(
      "INSERT INTO conversations (id, user_id, title, model_provider, model) VALUES (?, ?, ?, ?, 'gpt-4o')",
      conversation,
      id,
      `conversation of ${tag}`,
      provider,
    ),
    run(
      "INSERT INTO messages (id, user_id, conversation_id, seq, role, content) VALUES (?, ?, ?, 1, 'user', ?)",
      message,
      id,
      conversation,
      `message of ${tag}`,
    ),
    run(
      "UPDATE attachments SET conversation_id = ?, message_id = ? WHERE id = ?",
      conversation,
      message,
      attachment,
    ),
    run(
      "INSERT INTO user_settings (user_id, about, chat_provider, chat_model) VALUES (?, ?, ?, 'gpt-4o')",
      id,
      `about ${tag}`,
      provider,
    ),
    run(
      `INSERT INTO memories (id, user_id, kind, text, trust, status, op, source, conversation_id)
       VALUES (?, ?, 'fact', ?, 'user', 'active', 'create', 'memory_screen', ?)`,
      memory,
      id,
      `memory of ${tag}`,
      conversation,
    ),
    run(
      `INSERT INTO memories (id, user_id, kind, text, trust, status, op, source)
       VALUES (?, ?, 'fact', ?, 'user', 'active', 'create', 'memory_screen')`,
      spareMemory,
      id,
      `spare memory of ${tag}`,
    ),
    run(
      `INSERT INTO memories (id, user_id, kind, text, trust, status, op, source, expires_at)
       VALUES (?, ?, 'fact', ?, 'inferred', 'proposed', 'create', 'chat', ?)`,
      proposal,
      id,
      `proposal of ${tag}`,
      Date.now() + 86_400_000,
    ),
    run(
      `INSERT INTO tasks (id, user_id, conversation_id, workflow_instance_id, kind, mode, status, title, state)
       VALUES (?, ?, ?, ?, 'chat', 'background', 'budget_limited', ?, '{"paused":{"kind":"daily"}}')`,
      task,
      id,
      conversation,
      `wf-${task}`,
      `task of ${tag}`,
    ),
    run(
      "INSERT INTO grants (id, user_id, tool, scope, expires_at) VALUES (?, ?, 'web_fetch', 'hour', ?)",
      grant,
      id,
      Date.now() + 3_600_000,
    ),
    run(
      "INSERT INTO tool_overrides (user_id, tool, decision) VALUES (?, 'isolation_probe', 'ask')",
      id,
    ),
    run(
      "INSERT INTO usage (id, user_id, conversation_id, message_id, provider_id, model, input_tokens) VALUES (?, ?, ?, ?, 'openai', 'gpt-4o', 7)",
      usage,
      id,
      conversation,
      message,
    ),
    // The task's run journal, keyed by its Workflow instance rather than by user.
    run(
      "INSERT INTO task_events (instance_id, type, payload) VALUES (?, 'isolation', ?)",
      `wf-${task}`,
      JSON.stringify({ tag }),
    ),
    run(
      "INSERT INTO task_steps (instance_id, name, output) VALUES (?, 'isolation', ?)",
      `wf-${task}`,
      JSON.stringify({ tag }),
    ),
  ]);
  const artifact = crypto.randomUUID();
  await createRepository(env)
    .forUser(scopeFromSession({ userId: id }))
    .artifacts.save({
      id: artifact,
      name: `${tag}.md`,
      mediaType: "text/markdown",
      content: `artifact of ${tag}`,
      source: { conversationId: conversation, taskId: task },
    });

  const items = { session, conversation, message, memory, task, attachment, provider, secret };
  const ids = { ...items, spareSession, spareMemory, proposal, artifact, grant, usage };
  const markers = [id, ...Object.values(ids), apiKey, tag];
  return { ...user, name, id, ...ids, apiKey, markers };
}

/** The deployment: A claimed it and is the owner, B is a second user. */
export async function seedBoth() {
  await wipe();
  const a = await seed("A", "owner");
  const b = await seed("B", "member");
  return { a, b };
}

/**
 * Every table that holds one user's data: by `user_id`, or by `instance_id` for a task's run
 * journal, which belongs to whoever owns the task with that Workflow instance.
 */
async function userTables() {
  const { results } = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all<{ name: string }>();
  const byUser: string[] = [];
  const byInstance: string[] = [];
  for (const { name } of results) {
    if (name.startsWith("_cf_") || name.startsWith("sqlite_")) continue;
    const columns = await db.prepare(`PRAGMA table_info("${name}")`).all<{ name: string }>();
    const has = (column: string) => columns.results.some((c) => c.name === column);
    if (has("user_id")) byUser.push(name);
    else if (has("instance_id")) byInstance.push(name);
  }
  return { byUser, byInstance };
}

/**
 * Everything `user` owns: their `users` row, every row with their `user_id`, their tasks' run
 * journals and their R2 objects.
 * Two equal snapshots mean a request changed nothing of theirs. Without `audit`, it leaves out
 * the audit log, whose denied rows rightly name the ID a user tried.
 */
export async function snapshot(user: Seeded, { audit = true } = {}) {
  const rows: Record<string, unknown[]> = {};
  rows.users = (await db.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).all()).results;
  const { byUser, byInstance } = await userTables();
  for (const table of byUser) {
    if (!audit && table === "audit_log") continue;
    const sql = `SELECT * FROM "${table}" WHERE user_id = ? ORDER BY rowid`;
    rows[table] = (await db.prepare(sql).bind(user.id).all()).results;
  }
  const instances = "SELECT workflow_instance_id FROM tasks WHERE user_id = ?";
  for (const table of byInstance) {
    const sql = `SELECT * FROM "${table}" WHERE instance_id IN (${instances}) ORDER BY rowid`;
    rows[table] = (await db.prepare(sql).bind(user.id).all()).results;
  }
  const listed = await FILES.list({ prefix: `u/${user.id}/` });
  const objects = listed.objects.map((o) => `${o.key} ${o.etag} ${o.size}`);
  return JSON.stringify({ rows, objects });
}

/** The markers of `user` that `text` carries. */
export const leaked = (user: Seeded, text: string) => user.markers.filter((m) => text.includes(m));
