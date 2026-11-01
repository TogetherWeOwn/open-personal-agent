// SPDX-License-Identifier: Apache-2.0
// The chat over `GET /api/chat`, the hibernating WebSocket to the user's Assistant DO (ADR 0002).
import type { HarnessEvent } from "@opa/core";
import type { ChatTransport, ConversationSummary, StoredMessage } from "./transport";

const OPEN = 1; // WebSocket.OPEN
const UNAUTHENTICATED = 4401; // the session ended: reconnecting can't help until sign-in
const MAX_BACKOFF_MS = 30_000;

type Socket = Pick<WebSocket, "send" | "close"> & {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
};

export interface SocketOptions {
  url?: string;
  openSocket?: (url: string) => Socket;
  fetch?: (path: string) => Promise<Response>;
}

export function createSocketTransport({
  url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/chat`,
  openSocket = (u) => new WebSocket(u) as Socket,
  fetch: get = (path) => fetch(path, { headers: { accept: "application/json" } }),
}: SocketOptions = {}): ChatTransport {
  let socket: Socket | null = null;
  let onEvent: (event: HarnessEvent) => void = () => {};
  /** A read under `/api/conversations`; `null` for a 404. */
  const json = async <T>(path: string): Promise<T | null> => {
    const res = await get(`/api/conversations${path}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  };

  return {
    connect(handle, onOpen) {
      onEvent = handle;
      let stopped = false;
      let retries = 0;
      let current: Socket | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const open = () => {
        const ws = openSocket(url);
        current = ws;
        ws.onopen = () => {
          retries = 0;
          socket = ws;
          onOpen();
        };
        ws.onmessage = ({ data }) => {
          if (typeof data !== "string") return;
          try {
            const event = JSON.parse(data) as HarnessEvent;
            if (event.v === 1) handle(event);
          } catch {}
        };
        ws.onclose = ({ code }) => {
          if (socket === ws) socket = null;
          if (stopped || code === UNAUTHENTICATED) return;
          timer = setTimeout(open, Math.min(MAX_BACKOFF_MS, 500 * 2 ** retries++));
        };
      };
      open();
      return () => {
        stopped = true;
        clearTimeout(timer);
        current?.close();
      };
    },
    send(conversationId, text) {
      if (socket?.readyState === OPEN) {
        socket.send(JSON.stringify({ type: "chat.send", conversationId, text }));
        return;
      }
      const payload = { message: "Not connected to your assistant. Try again in a moment." };
      onEvent({
        v: 1,
        seq: 0,
        sessionId: conversationId,
        turnId: "",
        type: "turn.failed",
        payload,
      });
    },
    cancel() {
      if (socket?.readyState === OPEN) socket.send(JSON.stringify({ type: "turn.cancel" }));
    },
    conversations: async () =>
      (await json<{ conversations: ConversationSummary[] }>(""))?.conversations ?? [],
    messages: async (id) =>
      (await json<{ messages: StoredMessage[] }>(`/${encodeURIComponent(id)}/messages`))
        ?.messages ?? null,
  };
}
