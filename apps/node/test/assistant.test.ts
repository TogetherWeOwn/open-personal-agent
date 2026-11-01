// SPDX-License-Identifier: Apache-2.0
// The Node assistant (M3-23a AC1): the Limits counters and the event log over SQLite, and one
// user's serialised turns with the same frames and `resume` replay as the Worker's DO.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { HarnessEvent, ModelEvent, ModelProvider } from "@opa/core";
import { afterAll, describe, expect, it, vi } from "vitest";
import { NodeEventLog, SqliteKv } from "../src/assistant";
import { createNodeApp } from "../src/compose";

const dir = mkdtempSync(join(tmpdir(), "opa-assistant-"));
const vars = {
  OPA_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  OPA_SESSION_SECRET: "assistant-test-session-secret-0123456789",
  OPA_SETUP_TOKEN: "assistant-test-setup-token-0123456789",
};
const app = createNodeApp({
  dataDir: dir,
  migrationsDir: join(import.meta.dirname, "../../../migrations"),
  assetsDir: dir,
  vars,
});
afterAll(() => {
  app.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const USAGE = { inputTokens: 12, outputTokens: 3, cachedInputTokens: 0, reasoningTokens: 0 };

/** A model that replies "Hello there". A gate holds it mid-reply; `early` holds it first. */
function scripted(gate?: Promise<void>, early = false): ModelProvider {
  return {
    id: "scripted",
    listModels: async () => [],
    capabilities: () => ({ tools: false, usageInStream: true }),
    async *stream(): AsyncGenerator<ModelEvent> {
      const held = () => gate;
      if (early) await held();
      yield { type: "text.delta", text: "Hello" };
      await held();
      yield { type: "text.delta", text: " there" };
      yield { type: "usage", usage: USAGE };
      yield { type: "done", finishReason: "stop" };
    },
  };
}

let users = 0;
/** A user with a live session, and their assistant with the model stubbed. */
function setup(model?: ModelProvider) {
  users += 1;
  const userId = `assistant-user-${users}`;
  const sessionId = `session-${userId}`;
  const now = Date.now();
  const db = app.db as DatabaseSync;
  db.prepare("INSERT INTO users (id, display_name, role) VALUES (?, 'Test', 'owner')").run(userId);
  db.prepare(
    "INSERT INTO sessions (id, user_id, token_hash, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
  ).run(sessionId, userId, `hash-${sessionId}`, now + 3_600_000, now);
  const assistant = app.assistantFor(userId);
  assistant.resolveModel = async () => ({
    provider: model ?? scripted(),
    model: "test-model",
    apiKey: null,
  });
  return { userId, sessionId, assistant };
}

/** A tab's socket, collecting the frames it receives. */
function socket() {
  const sent: string[] = [];
  let closed: { code: number | undefined; reason: string | undefined } | null = null;
  return {
    sent,
    closed: () => closed,
    send: (data: string) => void sent.push(data),
    close: (code?: number, reason?: string) => {
      closed = { code, reason };
    },
  };
}

const send = (conversationId: string, text: string) =>
  JSON.stringify({ type: "chat.send", conversationId, text });
const events = (sock: ReturnType<typeof socket>) =>
  sock.sent.map((frame) => JSON.parse(frame) as HarnessEvent);
const ofType = (sock: ReturnType<typeof socket>, type: HarnessEvent["type"]) =>
  events(sock).filter((event) => event.type === type);
const until = (sock: ReturnType<typeof socket>, type: HarnessEvent["type"]) =>
  vi.waitFor(() => expect(ofType(sock, type)).toHaveLength(1), { timeout: 10_000 });

describe("SqliteKv", () => {
  it("round-trips JSON per user, like the DO's KV", () => {
    const kv = new SqliteKv(app.db, "kv-user");
    expect(kv.get("missing")).toBeUndefined();
    kv.put("limits", { turns: [1, 2, 3] });
    expect(kv.get<{ turns: number[] }>("limits")).toEqual({ turns: [1, 2, 3] });
    kv.put("limits", { turns: [] });
    expect(kv.get("limits")).toEqual({ turns: [] });
    // Another user's counters are untouched.
    expect(new SqliteKv(app.db, "kv-other").get("limits")).toBeUndefined();
  });
});

describe("NodeEventLog", () => {
  it("numbers frames per conversation and replays a turn after a seq", () => {
    const log = new NodeEventLog(app.db, "log-user");
    const first = log.append("conv-1", "turn-1", (seq) => `a:${seq}`);
    const second = log.append("conv-1", "turn-1", (seq) => `b:${seq}`);
    expect([first, second]).toEqual(["a:1", "b:2"]);
    // Another conversation counts from its own start.
    expect(log.append("conv-2", "turn-2", (seq) => `c:${seq}`)).toBe("c:1");
    expect(log.replay("conv-1", "turn-1", 0)).toEqual(["a:1", "b:2"]);
    expect(log.replay("conv-1", "turn-1", 1)).toEqual(["b:2"]);
    expect(log.replay("conv-1", "turn-1", 2)).toEqual([]);
    // Another user's log never leaks in.
    expect(new NodeEventLog(app.db, "log-other").replay("conv-1", "turn-1", 0)).toEqual([]);
  });

  it("drops a settled turn but keeps the conversation's seq", () => {
    const log = new NodeEventLog(app.db, "trim-user");
    log.append("conv-1", "turn-1", (seq) => `a:${seq}`);
    log.trim("conv-1", "turn-1");
    expect(log.replay("conv-1", "turn-1", 0)).toEqual([]);
    expect(log.append("conv-1", "turn-2", (seq) => `b:${seq}`)).toBe("b:2");
  });
});

describe("NodeAssistant recovery", () => {
  const PRICED = {
    provider: "workers-ai",
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  } as const;

  /**
   * A user whose dead turn is seeded before their assistant first runs its restart sweep: the
   * seeding is synchronous, so it lands before the sweep's first awaited query resolves.
   */
  function seedDeadTurn() {
    users += 1;
    const userId = `assistant-recover-${users}`;
    const conversationId = `conv-dead-${users}`;
    const replyId = `reply-dead-${users}`;
    const db = app.db as DatabaseSync;
    db.prepare("INSERT INTO users (id, display_name, role) VALUES (?, 'Test', 'owner')").run(
      userId,
    );
    db.prepare("INSERT INTO conversations (id, user_id, title) VALUES (?, ?, ?)").run(
      conversationId,
      userId,
      "Dead",
    );
    db.prepare(
      "INSERT INTO messages (id, user_id, conversation_id, seq, role, status, content) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(replyId, userId, conversationId, 1, "assistant", "streaming", "half-written");
    const assistant = app.assistantFor(userId);
    const reservation = assistant.limits.reserve(
      `dead-turn-${users}:0`,
      PRICED.provider,
      PRICED.model,
      100,
    );
    expect(reservation).not.toBeNull();
    expect(assistant.limits.totals().heldMicroUsd).toBeGreaterThan(0);
    return { userId, replyId, assistant };
  }

  it("interrupts a dead turn's reply and releases its hold on startup", async () => {
    const { replyId, assistant } = seedDeadTurn();
    await assistant.recover();

    expect(assistant.limits.totals().heldMicroUsd).toBe(0);
    expect(
      (app.db as DatabaseSync)
        .prepare("SELECT status, content FROM messages WHERE id = ?")
        .get(replyId),
    ).toEqual({ status: "interrupted", content: "half-written" });
  });

  it("keeps a stopped turn's reply and hold for its resume", async () => {
    const { userId, replyId, assistant } = seedDeadTurn();
    const db = app.db as DatabaseSync;
    db.prepare("INSERT INTO conversations (id, user_id, title) VALUES (?, ?, ?)").run(
      "conv-stop",
      userId,
      "Stopped",
    );
    db.prepare(
      "INSERT INTO messages (id, user_id, conversation_id, seq, role, status, content) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("reply-stop", userId, "conv-stop", 1, "assistant", "streaming", "partial");
    db.prepare(
      "INSERT INTO turn_states (turn_id, user_id, conversation_id, reply_id, provider_id, model, status, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "stop-turn",
      userId,
      "conv-stop",
      "reply-stop",
      PRICED.provider,
      PRICED.model,
      "awaiting_approval",
      "{}",
    );
    const reservation = assistant.limits.reserve("stop-turn:0", PRICED.provider, PRICED.model, 100);
    expect(reservation).not.toBeNull();

    await assistant.recover();

    // The stopped turn's hold stays for its resume, and its reply stays streaming with the
    // checkpointed text; only the dead turn without a saved stop was settled.
    expect(assistant.limits.totals().heldMicroUsd).toBeGreaterThan(0);
    expect(
      db.prepare("SELECT status, content FROM messages WHERE id = ?").get("reply-stop"),
    ).toEqual({ status: "streaming", content: "partial" });
    expect(db.prepare("SELECT status FROM messages WHERE id = ?").get(replyId)).toEqual({
      status: "interrupted",
    });
  });
});

describe("NodeAssistant shutdown", () => {
  it("closes tabs and refuses new sends", async () => {
    const { sessionId, assistant } = setup();
    const tab = socket();
    const conn = assistant.open(tab, sessionId, false);
    await assistant.shutdown();

    expect(tab.closed()).toMatchObject({ code: 1001, reason: "server shutdown" });
    assistant.message(conn, send("conv-shut", "Hello"));
    expect(ofType(tab, "turn.failed").at(-1)?.payload).toMatchObject({
      message: "The server is shutting down.",
    });
  });

  it("settles the running turn instead of hanging", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { sessionId, assistant } = setup(scripted(gate, true));
    const tab = socket();
    const conn = assistant.open(tab, sessionId, false);
    assistant.message(conn, send("conv-shut-turn", "Hello"));
    await until(tab, "turn.started");

    const stopping = assistant.shutdown();
    release();
    await stopping;

    expect(tab.closed()).toMatchObject({ code: 1001 });
  });
});

describe("NodeAssistant", () => {
  it("completes a text turn with the turn's frames in order", async () => {
    const { userId, sessionId, assistant } = setup();
    const tab = socket();
    const conn = assistant.open(tab, sessionId, false);
    assistant.message(conn, send("conv-text", "Hello"));
    await until(tab, "turn.completed");

    const frames = events(tab);
    expect(frames.map((event) => event.type)).toEqual([
      "turn.started",
      "step.started",
      "message.delta",
      "message.delta",
      "usage.updated",
      "message.completed",
      "step.completed",
      "turn.completed",
    ]);
    expect(frames.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const started = frames[0];
    expect(started?.turnId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(frames.every((event) => event.turnId === started?.turnId)).toBe(true);
    const completed = ofType(tab, "turn.completed")[0];
    expect(completed?.seq).toBe(8);

    // The reply and one ledger row are in D1, and the turn's log is trimmed: tabs reload
    // from D1 now.
    const db = app.db as DatabaseSync;
    const rows = db
      .prepare("SELECT role, status, content FROM messages WHERE conversation_id = ? ORDER BY seq")
      .all("conv-text") as { role: string; status: string; content: string }[];
    expect(rows).toEqual([
      { role: "user", status: "complete", content: "Hello" },
      { role: "assistant", status: "complete", content: "Hello there" },
    ]);
    const calls = db
      .prepare(
        "SELECT provider_id, model, input_tokens, output_tokens FROM usage WHERE conversation_id = ?",
      )
      .all("conv-text") as Record<string, unknown>[];
    expect(calls).toEqual([
      { provider_id: "scripted", model: "test-model", input_tokens: 12, output_tokens: 3 },
    ]);
    expect(
      db.prepare("SELECT count(*) AS n FROM node_assistant_events WHERE user_id = ?").get(userId),
    ).toMatchObject({ n: 0 });
  });

  it("rejects a second send while a turn runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { sessionId, assistant } = setup(scripted(gate, true));
    const tab = socket();
    const conn = assistant.open(tab, sessionId, false);
    assistant.message(conn, send("conv-busy", "First"));
    await until(tab, "turn.started");

    assistant.message(conn, send("conv-busy", "Second"));
    const rejected = ofType(tab, "turn.failed");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.payload).toMatchObject({
      message: "Another reply is still being written.",
    });
    // The refused send never started a turn: a reconnect replays nothing for it.
    expect(rejected[0]?.seq).toBe(0);

    release();
    await until(tab, "turn.completed");
  });

  it("replays a running turn to a reconnected tab without repeating it live", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { sessionId, assistant } = setup(scripted(gate));
    const first = socket();
    const conn1 = assistant.open(first, sessionId, false);
    assistant.message(conn1, send("conv-resume", "Hello"));
    await until(first, "message.delta");

    // The second tab reconnects mid-turn and replays from the start.
    const second = socket();
    const conn2 = assistant.open(second, sessionId, true);
    const turnId = ofType(first, "turn.started")[0]?.turnId;
    expect(turnId).toBeTruthy();
    assistant.message(
      conn2,
      JSON.stringify({ type: "resume", conversationId: "conv-resume", turnId, afterSeq: 0 }),
    );
    await vi.waitFor(() => expect(second.sent.length).toBeGreaterThan(0), { timeout: 10_000 });

    release();
    await until(first, "turn.completed");
    await until(second, "turn.completed");

    // The replay carried the frames so far, and the live remainder followed exactly once each.
    const replayed = events(second).map((event) => event.seq);
    expect(replayed[0]).toBe(1);
    expect(new Set(replayed).size).toBe(replayed.length);
    expect(replayed).toEqual([...replayed].sort((a, b) => a - b));
    expect(ofType(second, "turn.completed")).toHaveLength(1);
  });
});
