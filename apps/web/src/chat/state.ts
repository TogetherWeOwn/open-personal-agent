// SPDX-License-Identifier: Apache-2.0
import type { HarnessEvent } from "@opa/core";
import type { ConversationSummary, StoredMessage } from "./transport";

/** The statuses D1 stores, so a loaded message keeps its own. */
type Status = StoredMessage["status"];
export type Message = { id: string; role: "user" | "assistant"; text: string; status: Status };
/** `stale` until the server's copy of its messages has been loaded since the last (re)connect. */
export type Conversation = { id: string; title: string; messages: Message[]; stale: boolean };

export interface ChatState {
  conversations: Conversation[];
  activeId: string;
  /**
   * The assistant message the running turn streams into, from this tab or another. One turn runs
   * at a time. `turnId` is `null` until `turn.started` names the turn this tab sent.
   */
  pending: { conversationId: string; turnId: string | null; messageId: string } | null;
  /** Text for the polite live region: start, finish and failure, never each token. */
  announcement: string;
}

export type ChatAction =
  | { type: "new"; id: string }
  | { type: "select"; id: string }
  | { type: "send"; id: string; text: string }
  | { type: "event"; event: HarnessEvent }
  | { type: "connected" }
  | { type: "listed"; conversations: ConversationSummary[] }
  | { type: "loaded"; id: string; messages: StoredMessage[] };

const NEW_TITLE = "New chat";
const blank = (id: string): Conversation => ({ id, title: NEW_TITLE, messages: [], stale: false });

export const initialState = (id: string): ChatState => ({
  conversations: [blank(id)],
  activeId: id,
  pending: null,
  announcement: "",
});

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "new":
      return {
        ...state,
        conversations: [blank(action.id), ...state.conversations],
        activeId: action.id,
      };
    case "select":
      return { ...state, activeId: action.id };
    case "send": {
      const text = action.text.trim();
      if (state.pending || !text) return state;
      const pending = {
        conversationId: state.activeId,
        turnId: null,
        messageId: `${action.id}-reply`,
      };
      return {
        ...toTop(state, pending.conversationId, (c) => ({
          title: c.messages.length ? c.title : (text.split("\n", 1)[0]?.slice(0, 40) ?? text),
          messages: [
            ...c.messages,
            { id: action.id, role: "user", text, status: "complete" },
            { id: pending.messageId, role: "assistant", text: "", status: "streaming" },
          ],
        })),
        pending,
      };
    }
    case "connected": {
      // A send whose `turn.started` was lost with the socket: the reload shows whether it ran.
      const { pending } = state;
      if (pending?.turnId !== null) return state;
      const drop = (c: Conversation) => ({ messages: c.messages.slice(0, -2), stale: true });
      return { ...update(state, pending.conversationId, drop), pending: null };
    }
    case "listed": {
      // Chats this tab made that the server hasn't seen yet stay on top; the server's are reloaded.
      const known = new Map(state.conversations.map((c) => [c.id, c]));
      const listed = new Set(action.conversations.map((c) => c.id));
      return {
        ...state,
        conversations: [
          ...state.conversations.filter((c) => !listed.has(c.id)),
          ...action.conversations.map(({ id, title }) => ({
            id,
            title: title || NEW_TITLE,
            messages: known.get(id)?.messages ?? [],
            stale: true,
          })),
        ],
      };
    }
    case "loaded":
      return loaded(state, action.id, action.messages);
    case "event":
      return onEvent(state, action.event);
  }
}

