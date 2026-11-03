// SPDX-License-Identifier: Apache-2.0
// The production tool wiring (M3-08): a chat turn offers the builtin registry plus the memory
// and task tools — no test seam — with the policy input read from the user's stored overrides.
// The mock model is scripted to call `web_fetch` (refused: the deployment's own address, so no
// network is touched and the refusal keeps the turn trusted) then `create_artifact`, so the
// turn completes with the artifact saved. A second turn shows Settings › Apps & tools governing
// the loop: with `web_fetch` set to `never`, the call is denied from the stored override and the
// tool never runs.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { serve, type WebSocketServerLike } from "@hono/node-server";
import type { HarnessEvent } from "@opa/core";
import { SoftPasskey } from "@opa/server/test/softauthn";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { MOCK_MODEL, startMockOpenAI } from "../../../scripts/mock-openai.mjs";
import { createNodeApp, type NodeApp } from "../src/compose";

// Behind a TLS-terminating proxy, as in production: browsers use this, the test connects directly.
const PUBLIC = "https://agent.example";
const SECRETS = {
  OPA_MASTER_KEY: Buffer.alloc(32, 9).toString("base64"),
  OPA_SESSION_SECRET: "builtin-tools-session-secret-0123456789",
  OPA_SETUP_TOKEN: "builtin-tools-setup-token-0123456789",
  // The mock model is a server on this machine, so the guarded fetch must allow it.
  OPA_ALLOW_PRIVATE_MODEL_HOSTS: "1",
};
/** Every tool the production turn offers, in registry order. */
const ALL_TOOLS = [
  "web_fetch",
  "search_history",
  "create_artifact",
  "read_file",
  "remember",
  "recall",
  "forget",
  "task",
];

let mock: { url: string; close(): Promise<void>; requests: { tools: string[] }[] };
let app: NodeApp;
let base = "";
let server: ReturnType<typeof serve>;
let wss: WebSocketServer;
const dataDir = mkdtempSync(join(tmpdir(), "opa-builtin-tools-"));
const assetsDir = mkdtempSync(join(tmpdir(), "opa-builtin-tools-assets-"));
/** The owner's session cookies, saved by the claim for the model setup and the sockets below. */
const jar = new Map<string, string>();

beforeAll(async () => {
  mock = await startMockOpenAI({
    port: 0,
    // No test-seam injection: the turn offers the production registry, and the mock answers
    // with the calls the task needs. The fetch is refused (the deployment's own address), so
    // the refusal keeps the turn trusted and the save is allowed without asking.
    script: [
      // One entry per model call: the two tool calls, then the text that ends the turn.
      { tool: "web_fetch", args: { url: "https://agent.example/notes" } },
      {
        tool: "create_artifact",
        args: { name: "fetch-notes.md", content: "# notes\n\nsaved\n" },
      },
      { text: "Saved the notes." },
      // The forbidden-tool turn below: the denied call, then the text that ends it.
      { tool: "web_fetch", args: { url: "https://agent.example/notes" } },
      { text: "That tool is off." },
    ],
  });
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

async function send(conversationId: string, text: string): Promise<HarnessEvent[]> {
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
    ws.send(JSON.stringify({ type: "chat.send", conversationId, text }));
    await vi.waitFor(() => expect(frames.some((f) => f.type === "turn.completed")).toBe(true), {
      timeout: 15_000,
    });
  } finally {
    ws.close();
  }
  return frames;
}

describe("the production tool wiring (M3-08)", () => {
  it("claims, points the Chat role at the mock model, and runs the two-tool turn", async () => {
    const token = SECRETS.OPA_SETUP_TOKEN;
    const optionsRes = await post("/setup/options", { token });
    expect(optionsRes.status).toBe(200);
    const { options } = (await optionsRes.json()) as { options: { challenge: string } };
    const credential = await new SoftPasskey(new URL(PUBLIC).hostname, PUBLIC).create(options);
    expect((await post("/setup", { token, credential })).status).toBe(200);
    expect(await (await req("/api/me")).json()).toMatchObject({ role: "owner" });

    // Onboarding's model step through the API: profile first, then the mock as Chat's model.
    expect((await req("/api/settings/profile", { displayName: "Tools", about: "" })).status).toBe(
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

    // Deliberately no `resolveTools` replacement: the turn offers the production registry.
    const frames = await send("conv-tools", "fetch the notes and save them");

    // The turn offered every production tool: the request the mock recorded names them.
    expect(mock.requests.length).toBeGreaterThan(0);
    expect(mock.requests[0]?.tools).toEqual(ALL_TOOLS);

    // `web_fetch` ran first and was refused without touching the network — the deployment's
    // own address — then `create_artifact` saved, then the turn completed on the echo.
    const types = frames.map((f) => f.type);
    expect(types).not.toContain("turn.failed");
    expect(types).not.toContain("approval.requested");
    expect(types.filter((t) => t === "tool.called")).toHaveLength(2);
    expect(types.filter((t) => t === "tool.result")).toHaveLength(2);
    expect(types.indexOf("tool.called")).toBeLessThan(types.indexOf("turn.completed"));
    const [first, second] = frames.filter((f) => f.type === "tool.called");
    expect(first).toMatchObject({ payload: { tool: "web_fetch", risk: "read" } });
    expect(second).toMatchObject({
      payload: { tool: "create_artifact", risk: "write_reversible" },
    });
    const [firstResult, secondResult] = frames.filter((f) => f.type === "tool.result");
    expect(firstResult).toMatchObject({ payload: { ok: false } });
    expect(JSON.stringify(firstResult)).toContain("own address");
    expect(secondResult).toMatchObject({ payload: { ok: true } });

    // The artifact reached the store behind the same composition root as production: one row
    // under this conversation, and the file in the local blob store.
    const db = app.db as DatabaseSync;
    const artifacts = db
      .prepare("SELECT name, conversation_id FROM artifacts WHERE conversation_id = ?")
      .all("conv-tools") as { name: string; conversation_id: string }[];
    expect(artifacts.map((a) => a.name)).toEqual(["fetch-notes.md"]);
    // Three model calls reached the ledger: fetch, save, then the echo that ended the turn.
    const calls = db
      .prepare("SELECT model FROM usage WHERE conversation_id = ?")
      .all("conv-tools") as { model: string }[];
    expect(calls.map((c) => c.model)).toEqual([MOCK_MODEL, MOCK_MODEL, MOCK_MODEL]);
  });

  it("denies a call Settings forbids without running it", async () => {
    // Tightening needs no passkey step-up; the listing shows the stored override back.
    expect(
      await (await req("/api/settings/tools/web_fetch", { override: "never" })).json(),
    ).toMatchObject({ name: "web_fetch", override: "never" });
    // The loop still offers the registry, but decides the call from the stored override: the
    // denial names the user's choice, not the guard's refusal, so the tool never ran.
    const frames = await send("conv-tools-forbidden", "fetch the notes again");
    const types = frames.map((f) => f.type);
    expect(types).toContain("turn.completed");
    expect(types).not.toContain("turn.failed");
    const called = frames.filter((f) => f.type === "tool.called");
    expect(called).toHaveLength(1);
    expect(called[0]).toMatchObject({ payload: { tool: "web_fetch" } });
    const results = frames.filter((f) => f.type === "tool.result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ payload: { ok: false } });
    expect(JSON.stringify(results[0])).toContain("turned this tool off");
    expect(JSON.stringify(results[0])).not.toContain("own address");
  });
});
