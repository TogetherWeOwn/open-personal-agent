// SPDX-License-Identifier: Apache-2.0
// The per-user assistant on Node (M3-23a AC1): the same port as the Worker's Durable Object
// (`apps/worker/src/assistant.ts`) — one instance per user, serialised turns, the same v:1 event
// log and `resume` frame — over Node adapters. `node:sqlite` holds the event log and the
// `Limits` counters (one row set per user, since the database is shared); the loop, the
// repository and the model resolution are the same code the DO runs.
import type { DatabaseSync } from "node:sqlite";
import { upgradeWebSocket } from "@hono/node-server";
import type { HarnessEvent, ModelAttachment, ModelMessage, ModelProvider } from "@opa/core";
import {
  type AttachmentRow,
  createRepository,
  isId,
  scopeForAssistant,
  type TurnStatus,
  type UserScope,
} from "@opa/db/repository";
import { systemStore } from "@opa/db/system";
import {
  type Budget,
  bindBatch,
  type LoopEvent,
  type LoopHost,
  type LoopTool,
  newTurn,
  runTurn,
  type TurnState,
} from "@opa/harness-builtin";
import { ToolRegistry } from "@opa/policy";
import { resolveChatModel } from "@opa/server/chat-model";
import {
  base64,
  type CallUsage,
  type Emit,
  type FrameSender,
  fileTokenEstimate,
  MAX_ATTACHMENT_TEXT,
  MAX_TEXT,
  MODEL_ERRORS,
  messageChars,
  messageFileTokens,
  modelBytes,
  parse,
  pickUsage,
  readPrefix,
  reject,
  replySegments,
  TEXT_READ_BYTES,
  TURN_FILE_BYTES,
  UNREAD,
} from "@opa/server/chat-protocol";
import type { AppEnv, Env } from "@opa/server/env";
import { Limits } from "@opa/server/limits";
import { sameOrigin } from "@opa/server/security";
import { Hono } from "hono";
import type { WSContext } from "hono/ws";

/** A tab's socket, as the route adapts the upgrade to it. */
export interface NodeSocket extends FrameSender {
  close(code?: number, reason?: string): void;
}

/** A connected tab, as the assistant tracks it. */
export interface NodeConnection {
  id: number;
  socket: NodeSocket;
  sessionId: string | null;
  replaying: boolean;
}

/**
 * The `Limits` counters over SQLite (M3-23a AC1). One table for every user, with the same JSON
 * values the DO's KV holds, read and written synchronously so counts stay exact.
 */
export class SqliteKv {
  constructor(
    private readonly db: DatabaseSync,
    private readonly userId: string,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS node_assistant_kv (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (user_id, key)
    )`);
  }

  get<T = unknown>(key: string): T | undefined {
    const row = this.db
      .prepare("SELECT value FROM node_assistant_kv WHERE user_id = ? AND key = ?")
      .get(this.userId, key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  put<T>(key: string, value: T): void {
    this.db
      .prepare(
        `INSERT INTO node_assistant_kv (user_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value`,
      )
      .run(this.userId, key, JSON.stringify(value));
  }
}

/**
 * The per-conversation event log (M3-03 AC10), mirroring the DO's `EventLog`: every broadcast
 * event is stored first under a `seq` that never restarts per turn, so a tab that drops its
 * socket can replay what it missed. Scoped per user, since the database is shared. Synchronous,
 * and the process single-threaded: nothing can slip between the counter bump and the insert.
 */
export class NodeEventLog {
  constructor(
    private readonly db: DatabaseSync,
    private readonly userId: string,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS node_assistant_events (
      user_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      turn_id TEXT NOT NULL,
      frame TEXT NOT NULL,
      PRIMARY KEY (user_id, conversation_id, seq)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS node_assistant_seq (
      user_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      last_seq INTEGER NOT NULL,
      PRIMARY KEY (user_id, conversation_id)
    )`);
  }

