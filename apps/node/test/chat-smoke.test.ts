// SPDX-License-Identifier: Apache-2.0
// M3-23a AC2: CI boots apps/node with SQLite and the local blob store, claims, and completes a
// chat turn with one tool call against the mock model. The app boots in-process (the same
// composition root, migrations and HTTP+WS stack as `main.ts`, on an ephemeral port); the
// child-process boot, claim and shutdown paths are covered by `boot.test.ts`. The model is the
// repo's mock OpenAI server, saved as the Chat provider through the real settings API, so the
// turn exercises the vault, the SSRF-guarded model fetch and the OpenAI adapter. The one tool
// is injected through the assistant's documented `resolveTools` test seam: no production code
// changes to register it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { serve, type WebSocketServerLike } from "@hono/node-server";
import type { HarnessEvent } from "@opa/core";
import type { LoopTool } from "@opa/harness-builtin";
import { ToolRegistry } from "@opa/policy";
import { SoftPasskey } from "@opa/server/test/softauthn";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { MOCK_MODEL, startMockOpenAI } from "../../../scripts/mock-openai.mjs";
import { createNodeApp, type NodeApp } from "../src/compose";

// Behind a TLS-terminating proxy, as in production: browsers use this, the test connects directly.
const PUBLIC = "https://agent.example";
const SECRETS = {
  OPA_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  OPA_SESSION_SECRET: "chat-smoke-session-secret-0123456789",
  OPA_SETUP_TOKEN: "chat-smoke-setup-token-0123456789",
  // The mock model is a server on this machine, so the guarded fetch must allow it.
  OPA_ALLOW_PRIVATE_MODEL_HOSTS: "1",
};

let mock: { url: string; close(): Promise<void> };
let app: NodeApp;
let base = "";
let server: ReturnType<typeof serve>;
let wss: WebSocketServer;
const dataDir = mkdtempSync(join(tmpdir(), "opa-chat-smoke-"));
const assetsDir = mkdtempSync(join(tmpdir(), "opa-chat-smoke-assets-"));
/** The owner's session cookies, saved by the claim for the model setup and the socket below. */
const jar = new Map<string, string>();

beforeAll(async () => {
  mock = await startMockOpenAI({ port: 0 });
  app = createNodeApp({
    dataDir,
    migrationsDir: join(import.meta.dirname, "../../../migrations"),
    assetsDir,
    vars: { ...SECRETS },
    publicOrigin: PUBLIC,
  });
  // The same upgrade path as `main.ts`: the same port serves the app and the assistant.
  wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  await new Promise<void>((resolve) => {
    server = serve(
      {
        fetch: app.fetch,
        hostname: "127.0.0.1",
        port: 0,
        websocket: { server: wss as unknown as WebSocketServerLike },
      },
      (info) => {
        base = `http://127.0.0.1:${info.port}`;
        resolve();
      },
    );
  });
}, 60_000);

afterAll(async () => {
  for (const client of wss.clients) client.close(1001, "test done");
  await app.shutdown();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  app.db.close();
  await mock.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(assetsDir, { recursive: true, force: true });
}, 60_000);

/** An API request with the owner's cookies, saving any the response sets. */
async function req(path: string, body?: unknown): Promise<Response> {
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const init = body === undefined ? {} : { method: "PUT", body: JSON.stringify(body) };
  const res = await fetch(`${base}${path}`, { ...init, headers: { origin: PUBLIC, cookie } });
  for (const c of res.headers.getSetCookie()) {
    const [name = "", value = ""] = (c.split(";")[0] ?? "").split("=");
    jar.set(name, value);
  }
  return res;
}

async function post(path: string, body: unknown): Promise<Response> {
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { origin: PUBLIC, cookie },
  });
  for (const c of res.headers.getSetCookie()) {
    const [name = "", value = ""] = (c.split(";")[0] ?? "").split("=");
    jar.set(name, value);
  }
  return res;
}

