// SPDX-License-Identifier: Apache-2.0
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { Link } from "react-aria-components";
import { type AttachmentKind, cannotReadCopy, formatBytes } from "./attachments";
import { Markdown } from "./Markdown";
import type { ShowWork } from "./show-work";
import type { Conversation, Message } from "./state";
import { TurnView } from "./Turn";
import type { StoredAttachment } from "./transport";
import type { PriceTable } from "./turn-summary";

/**
 * The message log. Its own live region is off so streaming tokens are not read out one by one;
 * the app's status region announces the finished reply instead (UX direction §3.1).
 */
export function Thread({
  conversation,
  showWork,
  prices,
  after,
  afterCount = 0,
  onDequeue,
}: {
  conversation: Conversation;
  showWork: ShowWork;
  prices: PriceTable;
  /** Below the last message: the chat's approval cards and receipts (M3-07b). */
  after?: ReactNode;
  /** How many things `after` shows, so a new card scrolls into view as a message would. */
  afterCount?: number;
  onDequeue: (conversationId: string, messageId: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const last = conversation.messages.at(-1)?.text;

  // Follow the stream only while the reader is at the bottom (the app remounts this per chat).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-runs as messages grow
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [conversation.messages.length, last, afterCount]);

  // A queued send that the server stored also arrives as a user message on load; the turn's
  // bubble hides for those, so the thread never shows one twice (M3-09 AC4).
  const seenMessageIds = new Set(conversation.messages.map((m) => m.id));

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
        {conversation.messages.map((m) => {
          // The assistant's reply streams under its turn's timeline; other cards (approvals,
          // limits, artifacts) keep rendering from the events beside it.
          if (m.role === "assistant") {
            const turn = conversation.turns.find((t) => t.messageId === m.id);
            if (turn) {
              return (
                <TurnView
                  key={m.id}
                  turn={turn}
                  showWork={showWork}
                  prices={prices}
                  seenMessageIds={seenMessageIds}
                  onDequeue={(messageId) => onDequeue(conversation.id, messageId)}
                >
                  <MessageView message={m} />
                </TurnView>
              );
            }
          }
          return <MessageView key={m.id} message={m} />;
        })}
        {after}
      </div>
    </div>
  );
}

function MessageView({ message: m }: { message: Message }) {
  if (m.role === "system") {
    return <p className="self-center text-center text-sm text-text-muted">{m.text}</p>;
  }
  if (m.role === "user") {
    const files = m.attachments ?? [];
    // One line per kind the model wasn't given, so the record says plainly what wasn't read.
    const unread = [...new Set(files.filter((f) => f.sentToModel === false).map((f) => f.kind))];
    return (
      <>
        <div className="max-w-[85%] self-end rounded-2xl bg-user-bubble px-4 py-2">
          <span className="sr-only">You: </span>
          {m.text && <p className="whitespace-pre-wrap break-words">{m.text}</p>}
          {files.length > 0 && (
            <ul className={`flex flex-col gap-2 ${m.text ? "mt-2" : ""}`}>
              {files.map((f) => (
                <li key={f.id}>
                  <FileChip file={f} />
                </li>
              ))}
            </ul>
          )}
        </div>
        {unread.map((kind) => (
          <p key={kind} className="-mt-4 max-w-[85%] self-end text-sm text-text-muted">
            {cannotReadCopy(kind as AttachmentKind)}
          </p>
        ))}
      </>
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
      {m.status === "error" &&
        (m.failure === "vault_reset_required" ? (
          <p className="mt-1 text-sm text-danger">
            Your saved keys can't be opened.{" "}
            <Link href="/settings/models" className="font-medium underline underline-offset-2">
              Reset them in Settings
            </Link>
            , then enter your key again.
          </p>
        ) : (
          <p className="mt-1 text-sm text-danger">This reply failed. Try sending it again.</p>
        ))}
    </div>
  );
}

/**
 * A stored file: a link to the owner's copy, served sandboxed or as a download. An image shows
 * itself; the name beside it is the link's name either way.
 */
function FileChip({ file: f }: { file: StoredAttachment }) {
  const href = `/api/attachments/${encodeURIComponent(f.id)}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="block rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      {f.kind === "image" && (
        <img src={href} alt="" loading="lazy" className="mb-1 max-h-48 max-w-full rounded-xl" />
      )}
      <span className="break-words underline">{f.name}</span>{" "}
      <span className="text-sm text-text-muted">({formatBytes(f.sizeBytes)})</span>
    </a>
  );
}
