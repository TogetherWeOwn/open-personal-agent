// SPDX-License-Identifier: Apache-2.0
import { useEffect, useReducer, useRef, useState } from "react";
import { Button, Heading, Link } from "react-aria-components";
import { Composer } from "./chat/Composer";
import { ConversationList } from "./chat/ConversationList";
import { type ChatAction, chatReducer, initialState } from "./chat/state";
import { Thread } from "./chat/Thread";
import type { ChatTransport } from "./chat/transport";
import { ThemeToggle } from "./ThemeToggle";

const newId = () => crypto.randomUUID();

const buttonClass =
  "min-h-11 rounded-lg px-3 text-sm font-medium hover:bg-surface-raised data-pressed:bg-border data-selected:bg-surface-raised";

export function App({ transport }: { transport: ChatTransport }) {
  const [state, dispatch] = useReducer(chatReducer, undefined, () => initialState(newId()));
  // Below 640 px the list and the open conversation take turns filling the screen.
  const [threadOpen, setThreadOpen] = useState(false);
  const cancel = useRef<(() => void) | null>(null);
  const active = state.conversations.find((c) => c.id === state.activeId) ?? state.conversations[0];
  if (!active) throw new Error("no conversation");

  const [healthy, setHealthy] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  // The Worker serves the Finish setup page while `/api/health` reports `setup_required`.
  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json())
      .then((body: { status?: string }) => {
        if (body.status === "setup_required") window.location.replace("/setup");
        else setHealthy(body.status === "ok");
      })
      .catch(() => setHealthy(false));
  }, []);

  const open = (action: ChatAction) => {
    dispatch(action);
    setThreadOpen(true);
  };

  const send = (text: string): boolean => {
    if (state.pending || !text.trim()) return false;
    dispatch({ type: "send", id: newId(), text });
    cancel.current = transport.send(active.id, text, (event) => {
      dispatch({ type: "event", event });
      if (event.type === "turn.completed" || event.type === "turn.failed") cancel.current = null;
    });
    return true;
  };

  const stop = () => {
    cancel.current?.();
    dispatch({ type: "stop" });
  };

  return (
    <div className="flex h-dvh">
      <header className="sr-only">
        <h1>Open Personal Agent</h1>
      </header>
      <aside
        aria-label="Conversations"
        className={`${threadOpen ? "hidden" : "flex"} w-full flex-col border-border bg-surface-sunken sm:flex sm:w-72 sm:border-r`}
      >
        <div className="flex items-center justify-between gap-2 p-3">
          <Heading level={2} className="px-1 text-lg font-semibold">
            Chats
          </Heading>
          <ThemeToggle className={buttonClass} />
        </div>
        <Button
          className={`${buttonClass} mx-3 mb-2 border border-border-strong`}
          onPress={() => open({ type: "new", id: newId() })}
        >
          New chat
        </Button>
        <Link href="/usage" className={`${buttonClass} mx-3 mb-2 flex items-center`}>
          Usage
        </Link>
        <ConversationList
          conversations={state.conversations}
          activeId={active.id}
          onOpen={(id) => open({ type: "select", id })}
        />
      </aside>
      <main className={`${threadOpen ? "flex" : "hidden"} min-w-0 flex-1 flex-col sm:flex`}>
        <header className="flex min-h-14 items-center gap-2 border-b border-border px-3">
          <Button className={`${buttonClass} sm:hidden`} onPress={() => setThreadOpen(false)}>
            <span aria-hidden="true">← </span>Chats
          </Button>
          <Heading level={2} className="truncate px-1 font-semibold">
            {active.title}
          </Heading>
        </header>
        {!healthy && (
          <p role="alert" className="border-b border-border bg-surface-sunken px-4 py-2 text-sm">
            Your assistant's server isn't responding properly, so replies may fail.
          </p>
        )}
        <Thread key={active.id} conversation={active} />
        <Composer
          text={drafts[active.id] ?? ""}
          setText={(text) => setDrafts((d) => ({ ...d, [active.id]: text }))}
          busy={state.pending !== null}
          onSend={send}
          onStop={stop}
        />
      </main>
      <div role="status" className="sr-only">
        {state.announcement}
      </div>
    </div>
  );
}
