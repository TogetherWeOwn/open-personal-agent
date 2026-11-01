// SPDX-License-Identifier: Apache-2.0
// Model settings (M2-15): a saved key never returns to the browser, and Test reports latency
// and tool support.
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { Hono } from "hono";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import { compose, type WorkerEnv } from "../src/compose";
import type { AppEnv, Env } from "../src/env";
import { STARTER_MODEL } from "../src/model-settings";

const env = workerEnv as unknown as WorkerEnv & { TEST_MIGRATIONS: D1Migration[] };
const KEY = btoa("k".repeat(32));
const CANARY = "sk-canary-0123456789abcdefWXYZ";
const OPENAI = { kind: "openai-chat", providerId: "openai", baseUrl: "https://api.example.com/v1" };

// Stands in for the M2-10 session guard.
const signedIn = new Hono<AppEnv>();
signedIn.use(async (c, next) => {
  c.set("session", { id: "s1", userId: "u1" });
  await next();
});
signedIn.route("/", app);

async function call(path: string, init: RequestInit = {}, extra: Partial<Env> = {}) {
  const bindings = { ...(await compose({ ...env, OPA_MASTER_KEY: KEY })), ...extra };
  const headers = { "content-type": "application/json" };
  const res = await signedIn.request(`/api/settings${path}`, { headers, ...init }, bindings);
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
});

afterEach(() => vi.restoreAllMocks());

describe("model settings", () => {
  it("needs a session", async () => {
    const res = await app.request("/api/settings", {}, await compose(env));
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

  it("rejects plain-HTTP base URLs", async () => {
    const res = await put("/model", { ...OPENAI, baseUrl: "http://x.test", apiKey: CANARY });
    expect(res.status).toBe(400);
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

  it("starts on Workers AI without a key, then finishes onboarding", async () => {
    const saved = JSON.parse((await put("/model", { kind: "workers-ai" })).text);
    expect(saved.model).toMatchObject({ kind: "workers-ai", model: STARTER_MODEL });
    const missing = await call(
      "/model/test",
      { method: "POST" },
      { AI: undefined as unknown as Ai },
    );
    expect(missing).toEqual({ status: 503, text: '{"error":"ai_unavailable"}' });
    const AI = { run: async () => sse('{"response":"ready"}', "[DONE]") } as unknown as Ai;
    const tested = JSON.parse((await call("/model/test", { method: "POST" }, { AI })).text);
    expect(tested).toMatchObject({ ok: true, tools: false, reply: "ready" });
    expect((await call("/onboarded", { method: "POST" })).status).toBe(204);
    expect(JSON.parse((await call("")).text).onboarded).toBe(true);
  });
});
