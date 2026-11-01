// SPDX-License-Identifier: Apache-2.0
// Model settings (M2-15): a saved key never returns to the browser, and Test reports latency
// and tool support.
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { STARTER_MODEL } from "@opa/providers";
import { app } from "@opa/server/app";
import { encrypt, type UserScope, type Vault } from "@opa/vault";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { compose, type WorkerEnv } from "../src/compose";
import type { Env } from "../src/env";
import { ORIGIN, sessionHeaders } from "./helpers/app";

const env = workerEnv as unknown as WorkerEnv & { TEST_MIGRATIONS: D1Migration[] };
const KEY = btoa("k".repeat(32));
const CANARY = "sk-canary-0123456789abcdefWXYZ";
const OPENAI = { kind: "openai-chat", providerId: "openai", baseUrl: "https://api.example.com/v1" };

let signedIn: Record<string, string> = {};

async function call(path: string, init: RequestInit = {}, extra: Partial<Env> = {}) {
  const bindings = { ...(await compose({ ...env, OPA_MASTER_KEY: KEY })), ...extra };
  const headers = { "content-type": "application/json", ...signedIn };
  const res = await app.request(`${ORIGIN}/api/settings${path}`, { headers, ...init }, bindings);
  return { status: res.status, text: await res.text() };
}
const put = (path: string, body: unknown, extra?: Partial<Env>) =>
  call(path, { method: "PUT", body: JSON.stringify(body) }, extra);
const dump = async (table: string) =>
  JSON.stringify((await env.DB.prepare(`SELECT * FROM ${table}`).all()).results);

const sse = (...lines: string[]) =>
  new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(new TextEncoder().encode(`data: ${line}\n\n`));
      controller.close();
    },
  });

/** Whether a model request offers tools: the Test's tool-call probe (M3-06 AC4) does. */
const offersTools = (init?: RequestInit) => !!JSON.parse(String(init?.body ?? "{}")).tools;
/** A Chat Completions stream that calls the probe's tool. */
const toolCall = () => {
  const call = { index: 0, id: "call_1", function: { name: "report_ready", arguments: "{}" } };
  const chunk = { choices: [{ delta: { tool_calls: [call] }, finish_reason: "tool_calls" }] };
  return new Response(sse(JSON.stringify(chunk), "[DONE]"));
};

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, display_name, role) VALUES ('u1', 'Owner', 'owner')"),
    env.DB.prepare("INSERT INTO setup_state (id, claimed_by_user_id) VALUES (1, 'u1')"),
  ]);
  signedIn = await sessionHeaders("u1");
});

afterEach(() => vi.restoreAllMocks());

