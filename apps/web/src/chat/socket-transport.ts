// SPDX-License-Identifier: Apache-2.0
// The chat over `GET /api/chat`, the hibernating WebSocket to the user's Assistant DO (ADR 0002).
import type { HarnessEvent } from "@opa/core";
import type { ChatTransport, ConversationSummary, StoredMessage } from "./transport";

const OPEN = 1; // WebSocket.OPEN
const UNAUTHENTICATED = 4401; // the session ended: reconnecting can't help until sign-in
const MAX_BACKOFF_MS = 30_000;
const SIGNED_OUT = "You're signed out. Reload the page to sign in again.";

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
  let signedOut = false;
  /** The conversation of the last send, which a 4401 close may leave without an answer. */
  let lastSent = "";
  /** A local rejection at `seq` 0, the same shape as the server's. */
  const reject = (conversationId: string, message: string) =>
    onEvent({
      v: 1,
      seq: 0,
      sessionId: conversationId,
      turnId: "",
      type: "turn.failed",
      payload: { message },
    });
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
          if (stopped) return;
          if (code === UNAUTHENTICATED) {
            // The server closes a send from an ended session without answering it.
            signedOut = true;
            if (lastSent) reject(lastSent, SIGNED_OUT);
            return;
          }
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
    send(conversationId, text, model, attachmentIds) {
      if (socket?.readyState === OPEN) {
        lastSent = conversationId;
        socket.send(
          JSON.stringify({
            type: "chat.send",
            conversationId,
            text,
            model,
            ...(attachmentIds?.length ? { attachmentIds } : {}),
          }),
        );
        return;
      }
      reject(
        conversationId,
        signedOut ? SIGNED_OUT : "Not connected to your assistant. Try again in a moment.",
      );
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
