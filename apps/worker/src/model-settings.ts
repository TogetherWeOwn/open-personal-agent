// SPDX-License-Identifier: Apache-2.0
// Onboarding answers and model settings (M2-15). Keys arrive in a POST body, go straight into the
// vault, and never come back: responses carry the last 4 characters only (ADR 0010 D4).
import type { ModelProvider } from "@opa/core";
import { createRepository } from "@opa/db/repository";
import {
  createOpenAIChatProvider,
  createWorkersAIProvider,
  credentialBinding,
  isLoopbackHost,
  type WorkersAIBinding,
} from "@opa/providers";
import { decrypt, encrypt, type UserScope as VaultScope } from "@opa/vault";
import { type Context, Hono } from "hono";
import type { AppEnv } from "./env";

/** The "Try without a key" starter: metered Workers AI through the `AI` binding. */
export const STARTER_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const CALLER = "model-settings";
const PURPOSE = "model_api_key" as const;
const TEST_TIMEOUT_MS = 20_000;
const TEST_PROMPT = [{ role: "user" as const, content: "Reply with one word: ready" }];

type Settings = NonNullable<Awaited<ReturnType<ReturnType<typeof settingsOf>["get"]>>>;

const settingsOf = (c: Ctx) => createRepository(c.env).forUser(c.var.session.scope).settings;
// The vault takes the session's scope too; its own brand keeps it from importing `@opa/db`.
const vaultScope = (c: Ctx) => c.var.session.scope as unknown as VaultScope;

const text = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim() !== "" && value.length <= max ? value.trim() : null;

function view(row: Settings) {
  // `last4` is null for keys shorter than 8 characters; the join still finds the row. The starter
  // keeps the key's binding for switching back, but reports none: it uses the AI binding only.
  const starter = row.modelKind === "workers-ai";
  const key = row.keyUpdatedAt !== null && !starter;
  return {
    displayName: row.displayName,
    about: row.about ?? "",
    onboarded: row.onboardedAt !== null,
    model: row.modelKind && {
      kind: row.modelKind,
      providerId: starter ? null : row.providerId,
      baseUrl: starter ? null : row.baseUrl,
      model: row.model,
      key: key
        ? { last4: row.keyLast4, updatedAt: row.keyUpdatedAt, lastUsedAt: row.keyLastUsedAt }
        : null,
    },
  };
}

/** Whether `text` contains any 8-character run of `key`. */
function leaks(text: string, key: string) {
  for (let i = 0; i + 8 <= key.length; i++) if (text.includes(key.slice(i, i + 8))) return true;
  return false;
}

type Ctx = Context<AppEnv>;
// Only with the guarded fetch that enforces it; the flag alone never widens plain HTTP.
const privateHttp = (c: Ctx) => c.env.MODEL_PRIVATE_HOSTS === true && !!c.env.MODEL_FETCH;
const fail = (c: Ctx, status: 400 | 404 | 409 | 503, error: string) => c.json({ error }, status);

export const settings = new Hono<AppEnv>();

// The session guard (M2-10) has already resolved `c.var.session` for every route here.
settings.use(async (c, next) => {
  c.header("Cache-Control", "no-store");
  return next();
});

settings.get("/", async (c) => {
  const row = await settingsOf(c).get();
  return row ? c.json(view(row)) : fail(c, 404, "not_found");
});

settings.put("/profile", async (c) => {
  const body = await c.req.json().catch(() => null);
  const displayName = text(body?.displayName, 80);
  const about = typeof body?.about === "string" && body.about.length <= 2000 ? body.about : null;
  if (!displayName || about === null) return fail(c, 400, "invalid_profile");
  await settingsOf(c).rename(displayName);
  await settingsOf(c).save({ about: about.trim() });
  return c.body(null, 204);
});

