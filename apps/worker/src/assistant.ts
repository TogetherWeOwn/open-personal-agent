// SPDX-License-Identifier: Apache-2.0
// The per-user assistant (ADR 0002): one Durable Object per user, named `u:<userId>` by the
// server. It owns the hibernating WebSockets of all the user's tabs and runs one chat turn at a
// time. Every event goes to every tab, so two tabs show the same stream. D1 holds the messages;
// the DO keeps only what a turn needs while it runs.
import type { HarnessEvent, ModelProvider } from "@opa/core";
import { createWorkersAIProvider } from "@opa/providers";
import {
  Agent,
  type Connection,
  type ConnectionContext,
  type FiberRecoveryContext,
  type WSMessage,
} from "agents";
import { chatStore, isConversationId, type TurnRecord } from "./chat-store";
import { withoutMasterKeys } from "./compose";
import type { Bindings } from "./env";

/** The Durable Object name for a user. Only server code calls this, with the session's user. */
export const assistantName = (userId: string) => `u:${userId}`;
/** Set by the Worker on the upgrade (a client's own value is overwritten): the session's row ID. */
export const SESSION_HEADER = "x-opa-session-id";

/** Workers AI needs no key, so a fresh deployment can chat (ADR 0006). Onboarding picks later. */
export const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_TEXT = 32_000;
/** How often a streaming reply is checkpointed, so an eviction keeps most of it. */
const STASH_MS = 1_000;

/** What a tab may send. Anything else is ignored. */
type ClientMessage =
  | { type: "chat.send"; conversationId: string; text: string }
  | { type: "turn.cancel" };

type Emit = <T extends HarnessEvent["type"]>(
  type: T,
  payload: Extract<HarnessEvent, { type: T }>["payload"],
) => void;

export class Assistant extends Agent<Bindings> {
  // Tabs learn nothing about the instance, and get none of the SDK's own protocol frames.
  static override options = { sendIdentityOnConnect: false };
  /** The model for chat turns. Tests replace it with a scripted provider. */
  chatModel: { provider: ModelProvider; model: string } = {
    provider: createWorkersAIProvider(this.env.AI),
    model: DEFAULT_MODEL,
  };
  #running: AbortController | null = null;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, withoutMasterKeys(env));
  }

  /** Liveness check for `/api/health`. */
  ping(): string {
    return "pong";
  }

  /** The user this assistant belongs to, from its own name, which only the server sets. */
  get userId(): string {
    if (!this.name.startsWith("u:")) throw new Error("not a user's assistant");
    return this.name.slice(2);
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
    if (msg?.type === "turn.cancel") this.#running?.abort();
    if (msg?.type !== "chat.send") return;
    if (this.#running) {
      reject(connection, msg.conversationId, "Another reply is still being written.");
    } else if (!isConversationId(msg.conversationId) || !msg.text.trim()) {
      reject(connection, "", "That message can't be sent.");
    } else if (msg.text.length > MAX_TEXT) {
      reject(connection, msg.conversationId, "That message is too long.");
    } else {
      const running = new AbortController();
      this.#running = running;
      void this.runFiber("chat-turn", (fiber) =>
        this.#turn(connection, msg.conversationId, msg.text.trim(), running.signal, fiber.stash),
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
    const store = chatStore(this.env.DB, this.userId);
    // A socket outlives logout and revocation, so each turn rechecks the session it was opened with.
    const { sessionId } = (connection.state ?? {}) as { sessionId?: string | null };
    if (!sessionId || !(await store.sessionLive(sessionId))) {
      return connection.close(4401, "unauthenticated");
    }
    const title = text.split("\n", 1)[0]?.slice(0, 40) ?? "";
    if (!(await store.openConversation(conversationId, title))) {
      return reject(connection, conversationId, "That conversation doesn't exist.");
    }
    const { provider, model } = this.chatModel;
    const turnId = crypto.randomUUID();
    const turn: TurnRecord = {
      conversationId,
      turnId,
      replyId: crypto.randomUUID(),
      providerId: provider.id,
      model,
      reply: "",
      usage: null,
    };
    // Checkpoint before the first write, so a recovery can always name the turn.
    stash(turn);
    const emit = this.#emitter(conversationId, turnId);
    await store.append(conversationId, crypto.randomUUID(), "user", text);
    // The model context comes from D1, never from memory, so it survives an eviction.
    const messages = ((await store.listMessages(conversationId)) ?? [])
      .filter((m) => m.content !== "")
      .map(({ role, content }) => ({ role, content }));
    await store.append(conversationId, turn.replyId, "assistant");
    emit("turn.started", { messageId: turn.replyId });

    let failure: string | null = null;
    let stashedAt = 0;
    try {
      for await (const event of provider.stream({ model, messages, signal })) {
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
    try {
      await store.settle(turn, signal.aborted ? "interrupted" : failure ? "error" : "complete");
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

  /**
   * A turn's fiber outlived its process: an eviction or a deploy. Keep the reply checkpointed so
   * far, mark it interrupted and tell the tabs, so the turn never fails silently (ADR 0003 #1).
   */
  override async onFiberRecovered(ctx: FiberRecoveryContext): Promise<void> {
    if (ctx.name !== "chat-turn") return;
    const store = chatStore(this.env.DB, this.userId);
    const turn = ctx.snapshot as TurnRecord | null;
    if (turn) {
      await store.settle(turn, "interrupted"); // the ledger keeps any usage already reported
      this.#emitter(turn.conversationId, turn.turnId)("turn.interrupted", {
        message: "Interrupted. Retry?",
      });
    }
  }

  #emitter(sessionId: string, turnId: string): Emit {
    let seq = 0;
    return (type, payload) =>
      this.broadcast(JSON.stringify({ seq: ++seq, sessionId, turnId, type, payload }));
  }
}

function parse(message: WSMessage): ClientMessage | null {
  if (typeof message !== "string") return null;
  try {
    const msg = JSON.parse(message) as Partial<Record<string, unknown>>;
    if (msg.type === "turn.cancel") return { type: "turn.cancel" };
    if (msg.type === "chat.send" && typeof msg.text === "string") {
      return { type: "chat.send", conversationId: String(msg.conversationId), text: msg.text };
    }
  } catch {}
  return null;
}

/** Fails a send for the tab that made it only. No turn started, so it has no turn ID. */
function reject(connection: Connection, sessionId: string, message: string) {
  const payload = { message };
  connection.send(JSON.stringify({ seq: 1, sessionId, turnId: "", type: "turn.failed", payload }));
}
