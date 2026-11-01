// SPDX-License-Identifier: Apache-2.0
import type { HarnessEvent } from "@opa/core";

/** A row of `GET /api/conversations`, newest first. `model` is the chat's own pick, if it has one. */
export type ConversationSummary = {
  id: string;
  title: string | null;
  updatedAt: number;
  model?: { provider: string; model: string } | null;
};

/** A file stored with a message. `sentToModel` is `null` until the send that carried it ran. */
export type StoredAttachment = {
  id: string;
  name: string;
  mediaType: string;
  kind: "image" | "pdf" | "text";
  sizeBytes: number;
  sentToModel: boolean | null;
};

/**
 * A row of `GET /api/conversations/:id/messages`, oldest first. A `system` row records a model
 * switch, and never reaches the model.
 */
export type StoredMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  status: "complete" | "streaming" | "interrupted" | "error";
  content: string;
  attachments?: StoredAttachment[];
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
   * Starts a turn, carrying any already-uploaded files by ID. A send that can't be made is
   * answered with a `turn.failed` at `seq` 0. `model` pins the chat to its own model first, for a
   * chat picked before the server had it.
   */
  send(
    conversationId: string,
    text: string,
    model?: { provider: string; model: string },
    attachmentIds?: string[],
  ): void;
  /** Stops the running turn, which then ends with `turn.cancelled`. */
  cancel(): void;
  /** Takes a waiting send back; the server answers with `turn.dequeued` (M3-09 AC4). */
  dequeue(conversationId: string, messageId: string): void;
  conversations(): Promise<ConversationSummary[]>;
  /** `null` when the conversation isn't on the server (yet). */
  messages(conversationId: string): Promise<StoredMessage[] | null>;
}
