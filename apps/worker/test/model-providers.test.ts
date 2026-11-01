// SPDX-License-Identifier: Apache-2.0
// Model settings v2 routes (M3-06a): several providers, roles, a conversation's model and Test.
// Every response any route sends is kept, and the last test checks none carries a key (A-M3).
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { app } from "@opa/server/app";
import { settings } from "@opa/server/model-settings";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { compose, type WorkerEnv } from "../src/compose";
import type { Env } from "../src/env";
import { ORIGIN, sessionHeaders } from "./helpers/app";

const env = workerEnv as unknown as WorkerEnv & { TEST_MIGRATIONS: D1Migration[] };
const MASTER = btoa("k".repeat(32));
const KEYS = ["sk-first-0123456789abcdefWXYZ", "sk-second-9876543210fedcbaQRST"];
// OpenAI's host under its own name, not the OpenAI preset: priced as OpenAI, and on Chat
// Completions, so the mocks below speak one wire format (M3-04 moves the preset to Responses).
const OPENAI = {
  kind: "openai-chat",
  providerId: "my-openai",
  baseUrl: "https://api.openai.com/v1",
};
const ROUTER = {
  kind: "openai-chat",
  providerId: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
};

const sessions: Record<string, Record<string, string>> = {};
const responses: string[] = [];
const exercised = new Set<string>();

async function call(
  user: string,
  method: string,
  path: string,
  body?: unknown,
  extra: Partial<Env> = {},
) {
  const bindings = { ...(await compose({ ...env, OPA_MASTER_KEY: MASTER })), ...extra };
  const headers = { "content-type": "application/json", ...sessions[user] };
  const init = { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
  const res = await app.request(`${ORIGIN}/api${path}`, init, bindings);
  const text = await res.text();
  responses.push(text);
  const route = path
    .replace(/^\/settings/, "")
    .replace(/^\/(providers|conversations)\/[^/]+/, "/$1/:id");
  exercised.add(`${method} ${route}`);
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const sse = (...lines: string[]) => new Response(lines.map((line) => `data: ${line}\n\n`).join(""));
/** Answers in text, and calls the probe's tool when offered tools; or refuses tools outright. */
const answer = (tools: "call" | "refuse" | "limit" = "call") =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    if (!JSON.parse(String(init?.body)).tools) {
      return sse(JSON.stringify({ choices: [{ delta: { content: "ready" } }] }), "[DONE]");
    }
    if (tools === "refuse") {
      return Response.json({ error: { message: "tools are not supported" } }, { status: 400 });
    }
    if (tools === "limit")
      return Response.json({ error: { message: "slow down" } }, { status: 429 });
    const call = { index: 0, id: "c1", function: { name: "report_ready", arguments: "{}" } };
    return sse(JSON.stringify({ choices: [{ delta: { tool_calls: [call] } }] }), "[DONE]");
  });

let first = "";
let second = "";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, display_name, role) VALUES ('u1', 'A', 'owner')"),
    env.DB.prepare("INSERT INTO users (id, display_name, role) VALUES ('u2', 'B', 'member')"),
    env.DB.prepare("INSERT INTO setup_state (id, claimed_by_user_id) VALUES (1, 'u1')"),
    env.DB.prepare("INSERT INTO conversations (id, user_id) VALUES ('c1', 'u1'), ('c2', 'u2')"),
  ]);
  sessions.u1 = await sessionHeaders("u1");
  sessions.u2 = await sessionHeaders("u2");
});

afterEach(() => vi.restoreAllMocks());

