// SPDX-License-Identifier: Apache-2.0
// Onboarding answers and model settings (M2-15, M3-06). Keys arrive in a request body, go straight
// into the vault, and never come back: responses carry the last 4 characters only (ADR 0010 D4).
import type { ModelUsage } from "@opa/core";
import { createRepository } from "@opa/db/repository";
import { findPrice, isStale } from "@opa/pricing";
import { credentialBinding, isLoopbackHost, STARTER_MODEL } from "@opa/providers";
import { encrypt, type UserScope as VaultScope } from "@opa/vault";
import { type Context, Hono } from "hono";
import {
  billerOf,
  type ModelPick,
  MODEL_KEY_PURPOSE as PURPOSE,
  pickModel,
  privateHttp,
  resolveChatModel,
} from "./chat-model";
import type { AppEnv } from "./env";

const CALLER = "model-settings";
const TEST_TIMEOUT_MS = 20_000;
const TEST_PROMPT = [{ role: "user" as const, content: "Reply with one word: ready" }];

type Ctx = Context<AppEnv>;
type User = ReturnType<typeof userOf>;
type Provider = NonNullable<Awaited<ReturnType<User["providers"]["get"]>>>;

const userOf = (c: Ctx) => createRepository(c.env).forUser(c.var.session.scope);
// The vault takes the session's scope too; its own brand keeps it from importing `@opa/db`.
const vaultScope = (c: Ctx) => c.var.session.scope as unknown as VaultScope;

const text = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim() !== "" && value.length <= max ? value.trim() : null;

/** The dated price hint (COST-7), from the table; null when it has no price for the model. */
function priceHint(billingId: string, model: string | null) {
  const price = model ? findPrice(billingId, model) : undefined;
  if (!price) return null;
  const { inputUsdPerMTok, outputUsdPerMTok, verifiedAt } = price;
  return { inputUsdPerMTok, outputUsdPerMTok, verifiedAt, stale: isStale(verifiedAt) };
}

/** A saved provider as the browser sees it: the key's last 4 and dates, never the key (SEC-7). */
function providerView(row: Provider) {
  // `last4` is null for keys shorter than 8 characters; the join still finds the row.
  const keyed = row.keyCreatedAt !== null && row.kind !== "workers-ai";
  return {
    id: row.id,
    kind: row.kind,
    providerId: row.providerId,
    baseUrl: row.baseUrl,
    model: row.model,
    createdAt: row.createdAt,
    key: keyed
      ? {
          last4: row.keyLast4,
          createdAt: row.keyCreatedAt,
          updatedAt: row.keyUpdatedAt,
          lastUsedAt: row.keyLastUsedAt,
        }
      : null,
    price: priceHint(billerOf(row), row.model),
  };
}

const rolePick = (picked: Awaited<ReturnType<typeof pickModel>>) =>
  picked && { provider: picked.row.id, model: picked.model };

async function view(c: Ctx) {
  const user = userOf(c);
  const row = await user.settings.get();
  if (!row) return null;
  const providers = await user.providers.list();
  const chat = providers.find((p) => p.id === row.chatProvider);
  const starter = chat?.kind === "workers-ai";
  const scope = c.var.session.scope;
  const background = rolePick(await pickModel(c.env, scope, { role: "background" }));
  return {
    displayName: row.displayName,
    about: row.about ?? "",
    onboarded: row.onboardedAt !== null,
    // The Chat role's model, in the shape onboarding has always read.
    model: chat
      ? {
          kind: chat.kind,
          providerId: starter ? null : chat.providerId,
          baseUrl: starter ? null : chat.baseUrl,
          model: row.chatModel ?? chat.model,
          key: providerView(chat).key,
        }
      : null,
    providers: providers.map(providerView),
    roles: {
      chat: rolePick(await pickModel(c.env, scope, { role: "chat" })),
      // A null Background is the cheapest saved model; `default` says it wasn't chosen.
      background: background && { ...background, default: row.backgroundProvider === null },
      embedding: null, // reserved: no embedding model in M3
    },
  };
}

