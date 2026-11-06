// SPDX-License-Identifier: Apache-2.0
import { env as workerEnv } from "cloudflare:workers";
import type { CapabilityScope } from "@opa/db/capability-tokens";
import { createRepository, scopeFromSession } from "@opa/db/repository";
import { resolveProxyProvider } from "@opa/server/model-proxy-config";
import { describe, expect, it } from "vitest";
import { compose, type WorkerEnv } from "../src/compose";
import { Browser, claim, db, env, freshDatabase } from "./helpers/app";

freshDatabase();
const MODEL = "gpt-4o-mini";
const KEY = "sk-proxy-config-test-key-1234567890";
async function saved() {
  const { owner, browser } = await claim();
  const bindings = await compose({
    ...workerEnv,
    OPA_MASTER_KEY: btoa("k".repeat(32)),
    PUBLIC_LIMIT: env.PUBLIC_LIMIT,
    OPA_SESSION_SECRET: env.OPA_SESSION_SECRET,
  } as unknown as WorkerEnv);
  const br = new Browser(bindings);
  br.cookies = browser.cookies;
  const response = await br.req("/api/settings/providers", {
    body: {
      kind: "openai-chat",
      api: "openai-chat",
      providerId: "my-openai",
      baseUrl: "https://api.openai.com/v1",
      model: MODEL,
      apiKey: KEY,
    },
  });
  expect(response.status).toBe(201);
  const { id } = await response.json<{ id: string }>();
  const scope = scopeFromSession({ userId: owner });
  const user = createRepository(bindings).forUser(scope);
  await user.chat.open("config-conversation", "config");
  await user.tasks.create({
    id: "config-task",
    conversationId: "config-conversation",
    kind: "turn",
    mode: "background",
  });
  await user.settings.save({ chatProvider: id, chatModel: MODEL });
  const capability: CapabilityScope = {
    tokenId: "row",
    userId: owner,
    taskId: "config-task",
    computerId: "computer",
    aud: "model_proxy",
    expiresAt: Date.now() + 60_000,
    modelAllowlist: [{ providerId: id, model: MODEL }],
  };
  const resolve = (provider = id, model = MODEL) =>
    resolveProxyProvider(bindings, scope, capability, provider, model);
  return { user, resolve, id, bindings, scope, capability };
}

describe("live proxy provider selection", () => {
  it("resolves the task's current exact pair and decrypts only the bound saved endpoint key", async () => {
    const f = await saved();
    expect(await f.resolve()).toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      apiKey: KEY,
      api: "openai-chat",
      billingId: "openai",
    });
    expect(await f.resolve("another-users-provider")).toBeNull();
    expect(await f.resolve(f.id, "gpt-4o")).toBeNull();
  });
  it("never resolves another user's saved provider or a task outside the owning scope", async () => {
    const f = await saved();
    await db
      .prepare("INSERT INTO users (id, display_name, role) VALUES ('config-bob', 'B', 'member')")
      .run();
    const scope = scopeFromSession({ userId: "config-bob" });
    const bob = createRepository(f.bindings).forUser(scope);
    await bob.chat.open("bob-conversation", "B");
    await bob.tasks.create({
      id: "bob-task",
      conversationId: "bob-conversation",
      kind: "turn",
      mode: "background",
    });
    const capability = { ...f.capability, userId: "config-bob", taskId: "bob-task" };
    expect(await resolveProxyProvider(f.bindings, scope, capability, f.id, MODEL)).toBeNull();
    expect(
      await resolveProxyProvider(
        f.bindings,
        scope,
        { ...capability, taskId: "config-task" },
        f.id,
        MODEL,
      ),
    ).toBeNull();
    expect(await resolveProxyProvider(f.bindings, f.scope, capability, f.id, MODEL)).toBeNull();
    expect(await f.resolve()).toMatchObject({ apiKey: KEY });
  });

  it("reselects a changed role on each call rather than treating the token ceiling as config", async () => {
    const f = await saved();
    expect(await f.resolve()).not.toBeNull();
    await f.user.settings.save({ chatModel: "gpt-4o" });
    expect(await f.resolve()).toBeNull();
  });
});
