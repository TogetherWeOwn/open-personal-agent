// SPDX-License-Identifier: Apache-2.0

type Event<T extends string, P> = { seq: number; turnId: string; type: T; payload: P };

/**
 * The `HarnessEvent` v1 subset the chat renders (ADR 0005 envelope), mirrored here until
 * `packages/core` exports the shared type.
 */
export type ChatEvent =
  | Event<"turn.started" | "turn.completed", Record<string, never>>
  | Event<"message.delta" | "message.completed" | "status", { text: string }>
  | Event<"turn.failed", { message: string }>;

/** The port the chat screen talks to. The Assistant DO WebSocket (M2-13) implements it next. */
export interface ChatTransport {
  /** Starts a turn and streams its events to `onEvent`. Returns a function that stops the turn. */
  send(conversationId: string, text: string, onEvent: (event: ChatEvent) => void): () => void;
}