/** Whether `text` contains any 8-character run of `key`. */
function leaks(text: string, key: string) {
  for (let i = 0; i + 8 <= key.length; i++) if (text.includes(key.slice(i, i + 8))) return true;
  return false;
}

/** A base URL's path without trailing slashes; `/v1` and `/v1/` are one endpoint. */
const path = (url: string) => new URL(url).pathname.replace(/\/+$/, "");

type Failure = 400 | 404 | 409 | 503;
const fail = (c: Ctx, status: Failure, error: string) => c.json({ error }, status);

/**
 * Checks an OpenAI-compatible provider body and stores its key, if it has one. Without a key it
 * keeps `current`'s, but only for the same provider, origin and path.
 */
async function keyedValues(c: Ctx, body: Record<string, unknown> | null, current?: Provider) {
  const providerId = text(body?.providerId, 63);
  const baseUrl = text(body?.baseUrl, 500);
  const model = text(body?.model, 200);
  const apiKey = body?.apiKey === undefined ? null : text(body.apiKey, 4096);
  if (!providerId || !baseUrl || !model || (body?.apiKey !== undefined && !apiKey)) {
    return [400, "invalid_model"] as const;
  }
  let binding: string;
  try {
    // A key never crosses the internet over plain HTTP: HTTP is for a server on this machine
    // (`pnpm dev`'s mock, Ollama), or on Node with private hosts allowed, whose fetch refuses
    // plain HTTP to a public address. The adapter refuses a query or fragment, so a URL with one
    // could be saved but never tested.
    const url = new URL(baseUrl);
    // Node's guarded fetch refuses loopback unless private hosts are allowed.
    const local = isLoopbackHost(url.hostname) && !c.env.MODEL_FETCH;
    const plain = url.protocol === "http:" && (local || privateHttp(c.env));
    if ((url.protocol !== "https:" && !plain) || url.search || url.hash) {
      throw new Error("invalid URL");
    }
    binding = credentialBinding(providerId, baseUrl);
  } catch {
    return [400, "invalid_base_url"] as const;
  }
  let secretId = current?.keySecretId ?? null;
  if (apiKey) {
    if (!c.env.VAULT) return [503, "vault_unavailable"] as const;
    secretId ??= crypto.randomUUID();
    const input = { secretId, purpose: PURPOSE, binding, plaintext: apiKey, caller: CALLER };
    await encrypt(c.env.VAULT, vaultScope(c), input);
  } else {
    // A key is bound to its provider and origin: a change means entering it again (ADR 0006 #5).
    // So does a new path, as one host can serve many accounts (an AI Gateway, for one).
    const { providerId: savedProvider, baseUrl: savedUrl } = current ?? {};
    if (!secretId || !savedProvider || !savedUrl) return [400, "key_required"] as const;
    if (
      credentialBinding(savedProvider, savedUrl) !== binding ||
      path(savedUrl) !== path(baseUrl)
    ) {
      return [400, "key_required"] as const;
    }
  }
  return { kind: "openai-chat" as const, providerId, baseUrl, model, keySecretId: secretId };
}

/** The user's starter row, made on first use; there is one, as it has no key. */
async function starterRow(user: User) {
  const saved = (await user.providers.list()).find((p) => p.kind === "workers-ai");
  return saved?.id ?? (await user.providers.add({ kind: "workers-ai", model: STARTER_MODEL }));
}

/** A role or conversation choice from the body, checked against the user's own providers. */
export async function choice(user: User, value: unknown) {
  const pick = value as { provider?: unknown; model?: unknown } | null;
  const id = typeof pick?.provider === "string" ? pick.provider : "";
  const row = await user.providers.get(id);
  const model = pick?.model === undefined ? row?.model : text(pick.model, 200);
  return row && model ? { provider: row.id, model } : null;
}

