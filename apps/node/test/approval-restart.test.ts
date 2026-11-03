// SPDX-License-Identifier: Apache-2.0
// Approval resume across a restart: a decision that queued mid-turn is lost with the
// in-memory queue, so the next start's recovery re-queues it; a shutdown never starts the
// queued drive underneath the database close; and the sweep spares a parked approval's
// reply instead of marking it interrupted.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { serve, type WebSocketServerLike } from "@hono/node-server";
import type { HarnessEvent, ModelEvent, ModelProvider } from "@opa/core";
import type { LoopTool } from "@opa/harness-builtin";
import { type RiskClass, ToolRegistry } from "@opa/policy";
import { SoftPasskey } from "@opa/server/test/softauthn";
import { afterAll, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createNodeApp, type NodeApp } from "../src/compose";

const PUBLIC = "https://agent.example";
const SECRETS = {
  OPA_MASTER_KEY: Buffer.alloc(32, 11).toString("base64"),
  OPA_SESSION_SECRET: "approval-restart-session-secret-012345",
  OPA_SETUP_TOKEN: "approval-restart-setup-token-0123456789",
};

const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningTokens: 0 };

interface RunningApp {
  app: NodeApp;
  base: string;
  server: ReturnType<typeof serve>;
  wss: WebSocketServer;
  dataDir: string;
  assetsDir: string;
}

const running: RunningApp[] = [];
/** The owner's session cookies, shared by every app on the same database. */
const jar = new Map<string, string>();

async function boot(dataDir: string): Promise<RunningApp> {
  const assetsDir = mkdtempSync(join(tmpdir(), "opa-approval-restart-assets-"));
  const app = createNodeApp({
    dataDir,
    migrationsDir: join(import.meta.dirname, "../../../migrations"),
    assetsDir,
    vars: { ...SECRETS },
    publicOrigin: PUBLIC,
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  let base = "";
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve(
      {
        fetch: app.fetch,
        hostname: "127.0.0.1",
        port: 0,
        websocket: { server: wss as unknown as WebSocketServerLike },
      },
      (info) => {
        base = `http://127.0.0.1:${info.port}`;
        resolve(s);
      },
    );
  });
  const out = { app, base, server, wss, dataDir, assetsDir };
  running.push(out);
  return out;
}

afterAll(async () => {
  for (const r of running) {
    for (const client of r.wss.clients) client.close(1001, "test done");
  }
  for (const r of running) await r.app.shutdown().catch(() => {});
  for (const r of running) await new Promise<void>((resolve) => r.wss.close(() => resolve()));
  for (const r of running) await new Promise<void>((resolve) => r.server.close(() => resolve()));
  for (const r of running) r.app.db.close();
  for (const r of running) {
    rmSync(r.dataDir, { recursive: true, force: true });
    rmSync(r.assetsDir, { recursive: true, force: true });
  }
}, 60_000);

function saveCookies(res: Response): void {
  for (const c of res.headers.getSetCookie()) {
    const [name = "", value = ""] = (c.split(";")[0] ?? "").split("=");
    jar.set(name, value);
  }
}

async function get(base: string, path: string): Promise<Response> {
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(`${base}${path}`, { headers: { origin: PUBLIC, cookie } });
  saveCookies(res);
  return res;
}

async function post(base: string, path: string, body: unknown): Promise<Response> {
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { origin: PUBLIC, cookie },
  });
  saveCookies(res);
  return res;
}

/** The owner claim, once per database: later apps on the same directory reuse the session. */
async function claim(base: string): Promise<void> {
  const token = SECRETS.OPA_SETUP_TOKEN;
  const optionsRes = await post(base, "/setup/options", { token });
  expect(optionsRes.status).toBe(200);
  const { options } = (await optionsRes.json()) as { options: { challenge: string } };
  const credential = await new SoftPasskey(new URL(PUBLIC).hostname, PUBLIC).create(options);
  expect((await post(base, "/setup", { token, credential })).status).toBe(200);
  expect(await (await get(base, "/api/me")).json()).toMatchObject({ role: "owner" });
}

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
        yield { type: "text.delta", text: "approved" };
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