function onEvent(state: ChatState, event: HarnessEvent): ChatState {
  const { pending } = state;
  if (event.type === "turn.started") {
    const { messageId } = event.payload;
    const turn = { conversationId: event.sessionId, turnId: event.turnId, messageId };
    if (pending?.turnId === null && pending.conversationId === event.sessionId) {
      // The turn this tab sent: its reply takes the server's message ID.
      const next = updateMessage(state, pending, () => ({ id: messageId }));
      return { ...next, pending: turn, announcement: "Assistant is working." };
    }
    if (pending) return state;
    // Another tab's turn. Its user message comes with the next load of the conversation.
    const reply: Message = { id: messageId, role: "assistant", text: "", status: "streaming" };
    return {
      ...toTop(state, event.sessionId, (c) => ({ messages: [...c.messages, reply], stale: true })),
      pending: turn,
      announcement: "Assistant is working.",
    };
  }
  // A rejection (`seq` 0) answers this tab's send before any turn started.
  const ours =
    pending && (event.turnId === "" ? pending.turnId === null : event.turnId === pending.turnId);
  if (!ours) {
    // A turn that was already running when this tab (re)connected: stream into its reply.
    const last = state.conversations.find((c) => c.id === event.sessionId)?.messages.at(-1);
    if (!pending && event.type === "message.delta" && last?.status === "streaming") {
      const adopted = { conversationId: event.sessionId, turnId: event.turnId, messageId: last.id };
      return onEvent({ ...state, pending: adopted }, event);
    }
    // A turn ended unseen: the next load of its conversation shows how.
    if (!pending && event.turnId && event.type.startsWith("turn.")) {
      return update(state, event.sessionId, () => ({ stale: true }));
    }
    return state;
  }
  switch (event.type) {
    case "status":
      return { ...state, announcement: event.payload.text };
    case "message.delta":
      return updateMessage(state, pending, (m) => ({ text: m.text + event.payload.text }));
    case "message.completed":
      return {
        ...updateMessage(state, pending, () => ({ text: event.payload.text })),
        announcement: `Assistant replied: ${event.payload.text}`,
      };
    case "turn.completed":
      return finish(state, "complete", state.announcement);
    case "turn.interrupted":
      return finish(state, "interrupted", "The reply stopped before it finished.");
    case "turn.failed":
      return finish(state, "error", `Something went wrong: ${event.payload.message}`);
    case "usage.updated":
      return state;
  }
}

/** Replaces a conversation's messages with the server's, keeping what streams here meanwhile. */
function loaded(state: ChatState, id: string, stored: StoredMessage[]): ChatState {
  const { pending } = state;
  const current = state.conversations.find((c) => c.id === id);
  if (!current) return state;
  const local = new Map(current.messages.map((m) => [m.id, m]));
  // D1 holds a streaming reply's text only once it ends; the stream here is ahead.
  const messages = stored.map(({ id, role, status, content }): Message => {
    const m = local.get(id);
    return m?.status === "streaming" && status === "streaming"
      ? m
      : { id, role, status, text: content };
  });
  const mine = pending?.conversationId === id ? pending : null;
  const reply = mine && stored.find((s) => s.id === mine.messageId);
  if (mine && !reply) {
    // Loaded before the turn's first write: keep this tab's copy of it.
    const at = current.messages.findIndex((m) => m.id === mine.messageId);
    const sent = current.messages[at - 1];
    if (sent?.role === "user" && !stored.some((s) => s.id === sent.id)) messages.push(sent);
    if (at >= 0) messages.push(current.messages[at] as Message);
  }
  const next = update(state, id, () => ({ messages, stale: false }));
  // The turn ended while this tab was disconnected.
  return reply && reply.status !== "streaming" ? { ...next, pending: null } : next;
}

function finish(state: ChatState, status: Status, announcement: string): ChatState {
  if (!state.pending) return state;
  return {
    ...updateMessage(state, state.pending, () => ({ status })),
    pending: null,
    announcement,
  };
}

function update(
  state: ChatState,
  id: string,
  patch: (c: Conversation) => Partial<Conversation>,
): ChatState {
  return {
    ...state,
    conversations: state.conversations.map((c) => (c.id === id ? { ...c, ...patch(c) } : c)),
  };
}

/** Updates a chat, adding it if it's new, and moves it to the top, as its new turn does in D1. */
function toTop(state: ChatState, id: string, patch: (c: Conversation) => Partial<Conversation>) {
  const chat = state.conversations.find((c) => c.id === id) ?? blank(id);
  const rest = state.conversations.filter((c) => c !== chat);
  return { ...state, conversations: [{ ...chat, ...patch(chat) }, ...rest] };
}

function updateMessage(
  state: ChatState,
  at: { conversationId: string; messageId: string },
  patch: (m: Message) => Partial<Message>,
): ChatState {
  return update(state, at.conversationId, (c) => ({
    messages: c.messages.map((m) => (m.id === at.messageId ? { ...m, ...patch(m) } : m)),
  }));
}
