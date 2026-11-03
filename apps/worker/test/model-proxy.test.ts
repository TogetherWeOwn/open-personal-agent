// SPDX-License-Identifier: Apache-2.0
import { runInDurableObject } from "cloudflare:test";
import { type CapabilityAudience, mintCapabilityToken } from "@opa/db/capability-tokens";
import { computerStore } from "@opa/db/computers";
import { createRepository, scopeFromSession } from "@opa/db/repository";
import type { SqlDatabase } from "@opa/db/system";
import { SESSION_COOKIE } from "@opa/server/auth";
import { describe, expect, it } from "vitest";
import type { Assistant } from "../src/assistant";
import { workerApp } from "../src/worker-app";
import { claim, db, env, freshDatabase, ORIGIN } from "./helpers/app";

freshDatabase();
const MODEL = "gpt-4o-mini";
const PROVIDER = "saved-provider";
const BODY = {
  path: "/chat/completions",
  body: { model: MODEL, messages: [{ role: "user", content: "hi" }] },
};

async function setup() {
  const { owner, browser } = await claim();
  const user = createRepository(env).forUser(scopeFromSession({ userId: owner }));
  await user.chat.open("proxy-conversation", "proxy");
  await user.tasks.create({
    id: "proxy-task",
    conversationId: "proxy-conversation",
    kind: "turn",
    mode: "background",
  });
  const computer = await computerStore(env).create(
    {
      userId: owner,
      taskId: "proxy-task",
      provider: "fake",
      profile: "host",
      providerComputerId: "proxy-test",
    },
    Date.now(),
  );
  const mint = (aud: CapabilityAudience = "model_proxy") =>
    mintCapabilityToken(db as unknown as SqlDatabase, {
      userId: owner,
      taskId: "proxy-task",
      computerId: computer.id,
      aud,
      modelAllowlist: [{ providerId: PROVIDER, model: MODEL }],
    });
  const { token } = await mint();
  const stub = env.ASSISTANT.get(env.ASSISTANT.idFromName(`u:${owner}`));
  // Only external boundaries are replaced: D1 verification, DO admission, real Limits and
  // task ledger/cancellation all run normally. Saved config/vault resolution has separate tests.
  await runInDurableObject(stub, (instance: Assistant) => {
    instance.startTask("proxy-task", 5_000);
    instance.resolveProxyProvider = async (_env, _scope, _capability, providerId, model) =>
      providerId === PROVIDER && model === MODEL
        ? {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-chat",
            apiKey: "test-provider-key",
            billingId: "openai",
          }
        : null;
    instance.proxyFetch = async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-provider-key");
      expect(init?.redirect).toBe("manual");
      const reserved = await db
        .prepare("SELECT task_id, output_tokens FROM usage WHERE task_id = ?")
        .bind("proxy-task")
        .first<{ task_id: string; output_tokens: number }>();
      expect(reserved?.task_id).toBe("proxy-task");
      expect(reserved?.output_tokens).toBeGreaterThan(3);
      return Response.json({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } });
    };
  });
  const send = (
    headers: Record<string, string> = {},
    body: unknown = BODY,
    providerId = PROVIDER,
    method = "POST",
  ) =>
    workerApp.request(
      `${ORIGIN}/api/model-proxy/${providerId}`,
      {
        method,
        headers: { authorization: `Bearer ${token}`, ...headers },
        body: method === "POST" ? JSON.stringify(body) : null,
      },
      env,
    );
  return { token, user, stub, mint, send, browser, owner };
}