export const settings = new Hono<AppEnv>();

// The session guard (M2-10) has already resolved `c.var.session` for every route here.
settings.use(async (c, next) => {
  c.header("Cache-Control", "no-store");
  return next();
});

settings.get("/", async (c) => {
  const body = await view(c);
  return body ? c.json(body) : fail(c, 404, "not_found");
});

settings.put("/profile", async (c) => {
  const body = await c.req.json().catch(() => null);
  const displayName = text(body?.displayName, 80);
  const about = typeof body?.about === "string" && body.about.length <= 2000 ? body.about : null;
  if (!displayName || about === null) return fail(c, 400, "invalid_profile");
  const { settings: store } = userOf(c);
  await store.rename(displayName);
  await store.save({ about: about.trim() });
  return c.body(null, 204);
});

/** Onboarding's one model: saves it and makes it the Chat role. */
settings.put("/model", async (c) => {
  const body = await c.req.json().catch(() => null);
  const user = userOf(c);
  if (body?.kind === "workers-ai") {
    // Any saved key stays in its own row, for switching back.
    await user.settings.save({ chatProvider: await starterRow(user), chatModel: STARTER_MODEL });
    return c.json(await view(c));
  }
  if (body?.kind !== "openai-chat") return fail(c, 400, "invalid_model");
  const settings = await user.settings.get();
  if (!settings) return fail(c, 404, "not_found");
  // This route edits one key, as onboarding always has: the Chat role's, else the newest saved.
  const keyed = (await user.providers.list()).filter((p) => p.kind === "openai-chat");
  const current = keyed.find((p) => p.id === settings.chatProvider) ?? keyed.at(-1);
  const values = await keyedValues(c, body, current);
  if (Array.isArray(values)) return fail(c, ...values);
  let id = current?.id;
  if (id) await user.providers.update(id, values);
  else id = await user.providers.add(values);
  await user.settings.save({ chatProvider: id, chatModel: values.model });
  return c.json(await view(c));
});

settings.post("/providers", async (c) => {
  const body = await c.req.json().catch(() => null);
  const user = userOf(c);
  if (body?.kind === "workers-ai") {
    const row = await user.providers.get(await starterRow(user));
    return c.json(providerView(row as Provider), 201);
  }
  if (body?.kind !== "openai-chat") return fail(c, 400, "invalid_model");
  if (body.apiKey === undefined) return fail(c, 400, "key_required");
  const values = await keyedValues(c, body);
  if (Array.isArray(values)) return fail(c, ...values);
  const row = await user.providers.get(await user.providers.add(values));
  return c.json(providerView(row as Provider), 201);
});

settings.put("/providers/:id", async (c) => {
  const user = userOf(c);
  const current = await user.providers.get(c.req.param("id"));
  if (!current) return fail(c, 404, "not_found");
  const body = await c.req.json().catch(() => null);
  if (current.kind === "workers-ai") {
    // The starter has one model and nothing else to change.
    return fail(c, 400, "invalid_model");
  }
  const values = await keyedValues(c, body, current);
  if (Array.isArray(values)) return fail(c, ...values);
  await user.providers.update(current.id, values);
  return c.json(providerView((await user.providers.get(current.id)) as Provider));
});

settings.delete("/providers/:id", async (c) => {
  const user = userOf(c);
  const id = c.req.param("id");
  // Chat always has a model: the user picks another for it first.
  if ((await user.settings.get())?.chatProvider === id) return fail(c, 409, "chat_role");
  return (await user.providers.remove(id)) ? c.body(null, 204) : fail(c, 404, "not_found");
});

