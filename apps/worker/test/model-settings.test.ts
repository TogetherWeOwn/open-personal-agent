// SPDX-License-Identifier: Apache-2.0
// Model settings (M2-15): a saved key never returns to the browser, and Test reports latency
// and tool support.
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { STARTER_MODEL } from "@opa/providers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
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
    expect(body).toMatchObject({ ok: true, tools: true });
    expect(body.latencyMs).toBeTypeOf("number");
    expect(fetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8788/v1/chat/completions");
    // No usage came back, so the ledger keeps the call unpriced, billed by the endpoint's host.
    const ledger = "SELECT provider_id, cost_micro_usd FROM usage WHERE model = 'echo'";
    expect((await env.DB.prepare(ledger).all()).results).toEqual([
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

  it("keeps the key for a new model, but asks again for a new origin", async () => {
    expect((await put("/model", { ...OPENAI, model: "gpt-y" })).status).toBe(200);
    const moved = await put("/model", { ...OPENAI, baseUrl: "https://other.test/v1", model: "m" });
    expect(moved).toEqual({ status: 400, text: '{"error":"key_required"}' });
  });

  it("tests the saved key against its own origin and reports latency and tools", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const chunk = (content: string) => JSON.stringify({ choices: [{ delta: { content } }] });
      return new Response(sse(chunk("rea"), chunk("dy"), "[DONE]"));
    });
    const res = await call("/model/test", { method: "POST" });
    const body = JSON.parse(res.text);
    expect(body).toMatchObject({ ok: true, tools: true, reply: "ready" });
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
    const AI = { run: async () => sse('{"response":"ready"}', usage, "[DONE]") } as unknown as Ai;
    const tested = JSON.parse((await call("/model/test", { method: "POST" }, { AI })).text);
    expect(tested).toMatchObject({ ok: true, tools: false, reply: "ready" });
    // The test call is billed, so the ledger has it, priced: 25 × $0.293/M + 6 × $2.253/M.
    const ledger = "SELECT * FROM usage WHERE provider_id = 'workers-ai'";
    expect((await env.DB.prepare(ledger).all()).results).toMatchObject([
      { input_tokens: 25, output_tokens: 6, cost_micro_usd: 21 },
    ]);
    expect((await call("/onboarded", { method: "POST" })).status).toBe(204);
    expect(JSON.parse((await call("")).text).onboarded).toBe(true);
  });

  it("keeps the saved key for switching back from the starter", async () => {
    expect((await put("/model", { ...OPENAI, model: "gpt-y" })).status).toBe(200);
  });
});