describe("the CI chat smoke (M3-23a AC2)", () => {
  it("claims, points the Chat role at the mock model, and runs one tool turn over the socket", async () => {
    const token = SECRETS.OPA_SETUP_TOKEN;
    const optionsRes = await post("/setup/options", { token });
    expect(optionsRes.status).toBe(200);
    const { options } = (await optionsRes.json()) as { options: { challenge: string } };
    const credential = await new SoftPasskey(new URL(PUBLIC).hostname, PUBLIC).create(options);
    expect((await post("/setup", { token, credential })).status).toBe(200);
    expect(await (await req("/api/me")).json()).toMatchObject({ role: "owner" });

    // Onboarding's model step through the API: profile first, then the mock as Chat's model.
    expect((await req("/api/settings/profile", { displayName: "Smoke", about: "" })).status).toBe(
      204,
    );
    const modelRes = await req("/api/settings/model", {
      kind: "openai-chat",
      providerId: "mock",
      baseUrl: mock.url,
      model: MOCK_MODEL,
      apiKey: "mock-key",
    });
    expect(modelRes.status).toBe(200);
    expect(await modelRes.json()).toMatchObject({ model: { model: MOCK_MODEL } });

    // The turn's one tool, through the assistant's test seam. It takes no input, so the
    // mock's empty-arguments call validates; the content joins the context like any read.
    const { id: userId } = (await (await req("/api/me")).json()) as { id: string };
    const inputs: Record<string, unknown>[] = [];
    const lookup: LoopTool = {
      manifest: {
        name: "lookup",
        description: "Look up a fact for the smoke test.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        riskClass: "read",
        destinations: [],
        scopes: [],
      },
      execute: async (input) => {
        inputs.push(input);
        return { ok: true, content: "The blue door is at 1 Memory Lane." };
      },
    };
    const assistant = app.assistantFor(userId);
    const registry = new ToolRegistry<LoopTool>();
    registry.register(lookup);
    assistant.resolveTools = () => ({ tools: registry, policy: () => ({}) });

    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/chat`, {
      headers: { cookie, origin: PUBLIC },
    });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("unexpected-response", (_req, res) =>
        reject(new Error(`upgrade rejected: ${res.statusCode}`)),
      );
      ws.on("error", reject);
    });
    const frames: HarnessEvent[] = [];
    ws.on("message", (data) => frames.push(JSON.parse(String(data)) as HarnessEvent));
    try {
      ws.send(JSON.stringify({ type: "chat.send", conversationId: "conv-smoke", text: "open it" }));
      await vi.waitFor(() => expect(frames.some((f) => f.type === "turn.completed")).toBe(true), {
        timeout: 15_000,
      });
    } finally {
      ws.close();
    }

    // Exactly one tool call ran, then the turn completed with the mock's echo.
    const types = frames.map((f) => f.type);
    expect(types.indexOf("tool.called")).toBeLessThan(types.indexOf("tool.result"));
    expect(types.indexOf("tool.result")).toBeLessThan(types.indexOf("turn.completed"));
    expect(types.filter((t) => t === "tool.called")).toHaveLength(1);
    expect(types).not.toContain("turn.failed");
    const called = frames.find((f) => f.type === "tool.called");
    expect(called).toMatchObject({ payload: { tool: "lookup", args: "{}", risk: "read" } });
    const result = frames.find((f) => f.type === "tool.result");
    expect(result).toMatchObject({
      payload: { ok: true, preview: "The blue door is at 1 Memory Lane." },
    });
    expect(inputs).toEqual([{}]);

    // Both model calls reached the ledger, and the reply was saved: the local SQLite and
    // blob store behind the same composition root as production did the work.
    const db = app.db as DatabaseSync;
    // One ledger row per model call; both bill to the mock's endpoint.
    const calls = db
      .prepare("SELECT provider_id, model FROM usage WHERE conversation_id = ?")
      .all("conv-smoke") as { provider_id: string; model: string }[];
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.model)).toEqual([MOCK_MODEL, MOCK_MODEL]);
    expect(new Set(calls.map((c) => c.provider_id))).toEqual(new Set([new URL(mock.url).host]));
    const rows = db
      .prepare("SELECT role, status, content FROM messages WHERE conversation_id = ? ORDER BY seq")
      .all("conv-smoke") as { role: string; status: string; content: string }[];
    expect(rows).toEqual([
      { role: "user", status: "complete", content: "open it" },
      { role: "assistant", status: "complete", content: "You said: open it" },
    ]);
    // The turn settled its budget holds: nothing is left held.
    expect(assistant.limits.totals().heldMicroUsd).toBe(0);
  });
});
