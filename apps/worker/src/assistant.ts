// SPDX-License-Identifier: Apache-2.0
// The per-user assistant (ADR 0002), named `u:<userId>` by the server. It owns the hibernating
// WebSockets of all the user's tabs, runs one chat turn at a time and sends every event to every
// tab, so two tabs show the same stream. D1 holds the messages; the DO only the running turn.
import type { HarnessEvent, ModelProvider } from "@opa/core";
import { chatStore, isConversationId, type TurnRecord } from "@opa/db/chat";
import { scopeFromAssistantName } from "@opa/db/repository";
import { createWorkersAIProvider } from "@opa/providers";
import {
  Agent,
  type Connection,
  type ConnectionContext,
  type FiberRecoveryContext,
  type WSMessage,
} from "agents";
import { withoutMasterKeys } from "./compose";
import type { Bindings } from "./env";
import { IDLE_MS } from "./session";

/** Set by the Worker on the upgrade (a client's own value is overwritten): the session's row ID. */
export const SESSION_HEADER = "x-opa-session-id";

/** Workers AI needs no key, so a fresh deployment can chat (ADR 0006). Onboarding picks later. */
export const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_TEXT = 32_000;
/** How often a streaming reply is checkpointed, so an eviction keeps most of it. */
const STASH_MS = 1_000;

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

  /** The user's chat rows, scoped by this DO's own name, which only the server sets. */
  get #store() {
    return chatStore(this.env, scopeFromAssistantName(this.name));
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
    if (this.#running) {
      reject(connection, msg.conversationId, "Another reply is still being written.");
    } else if (!isConversationId(msg.conversationId) || !text || text.length > MAX_TEXT) {
      reject(connection, "", "That message can't be sent.");
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
    const store = this.#store;
    const title = text.split("\n", 1)[0]?.slice(0, 40) ?? "";
    if (!(await store.openConversation(conversationId, title))) {
      return reject(connection, conversationId, "That conversation doesn't exist.");
    }
    const { provider, model } = this.chatModel;
    const turn: TurnRecord = {
      conversationId,
      turnId: crypto.randomUUID(),
      replyId: crypto.randomUUID(),
      providerId: provider.id,
      model,
      reply: "",
      usage: null,
      called: false,
    };
    // Checkpoint before the first write, so a recovery can always name the turn.
    stash(turn);
    const emit = this.#emitter(conversationId, turn.turnId);
    await store.startTurn(conversationId, text, turn.replyId);
    // The model context comes from D1, never from memory, so it survives an eviction.
    const messages = ((await store.listMessages(conversationId)) ?? [])
      .filter((m) => m.content !== "")
      .map(({ role, content }) => ({ role, content }));
    emit("turn.started", { messageId: turn.replyId });
    turn.called = true;
    stash(turn);

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

  /** A socket outlives logout and revocation, so each action rechecks the session it opened with. */
  async #sessionLive(connection: Connection): Promise<boolean> {
    const { sessionId } = (connection.state ?? {}) as { sessionId?: string | null };
    const now = Date.now();
    if (sessionId && (await this.#store.sessionLive(sessionId, now, now - IDLE_MS))) return true;
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
    await this.#store.settle(turn, "interrupted"); // the ledger keeps any usage already reported
    this.#emitter(turn.conversationId, turn.turnId)("turn.interrupted", { message: "Retry?" });
  }

  #emitter(sessionId: string, turnId: string): Emit {
    let seq = 0;
    return (type, payload) =>
      this.broadcast(JSON.stringify({ seq: ++seq, sessionId, turnId, type, payload }));
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

/** Fails a send for the tab that made it only. No turn started, so it has no turn ID. */
function reject(connection: Connection, sessionId: string, message: string) {
  const payload = { message };
  connection.send(JSON.stringify({ seq: 1, sessionId, turnId: "", type: "turn.failed", payload }));
}