  append(conversationId: string, turnId: string, build: (seq: number) => string): string {
    const { last_seq: seq } = this.db
      .prepare(
        `INSERT INTO node_assistant_seq (user_id, conversation_id, last_seq) VALUES (?, ?, 1)
         ON CONFLICT (user_id, conversation_id) DO UPDATE SET last_seq = last_seq + 1
         RETURNING last_seq`,
      )
      .get(this.userId, conversationId) as { last_seq: number };
    const frame = build(seq);
    this.db
      .prepare(
        `INSERT INTO node_assistant_events (user_id, conversation_id, seq, turn_id, frame)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(this.userId, conversationId, seq, turnId, frame);
    return frame;
  }

  /** A turn's stored frames after `afterSeq`, in order. Empty once the turn has settled. */
  replay(conversationId: string, turnId: string, afterSeq: number): string[] {
    return (
      this.db
        .prepare(
          `SELECT frame FROM node_assistant_events
           WHERE user_id = ?1 AND conversation_id = ?2 AND turn_id = ?3 AND seq > ?4
           ORDER BY seq LIMIT 100000`,
          // Far beyond any turn the limits allow, as the DO's REPLAY_LIMIT.
        )
        .all(this.userId, conversationId, turnId, afterSeq) as { frame: string }[]
    ).map(({ frame }) => frame);
  }

  /** Drops a settled turn's rows. The conversation's counter stays, so `seq` never restarts. */
  trim(conversationId: string, turnId: string): void {
    this.db
      .prepare(
        `DELETE FROM node_assistant_events
         WHERE user_id = ? AND conversation_id = ? AND turn_id = ?`,
      )
      .run(this.userId, conversationId, turnId);
  }
}

/** A stored message as `listMessages` returns it, with its attachments. */
type StoredMessage = NonNullable<
  Awaited<
    ReturnType<ReturnType<ReturnType<typeof createRepository>["forUser"]>["chat"]["listMessages"]>
  >
>[number];

/** A live frame held back from a replaying tab, with what its replay may already have sent. */
interface HeldFrame {
  conversationId: string;
  seq: number;
  frame: string;
}

/** Live frames held back from one replaying tab, at most: far beyond a turn's. */
const MAX_HELD_FRAMES = 100_000;

/**
 * A running turn's checkpoint: plain JSON. Only a turn that stopped cleanly (approval, limit)
 * has its `TurnState` in D1 to resume from; anything else settles interrupted on restart. The
 * single process is never evicted like a DO, so the stash stays in memory (PR2 persists it for
 * a restart sweep).
 */
interface TurnCheckpoint {
  conversationId: string;
  turnId: string;
  replyId: string;
  /** Who bills the turn's calls (`billingProviderId`). */
  providerId: string;
  model: string;
  /** The reply's text so far: its message segments joined with a blank line. */
  reply: string;
  /** The user's message and the streaming reply are in D1. */
  wrote: boolean;
  /** Budget holds of calls still running, `<turnId>:<n>`, unsettled. */
  holds: string[];
  /** A model call has started, so it belongs in the ledger. */
  callStarted: boolean;
  /** This call's ledger row is written. */
  callRecorded: boolean;
  callUsage: CallUsage | null;
  /** This call's ledger row ID, fixed when it starts, so a retry's write can't add a second. */
  callId?: string;
  /**
   * It runs again from a saved stop, so its `turn_states` row predates this run: the row alone
   * no longer shows that the turn stopped cleanly.
   */
  resumed?: boolean;
  /**
   * When it began saving a stop (approval, limit): a row saved since then is that stop's. A
   * resumed turn's older row is the stop it resumed from.
   */
  stopping?: number;
}

export interface NodeAssistantDeps {
  db: DatabaseSync;
  getEnv: () => Promise<Env>;
}

/**
 * The user's in-process assistant (ADR 0002): one per user, named `u:<userId>` like the DO.
 * Tabs connect over the same `/api/chat` socket protocol (`chat.send`, `turn.cancel`,
 * `resume`), turns run serialised through the same loop, and every event goes to every tab.
 */
export class NodeAssistant {
  /** Picks each turn's model. Tests replace it with a scripted provider. */
  resolveModel = resolveChatModel;
  /**
   * The tools a turn may offer the model, with the policy inputs for them. Tests replace it;
   * the builtin tools (M3-04 and later) register here. Until then a turn offers none.
   */
  resolveTools: () => { tools: ToolRegistry<LoopTool>; policy: LoopHost["policy"] } = () => ({
    tools: new ToolRegistry<LoopTool>(),
    policy: () => ({}),
  });

  readonly #db: DatabaseSync;
  readonly #userId: string;
  readonly #getEnv: () => Promise<Env>;
  readonly #scope: UserScope;
  /** Turn rate and daily spend, in this process's SQLite (M2-22). */
  readonly limits: Limits;
  /** Every broadcast event, per conversation, until its turn settles to D1 (M3-03 AC10). */
  readonly #events: NodeEventLog;
  readonly #tabs = new Map<number, NodeConnection>();
  #nextId = 1;
  /** Live frames each replaying tab hasn't been sent yet, by connection ID (see `#endReplay`). */
  readonly #held = new Map<number, HeldFrame[]>();
  #running: AbortController | null = null;
  /** The turn slot's current run, so shutdown can wait for it to settle. */
  #turnPromise: Promise<void> | null = null;
  /** Set once the process starts shutting down: no new turn may start. */
  #closing = false;
  /** The restart sweep, at most once per process; a failure retries on the next turn. */
  #recovery: Promise<void> | null = null;
  /** The latest checkpoint of each turn this process runs. */
  readonly #checkpoints = new Map<string, TurnCheckpoint>();

  constructor(userId: string, deps: NodeAssistantDeps) {
    this.#db = deps.db;
    this.#userId = userId;
    this.#getEnv = deps.getEnv;
    this.#scope = scopeForAssistant(`u:${userId}`);
    this.limits = new Limits(new SqliteKv(deps.db, userId));
    this.#events = new NodeEventLog(deps.db, userId);
  }

  /** Liveness check for `/api/health`. */
  ping(): string {
    return "pong";
  }

  get #repo() {
    return this.#repoFor();
  }

  async #repoFor() {
    return createRepository(await this.#getEnv()).forUser(this.#scope);
  }

  /** A tab opened its socket: hold live frames while it replays, if it is resuming. */
  open(socket: NodeSocket, sessionId: string | null, resume: boolean): NodeConnection {
    const conn: NodeConnection = { id: this.#nextId++, socket, sessionId, replaying: resume };
    this.#tabs.set(conn.id, conn);
    return conn;
  }

  /** A tab went away. */
  close(conn: NodeConnection): void {
    this.#tabs.delete(conn.id);
    this.#held.delete(conn.id);
  }

  /** A frame from a tab: `chat.send`, `turn.cancel` or `resume`. Anything else is ignored. */
  message(conn: NodeConnection, data: unknown): void {
    const msg = parse(data);
    if (msg?.type !== "resume") this.#endReplay(conn);
    // A tab whose session is still live may stop the running turn.
    if (msg?.type === "turn.cancel")
      void this.#sessionLive(conn).then((ok) => ok && this.#running?.abort());
    // A reconnected tab replays what it missed (M3-03 AC11): to this tab only, after the same
    // session recheck, and only from this user's own log — the assistant is named from the
    // session, so a conversation ID from the client can't reach another user's events.
    if (msg?.type === "resume") {
      void this.#sessionLive(conn)
        .then((ok) => {
          if (!ok) return;
          const frames = this.#events.replay(msg.conversationId, msg.turnId, msg.afterSeq);
          try {
            for (const frame of frames) conn.socket.send(frame);
          } catch {
            // The tab went away mid-replay; it will resume again on its next connect.
          }
          // Synchronous since the replay read the log, so no live frame can fall in between.
          const last = frames.at(-1);
          const seq = last ? (JSON.parse(last) as { seq: number }).seq : 0;
          this.#endReplay(conn, {
            conversationId: msg.conversationId,
            seq: Math.max(seq, msg.afterSeq),
          });
        })
        .catch(() => this.#closeLive(conn, 1011, "session check failed"));
      return;
    }
    if (msg?.type !== "chat.send") return;
    if (this.#closing) {
      reject(conn.socket, msg.conversationId, "The server is shutting down.");
      return;
    }
    const text = msg.text.trim();
    // One turn at a time is the concurrency limit: a second send waits for the first.
    if (this.#running) {
      reject(conn.socket, msg.conversationId, "Another reply is still being written.");
    } else if (
      !isId(msg.conversationId) ||
      (!text && !msg.attachmentIds.length) ||
      text.length > MAX_TEXT
    ) {
      reject(conn.socket, "", "That message can't be sent.");
    } else if (!this.limits.startTurn()) {
      const message = "You're sending messages quickly. Wait a minute, then try again.";
      reject(conn.socket, msg.conversationId, message, "slow_down");
    } else {
      const running = new AbortController();
      this.#running = running;
      // The model's failures are reported in the turn; a rejection here is D1 failing. The tab
      // may be gone too (shutdown closes sockets), so that rejection never escapes either.
      const done = this.#turn(
        conn,
        msg.conversationId,
        text,
        msg.model,
        msg.attachmentIds,
        running.signal,
      )
        .catch(() => {
          try {
            reject(conn.socket, msg.conversationId, "The reply couldn't be saved.");
          } catch {
            // The tab went away; nothing left to tell.
          }
        })
        .finally(() => this.#release(running));
      this.#turnPromise = done;
      done.catch(() => {});
    }
  }

  /**
   * Lets live frames reach a tab again once its replay is sent, or it isn't resuming after all.
   * The frames held back meanwhile go first: a turn that settled during the replay has left the
   * log, so they are its only copy. `upTo` is how far the tab now has the replayed conversation
   * (`seq` never restarts there), so those frames aren't sent twice.
   */
  #endReplay(conn: NodeConnection, upTo?: { conversationId: string; seq: number }): void {
    if (conn.replaying) conn.replaying = false;
    const held = this.#held.get(conn.id) ?? [];
    this.#held.delete(conn.id);
    try {
      for (const h of held) {
        if (h.conversationId === upTo?.conversationId && h.seq <= upTo.seq) continue;
        conn.socket.send(h.frame);
      }
    } catch {
      // The tab went away; it will resume again on its next connect.
    }
  }

