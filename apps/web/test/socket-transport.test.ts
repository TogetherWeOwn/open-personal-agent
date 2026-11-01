// SPDX-License-Identifier: Apache-2.0
import type { HarnessEvent } from "@opa/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSocketTransport, type SocketOptions } from "../src/chat/socket-transport";

type FakeSocket = ReturnType<NonNullable<SocketOptions["openSocket"]>> & { sent: string[] };

function setup(responses: Record<string, Response> = {}) {
  const sockets: FakeSocket[] = [];
  const transport = createSocketTransport({
    url: "ws://test/api/chat",
    openSocket: () => {
      const ws: FakeSocket = {
        readyState: 0,
        sent: [],
        send: (data) => void ws.sent.push(String(data)),
        close: () => {
          ws.readyState = 3;
          ws.onclose?.({ code: 1000 });
        },
        onopen: null,
        onmessage: null,
        onclose: null,
      };
      sockets.push(ws);
      return ws;
    },
    fetch: async (path) => responses[path] ?? new Response("{}", { status: 500 }),
  });
  const events: HarnessEvent[] = [];
  const onOpen = vi.fn();
  const disconnect = transport.connect((e) => events.push(e), onOpen);
  const open = (ws = sockets.at(-1)) => {
    if (!ws) throw new Error("no socket");
    ws.readyState = 1;
    ws.onopen?.();
    return ws;
  };
  return { transport, sockets, events, onOpen, disconnect, open };
}

afterEach(() => vi.useRealTimers());

describe("the socket transport", () => {
  it("sends chat.send and turn.cancel, and passes v1 events on", () => {
    const { transport, events, onOpen, open } = setup();
    const ws = open();
    expect(onOpen).toHaveBeenCalledOnce();
    transport.send("c1", "Hi");
    transport.cancel();
    expect(ws.sent.map((s) => JSON.parse(s))).toEqual([
      { type: "chat.send", conversationId: "c1", text: "Hi" },
      { type: "turn.cancel" },
    ]);
    const event = { v: 1, seq: 1, sessionId: "c1", turnId: "t1", type: "status", payload: {} };
    ws.onmessage?.({ data: JSON.stringify(event) });
    ws.onmessage?.({ data: JSON.stringify({ ...event, v: 2 }) });
    ws.onmessage?.({ data: "not json" });
    expect(events).toEqual([event]);
  });

  it("answers a send while disconnected with a rejection, and reconnects with onOpen again", () => {
    vi.useFakeTimers();
    const { transport, sockets, events, onOpen, open, disconnect } = setup();
    transport.send("c1", "Hi");
    expect(events).toMatchObject([{ seq: 0, sessionId: "c1", turnId: "", type: "turn.failed" }]);
    open().onclose?.({ code: 1006 });
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(2);
    open();
    expect(onOpen).toHaveBeenCalledTimes(2);
    // A closed session isn't retried, and neither is a socket the app closed.
    sockets[1]?.onclose?.({ code: 4401 });
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(2);
    disconnect();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(2);
  });

  it("answers a send the server closed with 4401, and every later send, with a sign-in rejection", () => {
    const { transport, events, open } = setup();
    const ws = open();
    transport.send("c1", "Hi");
    ws.onclose?.({ code: 4401 });
    transport.send("c1", "Again");
    const signedOut = { message: "You're signed out. Reload the page to sign in again." };
    const failed = { seq: 0, sessionId: "c1", turnId: "", type: "turn.failed", payload: signedOut };
    expect(events).toMatchObject([failed, failed]);
  });

  it("reads the conversation list and a conversation's messages; a 404 is null", async () => {
    const list = { conversations: [{ id: "c1", title: "Plan", updatedAt: 1 }] };
    const { transport } = setup({
      "/api/conversations": Response.json(list),
      "/api/conversations/c1/messages": Response.json({ messages: [] }),
      "/api/conversations/c2/messages": new Response("{}", { status: 404 }),
    });
    expect(await transport.conversations()).toEqual(list.conversations);
    expect(await transport.messages("c1")).toEqual([]);
    expect(await transport.messages("c2")).toBe(null);
    await expect(transport.messages("c3")).rejects.toThrow("500");
  });
});