settings.put("/model", async (c) => {
  const body = await c.req.json().catch(() => null);
  const store = settingsOf(c);
  if (body?.kind === "workers-ai") {
    // The provider and base URL stay: they bind the saved key, which is kept for switching back.
    await store.save({ modelKind: "workers-ai", model: STARTER_MODEL });
    return c.json(view((await store.get()) as Settings));
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
    // A key never crosses the internet over plain HTTP: HTTP is for a server on this machine
    // (`pnpm dev`'s mock, Ollama), or on Node with private hosts allowed, whose fetch refuses
    // plain HTTP to a public address. The adapter refuses a query or fragment, so a URL with one
    // could be saved but never tested.
    const url = new URL(baseUrl);
    // Node's guarded fetch refuses loopback unless private hosts are allowed.
    const local = isLoopbackHost(url.hostname) && !c.env.MODEL_FETCH;
    const plain = url.protocol === "http:" && (local || privateHttp(c));
    if ((url.protocol !== "https:" && !plain) || url.search || url.hash) {
      throw new Error("invalid URL");
    }
    binding = credentialBinding(providerId, baseUrl);
  } catch {
    return fail(c, 400, "invalid_base_url");
  }
  const current = await store.get();
  if (!current) return fail(c, 404, "not_found");
  let secretId = current.keySecretId;
  if (apiKey) {
    if (!c.env.VAULT) return fail(c, 503, "vault_unavailable");
    secretId ??= crypto.randomUUID();
    const input = { secretId, purpose: PURPOSE, binding, plaintext: apiKey, caller: CALLER };
    await encrypt(c.env.VAULT, vaultScope(c), input);
  } else {
    // A key is bound to its provider and origin: a change means entering it again (ADR 0006 #5).
    const { providerId: savedProvider, baseUrl: savedUrl } = current;
    if (!secretId || !savedProvider || !savedUrl) return fail(c, 400, "key_required");
    if (credentialBinding(savedProvider, savedUrl) !== binding) {
      return fail(c, 400, "key_required");
    }
  }
  await store.save({
    modelKind: "openai-chat",
    providerId,
    baseUrl,
    model,
    modelKeySecretId: secretId,
  });
  return c.json(view((await store.get()) as Settings));
});

/** Sends one short prompt with the saved settings; reports latency and tool support. */
settings.post("/model/test", async (c) => {
  const store = settingsOf(c);
  const row = await store.get();
  if (!row?.modelKind || !row.model) return fail(c, 409, "no_model");
  let provider: ModelProvider;
  let apiKey: string | null = null;
  if (row.modelKind === "workers-ai") {
    if (!c.env.AI) return fail(c, 503, "ai_unavailable");
    provider = createWorkersAIProvider(c.env.AI as unknown as WorkersAIBinding);
  } else {
    if (!c.env.VAULT) return fail(c, 503, "vault_unavailable");
    const { providerId, baseUrl, keySecretId: secretId } = row;
    if (!providerId || !baseUrl || !secretId) return fail(c, 409, "no_model");
    const binding = credentialBinding(providerId, baseUrl);
    const ref = { secretId, purpose: PURPOSE, binding, caller: CALLER } as const;
    // A lost master key makes saved keys unreadable; the user enters theirs again.
    apiKey = await decrypt(c.env.VAULT, vaultScope(c), ref).catch(() => null);
    if (apiKey === null) return fail(c, 409, "key_required");
    // The base URL is the user's, so on Node this goes through the SSRF-guarded fetch (ADR 0010 D8).
    const fetch = c.env.MODEL_FETCH ? { fetch: c.env.MODEL_FETCH } : {};
    const options = { providerId, baseUrl, apiKey, privateHttp: privateHttp(c), ...fetch };
    try {
      provider = createOpenAIChatProvider(options);
    } catch {
      // Saved as plain HTTP while private hosts were allowed, and they no longer are.
      return fail(c, 409, "invalid_base_url");
    }
    await store.keyUsed(secretId);
  }
  const started = Date.now();
  let firstTokenMs: number | null = null;
  let reply = "";
  const signal = AbortSignal.timeout(TEST_TIMEOUT_MS);
  const consume = async () => {
    const request = { model: row.model as string, messages: TEST_PROMPT, maxOutputTokens: 16 };
    for await (const event of provider.stream({ ...request, signal })) {
      if (event.type === "text.delta") {
        firstTokenMs ??= Date.now() - started;
        reply += event.text;
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
    tools: provider.capabilities(row.model).tools,
    reply: reply.slice(0, 200),
  });
});

settings.post("/onboarded", async (c) => {
  const store = settingsOf(c);
  if (!(await store.get())?.modelKind) return fail(c, 409, "no_model");
  await store.save({ onboardedAt: Date.now() });
  return c.body(null, 204);
});