/** Sets the Chat and Background roles; a null Background goes back to the cheapest. */
settings.put("/roles", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return fail(c, 400, "invalid_role");
  const user = userOf(c);
  if (!(await user.settings.get())) return fail(c, 404, "not_found");
  const update: Parameters<User["settings"]["save"]>[0] = {};
  if ("chat" in body) {
    const chat = await choice(user, body.chat);
    if (!chat) return fail(c, 400, "invalid_role");
    Object.assign(update, { chatProvider: chat.provider, chatModel: chat.model });
  }
  if ("background" in body) {
    const background = body.background === null ? null : await choice(user, body.background);
    if (body.background !== null && !background) return fail(c, 400, "invalid_role");
    update.backgroundProvider = background?.provider ?? null;
    update.backgroundModel = background?.model ?? null;
  }
  await user.settings.save(update);
  return c.json(await view(c));
});

/** Sends one short prompt with the picked model; reports latency, tools and the price hint. */
async function test(c: Ctx, pick: ModelPick) {
  const resolved = await resolveChatModel(c.env, c.var.session.scope, CALLER, pick);
  if ("error" in resolved) {
    const { error } = resolved;
    return fail(c, error === "ai_unavailable" || error === "vault_unavailable" ? 503 : 409, error);
  }
  const { provider, model, apiKey } = resolved;
  await resolved.used?.();
  const started = Date.now();
  let firstTokenMs: number | null = null;
  let reply = "";
  let usage: ModelUsage | null = null;
  const signal = AbortSignal.timeout(TEST_TIMEOUT_MS);
  const consume = async () => {
    const request = { model, messages: TEST_PROMPT, maxOutputTokens: 16 };
    for await (const event of provider.stream({ ...request, signal })) {
      if (event.type === "text.delta") {
        firstTokenMs ??= Date.now() - started;
        reply += event.text;
      } else if (event.type === "usage") {
        usage = event.usage;
      } else if (event.type === "error") {
        return { code: event.code, message: event.message };
      }
    }
    return null;
  };
  // Some providers never settle once they stall, so the deadline doesn't wait for the stream.
  const timedOut = new Promise<{ code: string; message: string }>((resolve) =>
    signal.addEventListener("abort", () =>
      resolve({ code: "timeout", message: "The model didn't answer in 20 seconds." }),
    ),
  );
  const failure = await Promise.race([consume(), timedOut]);
  // A test that ran is a real, billed call, so it goes in the ledger like a chat turn, unpriced
  // when the provider reported no usage. One rejected before any output (a bad key) ran no model.
  const billingId = resolved.billingId ?? provider.id;
  const call = { providerId: billingId, model, usage };
  if (usage || !failure || firstTokenMs !== null) await userOf(c).usage.record(call);
  if (failure) {
    // The provider writes this text. If it echoes any 8 characters of the key, drop it: a saved
    // key never returns to the browser, even in part beyond its last 4 (ADR 0010 D4).
    const echoed = apiKey !== null && leaks(failure.message, apiKey);
    const message = echoed
      ? "The provider rejected the request. Check the key and model."
      : failure.message;
    return c.json({ ok: false, error: { code: failure.code, message } });
  }
  return c.json({
    ok: true,
    latencyMs: firstTokenMs ?? Date.now() - started,
    totalMs: Date.now() - started,
    tools: provider.capabilities(model).tools,
    price: priceHint(billingId, model),
    reply: reply.slice(0, 200),
  });
}

settings.post("/model/test", (c) => test(c, { role: "chat" }));

/** Tests one saved provider, with its own model or the one in the body. */
settings.post("/providers/:id/test", async (c) => {
  const row = await userOf(c).providers.get(c.req.param("id"));
  if (!row) return fail(c, 404, "not_found");
  const body = await c.req.json().catch(() => null);
  const model = body?.model === undefined ? undefined : text(body.model, 200);
  if (model === null) return fail(c, 400, "invalid_model");
  return test(c, { provider: row.id, ...(model ? { model } : {}) });
});

settings.post("/onboarded", async (c) => {
  const store = userOf(c).settings;
  if (!(await store.get())?.chatProvider) return fail(c, 409, "no_model");
  await store.save({ onboardedAt: Date.now() });
  return c.body(null, 204);
});
