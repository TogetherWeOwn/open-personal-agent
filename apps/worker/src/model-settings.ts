// SPDX-License-Identifier: Apache-2.0
// Onboarding answers and model settings (M2-15). Keys arrive in a POST body, go straight into the
// vault, and never come back: responses carry the last 4 characters only (ADR 0010 D4).
import type { ModelProvider } from "@opa/core";
import {
  createOpenAIChatProvider,
  createWorkersAIProvider,
  credentialBinding,
  type WorkersAIBinding,
} from "@opa/providers";
import { decrypt, encrypt, type UserScope } from "@opa/vault";
import { type Context, Hono } from "hono";
import type { AppEnv, Session } from "./env";

/** The "Try without a key" starter: metered Workers AI through the `AI` binding. */
export const STARTER_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const CALLER = "model-settings";
const PURPOSE = "model_api_key" as const;
const TEST_TIMEOUT_MS = 20_000;

interface SettingsRow {
  display_name: string;
  about: string | null;
  model_kind: "openai-chat" | "workers-ai" | null;
  provider_id: string | null;
  base_url: string | null;
  model: string | null;
  model_key_secret_id: string | null;
  onboarded_at: number | null;
  last4: string | null;
  key_updated_at: number | null;
  key_last_used_at: number | null;
}

// Moves into the scoped repository layer with M2-11, which also mints the scope.
const scopeOf = (session: Session) => ({ userId: session.userId }) as UserScope;

const load = (db: D1Database, userId: string) =>
  db
    .prepare(
      `SELECT u.display_name, s.about, s.model_kind, s.provider_id, s.base_url, s.model,
         s.model_key_secret_id, s.onboarded_at, k.last4, k.updated_at AS key_updated_at,
         k.last_used_at AS key_last_used_at
       FROM users u
       LEFT JOIN user_settings s ON s.user_id = u.id
       LEFT JOIN secrets k ON k.id = s.model_key_secret_id AND k.user_id = u.id
       WHERE u.id = ?`,
    )
    .bind(userId)
    .first<SettingsRow>();

/** Upserts the named `user_settings` columns; the names come from this file, never the client. */
function save(db: D1Database, userId: string, values: Record<string, string | number | null>) {
  const cols = Object.keys(values);
  const updates = cols.map((col) => `${col} = excluded.${col}`).join(", ");
  return db
    .prepare(
      `INSERT INTO user_settings (user_id, ${cols.join(", ")}) VALUES (?${", ?".repeat(cols.length)})
       ON CONFLICT (user_id) DO UPDATE SET ${updates}, updated_at = (unixepoch('subsec') * 1000)`,
    )
    .bind(userId, ...Object.values(values))
    .run();
}

const text = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim() !== "" && value.length <= max ? value.trim() : null;

function view(row: SettingsRow) {
  // `last4` is null for keys shorter than 8 characters; the join still finds the row.
  const key = row.key_updated_at !== null;
  return {
    displayName: row.display_name,
    about: row.about ?? "",
    onboarded: row.onboarded_at !== null,
    model: row.model_kind && {
      kind: row.model_kind,
      providerId: row.provider_id,
      baseUrl: row.base_url,
      model: row.model,
      key: key
        ? { last4: row.last4, updatedAt: row.key_updated_at, lastUsedAt: row.key_last_used_at }
        : null,
    },
  };
}

type Ctx = Context<AppEnv>;
const fail = (c: Ctx, status: 400 | 404 | 409 | 503, error: string) => c.json({ error }, status);

export const settings = new Hono<AppEnv>();

// The session guard (M2-10) has already resolved `c.var.session` for every route here.
settings.use(async (c, next) => {
  c.header("Cache-Control", "no-store");
  return next();
});

settings.get("/", async (c) => {
  const row = await load(c.env.DB, c.var.session.userId);
  return row ? c.json(view(row)) : fail(c, 404, "not_found");
});

settings.put("/profile", async (c) => {
  const body = await c.req.json().catch(() => null);
  const displayName = text(body?.displayName, 80);
  const about = typeof body?.about === "string" && body.about.length <= 2000 ? body.about : null;
  if (!displayName || about === null) return fail(c, 400, "invalid_profile");
  const { userId } = c.var.session;
  await c.env.DB.prepare(
    "UPDATE users SET display_name = ?, updated_at = (unixepoch('subsec') * 1000) WHERE id = ?",
  )
    .bind(displayName, userId)
    .run();
  await save(c.env.DB, userId, { about: about.trim() });
  return c.body(null, 204);
});

