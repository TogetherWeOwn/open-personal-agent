// SPDX-License-Identifier: Apache-2.0
// The per-user assistant (ADR 0002), named `u:<userId>` by the server. It owns the hibernating
// WebSockets of all the user's tabs, runs one chat turn at a time and sends every event to every
// tab, so two tabs show the same stream. D1 holds the messages; the DO only the running turn.
import type { HarnessEvent, TurnLimit } from "@opa/core";
import { createRepository, isId, scopeForAssistant, type TurnRecord } from "@opa/db/repository";
import { systemStore } from "@opa/db/system";
import {
  Agent,
  type Connection,
  type ConnectionContext,
  type FiberRecoveryContext,
  type WSMessage,
} from "agents";
import { type ChatModelError, resolveChatModel } from "./chat-model";
import { compose, type WorkerEnv, withoutMasterKeys } from "./compose";
import type { Bindings, Env } from "./env";
import { Limits } from "./limits";

/** Set by the Worker on the upgrade (a client's own value is overwritten): the session's row ID. */
export const SESSION_HEADER = "x-opa-session-id";
const MAX_TEXT = 32_000;
const STASH_MS = 1_000; // how often a streaming reply is checkpointed, so eviction keeps most

type Emit = <T extends HarnessEvent["type"]>(
  type: T,
  payload: Extract<HarnessEvent, { type: T }>["payload"],
) => void;

