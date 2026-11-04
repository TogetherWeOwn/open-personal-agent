// SPDX-License-Identifier: Apache-2.0
import { createSocketTransport } from "../../apps/web/src/chat/socket-transport.ts";

/** Feed a real notification through the browser's cursor and capture its reconnect request. */
export async function resumeAfterArtifact(notification) {
  const tabs = [];
  const sent = [];
  let reconnected = () => {};
  const resumed = new Promise((resolve) => {
    reconnected = resolve;
  });
  const transport = createSocketTransport({
    url: "ws://localhost/api/chat",
    openSocket: () => {
      const tab = {
        readyState: 1,
        onopen: null,
        onmessage: null,
        onclose: null,
        close: () => {},
        send: (frame) => sent.push(JSON.parse(String(frame))),
      };
      tabs.push(tab);
      queueMicrotask(() => tab.onopen?.());
      return tab;
    },
  });
  const stop = transport.connect(
    () => {},
    () => {
      if (tabs.length > 1) reconnected();
    },
  );
  try {
    await Promise.resolve();
    const first = tabs[0];
    if (!first) throw new Error("missing initial socket");
    for (const frame of [
      {
        v: 1,
        seq: 3,
        sessionId: notification.sessionId,
        turnId: "chat-turn",
        type: "turn.started",
        payload: {},
      },
      {
        v: 1,
        seq: 4,
        sessionId: notification.sessionId,
        turnId: "chat-turn",
        type: "message.delta",
        payload: { text: "hello" },
      },
      notification,
    ])
      first.onmessage?.({ data: JSON.stringify(frame) });
    first.onclose?.({ code: 1006 });
    await resumed;
    return sent;
  } finally {
    stop();
  }
}