  #closeLive(conn: NodeConnection, code: number, reason: string): void {
    this.close(conn);
    try {
      conn.socket.close(code, reason);
    } catch {
      // Already gone.
    }
  }

  /**
   * Releases the claim on the turn slot. (PR2 drains the resume queue here, once batches can
   * queue behind a running turn.)
   */
  #release(running: AbortController): void {
    if (this.#running !== running) return;
    this.#running = null;
  }

  /**
   * Settles what a restart left behind, at most once per process: a failure retries on the next
   * call. Safe to call any time; it resolves once the sweep has run.
   */
  recover(): Promise<void> {
    if (!this.#recovery) {
      this.#recovery = this.#recover().catch(() => {
        this.#recovery = null;
      });
    }
    return this.#recovery;
  }

  /**
   * The restart sweep (M3-23a review): in-memory checkpoints don't survive a restart, so any
   * streaming reply still in D1 belongs to a turn that will never settle it, and any hold with
   * no saved stop belongs to a turn that will never spend it. Streaming replies become
   * `interrupted` (keeping their text, as `interrupt` does), and those holds go back
   * uncharged. Stopped turns (approval, limit) keep both for their resume, as the worker's
   * `onFiberRecovered` keeps them: their `turn_states` row names the reply to spare.
   */
  async #recover(): Promise<void> {
    const repo = await this.#repo;
    const byTurn = new Map<string, string[]>();
    for (const hold of this.limits.heldIds()) {
      const turnId = hold.split(":")[0] ?? hold;
      byTurn.set(turnId, [...(byTurn.get(turnId) ?? []), hold]);
    }
    const stopped = new Set<string>();
    for (const [turnId, holds] of byTurn) {
      const row = await repo.turns.load(turnId);
      if (row) {
        stopped.add(row.replyId);
        continue;
      }
      for (const hold of holds) this.limits.release(hold);
    }
    for (const conv of await repo.listConversations()) {
      for (const m of (await repo.chat.listMessages(conv.id)) ?? []) {
        if (m.role === "assistant" && m.status === "streaming" && !stopped.has(m.id)) {
          await repo.chat.interrupt({ replyId: m.id, reply: m.content });
        }
      }
    }
  }

  /**
   * The process is shutting down: refuse new turns, close every tab (1001) and interrupt the
   * running turn, then resolve once it has settled so the database can close under it.
   */
  async shutdown(): Promise<void> {
    this.#closing = true;
    for (const tab of [...this.#tabs.values()]) this.#closeLive(tab, 1001, "server shutdown");
    this.#running?.abort();
    await this.#turnPromise?.catch(() => {});
  }

  async #turn(
    conn: NodeConnection,
    conversationId: string,
    text: string,
    own: { provider: string; model: string } | undefined,
    attachmentIds: readonly string[],
    signal: AbortSignal,
  ) {
    // A restart drops in-memory checkpoints, so settle what it left behind before starting: a
    // failure here is D1 failing, reported like any other turn failure by the caller.
    await this.recover();
    if (!(await this.#sessionLive(conn))) return;
    const repo = await this.#repo;
    const chat = repo.chat;
    // The model context comes from D1, never from memory, so it survives a restart. A new
    // conversation has none yet.
    const history = await chat.listMessages(conversationId);
    // Picked before `open`, so a send that can't run never creates an empty conversation. A send
    // may name the chat's own model, for a chat picked before the server had it (M3-06 AC3); an
    // existing chat keeps the pin it has, so a newer switch is never overwritten by a send.
    const fresh = history === null ? own : undefined;
    const pick = fresh ?? { conversationId };
    const picked = await this.resolveModel(await this.#getEnv(), this.#scope, "chat", pick);
    if ("error" in picked) {
      const message = MODEL_ERRORS[picked.error] ?? "The model isn't available right now.";
      const code = picked.error === "vault_reset_required" ? picked.error : undefined;
      return reject(conn.socket, conversationId, message, undefined, code);
    }
    const { provider, model } = picked;
    // The send's files, scoped: an ID that isn't this user's upload reads as missing, and the
    // whole send is refused rather than quietly dropping a file the user attached.
    const attached = await repo.attachments.getMany(attachmentIds);
    if (attached.length !== new Set(attachmentIds).size) {
      return reject(conn.socket, conversationId, "One of those files isn't available anymore.");
    }
    const caps = provider.capabilities(model);
    // A file goes to the model only where its capability flags allow (M3-10 AC2); `skipped`
    // collects the kinds this send turned away, to say so plainly.
    const readable = (row: AttachmentRow) =>
      row.kind === "text" || (row.kind === "image" ? caps.imageInput : caps.pdfInput) === true;
    const skipped = new Set<"image" | "pdf">();
    for (const row of attached) if (row.kind !== "text" && !readable(row)) skipped.add(row.kind);
    // The files one turn hands the model are read into memory and sent as one request, so they
    // share a byte budget: this send's files first, whole or not at all, then earlier turns'
    // newest first while they fit. An earlier file left out was read on its own turn.
    const sending = attached.filter(readable);
    const budget = TURN_FILE_BYTES - sending.reduce((n, row) => n + modelBytes(row), 0);
    if (budget < 0) {
      const message =
        "Those files are too large to send in one message. Try fewer, or smaller, files.";
      return reject(conn.socket, conversationId, message);
    }
    const cp: TurnCheckpoint = {
      conversationId,
      turnId: crypto.randomUUID(),
      replyId: crypto.randomUUID(),
      providerId: picked.billingId ?? provider.id,
      model,
      reply: "",
      wrote: false,
      holds: [],
      callStarted: false,
      callRecorded: false,
      callUsage: null,
    };
    const stash = (data: TurnCheckpoint) => {
      this.#checkpoints.set(data.turnId, data);
    };
    const { messages, fileTokens: pastTokens } = await this.#modelHistory(
      history ?? [],
      readable,
      budget,
    );
    const { files: sent, ids: sentIds, tokens: sentTokens } = await this.#readFiles(sending);
    const fileTokens = pastTokens + sentTokens;
    messages.push({ role: "user", content: text, ...(sent.length ? { attachments: sent } : {}) });
    // Reserved before anything is written, so a refused send leaves no trace, not even a
    // conversation.
    const chars = messageChars(messages);
    // Everything from the first checkpoint to the loop runs under this `finally`: sends that
    // never reach `#drive` (a refused reservation, a missing conversation, a D1 failure in the
    // first write) delete their checkpoint on the way out, as `#drive`'s own `finally` does.
    let drove = false;
    try {
      // Checkpoint before the reservation and the first write, so a recovery can always name the
      // turn and release what it holds.
      stash(cp);
      // The first call is reserved before anything is written, so a refused send leaves no
      // trace, not even a conversation. The loop's budget spends this reservation on its first
      // call and reserves later calls itself.
      const firstHold = `${cp.turnId}:0`;
      const reservation = this.limits.reserve(firstHold, cp.providerId, model, chars, fileTokens);
      if (!reservation) {
        const message = "You've reached today's spending limit. It resets at midnight UTC.";
        return reject(conn.socket, conversationId, message, "limit_reached");
      }
      cp.holds = [firstHold];
      stash(cp);
      const emit = this.#emitter(conversationId, cp.turnId);
      const title = (text.split("\n", 1)[0] || attached[0]?.name || "").slice(0, 40);
      try {
        if (!(await chat.open(conversationId, title, fresh))) {
          this.limits.release(firstHold);
          return reject(conn.socket, conversationId, "That conversation doesn't exist.");
        }
        await picked.used?.();
        await chat.startTurn(
          conversationId,
          text,
          cp.replyId,
          attached.map((row) => ({ id: row.id, sentToModel: sentIds.has(row.id) })),
        );
      } catch (err) {
        this.limits.release(firstHold); // no call was made
        throw err;
      }
      cp.wrote = true;
      stash(cp);
      await this.#sweepTabs();
      // The host names the turn; the loop never emits `turn.started` itself.
      emit("turn.started", { messageId: cp.replyId });
      // Plainly, per m3-ux §3.2: the file stays with the message, but this model won't read it.
      for (const kind of skipped) emit("status", { text: UNREAD[kind] });
      await this.#drive({
        checkpoint: cp,
        stash,
        provider,
        model,
        firstHold: { id: firstHold, maxOutputTokens: reservation.maxOutputTokens },
        history: messages,
        state: newTurn(),
        signal,
      });
      drove = true;
    } finally {
      if (!drove) this.#checkpoints.delete(cp.turnId);
    }
  }

  /**
   * Drives the loop over `state` and owns everything around it: forwarding its events, the
   * reply's text, one ledger row per model call, the budget's holds, and the turn's end —
   * settled to D1 before its terminal event is sent, or, at an approval or limit, saved to D1
   * to resume later (its event log stays, so a reconnect still replays the whole turn).
   */
  async #drive(run: {
    checkpoint: TurnCheckpoint;
    stash: (data: TurnCheckpoint) => void;
    provider: ModelProvider;
    model: string;
    firstHold: { id: string; maxOutputTokens: number };
    history: ModelMessage[];
    state: TurnState;
    signal: AbortSignal;
  }): Promise<void> {
    const { checkpoint: cp, stash, state, signal } = run;
    const { conversationId, turnId, replyId } = cp;
    const repo = await this.#repo;
    const chat = repo.chat;
    const emit = (event: LoopEvent) =>
      this.#send(conversationId, turnId, event.type, event.payload);

    // One hold per model call. The first spends the caller's pre-reservation; a later call the
    // day's budget can't cover stops the turn at its daily limit instead.
    let calls = 0;
    let pendingHold: string | null = run.firstHold.id;
    let first = true;
    const budget: Budget = {
      reserve: (messages) => {
        if (first) {
          first = false;
          return { maxOutputTokens: run.firstHold.maxOutputTokens };
        }
        const hold = `${turnId}:${++calls}`;
        const chars = messages.reduce((sum, m) => sum + m.content.length, 0);
        const reserved = this.limits.reserve(
          hold,
          cp.providerId,
          cp.model,
          chars,
          messageFileTokens(messages),
        );
        if (!reserved) return { limit: "daily", detail: "Today's spending limit" };
        pendingHold = hold;
        cp.holds = [hold];
        stash(cp);
        return { maxOutputTokens: reserved.maxOutputTokens };
      },
      settle: (usage) => {
        if (!pendingHold) return;
        this.limits.settle(pendingHold, cp.providerId, cp.model, usage ? pickUsage(usage) : null);
        pendingHold = null;
        cp.holds = [];
      },
    };

    const { tools, policy } = this.resolveTools();
    const host: LoopHost = {
      provider: run.provider,
      model: run.model,
      tools,
      policy,
      budget,
      now: Date.now,
      newId: () => crypto.randomUUID(),
    };

    // The reply's text: one segment per model call that spoke, joined as paragraphs.
    const segments = replySegments(state);
    let current = "";
    const syncReply = () => {
      cp.reply = [...segments, current].filter((s) => s !== "").join("\n\n");
    };
    syncReply();

    const recordCall = async () => {
      await repo.usage.record({
        ...(cp.callId ? { id: cp.callId } : {}),
        providerId: cp.providerId,
        model: cp.model,
        usage: cp.callUsage,
        conversationId,
        messageId: replyId,
      });
      cp.callRecorded = true;
      stash(cp);
    };
    // Mid-turn a failed row is retried at the call's end and again before settling; only a
    // failure there fails the turn, as D1 failing did before the loop.
    const tryRecord = async () => {
      if (cp.callStarted && !cp.callRecorded) await recordCall().catch(() => {});
    };

    let persisted = false;
    const persistStop = async (status: TurnStatus) => {
      cp.stopping = Date.now();
      stash(cp);
      const saved = await repo.turns.save({
        turnId,
        conversationId,
        replyId,
        providerId: cp.providerId,
        model: cp.model,
        status,
        state: JSON.stringify(state),
      });
      if (!saved) throw new Error("the turn's conversation is gone");
      await chat.checkpointReply(replyId, cp.reply);
      persisted = true;
    };
    const failSave = async () => {
      const settled = await chat.settle({ replyId, reply: cp.reply }, "error").then(
        () => true,
        () => false,
      );
      this.#send(conversationId, turnId, "turn.failed", {
        message: "The reply couldn't be saved.",
      });
      // Only a turn D1 holds leaves the log; otherwise its frames, this failure included, are
      // all a reconnecting tab can learn it from.
      if (settled) this.#events.trim(conversationId, turnId);
    };

    const gen = runTurn(host, run.history, state, signal);
    let thinking = "";
    try {
      for (;;) {
        const next = await gen.next();
        if (next.done) {
          if (!persisted && next.value === "limit_reached") {
            await persistStop(next.value).catch(failSave);
          } else if (!persisted && next.value === "awaiting_approval") {
            // No approvals on Node yet (PR2 resumes them): the turn stops here, saved to D1.
            await persistStop(next.value).catch(failSave);
          }
          return;
        }
        const event = next.value;
        if (
          event.type === "turn.completed" ||
          event.type === "turn.cancelled" ||
          event.type === "turn.failed"
        ) {
          const status =
            event.type === "turn.completed"
              ? "complete"
              : event.type === "turn.cancelled"
                ? "interrupted" // D1 has no "cancelled": a stopped reply is an interrupted one
                : "error";
          try {
            if (cp.callStarted && !cp.callRecorded) await recordCall();
            await chat.settle({ replyId, reply: cp.reply }, status);
            await repo.turns.remove(turnId);
          } catch {
            await failSave();
            await gen.return("failed");
            return;
          }
          emit(event);
          // The turn is in D1 now, so its events leave the log; a later tab reloads from D1.
          this.#events.trim(conversationId, turnId);
          continue;
        }
        if (event.type === "approval.requested" || event.type === "limit.reached") {
          // The state is complete at these events; save it before any tab can act on them. An
          // approval's rows go first: the route reads its decisions from them (M3-07 AC9).
          try {
            if (event.type === "approval.requested" && state.pending) {
              const rows = await bindBatch({
                userId: this.#scope.userId,
                tools,
                pending: state.pending,
                context: { kind: "turn", id: turnId, conversationId },
              });
              if (!(await repo.approvals.create(rows))) throw new Error("the conversation is gone");
            }
            await persistStop(
              event.type === "approval.requested" ? "awaiting_approval" : "limit_reached",
            );
          } catch {
            await failSave();
            await gen.return("failed");
            return;
          }
          emit(event);
          continue;
        }
        switch (event.type) {
          case "step.started":
            if (!event.payload.toolCallId) {
              thinking = event.payload.stepId;
              cp.callStarted = true;
              cp.callRecorded = false;
              cp.callUsage = null;
              cp.callId = crypto.randomUUID();
              stash(cp);
            }
            break;
          case "message.delta":
            current += event.payload.text;
            syncReply();
            stash(cp);
            break;
          case "message.completed":
            if (event.payload.text) segments.push(event.payload.text);
            current = "";
            syncReply();
            stash(cp);
            break;
          case "usage.updated":
            cp.callUsage = pickUsage(event.payload.usage);
            await tryRecord();
            stash(cp);
            break;
          case "step.completed":
            if (event.payload.stepId === thinking) {
              await tryRecord(); // a call that reported no usage still gets its row
              stash(cp);
            }
            break;
          default:
            break;
        }
        emit(event);
      }
    } finally {
      this.#checkpoints.delete(turnId);
      // The first call's hold was taken before the loop ran; if the loop never spent it (a Stop
      // before its first call), it goes back uncharged.
      if (first && pendingHold) {
        this.limits.release(pendingHold);
        pendingHold = null;
        cp.holds = [];
      }
    }
  }

  /**
   * Every tab gets the reply, so first close those whose session has ended since they opened.
   * A check that fails closes its tab too, but retryably (1011, not 4401): the tab reconnects
   * and the upgrade rechecks its session. The turn itself goes on.
   */
  async #sweepTabs(): Promise<void> {
    await Promise.all(
      [...this.#tabs.values()].map((tab) =>
        this.#sessionLive(tab).catch(() => this.#closeLive(tab, 1011, "session check failed")),
      ),
    );
  }

  /**
   * The model context from a conversation's stored messages, with the files of earlier turns:
   * newest first while they fit in `budget` bytes and the model can read them. A file left out
   * was read on its own turn; a file-only message with none of its files left says nothing.
   */
  async #modelHistory(
    past: readonly StoredMessage[],
    readable: (row: AttachmentRow) => boolean,
    budget: number,
  ): Promise<{ messages: ModelMessage[]; fileTokens: number }> {
    const replayed = new Set<string>();
    let left = budget;
    for (const m of past.toReversed()) {
      if (m.role !== "user") continue;
      for (const row of m.attachments.filter(readable)) {
        if (modelBytes(row) > left) continue;
        left -= modelBytes(row);
        replayed.add(row.id);
      }
    }
    const messages: ModelMessage[] = [];
    let fileTokens = 0;
    for (const m of past) {
      if (m.role === "user" && m.attachments.length) {
        const { files, tokens } = await this.#readFiles(
          m.attachments.filter((row) => replayed.has(row.id)),
        );
        fileTokens += tokens;
        if (!m.content && !files.length) continue;
        messages.push({
          role: "user",
          content: m.content,
          ...(files.length ? { attachments: files } : {}),
        });
      } else if (m.content !== "") {
        messages.push({ role: m.role, content: m.content });
      }
    }
    return { messages, fileTokens };
  }

  /** Reads files for the model; one whose object is gone is left out. */
  async #readFiles(rows: readonly AttachmentRow[]) {
    const files: ModelAttachment[] = [];
    const ids = new Set<string>();
    let tokens = 0;
    for (const row of rows) {
      const file = await this.#modelFile(row);
      if (!file) continue;
      files.push(file);
      ids.add(row.id);
      tokens += fileTokenEstimate(row);
    }
    return { files, ids, tokens };
  }

  /**
   * One file as the model receives it, or `null` when its object is gone. A text file rides as
   * text and is read only as far as the model will see it; an image or PDF goes whole as base64,
   * which the model APIs take, and the caller has already fitted it to the turn's byte budget.
   */
  async #modelFile(row: AttachmentRow): Promise<ModelAttachment | null> {
    const repo = await this.#repo;
    const object = await repo.attachments.getObject(row.id);
    if (!object?.body) return null;
    if (row.kind === "text") {
      const { bytes, more } = await readPrefix(object.body, TEXT_READ_BYTES);
      // `stream` holds back a character the cut split, rather than decoding it as garbage.
      const whole = new TextDecoder().decode(bytes, { stream: more });
      const text =
        more || whole.length > MAX_ATTACHMENT_TEXT
          ? `${whole.slice(0, MAX_ATTACHMENT_TEXT)}\n[Only the first part of this file is shown: it is long.]`
          : whole;
      return { kind: "text", mediaType: row.mediaType, name: row.name, text };
    }
    const data = base64(new Uint8Array(await object.arrayBuffer()));
    return { kind: row.kind, mediaType: row.mediaType, name: row.name, data };
  }

  /** A socket outlives logout and revocation, so each action rechecks the session it opened with. */
  async #sessionLive(conn: NodeConnection): Promise<boolean> {
    const sessions = systemStore(await this.#getEnv()).sessions;
    if (conn.sessionId && (await sessions.isLive(conn.sessionId, this.#userId, Date.now())))
      return true;
    this.#closeLive(conn, 4401, "unauthenticated");
    return false;
  }

  #send(sessionId: string, turnId: string, type: HarnessEvent["type"], payload: unknown): void {
    let seq = 0;
    const frame = this.#events.append(sessionId, turnId, (n) => {
      seq = n;
      return JSON.stringify({ v: 1, seq, sessionId, turnId, type, payload });
    });
    const replaying = [...this.#tabs.values()].filter((tab) => tab.replaying);
    for (const tab of replaying) {
      const held = this.#held.get(tab.id) ?? [];
      this.#held.set(tab.id, held);
      // A tab that never sends its `resume` can't hold frames forever: it reconnects instead.
      if (held.length >= MAX_HELD_FRAMES) {
        this.#held.delete(tab.id);
        this.#closeLive(tab, 1011, "replay backlog");
        continue;
      }
      held.push({ conversationId: sessionId, seq, frame });
    }
    const heldIds = new Set(replaying.map((tab) => tab.id));
    for (const tab of this.#tabs.values()) {
      if (heldIds.has(tab.id)) continue;
      try {
        tab.socket.send(frame);
      } catch {
        // The tab went away; its close cleans up.
      }
    }
  }

  #emitter(sessionId: string, turnId: string): Emit {
    return (type, payload) => this.#send(sessionId, turnId, type, payload);
  }
}

