// SPDX-License-Identifier: Apache-2.0
import { useLayoutEffect, useRef } from "react";
import { Markdown } from "./Markdown";
import type { Conversation, Message } from "./state";

/**
 * The message log. Its own live region is off so streaming tokens are not read out one by one;
 * the app's status region announces the finished reply instead (UX direction §3.1).
 */
export function Thread({ conversation }: { conversation: Conversation }) {
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const last = conversation.messages.at(-1)?.text;

  // Follow the stream only while the reader is at the bottom (the app remounts this per chat).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-runs as messages grow
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [conversation.messages.length, last]);

  return (
    <div
      ref={scroller}
      role="log"
      aria-live="off"
      aria-label="Messages"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: lets keyboard users scroll the log
      tabIndex={0}
      onScroll={({ currentTarget: el }) => {
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
      }}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex max-w-[720px] flex-col gap-6 px-4 py-6">
        {conversation.messages.length === 0 && (
          <p className="text-text-muted">Hi. What can I help you with?</p>
        )}
        {conversation.messages.map((m) => (
          <MessageView key={m.id} message={m} />
        ))}
      </div>
    </div>
  );
}

function MessageView({ message: m }: { message: Message }) {
  if (m.role === "system") {
    return <p className="self-center text-center text-sm text-text-muted">{m.text}</p>;
  }
  if (m.role === "user") {
    return (
      <p className="max-w-[85%] self-end whitespace-pre-wrap break-words rounded-2xl bg-user-bubble px-4 py-2">
        <span className="sr-only">You: </span>
        {m.text}
      </p>
    );
  }
  return (
    <div>
      <p className="mb-1 text-sm font-semibold text-text-muted">Assistant</p>
      <div className={`break-words ${m.status === "streaming" ? "caret" : ""}`}>
        <Markdown text={m.text} streaming={m.status === "streaming"} />
      </div>
      {m.status === "interrupted" && (
        <p className="mt-1 text-sm text-text-muted">Stopped before it finished.</p>
      )}
      {m.status === "error" && (
        <p className="mt-1 text-sm text-danger">This reply failed. Try sending it again.</p>
      )}
    </div>
  );
}
