// SPDX-License-Identifier: Apache-2.0
import { type Dispatch, useEffect, useReducer, useRef, useState } from "react";
import { Button, Heading, Link } from "react-aria-components";
import { Composer } from "./chat/Composer";
import { ConversationList } from "./chat/ConversationList";
import { ModelChip } from "./chat/ModelChip";
import {
  type ChatAction,
  type ChatState,
  type Conversation,
  chatReducer,
  initialState,
} from "./chat/state";
import { Thread } from "./chat/Thread";
import type { ChatTransport } from "./chat/transport";
import {
  describePick,
  type ModelSettings,
  type RolePick,
  setConversationModel,
  settingsApi,
} from "./models/settings-api";
import { ThemeToggle } from "./ThemeToggle";

const newId = () => crypto.randomUUID();

const buttonClass =
  "min-h-11 rounded-lg px-3 text-sm font-medium hover:bg-surface-raised data-pressed:bg-border data-selected:bg-surface-raised";

/** Loads a stale chat's messages from the server. */
function useLoad(
  transport: ChatTransport,
  chat: Conversation | undefined,
  dispatch: Dispatch<ChatAction>,
) {
  const [id, stale] = [chat?.id, chat?.stale];
  useEffect(() => {
    if (!id || !stale) return;
    let current = true;
    transport
      .messages(id)
      .then((messages) => current && messages && dispatch({ type: "loaded", id, messages }))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [transport, id, stale, dispatch]);
}

interface AppProps {
  transport: ChatTransport;
  /** Client-side navigation, from the shell; a full load when the app stands alone. */
  onNavigate?: (href: string) => void;
  /** False while another screen covers the chat; becoming visible reloads the model settings. */
  visible?: boolean;
}

export function App({ transport, onNavigate, visible = true }: AppProps) {
  const [state, dispatch] = useReducer(chatReducer, undefined, () => initialState(newId()));
  // Below 640 px the list and the open conversation take turns filling the screen.
  const [threadOpen, setThreadOpen] = useState(false);
  const active = state.conversations.find((c) => c.id === state.activeId) ?? state.conversations[0];
  if (!active) throw new Error("no conversation");

  const [healthy, setHealthy] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // The saved providers and roles behind the context chip; null until they load, and after a
  // failed load the composer simply has no chip.
  const [modelSettings, setModelSettings] = useState<ModelSettings | null>(null);
  useEffect(() => {
    if (!visible) return;
    let current = true;
    settingsApi<ModelSettings>("").then(
      (loaded) => {
        if (current && Array.isArray(loaded.providers) && loaded.roles) setModelSettings(loaded);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [visible]);

  // A switch the server hasn't saved yet, for a chat it hasn't seen (nothing sent) or while the
  // save is in flight. A send carries it, so a new chat's first reply already uses it; `sentPins`
  // is what the last send carried, so a switch made after it is still saved once the chat exists.
  const pendingPins = useRef(new Map<string, RolePick | null>());
  const sentPins = useRef(new Map<string, RolePick | null | undefined>());
  // Removing a provider in Settings clears the server's pins on it, so a pin naming one that is
  // gone follows the Chat role here too.
  const live = (pick: RolePick | null | undefined) =>
    pick && (!modelSettings || modelSettings.providers.some((p) => p.id === pick.provider))
      ? pick
      : null;
  const pinned = live(active.model);

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

  const known = useRef(new Set<string>());
  known.current = new Set(state.conversations.map((c) => c.id));

  // Every tab streams every turn. On each (re)connect, and for a chat another tab started, reload
  // the list; it marks the server's chats stale, so the open one reloads its messages below.
  useEffect(() => {
    const list = () =>
      transport
        .conversations()
        .then((conversations) => dispatch({ type: "listed", conversations }))
        .catch(() => {});
    const connected = () => {
      dispatch({ type: "connected" });
      void list();
    };
    return transport.connect((event) => {
      if (event.type === "turn.started") {
        if (!known.current.has(event.sessionId)) void list();
        const id = event.sessionId;
        const pick = pendingPins.current.get(id);
        // The send saved its pick with the new chat; a later switch is saved now the chat exists.
        if (pendingPins.current.has(id) && sentPins.current.get(id) !== pick) {
          void setConversationModel(id, pick ?? null).then(
            () => pendingPins.current.get(id) === pick && pendingPins.current.delete(id),
            () => {},
          );
        } else pendingPins.current.delete(id);
        sentPins.current.delete(id);
      }
      dispatch({ type: "event", event });
    }, connected);
  }, [transport]);

  // The open chat reloads once stale, and so does a running turn's: only a load can end a turn
  // whose last events were missed while disconnected.
  const running = state.conversations.find((c) => c.id === state.pending?.conversationId);
  useLoad(transport, active, dispatch);
  useLoad(transport, running === active ? undefined : running, dispatch);

  // A send a limit refused goes back to the composer, unless something new was typed meanwhile.
  const { limit } = state;
  useEffect(() => {
    if (!limit) return;
    const { conversationId: id, text } = limit;
    setDrafts((d) => (d[id] ? d : { ...d, [id]: text }));
  }, [limit]);

  const open = (action: ChatAction) => {
    dispatch(action);
    setThreadOpen(true);
  };

  const send = (text: string): boolean => {
    if (state.pending || !text.trim()) return false;
    dispatch({ type: "send", id: newId(), text });
    const pick = pendingPins.current.get(active.id);
    sentPins.current.set(active.id, pick);
    transport.send(active.id, text, live(pick) ?? undefined);
    return true;
  };

  const goModels = () =>
    onNavigate ? onNavigate("/settings/models") : window.location.assign("/settings/models");

  /** Switches the open chat's model (M3-06 AC3); the thread records it, history is kept. */
  const switchModel = (pick: RolePick | null) => {
    if (!modelSettings) return;
    const effective = pick ?? modelSettings.roles.chat;
    if (!effective) return;
    const { modelName, providerName } = describePick(modelSettings, effective);
    const { id } = active;
    const previous = pinned;
    const noticeId = newId();
    dispatch({
      type: "model",
      id,
      noticeId,
      pick,
      notice: `Switched to ${modelName} via ${providerName}`,
    });
    pendingPins.current.set(id, pick);
    const settled = () => pendingPins.current.get(id) === pick && pendingPins.current.delete(id);
    void (async () => {
      try {
        await setConversationModel(id, pick);
        settled();
      } catch (e) {
        // A brand-new chat isn't on the server yet; its first send carries the pick.
        if ((e as Error).message === "not_found") return;
        settled();
        // The failure line takes the place of the optimistic "Switched to" line.
        dispatch({
          type: "model",
          id,
          noticeId,
          pick: previous,
          notice: "Couldn't switch the model, so nothing changed.",
        });
      }
    })();
  };

  const noModel = modelSettings !== null && !modelSettings.roles.chat && !pinned;

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
        <Link href="/settings/models" className={`${buttonClass} mx-3 mb-2 flex items-center`}>
          Settings
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
        {limit?.conversationId === active.id && <LimitNotice limit={limit} />}
        <Composer
          text={drafts[active.id] ?? ""}
          setText={(text) => setDrafts((d) => ({ ...d, [active.id]: text }))}
          busy={state.pending !== null}
          onSend={send}
          onStop={() => transport.cancel()}
          onNoModel={noModel ? goModels : undefined}
          chip={
            modelSettings && (
              <ModelChip settings={modelSettings} pinned={pinned} onSwitch={switchModel} />
            )
          }
        />
      </main>
      <div role="status" className="sr-only">
        {state.announcement}
      </div>
    </div>
  );
}

/** The "slow down" and "limit reached" states (M2-22): why the send didn't go, and when it can. */
function LimitNotice({ limit }: { limit: NonNullable<ChatState["limit"]> }) {
  const reached = limit.reason === "limit_reached";
  return (
    <div
      role="alert"
      className="mx-auto w-full max-w-[720px] px-4 pb-2 text-sm"
      data-limit={limit.reason}
    >
      <div className="rounded-xl border border-border-strong bg-surface-sunken px-3 py-2">
        <p className="font-semibold">{reached ? "Daily limit reached" : "Slow down"}</p>
        <p>
          {limit.message}
          {reached && (
            <>
              {" "}
              <Link href="/usage" className="underline">
                See today's usage
              </Link>
              .
            </>
          )}
        </p>
      </div>
    </div>
  );
}