settings.put("/model", async (c) => {
  const body = await c.req.json().catch(() => null);
  const { userId } = c.var.session;
  if (body?.kind === "workers-ai") {
    await save(c.env.DB, userId, {
      model_kind: "workers-ai",
      provider_id: null,
      base_url: null,
      model: STARTER_MODEL,
    });
    return c.json(view((await load(c.env.DB, userId)) as SettingsRow));
  }
  if (body?.kind !== "openai-chat") return fail(c, 400, "invalid_model");
  const providerId = text(body.providerId, 63);
  const baseUrl = text(body.baseUrl, 500);
  const model = text(body.model, 200);
  const apiKey = body.apiKey === undefined ? null : text(body.apiKey, 4096);
  if (!providerId || !baseUrl || !model || (body.apiKey !== undefined && !apiKey)) {
    return fail(c, 400, "invalid_model");
  }
  let binding: string;
  try {
    // The Worker reaches public hosts only, so a key never travels over plain HTTP.
    if (new URL(baseUrl).protocol !== "https:") throw new Error("https only");
    binding = credentialBinding(providerId, baseUrl);
  } catch {
    return fail(c, 400, "invalid_base_url");
  }
  const current = await load(c.env.DB, userId);
  if (!current) return fail(c, 404, "not_found");
  let secretId = current.model_key_secret_id;
  if (apiKey) {
    if (!c.env.VAULT) return fail(c, 503, "vault_unavailable");
    secretId ??= crypto.randomUUID();
    const input = { secretId, purpose: PURPOSE, binding, plaintext: apiKey, caller: CALLER };
    await encrypt(c.env.VAULT, scopeOf(c.var.session), input);
  } else {
    // A key is bound to its provider and origin: a change means entering it again (ADR 0006 #5).
    const { provider_id: savedProvider, base_url: savedUrl } = current;
    if (!secretId || !savedProvider || !savedUrl) return fail(c, 400, "key_required");
    if (credentialBinding(savedProvider, savedUrl) !== binding) {
      return fail(c, 400, "key_required");
    }
  }
  await save(c.env.DB, userId, {
    model_kind: "openai-chat",
    provider_id: providerId,
    base_url: baseUrl,
    model,
    model_key_secret_id: secretId,
  });
  return c.json(view((await load(c.env.DB, userId)) as SettingsRow));
});

/** Sends one short prompt with the saved settings; reports latency and tool support. */
settings.post("/model/test", async (c) => {
  const { userId } = c.var.session;
  const row = await load(c.env.DB, userId);
  if (!row?.model_kind || !row.model) return fail(c, 409, "no_model");
  let provider: ModelProvider;
  if (row.model_kind === "workers-ai") {
    if (!c.env.AI) return fail(c, 503, "ai_unavailable");
    provider = createWorkersAIProvider(c.env.AI as unknown as WorkersAIBinding);
  } else {
    if (!c.env.VAULT) return fail(c, 503, "vault_unavailable");
    const { provider_id: providerId, base_url: baseUrl, model_key_secret_id: secretId } = row;
    if (!providerId || !baseUrl || !secretId) return fail(c, 409, "no_model");
    const binding = credentialBinding(providerId, baseUrl);
    const ref = { secretId, purpose: PURPOSE, binding, caller: CALLER } as const;
    // A lost master key makes saved keys unreadable; the user enters theirs again.
    const apiKey = await decrypt(c.env.VAULT, scopeOf(c.var.session), ref).catch(() => null);
    if (apiKey === null) return fail(c, 409, "key_required");
    provider = createOpenAIChatProvider({ providerId, baseUrl, apiKey });
    await c.env.DB.prepare(
      "UPDATE secrets SET last_used_at = (unixepoch('subsec') * 1000) WHERE id = ? AND user_id = ?",
    )
      .bind(secretId, userId)
      .run();
  }
  const started = Date.now();
  let firstTokenMs: number | null = null;
  let reply = "";
  const events = provider.stream({
    model: row.model,
    messages: [{ role: "user", content: "Reply with one word: ready" }],
    maxOutputTokens: 16,
    signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
  });
  for await (const event of events) {
    if (event.type === "text.delta") {
      firstTokenMs ??= Date.now() - started;
      reply += event.text;
    } else if (event.type === "error") {
      return c.json({ ok: false, error: { code: event.code, message: event.message } });
    }
  }
  return c.json({
    ok: true,
    latencyMs: firstTokenMs ?? Date.now() - started,
    totalMs: Date.now() - started,
    tools: provider.capabilities(row.model).tools,
    reply: reply.slice(0, 200),
  });
});

settings.post("/onboarded", async (c) => {
  const row = await load(c.env.DB, c.var.session.userId);
  if (!row?.model_kind) return fail(c, 409, "no_model");
  await save(c.env.DB, c.var.session.userId, { onboarded_at: Date.now() });
  return c.body(null, 204);
});
