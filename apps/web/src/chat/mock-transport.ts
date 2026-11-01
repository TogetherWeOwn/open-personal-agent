// SPDX-License-Identifier: Apache-2.0
import type { HarnessEvent } from "@opa/core";
import type { ChatTransport } from "./transport";

const REPLY =
  "This is a placeholder reply. The assistant isn't connected yet, so every message gets this " +
  "answer, streamed a word at a time.";

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
    send(sessionId) {
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
