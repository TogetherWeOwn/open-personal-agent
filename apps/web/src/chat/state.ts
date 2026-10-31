// SPDX-License-Identifier: Apache-2.0
import type { ChatEvent } from "./transport";

type Status = "streaming" | "done" | "stopped" | "failed";
export type Message = { id: string; role: "user" | "assistant"; text: string; status: Status };
export type Conversation = { id: string; title: string; messages: Message[] };

export interface ChatState {
  conversations: Conversation[];
  activeId: string;
  /** The assistant message the running turn streams into. One turn runs at a time. */
  pending: { conversationId: string; messageId: string } | null;
  /** Text for the polite live region: start, finish and failure, never each token. */
  announcement: string;
}

export type ChatAction =
  | { type: "new"; id: string }
  | { type: "select"; id: string }
  | { type: "send"; id: string; text: string }
  | { type: "event"; event: ChatEvent }
  | { type: "stop" };

const NEW_TITLE = "New chat";

export const initialState = (id: string): ChatState => ({
  conversations: [{ id, title: NEW_TITLE, messages: [] }],
  activeId: id,
  pending: null,
  announcement: "",
});

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "new":
      return {
        ...state,
        conversations: [{ id: action.id, title: NEW_TITLE, messages: [] }, ...state.conversations],
        activeId: action.id,
      };
    case "select":
      return { ...state, activeId: action.id };
    case "send": {
      const text = action.text.trim();
      if (state.pending || !text) return state;
      const pending = { conversationId: state.activeId, messageId: `${action.id}-reply` };
      const conversations = state.conversations.map((c) =>
        c.id !== pending.conversationId
          ? c
          : {
              ...c,
              title: c.messages.length ? c.title : (text.split("\n", 1)[0]?.slice(0, 40) ?? text),
              messages: [
                ...c.messages,
                { id: action.id, role: "user", text, status: "done" } as const,
                {
                  id: pending.messageId,
                  role: "assistant",
                  text: "",
                  status: "streaming",
                } as const,
              ],
            },
      );
      return { ...state, conversations, pending };
    }
    case "stop":
      return finish(state, "stopped", "Stopped.");
    case "event": {
      const { event } = action;
      switch (event.type) {
        case "turn.started":
          return { ...state, announcement: "Assistant is working." };
        case "status":
          return { ...state, announcement: event.payload.text };
        case "message.delta":
          return updatePending(state, (m) => ({ text: m.text + event.payload.text }));
        case "message.completed":
          return {
            ...updatePending(state, () => ({ text: event.payload.text })),
            announcement: `Assistant replied: ${event.payload.text}`,
          };
        case "turn.completed":
          return finish(state, "done", state.announcement);
        case "turn.failed":
          return finish(state, "failed", `Something went wrong: ${event.payload.message}`);
      }
    }
  }
}

function finish(state: ChatState, status: Status, announcement: string): ChatState {
  if (!state.pending) return state;
  return { ...updatePending(state, () => ({ status })), pending: null, announcement };
}

function updatePending(state: ChatState, patch: (m: Message) => Partial<Message>): ChatState {
  const { pending } = state;
  if (!pending) return state;
  const conversations = state.conversations.map((c) =>
    c.id !== pending.conversationId
      ? c
      : {
          ...c,
          messages: c.messages.map((m) => (m.id === pending.messageId ? { ...m, ...patch(m) } : m)),
        },
  );
  return { ...state, conversations };
}