describe("model settings", () => {
  it("needs a session", async () => {
    const res = await app.request(`${ORIGIN}/api/settings`, {}, await compose(env));
    expect(res.status).toBe(401);
  });

  it("saves the profile and can't finish onboarding without a model", async () => {
    expect((await put("/profile", { displayName: "Sam", about: "I garden." })).status).toBe(204);
    expect(JSON.parse((await call("")).text)).toMatchObject({
      displayName: "Sam",
      about: "I garden.",
      onboarded: false,
      model: null,
    });
    expect((await call("/onboarded", { method: "POST" })).status).toBe(409);
  });

  it("refuses a key while the vault is down, and stores nothing", async () => {
    const res = await put("/model", { ...OPENAI, model: "m", apiKey: CANARY }, { VAULT: null });
    expect(res).toEqual({ status: 503, text: '{"error":"vault_unavailable"}' });
    expect(await dump("secrets")).toBe("[]");
  });

  it("rejects plain-HTTP public base URLs, and ones the adapter can't call", async () => {
    const urls = [
      "http://x.test",
      "http://8.8.8.8/v1",
      "https://x.test/v1?a=1",
      "https://x.test/v1#f",
    ];
    for (const baseUrl of [...urls, "ftp://x.test/v1"]) {
      const res = await put("/model", { ...OPENAI, baseUrl, model: "m", apiKey: CANARY });
      expect(res).toEqual({ status: 400, text: '{"error":"invalid_base_url"}' });
    }
    // The private-hosts flag widens plain HTTP only alongside the guarded fetch that enforces it.
    const lan = { ...OPENAI, baseUrl: "http://192.168.1.5:11434/v1", model: "m", apiKey: CANARY };
    const unguarded = await put("/model", lan, { MODEL_PRIVATE_HOSTS: true });
    expect(unguarded).toEqual({ status: 400, text: '{"error":"invalid_base_url"}' });
    // On Node without the flag, the guarded fetch refuses loopback, so it can't be saved there.
    const local = { ...lan, baseUrl: "http://127.0.0.1:8788/v1" };
    const guarded = await put("/model", local, { MODEL_FETCH: vi.fn() as typeof fetch });
    expect(guarded).toEqual({ status: 400, text: '{"error":"invalid_base_url"}' });
  });

  it("takes plain HTTP for a model server on this machine, and Test reaches it", async () => {
    const local = { ...OPENAI, providerId: "mock", model: "echo", apiKey: CANARY };
    for (const baseUrl of ["http://localhost:11434/v1", "http://[::1]:8788/v1"]) {
      expect((await put("/model", { ...local, baseUrl })).status).toBe(200);
    }
    const saved = await put("/model", { ...local, baseUrl: "http://127.0.0.1:8788/v1" });
    expect(JSON.parse(saved.text).model).toMatchObject({ baseUrl: "http://127.0.0.1:8788/v1" });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const chunk = JSON.stringify({ choices: [{ delta: { content: "ready" } }] });
      return new Response(sse(chunk, "[DONE]"));
    });
    const body = JSON.parse((await call("/model/test", { method: "POST" })).text);
    // This server answers the probe in text, so tools are reported as not working.
    expect(body).toMatchObject({ ok: true, tools: false, toolProbe: "ignored" });
    expect(body.latencyMs).toBeTypeOf("number");
    expect(fetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8788/v1/chat/completions");
    // No usage came back, so the ledger keeps the call unpriced, billed by the endpoint's host.
    const ledger = "SELECT provider_id, cost_micro_usd FROM usage WHERE model = 'echo'";
    // The probe is a second call, so it is in the ledger too.
    expect((await env.DB.prepare(ledger).all()).results).toEqual([
      { provider_id: "127.0.0.1:8788", cost_micro_usd: null },
      { provider_id: "127.0.0.1:8788", cost_micro_usd: null },
    ]);
  });

  it("takes plain HTTP to a LAN host on Node with private hosts allowed", async () => {
    const node = {
      MODEL_PRIVATE_HOSTS: true,
      MODEL_FETCH: vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({}),
      ),
    };
    const lan = { ...OPENAI, providerId: "ollama", model: "llama3", apiKey: CANARY };
    const saved = await put("/model", { ...lan, baseUrl: "http://192.168.1.5:11434/v1" }, node);
    expect(saved.status).toBe(200);
    await call("/model/test", { method: "POST" }, node);
    expect(node.MODEL_FETCH.mock.calls[0]?.[0]).toBe(
      "http://192.168.1.5:11434/v1/chat/completions",
    );
    // The operator turns the flag off again: Test refuses the saved URL instead of failing.
    const off = await call("/model/test", { method: "POST" }, { MODEL_FETCH: node.MODEL_FETCH });
    expect(off).toEqual({ status: 409, text: '{"error":"invalid_base_url"}' });
  });

  it("encrypts the key and only ever returns its last 4 characters", async () => {
    const saved = await put("/model", { ...OPENAI, model: "gpt-x", apiKey: CANARY });
    expect(saved.status).toBe(200);
    expect(JSON.parse(saved.text).model).toMatchObject({ model: "gpt-x", key: { last4: "WXYZ" } });
    for (const text of [saved.text, (await call("")).text]) expect(text).not.toContain(CANARY);
    for (const table of ["secrets", "user_settings", "audit_log"]) {
      expect(await dump(table)).not.toContain(CANARY.slice(0, 12));
    }
  });

  it("keeps the key for a new model, but asks again for a new origin or path", async () => {
    expect((await put("/model", { ...OPENAI, model: "gpt-y" })).status).toBe(200);
    const moved = await put("/model", { ...OPENAI, baseUrl: "https://other.test/v1", model: "m" });
    expect(moved).toEqual({ status: 400, text: '{"error":"key_required"}' });
    // Same origin, another path: on a shared gateway host that can be another account.
    const path = await put("/model", {
      ...OPENAI,
      baseUrl: "https://api.example.com/x/v1",
      model: "m",
    });
    expect(path).toEqual({ status: 400, text: '{"error":"key_required"}' });
    // A trailing slash is the same endpoint.
    const slash = await put("/model", { ...OPENAI, baseUrl: `${OPENAI.baseUrl}/`, model: "m" });
    expect(slash.status).toBe(200);
  });

  it("tests the saved key against its own origin and reports latency and tools", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (offersTools(init)) return toolCall();
      const chunk = (content: string) => JSON.stringify({ choices: [{ delta: { content } }] });
      return new Response(sse(chunk("rea"), chunk("dy"), "[DONE]"));
    });
    const res = await call("/model/test", { method: "POST" });
    const body = JSON.parse(res.text);
    expect(body).toMatchObject({ ok: true, tools: true, toolProbe: "called", reply: "ready" });
    const probe = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(probe.tools).toMatchObject([{ function: { name: "report_ready" } }]);
    expect(body.latencyMs).toBeTypeOf("number");
    expect(res.text).not.toContain(CANARY);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${CANARY}`);
    expect(JSON.parse((await call("")).text).model.key.lastUsedAt).toBeTypeOf("number");
  });

  it("sends Test through the runtime's model fetch when it sets one", async () => {
    const global = vi.spyOn(globalThis, "fetch");
    const MODEL_FETCH = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ error: { message: "refused" } }, { status: 403 }),
    );
    const ledger = async () => (await dump("usage")).split("api.example.com").length;
    const before = await ledger();
    await call("/model/test", { method: "POST" }, { MODEL_FETCH });
    expect(MODEL_FETCH.mock.calls[0]?.[0]).toBe("https://api.example.com/v1/chat/completions");
    expect(global).not.toHaveBeenCalled();
    expect(await ledger()).toBe(before); // a rejected test ran no model, so it isn't a call
    // A stream cut off after output did run the model: it is a call, unpriced.
    const cut = async () =>
      new Response(sse(JSON.stringify({ choices: [{ delta: { content: "re" } }] }), "{"));
    await call("/model/test", { method: "POST" }, { MODEL_FETCH: vi.fn(cut) });
    expect(await ledger()).toBe(before + 1);
  });

  it("never returns a provider error that echoes part of the key", async () => {
    const echo = `Incorrect API key provided: ${CANARY.slice(0, 16)}****`;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ error: { message: echo } }, { status: 401 }),
    );
    const res = await call("/model/test", { method: "POST" });
    expect(JSON.parse(res.text)).toMatchObject({ ok: false, error: { code: "auth" } });
    expect(res.text).not.toContain(CANARY.slice(0, 8));
  });

  it("starts on Workers AI without a key, then finishes onboarding", async () => {
    const saved = JSON.parse((await put("/model", { kind: "workers-ai" })).text);
    const starter = { kind: "workers-ai", model: STARTER_MODEL, providerId: null, key: null };
    expect(saved.model).toMatchObject({ ...starter, baseUrl: null });
    const missing = await call(
      "/model/test",
      { method: "POST" },
      { AI: undefined as unknown as Ai },
    );
    expect(missing).toEqual({ status: 503, text: '{"error":"ai_unavailable"}' });
    const usage = '{"response":"","usage":{"prompt_tokens":25,"completion_tokens":6}}';
    const called = '{"tool_calls":[{"name":"report_ready","arguments":{}}]}';
    const AI = {
      run: async (_model: string, inputs: { tools?: unknown }) =>
        inputs.tools ? sse(called, "[DONE]") : sse('{"response":"ready"}', usage, "[DONE]"),
    } as unknown as Ai;
    const tested = JSON.parse((await call("/model/test", { method: "POST" }, { AI })).text);
    expect(tested).toMatchObject({ ok: true, tools: true, toolProbe: "called", reply: "ready" });
    // Both calls are billed, so the ledger has them. The first is priced: 25 × $0.293/M +
    // 6 × $2.253/M. The probe reported no usage, so it is unpriced.
    const ledger = "SELECT * FROM usage WHERE provider_id = 'workers-ai' ORDER BY rowid";
    expect((await env.DB.prepare(ledger).all()).results).toMatchObject([
      { input_tokens: 25, output_tokens: 6, cost_micro_usd: 21 },
      { input_tokens: 0, cost_micro_usd: null },
    ]);
    expect((await call("/onboarded", { method: "POST" })).status).toBe(204);
    expect(JSON.parse((await call("")).text).onboarded).toBe(true);
  });

  it("keeps the saved key for switching back from the starter", async () => {
    expect((await put("/model", { ...OPENAI, model: "gpt-y" })).status).toBe(200);
  });

  it("asks for the key again when it was saved before its binding covered the path", async () => {
    // A key as saved before its binding covered the path (crypto review I-2), in the old
    // origin-only form. Nothing stored says which path it was saved for, and the saved URL is
    // only data, so it is never opened as-is: at its old path, or at another path written to D1.
    const { VAULT } = await compose({ ...env, OPA_MASTER_KEY: KEY });
    const chatKey =
      "SELECT key_secret_id AS id FROM model_providers " +
      "WHERE id = (SELECT chat_provider FROM user_settings)";
    const row = await env.DB.prepare(chatKey).first();
    const secretId = row?.id as string;
    const binding = "model:openai|https://api.example.com";
    const input = { secretId, purpose: "model_api_key" as const, binding, plaintext: CANARY };
    await encrypt(VAULT as Vault, { userId: "u1" } as UserScope, { ...input, caller: "t" });

    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        sse(JSON.stringify({ choices: [{ delta: { content: "ok" } }] }), "[DONE]"),
      );
    });
    const required = { status: 409, text: '{"error":"key_required"}' };
    expect(await call("/model/test", { method: "POST" })).toEqual(required);
    const move =
      "UPDATE model_providers SET base_url = ? WHERE id = (SELECT chat_provider FROM user_settings)";
    await env.DB.prepare(move).bind("https://api.example.com/x/v1").run();
    expect(await call("/model/test", { method: "POST" })).toEqual(required);
    expect(fetch).not.toHaveBeenCalled();
    await env.DB.prepare(move).bind(OPENAI.baseUrl).run();
  });

  it("does not accept a keyless save that keeps a key it can no longer open", async () => {
    // The saved key above is sealed under the old origin-only binding, so no current read can
    // open it. A save without a replacement key must say so at save time, on onboarding's route
    // and on the provider update, rather than reporting success and failing later at chat.
    const { VAULT } = await compose({ ...env, OPA_MASTER_KEY: KEY });
    const chatKey =
      "SELECT key_secret_id AS id FROM model_providers " +
      "WHERE id = (SELECT chat_provider FROM user_settings)";
    const row = await env.DB.prepare(chatKey).first();
    const secretId = row?.id as string;
    const binding = "model:openai|https://api.example.com";
    const input = { secretId, purpose: "model_api_key" as const, binding, plaintext: CANARY };
    await encrypt(VAULT as Vault, { userId: "u1" } as UserScope, { ...input, caller: "t" });

    const required = { status: 400, text: '{"error":"key_required"}' };
    expect(await put("/model", { ...OPENAI, model: "gpt-new" })).toEqual(required);
    // The refused save changed nothing: the Chat role still names the earlier model.
    expect(JSON.parse((await call("")).text).model.model).not.toBe("gpt-new");

    const view = JSON.parse((await call("")).text);
    const provider = view.providers.find(
      (p: { providerId: string; baseUrl: string }) =>
        p.providerId === "openai" && p.baseUrl === OPENAI.baseUrl,
    ) as { id: string };
    const update = { providerId: "openai", baseUrl: OPENAI.baseUrl, model: "gpt-new" };
    expect(await put(`/providers/${provider.id}`, update)).toEqual(required);
  });

  it("reports a vault fault on a keyless save as unavailable, not as a key to replace", async () => {
    expect((await put("/model", { ...OPENAI, model: "m", apiKey: CANARY })).status).toBe(200);
    // The key opens, but its decrypt can't be audited, so the vault refuses it (fails closed).
    await env.DB.prepare("ALTER TABLE audit_log RENAME TO audit_log_held").run();
    try {
      const unavailable = { status: 503, text: '{"error":"vault_unavailable"}' };
      expect(await put("/model", { ...OPENAI, model: "gpt-new" })).toEqual(unavailable);
    } finally {
      await env.DB.prepare("ALTER TABLE audit_log_held RENAME TO audit_log").run();
    }
    expect((await put("/model", { ...OPENAI, model: "gpt-new" })).status).toBe(200);
  });

  it("does not open a saved key when the stored path changes", async () => {
    expect((await put("/model", { ...OPENAI, model: "m", apiKey: CANARY })).status).toBe(200);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        sse(JSON.stringify({ choices: [{ delta: { content: "ok" } }] }), "[DONE]"),
      );
    });
    expect(JSON.parse((await call("/model/test", { method: "POST" })).text)).toMatchObject({
      ok: true,
    });
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      `Bearer ${CANARY}`,
    );
    const sent = fetch.mock.calls.length;
    // Pointing the saved URL at another path on the host, in D1, fails rather than sending the key.
    const move =
      "UPDATE model_providers SET base_url = ? WHERE id = (SELECT chat_provider FROM user_settings)";
    await env.DB.prepare(move).bind("https://api.example.com/x/v1").run();
    expect(await call("/model/test", { method: "POST" })).toEqual({
      status: 409,
      text: '{"error":"key_required"}',
    });
    expect(fetch.mock.calls).toHaveLength(sent);
    await env.DB.prepare(move).bind(OPENAI.baseUrl).run();
  });
});

describe("the OpenAI preset on Responses (M3-04 AC3)", () => {
  const preset = {
    kind: "openai-chat",
    providerId: "openai",
    baseUrl: "https://api.openai.com/v1",
  };
  const event = (type: string, fields: object) => JSON.stringify({ type, ...fields });

  it("moves a saved OpenAI key to Responses without asking for it again", async () => {
    // Saved exactly as M2 saved it: kind `openai-chat`, the preset's provider and URL.
    const saved = await put("/model", { ...preset, model: "gpt-5-mini", apiKey: CANARY });
    expect(JSON.parse(saved.text).model).toMatchObject({
      kind: "openai-chat",
      api: "openai-responses",
    });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (offersTools(init)) {
        const item = {
          type: "function_call",
          call_id: "fc_1",
          name: "report_ready",
          arguments: "{}",
        };
        return new Response(
          sse(
            event("response.output_item.done", { item }),
            event("response.completed", { response: { status: "completed" } }),
          ),
        );
      }
      const done = {
        response: { status: "completed", usage: { input_tokens: 9, output_tokens: 1 } },
      };
      return new Response(
        sse(
          event("response.output_text.delta", { delta: "ready" }),
          event("response.completed", done),
        ),
      );
    });
    const tested = JSON.parse((await call("/model/test", { method: "POST" })).text);
    expect(tested).toMatchObject({ ok: true, tools: true, toolProbe: "called", reply: "ready" });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${CANARY}`);
    expect(JSON.parse(String(init?.body))).toMatchObject({ store: false });
    // Another OpenAI-compatible host stays on Chat Completions.
    expect(
      JSON.parse((await put("/model", { ...OPENAI, model: "m", apiKey: CANARY })).text).model,
    ).toMatchObject({ api: "openai-chat" });
  });

  it("can't decrypt a key bound to one origin under another", async () => {
    await put("/model", { ...preset, model: "gpt-5-mini", apiKey: CANARY });
    const fetch = vi.spyOn(globalThis, "fetch");
    // Bypass the route's own check: the vault's binding still refuses the key.
    await env.DB.prepare(
      "UPDATE model_providers SET base_url = 'https://eu.api.openai.com/v1'",
    ).run();
    const res = await call("/model/test", { method: "POST" });
    expect(res).toEqual({ status: 409, text: '{"error":"key_required"}' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("the Anthropic preset on Messages (M3-05 AC3)", () => {
  const preset = {
    kind: "openai-chat",
    providerId: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
  };
  const event = (type: string, fields: object = {}) => JSON.stringify({ type, ...fields });

  it("saves an Anthropic key, tests it on Messages and shows its dated price", async () => {
    const saved = await put("/model", { ...preset, model: "claude-sonnet-5-5", apiKey: CANARY });
    expect(JSON.parse(saved.text).model).toMatchObject({
      providerId: "anthropic",
      api: "anthropic-messages",
      key: { last4: CANARY.slice(-4) },
    });
    expect(saved.text).not.toContain(CANARY);
    const usage = { input_tokens: 9, output_tokens: 1 };
    const reply = (block: object, delta: object, stop: string) =>
      new Response(
        sse(
          event("message_start", { message: { usage } }),
          event("content_block_start", { index: 0, content_block: block }),
          event("content_block_delta", { index: 0, delta }),
          event("message_delta", { delta: { stop_reason: stop }, usage }),
          event("message_stop"),
        ),
      );
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, init) =>
        offersTools(init)
          ? reply(
              { type: "tool_use", id: "toolu_1", name: "report_ready", input: {} },
              { type: "input_json_delta", partial_json: "{}" },
              "tool_use",
            )
          : reply({ type: "text", text: "" }, { type: "text_delta", text: "ready" }, "end_turn"),
      );
    const tested = JSON.parse((await call("/model/test", { method: "POST" })).text);
    expect(tested).toMatchObject({
      ok: true,
      tools: true,
      toolProbe: "called",
      reply: "ready",
      price: { inputUsdPerMTok: 2, outputUsdPerMTok: 10, verifiedAt: "2026-11-01" },
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = new Headers(init?.headers);
    expect(headers.get("x-api-key")).toBe(CANARY);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("anthropic-version")).toBe("2026-10-21");
    // The probe offers its tool in the Messages shape, cached as the last tool.
    const probe = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(probe.tools).toMatchObject([
      { name: "report_ready", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("keeps Anthropic's host under another preset on Chat Completions", async () => {
    const other = { ...preset, providerId: "custom", model: "m", apiKey: CANARY };
    expect(JSON.parse((await put("/model", other)).text).model).toMatchObject({
      api: "openai-chat",
    });
  });
});
