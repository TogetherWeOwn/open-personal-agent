// SPDX-License-Identifier: Apache-2.0
import type { ChatEvent, ChatTransport } from "./transport";

const REPLY =
  "This is a placeholder reply. The assistant isn't connected yet, so every message gets this " +
  "answer, streamed a word at a time.";

/** Streams a canned reply a word at a time until the real transport lands. */
export function createMockTransport(delayMs = 30): ChatTransport {
  let turns = 0;
  return {
    send(_conversationId, _text, onEvent) {
      const turnId = `mock-${++turns}`;
      let seq = 0;
      const emit = (type: ChatEvent["type"], payload = {}) =>
        onEvent({ seq: ++seq, turnId, type, payload } as ChatEvent);
      const words = REPLY.split(/(?<= )/);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = () => {
        const text = words.shift();
        if (text === undefined) {
          emit("message.completed", { text: REPLY });
          return emit("turn.completed");
        }
        emit("message.delta", { text });
        timer = setTimeout(tick, delayMs);
      };
      emit("turn.started");
      timer = setTimeout(tick, delayMs);
      return () => clearTimeout(timer);
    },
  };
}