describe("several providers", () => {
  it("saves several, each with its key's last 4 and dates, and a dated price", async () => {
    const add = (values: object, apiKey: string) =>
      call("u1", "POST", "/settings/providers", { ...values, apiKey });
    const a = await add({ ...OPENAI, model: "gpt-4o-mini" }, KEYS[0] as string);
    const b = await add({ ...ROUTER, model: "some/model" }, KEYS[1] as string);
    expect([a.status, b.status]).toEqual([201, 201]);
    first = a.body.id;
    second = b.body.id;
    expect(a.body).toMatchObject({
      providerId: "my-openai",
      api: "openai-chat",
      // Readable names for the chip and Settings: the biller's, not the typed provider ID.
      providerName: "OpenAI",
      model: "gpt-4o-mini",
      modelName: "GPT-4o mini",
      key: { last4: "WXYZ", lastUsedAt: null },
      price: { inputUsdPerMTok: 0.15, outputUsdPerMTok: 0.6, stale: expect.any(Boolean) },
    });
    expect(a.body.key.createdAt).toBeTypeOf("number");
    expect(a.body.price.verifiedAt).toMatch(/^\d{4}-\d\d-\d\d$/);
    expect(b.body).toMatchObject({ key: { last4: "QRST" }, price: null });
    const listed = (await call("u1", "GET", "/settings")).body;
    expect(listed.providers.map((p: { id: string }) => p.id)).toEqual([first, second]);
    // The first saved model wasn't made a role; Chat is still unset.
    expect(listed.roles).toEqual({
      chat: null,
      background: { provider: first, model: "gpt-4o-mini", default: true },
      embedding: null,
    });
  });

  it("needs a key for a new provider, and keeps it only for the same endpoint", async () => {
    const keyless = await call("u1", "POST", "/settings/providers", { ...OPENAI, model: "m" });
    expect(keyless).toEqual({ status: 400, body: { error: "key_required" } });
    const down = await call(
      "u1",
      "POST",
      "/settings/providers",
      { ...OPENAI, model: "m", apiKey: KEYS[0] },
      { VAULT: null },
    );
    expect(down).toEqual({ status: 503, body: { error: "vault_unavailable" } });
    const renamed = await call("u1", "PUT", `/settings/providers/${first}`, {
      ...OPENAI,
      model: "gpt-4.1-mini",
    });
    expect(renamed.body).toMatchObject({ model: "gpt-4.1-mini", key: { last4: "WXYZ" } });
    const moved = await call("u1", "PUT", `/settings/providers/${first}`, {
      ...OPENAI,
      baseUrl: "https://elsewhere.test/v1",
      model: "m",
    });
    expect(moved).toEqual({ status: 400, body: { error: "key_required" } });
  });

  it("sets Chat and Background, and Background falls back to the cheapest", async () => {
    const roles = (body: object) => call("u1", "PUT", "/settings/roles", body);
    const set = await roles({
      chat: { provider: second, model: "other/model" },
      background: { provider: first },
    });
    expect(set.body.roles).toEqual({
      chat: { provider: second, model: "other/model" },
      background: { provider: first, model: "gpt-4.1-mini", default: false },
      embedding: null,
    });
    // Onboarding's view follows the Chat role.
    expect(set.body.model).toMatchObject({ providerId: "openrouter", model: "other/model" });
    const reset = await roles({ background: null });
    expect(reset.body.roles.background).toMatchObject({ provider: first, default: true });
    for (const bad of [{ chat: null }, { chat: { provider: "nope" } }, { background: {} }]) {
      expect((await roles(bad)).body).toEqual({ error: "invalid_role" });
    }
  });

  it("tests one saved provider and returns its price hint", async () => {
    const fetch = answer();
    const tested = await call("u1", "POST", `/settings/providers/${first}/test`, {});
    expect(tested.body).toMatchObject({
      ok: true,
      tools: true,
      toolProbe: "called",
      price: { inputUsdPerMTok: 0.4 },
    });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/chat/completions");
    const init = fetch.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${KEYS[0]}`);
    expect(JSON.parse(init?.body as string).model).toBe("gpt-4.1-mini");
    // Test on the Chat role goes to its own provider and model.
    await call("u1", "POST", "/settings/model/test");
    // Each Test is two calls: the prompt, then the tool probe.
    expect(fetch.mock.calls[2]?.[0]).toBe("https://openrouter.ai/api/v1/chat/completions");
    const listed = (await call("u1", "GET", "/settings")).body.providers;
    expect(listed[0].key.lastUsedAt).toBeTypeOf("number");
  });

  it("tells a host that refuses tools from a probe that didn't get to ask", async () => {
    const fetch = answer("refuse");
    const tested = await call("u1", "POST", `/settings/providers/${first}/test`, {});
    expect(tested.body).toMatchObject({ ok: true, tools: false, toolProbe: "rejected" });
    // Room for a reasoning model to think before it calls; the cap counts those tokens.
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).max_completion_tokens).toBe(1024);
    vi.restoreAllMocks();
    answer("limit");
    const limited = await call("u1", "POST", `/settings/providers/${first}/test`, {});
    expect(limited.body).toMatchObject({ ok: true, tools: false, toolProbe: "failed" });
    // The total covers both calls; latency is the prompt's alone.
    expect(limited.body.totalMs).toBeGreaterThanOrEqual(limited.body.latencyMs);
  });

  it("never returns a key the provider echoes back, in a reply or an error", async () => {
    // A gateway that reflects the Authorization header into its output (TWO-514 F1).
    const echo = (fail: boolean) =>
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        const auth = new Headers(init?.headers).get("authorization") ?? "";
        if (fail) {
          return Response.json({ error: { message: `bad credential ${auth}` } }, { status: 400 });
        }
        return sse(JSON.stringify({ choices: [{ delta: { content: `hi ${auth}` } }] }), "[DONE]");
      });
    echo(false);
    const tested = await call("u1", "POST", `/settings/providers/${first}/test`, {});
    expect(tested.body).toMatchObject({ ok: true, reply: "" });
    vi.restoreAllMocks();
    echo(true);
    const failed = await call("u1", "POST", `/settings/providers/${first}/test`, {});
    expect(failed.body.ok).toBe(false);
    expect(failed.body.error.message).not.toContain((KEYS[0] as string).slice(0, 8));
  });

  it("pins a conversation to a model, and back to the Chat role", async () => {
    const pin = (id: string, body: unknown, user = "u1") =>
      call(user, "PUT", `/conversations/${id}/model`, body);
    const switched = await pin("c1", { provider: first, model: "gpt-4.1" });
    // The thread records the switch, in names a person reads, with the pin (TWO-614).
    const line = { role: "system", status: "complete", content: "Switched to GPT-4.1 via OpenAI" };
    expect(switched).toEqual({
      status: 200,
      body: { message: { id: expect.any(String), ...line } },
    });
    const saved = "SELECT model_provider, model FROM conversations WHERE id = 'c1'";
    expect(await env.DB.prepare(saved).first()).toEqual({
      model_provider: first,
      model: "gpt-4.1",
    });
    // The list carries the pin, so the context chip can show it after a reload (06b).
    const chats = (await call("u1", "GET", "/conversations")).body.conversations;
    expect(chats.find((c: { id: string }) => c.id === "c1").model).toEqual({
      provider: first,
      model: "gpt-4.1",
    });
    // Back to the Chat role: the line names the model the chat follows now.
    const back = await pin("c1", null);
    expect(back).toMatchObject({ status: 200, body: { message: { role: "system" } } });
    expect(await env.DB.prepare(saved).first()).toEqual({ model_provider: null, model: null });
    // The messages endpoint returns both lines, in order; refused switches write none.
    expect((await pin("c1", { provider: "missing" })).status).toBe(400);
    expect((await pin("nope", { provider: first })).status).toBe(404);
    const thread = (await call("u1", "GET", "/conversations/c1/messages")).body.messages;
    expect(thread.map((m: { id: string }) => m.id)).toEqual([
      switched.body.message.id,
      back.body.message.id,
    ]);
    expect(thread[0]).toMatchObject(line);
    await env.DB.prepare("DELETE FROM messages WHERE conversation_id = 'c1'").run();
  });

  it("moves the picks on a provider's model when it changes, and keeps the others", async () => {
    await call("u1", "PUT", "/settings/roles", { background: { provider: first } });
    await call("u1", "PUT", "/conversations/c1/model", { provider: first, model: "gpt-4.1" });
    await call("u1", "PUT", `/settings/providers/${first}`, { ...OPENAI, model: "gpt-4o-mini" });
    const { roles } = (await call("u1", "GET", "/settings")).body;
    expect(roles.background).toEqual({ provider: first, model: "gpt-4o-mini", default: false });
    const pinned = "SELECT model FROM conversations WHERE id = 'c1'";
    expect(await env.DB.prepare(pinned).first("model")).toBe("gpt-4.1");
    await call("u1", "PUT", "/settings/roles", { background: null });
  });

  it("lets onboarding edit only the provider saved for its endpoint", async () => {
    const before = (await call("u1", "GET", "/settings")).body.providers;
    // Chat is on OpenRouter; onboarding names OpenAI's endpoint, so it edits that row.
    const saved = await call("u1", "PUT", "/settings/model", { ...OPENAI, model: "gpt-4.1" });
    expect(saved.body.roles.chat).toEqual({ provider: first, model: "gpt-4.1" });
    // A new endpoint adds a row instead of rewriting one.
    const other = { ...ROUTER, baseUrl: "https://gateway.test/v1", model: "x", apiKey: KEYS[1] };
    const added = await call("u1", "PUT", "/settings/model", other);
    const after = added.body.providers;
    expect(after).toHaveLength(before.length + 1);
    expect(after.find((p: { id: string }) => p.id === second)).toEqual(
      before.find((p: { id: string }) => p.id === second),
    );
    await call("u1", "PUT", "/settings/roles", {
      chat: { provider: second, model: "other/model" },
    });
  });

  it("won't delete the Chat role's provider, and deletes another with its key", async () => {
    const chat = await call("u1", "DELETE", `/settings/providers/${second}`);
    expect(chat).toEqual({ status: 409, body: { error: "chat_role" } });
    const keys = env.DB.prepare("SELECT count(*) AS n FROM secrets WHERE user_id = 'u1'");
    const before = await keys.first<number>("n");
    expect((await call("u1", "DELETE", `/settings/providers/${first}`)).status).toBe(204);
    expect(await keys.first("n")).toBe(Number(before) - 1);
    expect((await call("u1", "DELETE", `/settings/providers/${first}`)).status).toBe(404);
  });

  it("audits each key added or removed by last 4, and each role change with both values", async () => {
    const { results } = await env.DB.prepare(
      "SELECT action, target_id, detail FROM audit_log WHERE user_id = 'u1' AND module = 'settings' ORDER BY id",
    ).all<{ action: string; target_id: string | null; detail: string }>();
    const rows = results.map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
    const keyed = (id: string) =>
      rows.filter((r) => r.action.startsWith("settings.key_") && r.target_id === id);
    expect([...keyed(first), ...keyed(second)]).toEqual([
      {
        action: "settings.key_add",
        target_id: first,
        detail: { provider: "OpenAI", last4: "WXYZ" },
      },
      {
        action: "settings.key_remove",
        target_id: first,
        detail: { provider: "OpenAI", last4: "WXYZ" },
      },
      {
        action: "settings.key_add",
        target_id: second,
        detail: { provider: "OpenRouter", last4: "QRST" },
      },
    ]);
    expect(rows.find((r) => r.action === "settings.roles")?.detail).toEqual({
      chatProvider: { from: null, to: second },
      chatModel: { from: null, to: "other/model" },
      backgroundProvider: { from: null, to: first },
      backgroundModel: { from: null, to: "gpt-4.1-mini" },
    });
    // No row carries any part of a key beyond its last 4.
    for (const r of results)
      for (const key of KEYS) expect(r.detail).not.toContain(key.slice(0, 8));
  });
});

describe("isolation", () => {
  it("answers 404 for another user's provider or conversation, on every route", async () => {
    const id = second;
    const notFound = { error: "not_found" };
    expect(await call("u2", "PUT", `/settings/providers/${id}`, { ...ROUTER, model: "x" })).toEqual(
      { status: 404, body: notFound },
    );
    expect(await call("u2", "DELETE", `/settings/providers/${id}`)).toEqual({
      status: 404,
      body: notFound,
    });
    expect(await call("u2", "POST", `/settings/providers/${id}/test`, {})).toEqual({
      status: 404,
      body: notFound,
    });
    // Naming it as a role or a conversation's model is refused as unknown.
    expect((await call("u2", "PUT", "/settings/roles", { chat: { provider: id } })).status).toBe(
      400,
    );
    expect((await call("u2", "PUT", "/conversations/c2/model", { provider: id })).status).toBe(400);
    // And u1 can't pin u2's conversation, even to u1's own model, nor write a line into it.
    expect((await call("u1", "PUT", "/conversations/c2/model", { provider: id })).status).toBe(404);
    const lines = "SELECT count(*) AS n FROM messages WHERE conversation_id = 'c2'";
    expect(await env.DB.prepare(lines).first("n")).toBe(0);
    // u2's switch lines are u2's alone: u1 can't read u2's thread, and u2 can't read u1's.
    const own = await call("u2", "PUT", "/conversations/c2/model", null);
    expect(own.status).toBe(200);
    expect(await call("u1", "GET", "/conversations/c2/messages")).toEqual({
      status: 404,
      body: notFound,
    });
    await call("u1", "PUT", "/conversations/c1/model", { provider: second });
    expect(await call("u2", "GET", "/conversations/c1/messages")).toEqual({
      status: 404,
      body: notFound,
    });
    expect((await call("u2", "GET", "/conversations/c2/messages")).body.messages).toEqual([]);
    expect((await call("u2", "GET", "/settings")).body.providers).toEqual([]);
  });
});

describe("A-M3: no saved key is ever returned to the browser", () => {
  it("exercised every settings route, and no response carries 8 characters of a key", async () => {
    await call("u1", "PUT", "/settings/profile", { displayName: "A", about: "" });
    await call("u1", "PUT", "/settings/model", { ...OPENAI, model: "m", apiKey: KEYS[0] });
    await call("u1", "POST", "/settings/onboarded");
    const routes = settings.routes
      .filter((r) => r.method !== "ALL")
      .map((r) => `${r.method} ${r.path === "/" ? "" : r.path}`);
    for (const route of routes) expect(exercised, route).toContain(route);
    expect(exercised).toContain("PUT /conversations/:id/model");
    for (const key of KEYS) {
      for (let i = 0; i + 8 <= key.length; i++) {
        for (const text of responses) expect(text).not.toContain(key.slice(i, i + 8));
      }
    }
  });
});
