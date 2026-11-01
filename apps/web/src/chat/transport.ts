// SPDX-License-Identifier: Apache-2.0
import type { HarnessEvent } from "@opa/core";

/** A row of `GET /api/conversations`, newest first. `model` is the chat's own pick, if it has one. */
export type ConversationSummary = {
  id: string;
  title: string | null;
  updatedAt: number;
  model?: { provider: string; model: string } | null;
};

/** A row of `GET /api/conversations/:id/messages`, oldest first. */
export type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  status: "complete" | "streaming" | "interrupted" | "error";
  content: string;
};

/**
 * The port the chat screen talks to. Every tab of the user receives the events of every turn, so
 * a turn another tab started streams here too.
 */
export interface ChatTransport {
  /**
   * Streams the user's turn events to `onEvent` and calls `onOpen` on every connect and
   * reconnect, after which the caller reloads what it shows. Returns a function that disconnects.
   */
  connect(onEvent: (event: HarnessEvent) => void, onOpen: () => void): () => void;
  /**
   * Starts a turn. A send that can't be made is answered with a `turn.failed` at `seq` 0. `model`
   * pins the chat to its own model first, for a chat picked before the server had it.
   */
  send(conversationId: string, text: string, model?: { provider: string; model: string }): void;
  /** Stops the running turn, which then ends with `turn.interrupted`. */
  cancel(): void;
  conversations(): Promise<ConversationSummary[]>;
  /** `null` when the conversation isn't on the server (yet). */
  messages(conversationId: string): Promise<StoredMessage[] | null>;
}
