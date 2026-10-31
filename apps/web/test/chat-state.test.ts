// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { type ChatAction, chatReducer, initialState } from "../src/chat/state";
import type { ChatEvent } from "../src/chat/transport";

const ev = (type: ChatEvent["type"], payload = {}): ChatAction => ({
  type: "event",
  event: { seq: 1, turnId: "t1", type, payload } as ChatEvent,
});
const run = (...actions: ChatAction[]) => actions.reduce(chatReducer, initialState("c1"));
const send: ChatAction = { type: "send", id: "m1", text: "Plan my week" };

describe("chatReducer", () => {
  it("streams a reply into the chat it was sent from and announces it once", () => {
    const state = run(
      send,
      ev("turn.started"),
      ev("message.delta", { text: "Hel" }),
      { type: "new", id: "c2" },
      ev("message.delta", { text: "lo" }),
    );
    const c1 = state.conversations.find((c) => c.id === "c1");
    expect(c1?.title).toBe("Plan my week");
    expect(c1?.messages[1]).toMatchObject({ text: "Hello", status: "streaming" });
    expect(state.conversations.find((c) => c.id === "c2")?.messages).toEqual([]);
    expect(state.announcement).toBe("Assistant is working.");

    const done = run(send, ev("message.completed", { text: "Hi." }), ev("turn.completed"));
    expect(done.pending).toBe(null);
    expect(done.conversations[0]?.messages[1]).toMatchObject({ text: "Hi.", status: "done" });
    expect(done.announcement).toBe("Assistant replied: Hi.");
  });

  it("marks a stopped or failed reply, and ignores sends while one streams", () => {
    expect(
      run(send, { type: "send", id: "m2", text: "again" }).conversations[0]?.messages.length,
    ).toBe(2);
    expect(run(send, { type: "stop" }).conversations[0]?.messages[1]?.status).toBe("stopped");
    const failed = run(send, ev("turn.failed", { message: "timeout" }));
    expect(failed.conversations[0]?.messages[1]?.status).toBe("failed");
    expect(failed.announcement).toBe("Something went wrong: timeout");
  });
});
