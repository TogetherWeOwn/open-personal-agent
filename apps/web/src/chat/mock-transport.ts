// SPDX-License-Identifier: Apache-2.0
import type { HarnessEvent, TurnLimit } from "@opa/core";
import type { ChatTransport } from "./transport";

const REPLY =
  "This is a placeholder reply. The assistant isn't connected yet, so every message gets this " +
  "answer, streamed a word at a time.";

/** Sending exactly one of these gets that limit's refusal instead of a reply. */
export const MOCK_LIMITS: Record<string, TurnLimit> = {
  "/mock slow down": "slow_down",
  "/mock limit reached": "limit_reached",
};
const LIMIT_MESSAGES: Record<TurnLimit, string> = {
  slow_down: "You're sending messages quickly. Wait a minute, then try again.",
  limit_reached: "You've reached today's spending limit. It resets at midnight UTC.",
};

/** Streams a canned reply a word at a time, for the e2e tests and `vite dev` without a Worker. */
export function createMockTransport(delayMs = 30): ChatTransport {
  let turns = 0;
  let onEvent: (event: HarnessEvent) => void = () => {};
  let stop: (() => void) | null = null;
  return {
    connect(handle, onOpen) {
      onEvent = handle;
      queueMicrotask(onOpen);
      return () => {
        onEvent = () => {};
      };
    },
    send(sessionId, text) {
      // Lets the e2e tests and `vite dev` show the limit states (M2-22).
      const reason = MOCK_LIMITS[text];
      if (reason) {
        const payload = { message: LIMIT_MESSAGES[reason], reason };
        const event = { v: 1, seq: 0, sessionId, turnId: "", type: "turn.failed", payload };
        return queueMicrotask(() => onEvent(event as HarnessEvent));
      }
      const turnId = `mock-${++turns}`;
      let seq = 0;
      const emit = (type: HarnessEvent["type"], payload = {}) =>
        onEvent({ v: 1, seq: ++seq, sessionId, turnId, type, payload } as HarnessEvent);
      const words = REPLY.split(/(?<= )/);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = () => {
        const text = words.shift();
        if (text === undefined) {
          stop = null;
          emit("message.completed", { text: REPLY });
          return emit("turn.completed");
        }
        emit("message.delta", { text });
        timer = setTimeout(tick, delayMs);
      };
      stop = () => {
        clearTimeout(timer);
        stop = null;
        emit("turn.interrupted", { message: "Stopped." });
      };
      emit("turn.started", { messageId: `${turnId}-reply` });
      timer = setTimeout(tick, delayMs);
    },
    cancel: () => stop?.(),
    conversations: async () => [],
    messages: async () => null,
  };
}
