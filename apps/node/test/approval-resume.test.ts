// SPDX-License-Identifier: Apache-2.0
// Approval resume on Node: a turn that stops at `approval.requested` parks in D1; the shared
// approval routes list its batch and record its decisions; the decision wakes the turn to
// `turn.completed` — approving runs the call, denying tells the model so. A decision that lands
// while a turn runs queues behind it, and one that lands after the conversation moved on runs
// the approved calls in a new turn at the chat's end.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { serve, type WebSocketServerLike } from "@hono/node-server";
import type { HarnessEvent, ModelEvent, ModelProvider } from "@opa/core";
import type { LoopTool } from "@opa/harness-builtin";
import { type RiskClass, ToolRegistry } from "@opa/policy";
import { SoftPasskey } from "@opa/server/test/softauthn";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createNodeApp, type NodeApp } from "../src/compose";

// Behind a TLS-terminating proxy, as in production: browsers use this, the test connects directly.
const PUBLIC = "https://agent.example";
const SECRETS = {
  OPA_MASTER_KEY: Buffer.alloc(32, 11).toString("base64"),
  OPA_SESSION_SECRET: "approval-resume-session-secret-0123456",
  OPA_SETUP_TOKEN: "approval-resume-setup-token-0123456789",
};

const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningTokens: 0 };

let app: NodeApp;
let base = "";
let server: ReturnType<typeof serve>;
let wss: WebSocketServer;
const dataDir = mkdtempSync(join(tmpdir(), "opa-approval-resume-"));
const assetsDir = mkdtempSync(join(tmpdir(), "opa-approval-resume-assets-"));
/** The owner's session cookies, saved by the claim for the API calls and the sockets below. */
const jar = new Map<string, string>();

/** A model that calls `tool` once for the first user message, then answers "Done". */
function caller(tool: string, args: unknown[], gateSecond?: Promise<void>): ModelProvider {
  let ids = 0;
  let seen = 0;
  return {
    id: "scripted",
    listModels: async () => [],
    capabilities: () => ({ tools: true, usageInStream: true }),
    async *stream(request): AsyncGenerator<ModelEvent> {
      const last = request.messages.at(-1);
      if (last?.role === "user" && seen++ === 0) {
        yield { type: "text.delta", text: "approved" }; // the model's word runs nothing
        for (const a of args) {
          yield {
            type: "tool_call",
            toolCall: { id: `call_${++ids}`, name: tool, arguments: JSON.stringify(a) },
          };
        }
        yield { type: "usage", usage: USAGE };
        yield { type: "done", finishReason: "tool_calls" };
        return;
      }
      if (last?.role === "user") await gateSecond;
      yield { type: "text.delta", text: "Done" };
      yield { type: "usage", usage: USAGE };
      yield { type: "done", finishReason: "stop" };
    },
  };
}

function gated(name: string, riskClass: RiskClass) {
  const inputs: unknown[] = [];
  const tool: LoopTool = {
    manifest: {
      name,
      description: `The ${name} tool.`,
      inputSchema: {
        type: "object",
        properties: { to: { type: "string" } },
        required: ["to"],
        additionalProperties: false,
      },
      riskClass,
      destinations: [{ id: "mail", kind: "third_party", dataEgress: true }],
      scopes: [],
    },
    target: (input) => String(input.to).split("@")[1],
    execute: async (input) => {
      inputs.push(input);
      return { ok: true, content: "sent", context: { kind: "system" } };
    },
  };
  return { tool, inputs };
}

/** The owner's assistant with the model and tools stubbed, like the Worker's `stopAt`. */
function stubTurnTools(gateSecond?: Promise<void>) {
  const send = gated("send", "consequential");
  // Built once: the provider counts the user messages it has seen, so only the first turns
  // into the tool call and a later one waits at the gate.
  const provider = caller("send", [{ to: "friend@example.com" }], gateSecond);
  const assistant = app.assistantFor(userId);
  assistant.resolveModel = async () => ({ provider, model: "m", apiKey: null });
  assistant.resolveTools = () => {
    const tools = new ToolRegistry<LoopTool>();
    tools.register(send.tool);
    return { tools, policy: () => ({}) };
  };
  return send;
}

let userId = "";

beforeAll(async () => {
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

  const token = SECRETS.OPA_SETUP_TOKEN;
  const optionsRes = await post("/setup/options", { token });
  expect(optionsRes.status).toBe(200);
  const { options } = (await optionsRes.json()) as { options: { challenge: string } };
  const credential = await new SoftPasskey(new URL(PUBLIC).hostname, PUBLIC).create(options);
  expect((await post("/setup", { token, credential })).status).toBe(200);
  expect(await (await get("/api/me")).json()).toMatchObject({ role: "owner" });

  // The claim created the only user; the socket route reaches their assistant by session, so
  // the stub reaches the same instance by this ID.
  const row = (app.db as DatabaseSync).prepare("SELECT id FROM users").get() as { id: string };
  userId = row.id;
}, 60_000);

afterAll(async () => {
  for (const client of wss.clients) client.close(1001, "test done");
  await app.shutdown();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  app.db.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(assetsDir, { recursive: true, force: true });
}, 60_000);

