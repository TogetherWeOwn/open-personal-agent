// SPDX-License-Identifier: Apache-2.0
import { runInDurableObject } from "cloudflare:test";
import { type CapabilityAudience, mintCapabilityToken } from "@opa/db/capability-tokens";
import { computerStore } from "@opa/db/computers";
import { createRepository, scopeFromSession } from "@opa/db/repository";
import { type SqlDatabase, systemStore } from "@opa/db/system";
import { SESSION_COOKIE } from "@opa/server/auth";
import { describe, expect, it, vi } from "vitest";
import type { Assistant } from "../src/assistant";
import { workerApp } from "../src/worker-app";
import { claim, db, env, freshDatabase, ORIGIN, sessionHeaders } from "./helpers/app";

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
  it.each(["expiry", "compromise"])(
    "aborts an admitted stalled stream after system %s cancels its task",
    async (kind) => {
      const f = await setup();
      await runInDurableObject(f.stub, (instance: Assistant) => {
        instance.proxyFetch = async () =>
          new Response(new ReadableStream(), {
            headers: { "content-type": "text/event-stream" },
          });
      });
      const response = await f.send();
      const reading = response.text().catch(() => "aborted");
      await db
        .prepare("UPDATE tasks SET status = 'waiting_for_approval' WHERE id = 'proxy-task'")
        .run();
      await db
        .prepare(`INSERT INTO approvals
      (batch_id, approval_id, position, user_id, conversation_id, task_id, tool, tool_call_id,
       risk, rule, step_up, scopes, canonical, binding_hash, expires_at, status, nonce)
      VALUES ('proxy-approval', 'proxy-approval', 0, ?, 'proxy-conversation', 'proxy-task',
        'send', 'call', 'consequential', 'default_consequential', 0, '["once"]', '{}', 'h', ?, 'pending', 'n')`)
        .bind(f.owner, Date.now() - 1)
        .run();
      if (kind === "expiry") await systemStore(env).approvals.expireDue(Date.now());
      else await systemStore(env).sessions.revokeAll(f.owner, Date.now());
      expect((await f.user.tasks.get("proxy-task"))?.status).toBe("cancelled");
      await vi.waitFor(
        async () => {
          const totals = await runInDurableObject(f.stub, (instance: Assistant) =>
            instance.limits.totals(),
          );
          expect(totals.heldMicroUsd).toBe(0);
        },
        { timeout: 3_000 },
      );
      expect(await reading).toBe("aborted");
      expect(await f.user.usage.list()).toHaveLength(1);
      expect((await f.send()).status).toBe(401);
    },
  );

  it.each(["cancel", "stop"])(
    "retries %s cleanup after a committed cancel and failed abort RPC",
    async (path) => {
      const f = await setup();
      await f.user.chat.startTurn("proxy-conversation", "Continue", "proxy-reply", []);
      await f.user.chat.checkpointReply("proxy-reply", "Partial reply.");
      await db
        .prepare(
          "UPDATE tasks SET workflow_instance_id = 'proxy-workflow', state = ? WHERE id = 'proxy-task'",
        )
        .bind(
          JSON.stringify({
            replyId: "proxy-reply",
            turnId: "proxy-turn",
            turn: { messages: [{ role: "assistant", content: "Partial reply." }] },
          }),
        )
        .run();
      const reply = async () =>
        (await f.user.chat.listMessages("proxy-conversation"))?.find(
          (message) => message.id === "proxy-reply",
        );
      let first = true;
      const abortModelProxyTask = async (taskId: string) => {
        if (first) {
          first = false;
          throw new Error("abort acknowledgement lost");
        }
        await f.stub.abortModelProxyTask(taskId);
      };
      const terminate = vi.fn(async () => {});
      const sendEvent = vi.fn(async () => {});
      const bindings = {
        ...env,
        ASSISTANT: {
          idFromName: (name: string) => env.ASSISTANT.idFromName(name),
          get: () => ({ abortModelProxyTask }),
        },
        TASK_WORKFLOW: { get: async () => ({ terminate, sendEvent }) },
      };
      const headers = await sessionHeaders(f.owner);
      const post = () =>
        workerApp.request(
          `${ORIGIN}/api/tasks/proxy-task/${path}`,
          { method: "POST", headers },
          bindings as never,
        );
      expect((await post()).status).toBe(500);
      expect((await f.user.tasks.get("proxy-task"))?.status).toBe("cancelled");
      expect(await reply()).toMatchObject({ status: "streaming" });
      expect((await post()).status).toBe(200);
      expect(path === "cancel" ? terminate : sendEvent).toHaveBeenCalledTimes(1);
      expect(await reply()).toMatchObject({ status: "interrupted", content: "Partial reply." });
    },
  );
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

  describe.each([
    ["openai-chat", "/chat/completions", "max_tokens"],
    ["openai-responses", "/responses", "max_output_tokens"],
    ["anthropic-messages", "/messages", "max_tokens"],
  ] as const)("%s small-cap DO accounting", (api, path, outputKey) => {
    it.each(["missing", "final", "cancel"])(
      "persists and settles %s usage at the actual cap",
      async (kind) => {
        const f = await setup();
        let held = 0;
        await runInDurableObject(f.stub, (instance: Assistant) => {
          instance.limits.endTask("proxy-task");
          instance.startTask("proxy-task", 240);
          instance.resolveProxyProvider = async () => ({
            baseUrl: "https://api.example/v1",
            api,
            apiKey: "test-provider-key",
            billingId: "openai",
          });
          instance.proxyFetch = async (_url, init) => {
            expect(JSON.parse(String(init?.body))[outputKey]).toBe(1);
            const row = await db
              .prepare("SELECT output_tokens FROM usage WHERE task_id = ?")
              .bind("proxy-task")
              .first<{ output_tokens: number }>();
            expect(row?.output_tokens).toBe(1);
            held = instance.limits.totals().heldMicroUsd;
            if (kind === "cancel")
              return new Response(new ReadableStream(), {
                headers: { "content-type": "text/event-stream" },
              });
            return Response.json(
              kind === "final" ? { usage: { input_tokens: 12, output_tokens: 1 } } : {},
            );
          };
        });
        const response = await f.send(
          {},
          {
            path,
            body: {
              ...BODY.body,
              max_tokens: 100,
              max_completion_tokens: 16,
              max_output_tokens: 1,
            },
          },
        );
        expect(response.status).toBe(200);
        expect(held).toBeGreaterThan(0);
        expect(held).toBeLessThanOrEqual(240);
        const reading = response.text().catch(() => "aborted");
        if (kind === "cancel") {
          await f.user.tasks.cancel("proxy-task");
          await f.user.tasks.cancel("proxy-task");
          expect(await reading).toBe("aborted");
        } else await reading;
        const rows = await f.user.usage.list();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ taskId: "proxy-task", outputTokens: 1 });
        expect(
          await runInDurableObject(f.stub, (instance: Assistant) => instance.limits.totals()),
        ).toEqual({
          todayMicroUsd: kind === "final" ? 3 : held,
          monthMicroUsd: kind === "final" ? 3 : held,
          heldMicroUsd: 0,
        });
      },
    );
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