describe("Worker model proxy capability route", () => {
  it("cannot attribute a scoped proxy ledger row to another user's task", async () => {
    const f = await setup();
    await db
      .prepare("INSERT INTO users (id, display_name, role) VALUES ('proxy-bob', 'B', 'member')")
      .run();
    const bob = createRepository(env).forUser(scopeFromSession({ userId: "proxy-bob" }));
    await bob.chat.open("bob-conversation", "B");
    await bob.tasks.create({
      id: "bob-task",
      conversationId: "bob-conversation",
      kind: "turn",
      mode: "background",
    });
    await expect(
      f.user.usage.recordProxy({
        id: "proxy-foreign",
        taskId: "bob-task",
        providerId: "openai",
        model: MODEL,
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
      }),
    ).rejects.toThrow();
    expect(await f.user.usage.list()).toEqual([]);
    expect(await bob.usage.list()).toEqual([]);
  });
  it("rejects a live token sent directly to a different user's DO", async () => {
    const f = await setup();
    await db
      .prepare("INSERT INTO users (id, display_name, role) VALUES ('proxy-bob', 'B', 'member')")
      .run();
    const bob = env.ASSISTANT.get(env.ASSISTANT.idFromName("u:proxy-bob"));
    await runInDurableObject(bob, (instance: Assistant) => {
      instance.startTask("proxy-task", 5_000);
      instance.resolveProxyProvider = async () => ({
        baseUrl: "https://api.openai.com/v1",
        api: "openai-chat",
        apiKey: "bob-key",
        billingId: "openai",
      });
      instance.proxyFetch = async () =>
        Response.json({ usage: { prompt_tokens: 12, completion_tokens: 3 } });
    });
    const response = await bob.modelProxy(
      new Request(`${ORIGIN}/api/model-proxy/${PROVIDER}`, {
        method: "POST",
        headers: { authorization: `Bearer ${f.token}` },
        body: JSON.stringify(BODY),
      }),
      PROVIDER,
    );
    expect(response.status).toBe(401);
    expect(await f.user.usage.list()).toEqual([]);
  });

  it("settles only the reserved ledger ID's exact task and model pair", async () => {
    const f = await setup();
    const reservation = {
      id: "proxy-reservation",
      taskId: "proxy-task",
      providerId: "openai",
      model: MODEL,
      usage: { inputTokens: 100, outputTokens: 200, cachedInputTokens: 0 },
    };
    await f.user.usage.recordProxy(reservation);
    await expect(f.user.usage.recordProxy({ ...reservation, model: "gpt-4o" })).rejects.toThrow();
    await f.user.tasks.create({
      id: "other-task",
      conversationId: "proxy-conversation",
      kind: "turn",
      mode: "background",
    });
    await expect(
      f.user.usage.recordProxy({ ...reservation, taskId: "other-task" }),
    ).rejects.toThrow();
    await f.user.usage.recordProxy({
      ...reservation,
      usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 0 },
    });
    const rows = await f.user.usage.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "proxy-reservation",
      taskId: "proxy-task",
      model: MODEL,
      inputTokens: 12,
      outputTokens: 3,
    });
  });

  it("admits concurrent streams under one real DO task envelope", async () => {
    const f = await setup();
    await runInDurableObject(f.stub, (instance: Assistant) => {
      instance.proxyFetch = async () =>
        new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
    });
    const responses = await Promise.all(Array.from({ length: 10 }, () => f.send()));
    const admitted = responses.filter((response) => response.status === 200);
    expect(admitted.length).toBeGreaterThan(0);
    expect(admitted.length).toBeLessThan(10);
    expect(responses.some((response) => response.status === 429)).toBe(true);
    const reading = admitted.map((response) => response.text().catch(() => "aborted"));
    const totals = await runInDurableObject(f.stub, (instance: Assistant) =>
      instance.limits.totals(),
    );
    expect(totals.heldMicroUsd + totals.todayMicroUsd).toBeLessThanOrEqual(5_000);
    await f.user.tasks.cancel("proxy-task");
    await Promise.all(reading);
    expect(await f.user.usage.list()).toHaveLength(admitted.length);
  });

  it("rejects oversized envelopes and non-allowlisted methods without making a call", async () => {
    const f = await setup();
    expect(
      (
        await f.send(
          {},
          {
            ...BODY,
            body: { ...BODY.body, messages: [{ role: "user", content: "x".repeat(256 * 1024) }] },
          },
        )
      ).status,
    ).toBe(413);
    expect((await f.send({ origin: ORIGIN }, BODY, PROVIDER, "GET")).status).toBe(401);
    expect(await f.user.usage.list()).toHaveLength(0);
  });

  it("accepts a bearer without a session or Origin and writes the task's usage ledger", async () => {
    const f = await setup();
    const response = await f.send();
    expect(response.status).toBe(200);
    await response.text();
    const rows = await f.user.usage.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ taskId: "proxy-task", inputTokens: 12, outputTokens: 3 });
    expect((await f.send({}, null)).status).toBe(400);
  });

  it("rejects cookies, a wrong audience, foreign provider IDs, expiry and revocation before fetch", async () => {
    const f = await setup();
    await runInDurableObject(f.stub, (instance: Assistant) => {
      instance.proxyFetch = async () => {
        throw new Error("denied call reached upstream");
      };
    });
    const cookie = `${SESSION_COOKIE}=${f.browser.cookies.get(SESSION_COOKIE)}`;
    expect((await f.send({ cookie })).status).toBe(401);
    expect((await f.send({ cookie, authorization: "", origin: ORIGIN })).status).toBe(401);
    const otherAudience = await f.mint("artifact_upload");
    expect((await f.send({ authorization: `Bearer ${otherAudience.token}` })).status).toBe(401);
    expect((await f.send({}, BODY, "another-users-provider")).status).toBe(401);
    await db
      .prepare("UPDATE capability_tokens SET expires_at = ? WHERE user_id = ?")
      .bind(Date.now() - 1, f.owner)
      .run();
    expect((await f.send()).status).toBe(401);
    const next = await f.mint();
    await f.user.tasks.cancel("proxy-task");
    expect((await f.send({ authorization: `Bearer ${next.token}` })).status).toBe(401);
    expect(await f.user.usage.list()).toHaveLength(0);
  });

  it("cancels a live stream through the shared task lifecycle and settles exactly once", async () => {
    const f = await setup();
    await runInDurableObject(f.stub, (instance: Assistant) => {
      instance.proxyFetch = async () =>
        new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
    });
    const response = await f.send({}, { ...BODY, body: { ...BODY.body, stream: true } });
    expect(response.status).toBe(200);
    const reading = response.text().catch(() => "aborted");
    await f.user.tasks.cancel("proxy-task");
    expect(await reading).toBe("aborted");
    expect(await f.user.usage.list()).toHaveLength(1);
    expect((await f.send()).status).toBe(401);
    const totals = await runInDurableObject(f.stub, (instance: Assistant) =>
      instance.limits.totals(),
    );
    expect(totals.heldMicroUsd).toBe(0);
  });
});
