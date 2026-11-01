// SPDX-License-Identifier: Apache-2.0
// Model settings v2 storage (M3-06a): migration 0005 turns each saved model into a provider row,
// and roles and conversations resolve only to the user's own rows.
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { createRepository, scopeFromSession } from "@opa/db/repository";
import { STARTER_MODEL } from "@opa/providers";
import { beforeAll, describe, expect, it } from "vitest";
import { pickModel, resolveChatModel } from "../src/chat-model";
import type { Env } from "../src/env";

const env = workerEnv as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
const repo = createRepository(env);
const scope = (userId: string) => scopeFromSession({ userId });
const OPENAI = "https://api.openai.com/v1";

const rows = async (sql: string) => (await env.DB.prepare(sql).all()).results;

beforeAll(async () => {
  // Up to 0004, then rows as M2 wrote them, then the rest.
  const v2 = env.TEST_MIGRATIONS.findIndex((m) => m.name.startsWith("0005"));
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(0, v2));
  const secret = (id: string, user: string) =>
    env.DB.prepare(
      "INSERT INTO secrets (id, user_id, purpose, binding, ciphertext, iv, last4) VALUES (?, ?, 'model_api_key', 'b', x'00', x'00', 'WXYZ')",
    ).bind(id, user);
  const settings = env.DB.prepare(
    "INSERT INTO user_settings (user_id, about, model_kind, provider_id, base_url, model, model_key_secret_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, display_name, role) VALUES ('keyed', 'K', 'owner'), ('starter', 'S', 'member'), ('fresh', 'F', 'member')",
    ),
    secret("s-keyed", "keyed"),
    secret("s-starter", "starter"),
    settings.bind("keyed", "Keyed", "openai-chat", "openai", OPENAI, "gpt-4.1", "s-keyed"),
    // A starter user who saved a key first: the starter overwrote the model, not the key.
    settings.bind("starter", null, "workers-ai", "openai", OPENAI, STARTER_MODEL, "s-starter"),
    settings.bind("fresh", "Just me", null, null, null, null, null),
  ]);
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(v2));
});

describe("migration 0005", () => {
  it("makes each saved model a provider row and the Chat role", async () => {
    const providers = await rows(
      "SELECT user_id, kind, provider_id, base_url, model, key_secret_id FROM model_providers ORDER BY user_id, kind",
    );
    expect(providers).toEqual([
      {
        user_id: "keyed",
        kind: "openai-chat",
        provider_id: "openai",
        base_url: OPENAI,
        model: "gpt-4.1",
        key_secret_id: "s-keyed",
      },
      {
        user_id: "starter",
        kind: "openai-chat",
        provider_id: "openai",
        base_url: OPENAI,
        model: null,
        key_secret_id: "s-starter",
      },
      {
        user_id: "starter",
        kind: "workers-ai",
        provider_id: null,
        base_url: null,
        model: STARTER_MODEL,
        key_secret_id: null,
      },
    ]);
    const roles = await rows(
      "SELECT s.user_id, s.about, p.kind, s.chat_model, s.background_provider FROM user_settings s LEFT JOIN model_providers p ON p.id = s.chat_provider ORDER BY s.user_id",
    );
    expect(roles).toEqual([
      {
        user_id: "fresh",
        about: "Just me",
        kind: null,
        chat_model: null,
        background_provider: null,
      },
      {
        user_id: "keyed",
        about: "Keyed",
        kind: "openai-chat",
        chat_model: "gpt-4.1",
        background_provider: null,
      },
      {
        user_id: "starter",
        about: null,
        kind: "workers-ai",
        chat_model: STARTER_MODEL,
        background_provider: null,
      },
    ]);
  });
});

describe("model roles", () => {
  it("resolves the Chat role, and a conversation's own model over it", async () => {
    const keyed = repo.forUser(scope("keyed"));
    expect(await pickModel(env, scope("keyed"), { role: "chat" })).toMatchObject({
      model: "gpt-4.1",
      row: { kind: "openai-chat", keyLast4: "WXYZ" },
    });
    expect(await pickModel(env, scope("fresh"), { role: "chat" })).toBeNull();
    const mini = await keyed.providers.add({
      kind: "openai-chat",
      providerId: "openai",
      baseUrl: OPENAI,
      model: "gpt-4o-mini",
    });
    await keyed.createConversation("c-keyed");
    const pinned = { conversationId: "c-keyed" };
    expect((await pickModel(env, scope("keyed"), pinned))?.model).toBe("gpt-4.1");
    expect(await keyed.chat.setModel("c-keyed", { provider: mini, model: "gpt-4.1-mini" })).toBe(
      true,
    );
    expect(await pickModel(env, scope("keyed"), pinned)).toMatchObject({
      model: "gpt-4.1-mini",
      row: { id: mini },
    });
    // Removing the provider puts the conversation back on the Chat role.
    expect(await keyed.providers.remove(mini)).toBe(true);
    expect((await pickModel(env, scope("keyed"), pinned))?.model).toBe("gpt-4.1");
  });

  it("defaults Background to the cheapest saved model, and honours a set one", async () => {
    const starter = repo.forUser(scope("starter"));
    // The kept key has no model, so it can't be picked; the starter is the only candidate.
    expect((await pickModel(env, scope("starter"), { role: "background" }))?.model).toBe(
      STARTER_MODEL,
    );
    const values = { kind: "openai-chat" as const, providerId: "openai", baseUrl: OPENAI };
    const cheap = await starter.providers.add({ ...values, model: "gpt-4o-mini" });
    await starter.providers.add({ ...values, model: "gpt-4.1" });
    await starter.providers.add({ ...values, model: "unpriced-model" });
    expect(await pickModel(env, scope("starter"), { role: "background" })).toMatchObject({
      model: "gpt-4o-mini",
      row: { id: cheap },
    });
    const chat = (await starter.settings.get())?.chatProvider;
    await starter.settings.save({ backgroundProvider: chat, backgroundModel: STARTER_MODEL });
    expect((await pickModel(env, scope("starter"), { role: "background" }))?.model).toBe(
      STARTER_MODEL,
    );
  });

  it("never resolves another user's provider, whatever a row names", async () => {
    const [theirs] = await rows("SELECT id FROM model_providers WHERE user_id = 'keyed'");
    const id = String(theirs?.id);
    const fresh = repo.forUser(scope("fresh"));
    expect(await fresh.providers.get(id)).toBeUndefined();
    expect(await fresh.providers.remove(id)).toBe(false);
    await fresh.providers.update(id, { model: "changed" });
    // A foreign key proves only that the row exists, so point the roles at it directly.
    await fresh.settings.save({ chatProvider: id, chatModel: "gpt-4.1", backgroundProvider: id });
    await fresh.createConversation("c-fresh");
    await fresh.chat.setModel("c-fresh", { provider: id, model: "gpt-4.1" });
    for (const pick of [{ role: "chat" }, { role: "background" }, { conversationId: "c-fresh" }]) {
      expect(await pickModel(env, scope("fresh"), pick as never)).toBeNull();
    }
    expect(await resolveChatModel(env, scope("fresh"), "test", { provider: id })).toEqual({
      error: "no_model",
    });
    expect(await fresh.chat.setModel("c-keyed", null)).toBe(false);
    expect((await rows(`SELECT model FROM model_providers WHERE id = '${id}'`))[0]?.model).toBe(
      "gpt-4.1",
    );
  });
});