/** An API request with the owner's cookies, saving any the response sets. */
async function get(path: string): Promise<Response> {
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(`${base}${path}`, { headers: { origin: PUBLIC, cookie } });
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

async function openSocket(): Promise<{ ws: WebSocket; frames: HarnessEvent[] }> {
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
  return { ws, frames };
}

/** Sends a message and waits until the turn stops at its approval. */
async function stopAt(conversationId: string) {
  const { ws, frames } = await openSocket();
  ws.send(JSON.stringify({ type: "chat.send", conversationId, text: "Mail my friend" }));
  await vi.waitFor(() => expect(frames.map((f) => f.type)).toContain("approval.requested"), {
    timeout: 15_000,
  });
  const asked = frames.find((f) => f.type === "approval.requested") as Extract<
    HarnessEvent,
    { type: "approval.requested" }
  >;
  const { batchId } = asked.payload;
  const approvalId = asked.payload.items[0]?.approvalId as string;
  const done = () =>
    vi.waitFor(() => expect(frames.map((f) => f.type)).toContain("turn.completed"), {
      timeout: 15_000,
    });
  return { batchId, approvalId, ws, frames, done };
}

const rowStatus = (batchId: string) =>
  (
    (app.db as DatabaseSync)
      .prepare("SELECT status FROM approvals WHERE batch_id = ?")
      .get(batchId) as { status: string }
  ).status;

describe("approval resume on Node", () => {
  it("approves over POST: the turn resumes and the call runs", async () => {
    const send = stubTurnTools();
    const { batchId, approvalId, ws, done } = await stopAt("conv-approve");
    try {
      expect(send.inputs).toEqual([]); // the model's word ran nothing

      // The Inbox lists the parked batch as its card shows it.
      const listed = await get("/api/approvals?status=pending");
      expect(listed.status).toBe(200);
      expect(listed.headers.get("cache-control")).toBe("no-store");
      const { batches } = (await listed.json()) as {
        batches: { batchId: string; items: { approvalId: string; tool: string }[] }[];
      };
      expect(batches.map((b) => b.batchId)).toContain(batchId);
      expect(batches.find((b) => b.batchId === batchId)?.items).toMatchObject([
        { approvalId, tool: "send" },
      ]);

      const res = await post(`/api/approvals/${batchId}`, {
        decisions: [{ approvalId, decision: "approve", scope: "once" }],
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "resumed" });
      await done();
      expect(send.inputs).toEqual([{ to: "friend@example.com" }]);
      expect(rowStatus(batchId)).toBe("executed");

      // A second POST, a retry or another tab, decides nothing.
      const again = await post(`/api/approvals/${batchId}`, {
        decisions: [{ approvalId, decision: "approve", scope: "once" }],
      });
      expect(again.status).toBe(409);
      expect(send.inputs).toHaveLength(1);

      // Decided, so the pending list drops it.
      expect(await (await get("/api/approvals?status=pending")).json()).toEqual({ batches: [] });
    } finally {
      ws.close();
    }
  });

  it("denies: the call never runs and the model is told so", async () => {
    const send = stubTurnTools();
    const { batchId, approvalId, ws, frames, done } = await stopAt("conv-deny");
    try {
      const res = await post(`/api/approvals/${batchId}`, {
        decisions: [{ approvalId, decision: "deny" }],
      });
      expect(res.status).toBe(200);
      await done();
      expect(send.inputs).toEqual([]);
      expect(rowStatus(batchId)).toBe("denied");
      const results = frames.filter((f) => f.type === "tool.result");
      expect(results.at(-1)).toMatchObject({ payload: { error: "The user denied this call." } });
    } finally {
      ws.close();
    }
  });

  it("answers gone for a batch that was never parked", async () => {
    stubTurnTools();
    await expect(app.assistantFor(userId).resumeBatch("batch_missing")).resolves.toBe("gone");
  });

  it("answers gone once the parked turn has settled", async () => {
    stubTurnTools();
    const { batchId, approvalId, ws, done } = await stopAt("conv-gone");
    try {
      const res = await post(`/api/approvals/${batchId}`, {
        decisions: [{ approvalId, decision: "approve", scope: "once" }],
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "resumed" });
      await done();
      // Settled, so no awaiting turn waits on the batch anymore.
      await expect(app.assistantFor(userId).resumeBatch(batchId)).resolves.toBe("gone");
    } finally {
      ws.close();
    }
  });

  it("queues a decision that lands mid-turn, then runs it late at the chat's end", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = stubTurnTools(gate);
    const { batchId, approvalId, ws, frames } = await stopAt("conv-late");
    try {
      const oldTurnId = frames.find((f) => f.type === "turn.started")?.turnId;
      expect(oldTurnId).toBeTruthy();

      // The conversation moves on while the approval waits: a second turn starts and runs.
      ws.send(
        JSON.stringify({ type: "chat.send", conversationId: "conv-late", text: "Meanwhile hello" }),
      );
      await vi.waitFor(
        () => expect(frames.filter((f) => f.type === "turn.started")).toHaveLength(2),
        { timeout: 15_000 },
      );

      // Decided while that turn holds the slot, so the resume queues behind it.
      const res = await post(`/api/approvals/${batchId}`, {
        decisions: [{ approvalId, decision: "approve", scope: "once" }],
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "queued" });
      expect(send.inputs).toEqual([]); // nothing ran while the turn held the slot
      release();

      // The second turn, the old turn settling where it stopped, then the late turn at the end.
      await vi.waitFor(
        () => expect(frames.filter((f) => f.type === "turn.completed")).toHaveLength(3),
        { timeout: 15_000 },
      );
      expect(send.inputs).toEqual([{ to: "friend@example.com" }]);
      const completed = frames.filter((f) => f.type === "turn.completed");
      expect(completed.map((f) => f.turnId)).toContain(oldTurnId);
      expect(new Set(completed.map((f) => f.turnId)).size).toBe(3);

      // The move left a thread line naming the original request.
      const thread = (app.db as DatabaseSync)
        .prepare("SELECT content FROM messages WHERE conversation_id = ?")
        .all("conv-late") as { content: string }[];
      expect(thread.map((m) => m.content).join("\n")).toContain("Approved later: send, from");
    } finally {
      ws.close();
    }
  });
});