/** A model that never calls: the post-restart turn just runs and ends. */
function answerer(): ModelProvider {
  return {
    id: "scripted",
    listModels: async () => [],
    capabilities: () => ({ tools: true, usageInStream: true }),
    async *stream(): AsyncGenerator<ModelEvent> {
      yield { type: "text.delta", text: "Noted" };
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

function stub(app: NodeApp, userId: string, provider: ModelProvider, tool: LoopTool): void {
  const assistant = app.assistantFor(userId);
  assistant.resolveModel = async () => ({ provider, model: "m", apiKey: null });
  assistant.resolveTools = () => {
    const tools = new ToolRegistry<LoopTool>();
    tools.register(tool);
    return { tools, policy: () => ({}) };
  };
}

async function openSocket(base: string): Promise<{ ws: WebSocket; frames: HarnessEvent[] }> {
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
async function stopAt(base: string, conversationId: string, text = "Mail my friend") {
  const { ws, frames } = await openSocket(base);
  ws.send(JSON.stringify({ type: "chat.send", conversationId, text }));
  await vi.waitFor(() => expect(frames.map((f) => f.type)).toContain("approval.requested"), {
    timeout: 15_000,
  });
  const asked = frames.find((f) => f.type === "approval.requested") as Extract<
    HarnessEvent,
    { type: "approval.requested" }
  >;
  const started = frames.find((f) => f.type === "turn.started");
  return {
    batchId: asked.payload.batchId,
    approvalId: asked.payload.items[0]?.approvalId as string,
    replyId: started && "messageId" in started.payload ? started.payload.messageId : "",
    turnId: started?.turnId as string,
    ws,
    frames,
  };
}

const messageStatus = (db: DatabaseSync, replyId: string) =>
  (
    db.prepare("SELECT status FROM messages WHERE id = ?").get(replyId) as {
      status: string;
    }
  ).status;

const turnRow = (db: DatabaseSync, turnId: string) =>
  db.prepare("SELECT status FROM turn_states WHERE turn_id = ?").get(turnId) as
    | { status: string }
    | undefined;

describe("approval resume across a restart", () => {
  it("a shutdown never runs the queued batch, and the restart resumes it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "opa-approval-restart-"));
    const first = await boot(dataDir);
    await claim(first.base);
    const userId = (first.app.db.prepare("SELECT id FROM users").get() as { id: string }).id;

    // Park a turn at its approval, then decide it while another turn holds the slot.
    // One provider instance for both turns: the first user message turns into the gated
    // call, the second waits at the gate while holding the slot.
    const { tool, inputs } = gated("send", "consequential");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stub(first.app, userId, caller("send", [{ to: "friend@example.com" }], gate), tool);
    const parked = await stopAt(first.base, "conv-restart");
    parked.ws.send(
      JSON.stringify({ type: "chat.send", conversationId: "conv-restart", text: "Meanwhile" }),
    );
    await vi.waitFor(
      () => expect(parked.frames.filter((f) => f.type === "turn.started")).toHaveLength(2),
      { timeout: 15_000 },
    );
    const res = await post(first.base, `/api/approvals/${parked.batchId}`, {
      decisions: [{ approvalId: parked.approvalId, decision: "approve", scope: "once" }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "queued" });
    expect(inputs).toEqual([]);

    // Shutting down with the batch queued starts no drive: the call never runs, the
    // decisions stay in D1, and the turn stays parked for the next start.
    const stopping = first.app.shutdown();
    release();
    await stopping;
    expect(inputs).toEqual([]);
    expect(turnRow(first.app.db, parked.turnId)?.status).toBe("awaiting_approval");
    parked.ws.close();

    // A new process on the same database: recovery spares the parked reply (still
    // streaming, not interrupted) and re-queues the decided batch.
    const second = await boot(dataDir);
    const assistant = second.app.assistantFor(userId);
    const send2 = gated("send", "consequential");
    stub(second.app, userId, answerer(), send2.tool);
    await assistant.recover();
    expect(messageStatus(second.app.db, parked.replyId)).toBe("streaming");

    // The next turn ends, the queued batch resumes into it, and the approved call runs
    // late at the chat's end: the new turn, the old turn settling where it stopped, then
    // the late turn.
    const { ws, frames } = await openSocket(second.base);
    try {
      ws.send(JSON.stringify({ type: "chat.send", conversationId: "conv-restart", text: "After" }));
      await vi.waitFor(
        () => expect(frames.filter((f) => f.type === "turn.completed")).toHaveLength(3),
        { timeout: 20_000 },
      );
      expect(send2.inputs).toEqual([{ to: "friend@example.com" }]);
      expect(messageStatus(second.app.db, parked.replyId)).toBe("complete");
    } finally {
      ws.close();
    }
  }, 90_000);

  it("a restart spares the parked reply of a batch still waiting on the user", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "opa-approval-restart-undecided-"));
    const first = await boot(dataDir);
    await claim(first.base);
    const userId = (first.app.db.prepare("SELECT id FROM users").get() as { id: string }).id;

    const { tool } = gated("send", "consequential");
    stub(first.app, userId, caller("send", [{ to: "friend@example.com" }]), tool);
    const parked = await stopAt(first.base, "conv-waiting");
    parked.ws.close();
    await first.app.shutdown();

    // Nothing was decided: recovery spares the reply, parks nothing to resume, and the
    // Inbox still lists the batch for the user to decide.
    const second = await boot(dataDir);
    const assistant = second.app.assistantFor(userId);
    await assistant.recover();
    expect(messageStatus(second.app.db, parked.replyId)).toBe("streaming");
    expect(turnRow(second.app.db, parked.turnId)?.status).toBe("awaiting_approval");
    const listed = await get(second.base, "/api/approvals?status=pending");
    expect(listed.status).toBe(200);
    const { batches } = (await listed.json()) as { batches: { batchId: string }[] };
    expect(batches.map((b) => b.batchId)).toContain(parked.batchId);
  }, 90_000);
});