export class Assistant extends Agent<Bindings> {
  // Tabs learn nothing about the instance, and get none of the SDK's own protocol frames.
  static override options = { sendIdentityOnConnect: false };
  /** Picks each turn's model. Tests replace it with a scripted provider. */
  resolveModel = resolveChatModel;
  #running: AbortController | null = null;
  /** Turn rate and daily spend, in this DO's storage (M2-22). */
  readonly limits = new Limits(this.ctx.storage.kv);
  /** The env with the vault: `compose` stays the only reader of the master keys. */
  readonly #composed: Promise<Env>;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, withoutMasterKeys(env));
    this.#composed = compose(env);
  }

  /** Liveness check for `/api/health`. */
  ping(): string {
    return "pong";
  }

  /** The user's scope, from this DO's own name, which only the server sets. */
  get #scope() {
    return scopeForAssistant(this.name);
  }

  get #chat() {
    return createRepository(this.env).forUser(this.#scope).chat;
  }

  override shouldSendProtocolMessages(): boolean {
    return false;
  }

  /** Tabs can't write the SDK's state; they talk only through `onMessage`. */
  override shouldConnectionBeReadonly(): boolean {
    return true;
  }

  override onConnect(connection: Connection, ctx: ConnectionContext): void {
    connection.setState({ sessionId: ctx.request.headers.get(SESSION_HEADER) });
  }

  override onMessage(connection: Connection, message: WSMessage): void {
    const msg = parse(message);
    // A tab whose session is still live may stop the running turn.
    if (msg?.type === "turn.cancel")
      void this.#sessionLive(connection).then((ok) => ok && this.#running?.abort());
    if (msg?.type !== "chat.send") return;
    const text = msg.text.trim();
    // One turn at a time is the concurrency limit: a second send waits for the first.
    if (this.#running) {
      reject(connection, msg.conversationId, "Another reply is still being written.");
    } else if (!isId(msg.conversationId) || !text || text.length > MAX_TEXT) {
      reject(connection, "", "That message can't be sent.");
    } else if (!this.limits.startTurn()) {
      const message = "You're sending messages quickly. Wait a minute, then try again.";
      reject(connection, msg.conversationId, message, "slow_down");
    } else {
      const running = new AbortController();
      this.#running = running;
      void this.runFiber("chat-turn", (fiber) =>
        this.#turn(connection, msg.conversationId, text, running.signal, fiber.stash),
      )
        // The model's failures are reported in the turn; this is D1 failing.
        .catch(() => reject(connection, msg.conversationId, "The reply couldn't be saved."))
        .finally(() => {
          if (this.#running === running) this.#running = null;
        });
    }
  }

  async #turn(
    connection: Connection,
    conversationId: string,
    text: string,
    signal: AbortSignal,
    stash: (data: TurnRecord) => void,
  ) {
    if (!(await this.#sessionLive(connection))) return;
    const chat = this.#chat;
    // Picked before `open`, so a send that can't run never creates an empty conversation.
    const picked = await this.resolveModel(await this.#composed, this.#scope, "chat");
    if ("error" in picked) {
      const message = MODEL_ERRORS[picked.error] ?? "The model isn't available right now.";
      return reject(connection, conversationId, message);
    }
    const { provider, model } = picked;
    const turn: TurnRecord = {
      conversationId,
      turnId: crypto.randomUUID(),
      replyId: crypto.randomUUID(),
      providerId: picked.billingId ?? provider.id,
      model,
      reply: "",
      usage: null,
      called: false,
    };
    // The model context comes from D1, never from memory, so it survives an eviction. A new
    // conversation has none yet.
    const messages = ((await chat.listMessages(conversationId)) ?? [])
      .filter((m) => m.content !== "")
      .map(({ role, content }) => ({ role, content }))
      .concat({ role: "user", content: text });
    // Checkpoint before the reservation and the first write, so a recovery can always name the
    // turn and release what it holds.
    stash(turn);
    // Reserved before anything is written, so a refused send leaves no trace, not even a
    // conversation.
    const chars = messages.reduce((sum, m) => sum + m.content.length, 0);
    const reservation = this.limits.reserve(turn.turnId, turn.providerId, model, chars);
    if (!reservation) {
      const message = "You've reached today's spending limit. It resets at midnight UTC.";
      return reject(connection, conversationId, message, "limit_reached");
    }
    const emit = this.#emitter(conversationId, turn.turnId);
    const title = text.split("\n", 1)[0]?.slice(0, 40) ?? "";
    try {
      if (!(await chat.open(conversationId, title))) {
        this.limits.release(turn.turnId);
        return reject(connection, conversationId, "That conversation doesn't exist.");
      }
      await picked.used?.();
      await chat.startTurn(conversationId, text, turn.replyId);
    } catch (err) {
      this.limits.release(turn.turnId); // no call was made
      throw err;
    }
    emit("turn.started", { messageId: turn.replyId });
    turn.called = true;
    stash(turn);

    let failure: string | null = null;
    let stashedAt = 0;
    const { maxOutputTokens } = reservation;
    try {
      // A chat turn makes one call; the tool loop (M3) makes more under the same cap.
      if (!this.limits.call(turn.turnId)) throw new RangeError("too many calls in one turn");
      for await (const event of provider.stream({ model, messages, maxOutputTokens, signal })) {
        if (event.type === "text.delta") {
          turn.reply += event.text;
          emit("message.delta", { text: event.text });
          if (Date.now() - stashedAt > STASH_MS) {
            stash(turn);
            stashedAt = Date.now();
          }
        } else if (event.type === "usage") {
          turn.usage = event.usage;
          stash(turn);
          emit("usage.updated", { usage: event.usage, providerId: provider.id, model });
        } else if (event.type === "error" && event.code !== "aborted") {
          failure = `The model call failed (${event.code}).`;
        }
      }
    } catch {
      failure = "The model call failed.";
    }
    this.limits.settle(turn.turnId, turn.providerId, model, turn.usage);
    try {
      await chat.settle(turn, signal.aborted ? "interrupted" : failure ? "error" : "complete");
    } catch {
      return emit("turn.failed", { message: "The reply couldn't be saved." });
    }
    if (signal.aborted) {
      emit("turn.interrupted", { message: "Stopped." });
    } else if (failure) {
      emit("turn.failed", { message: failure });
    } else {
      emit("message.completed", { text: turn.reply });
      emit("turn.completed", {});
    }
  }

  /** A socket outlives logout and revocation, so each action rechecks the session it opened with. */
  async #sessionLive(connection: Connection): Promise<boolean> {
    const { sessionId } = (connection.state ?? {}) as { sessionId?: string | null };
    const sessions = systemStore(this.env).sessions;
    if (sessionId && (await sessions.isLive(sessionId, this.#scope.userId, Date.now())))
      return true;
    connection.close(4401, "unauthenticated");
    return false;
  }

  /**
   * A turn's fiber outlived its process: an eviction or a deploy. Keep the reply checkpointed so
   * far, mark it interrupted and tell the tabs, so the turn never fails silently (ADR 0003 #1).
   */
  override async onFiberRecovered(ctx: FiberRecoveryContext): Promise<void> {
    if (ctx.name !== "chat-turn") return;
    const turn = ctx.snapshot as TurnRecord | null;
    if (!turn) return;
    // Settling twice charges once, so a recovery after the turn settled costs nothing more.
    if (turn.called) this.limits.settle(turn.turnId, turn.providerId, turn.model, turn.usage);
    else this.limits.release(turn.turnId);
    await this.#chat.settle(turn, "interrupted"); // the ledger keeps any usage already reported
    this.#emitter(turn.conversationId, turn.turnId)("turn.interrupted", { message: "Retry?" });
  }

  #emitter(sessionId: string, turnId: string): Emit {
    let seq = 0;
    return (type, payload) =>
      this.broadcast(JSON.stringify({ v: 1, seq: ++seq, sessionId, turnId, type, payload }));
  }
}

/** What a tab may send: `chat.send` or `turn.cancel`. Anything else is ignored. */
function parse(message: WSMessage) {
  if (typeof message !== "string") return null;
  try {
    const msg = JSON.parse(message) as Partial<Record<string, unknown>>;
    if (msg.type === "turn.cancel") return { type: "turn.cancel" } as const;
    const conversationId = String(msg.conversationId);
    if (msg.type === "chat.send" && typeof msg.text === "string") {
      return { type: "chat.send", conversationId, text: msg.text } as const;
    }
  } catch {}
  return null;
}

const MODEL_ERRORS: Partial<Record<ChatModelError, string>> = {
  no_model: "Pick a model in Settings first.",
  key_required: "Enter your model key again in Settings.",
};

/**
 * Fails a send for the tab that made it only. No turn started, so it has no turn ID, and `seq` 0
 * keeps it outside the sequence of a turn the tab may be receiving.
 */
function reject(connection: Connection, sessionId: string, message: string, reason?: TurnLimit) {
  const event: HarnessEvent = {
    v: 1,
    seq: 0,
    sessionId,
    turnId: "",
    type: "turn.failed",
    payload: reason ? { message, reason } : { message },
  };
  connection.send(JSON.stringify(event));
}