/** The extra routes only Node serves: the chat socket to the user's assistant (ADR 0002). */
export function nodeRoutes(assistantFor: (userId: string) => NodeAssistant): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get("/chat", async (c, next) => {
    // A WebSocket upgrade is a GET and skips CORS, so a cross-site page could open one with the
    // user's cookie. The session guard checks Origin on writes only, so check it here.
    if (!sameOrigin(c)) return c.json({ error: "bad_origin" }, 403);
    return next();
  });

  routes.get(
    "/chat",
    upgradeWebSocket((c) => {
      const assistant = assistantFor(c.var.session.scope.userId);
      const sessionId = c.var.session.id;
      const resume = new URL(c.req.url).searchParams.has("resume");
      let conn: NodeConnection | null = null;
      const socketFor = (ws: WSContext): NodeSocket => ({
        send: (data) => ws.send(data),
        close: (code, reason) => ws.close(code, reason),
      });
      return {
        onOpen(_event, ws) {
          // A reconnecting tab (`?resume`) gets no live frames until its `resume` has replayed
          // the log: a live frame arriving first would raise its applied seq past the frames it
          // missed, which its dedupe would then drop. The log holds every frame sent meanwhile,
          // so none is lost.
          conn = assistant.open(socketFor(ws), sessionId, resume);
        },
        onMessage(event, ws) {
          if (!conn) conn = assistant.open(socketFor(ws), sessionId, false);
          assistant.message(conn, event.data);
        },
        onClose() {
          if (conn) assistant.close(conn);
        },
      };
    }),
  );

  return routes;
}
