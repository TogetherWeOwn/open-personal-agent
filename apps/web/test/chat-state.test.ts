// SPDX-License-Identifier: Apache-2.0
import type { HarnessEvent } from "@opa/core";
import { describe, expect, it } from "vitest";
import { type ChatAction, chatReducer, initialState } from "../src/chat/state";
import type { StoredMessage } from "../src/chat/transport";

const ev = (
  type: HarnessEvent["type"],
  payload = {},
  turnId = "t1",
  sessionId = "c1",
): ChatAction => ({
  type: "event",
  event: { v: 1, seq: 1, sessionId, turnId, type, payload } as HarnessEvent,
});
const started = (turnId = "t1", sessionId = "c1") =>
  ev("turn.started", { messageId: `r-${turnId}` }, turnId, sessionId);
const run = (...actions: ChatAction[]) => actions.reduce(chatReducer, initialState("c1"));
const send: ChatAction = { type: "send", id: "m1", text: "Plan my week" };
const stored = (
  id: string,
  role: "user" | "assistant",
  content: string,
  status: StoredMessage["status"] = "complete",
) => ({ id, role, content, status }) as const;

describe("chatReducer", () => {
  it("streams a reply into the chat it was sent from and announces it once", () => {
    const state = run(
      send,
      started(),
      ev("message.delta", { text: "Hel" }),
      { type: "new", id: "c2" },
      ev("message.delta", { text: "lo" }),
    );
    const c1 = state.conversations.find((c) => c.id === "c1");
    expect(c1?.title).toBe("Plan my week");
    expect(c1?.messages[1]).toMatchObject({ id: "r-t1", text: "Hello", status: "streaming" });
    expect(state.conversations.find((c) => c.id === "c2")?.messages).toEqual([]);
    expect(state.announcement).toBe("Assistant is working.");

    const done = run(
      send,
      started(),
      ev("message.completed", { text: "Hi." }),
      ev("turn.completed"),
    );
    expect(done.pending).toBe(null);
    expect(done.conversations[0]?.messages[1]).toMatchObject({ text: "Hi.", status: "complete" });
    expect(done.announcement).toBe("Assistant replied: Hi.");
  });

  it("titles a chat from its first message only, even when that message is the default title", () => {
    const first: ChatAction = { type: "send", id: "m1", text: "New chat" };
    const state = run(first, started(), ev("turn.completed"), {
      type: "send",
      id: "m2",
      text: "More",
    });
    expect(state.conversations[0]?.title).toBe("New chat");
    expect(state.conversations[0]?.messages).toHaveLength(4);
  });

  it("marks an interrupted, failed or rejected reply, and ignores sends while one streams", () => {
    expect(
      run(send, { type: "send", id: "m2", text: "again" }).conversations[0]?.messages.length,
    ).toBe(2);
    const stopped = run(send, started(), ev("turn.interrupted", { message: "Stopped." }));
    expect(stopped.conversations[0]?.messages[1]?.status).toBe("interrupted");
    const failed = run(send, started(), ev("turn.failed", { message: "timeout" }));
    expect(failed.conversations[0]?.messages[1]?.status).toBe("error");
    expect(failed.announcement).toBe("Something went wrong: timeout");
    // A rejection has no turn: it answers the send that hasn't started yet.
    const rejected = run(send, ev("turn.failed", { message: "busy" }, ""));
    expect(rejected.pending).toBe(null);
    expect(rejected.conversations[0]?.messages[1]?.status).toBe("error");
  });

  it("renders a turn another tab started, with its user message from the next load", () => {
    const state = run(
      { type: "listed", conversations: [{ id: "c9", title: "Elsewhere", updatedAt: 1 }] },
      started("t9", "c9"),
      ev("message.delta", { text: "Hel" }, "t9", "c9"),
      // Loaded mid-stream: D1 has the user message and the empty streaming reply.
      {
        type: "loaded",
        id: "c9",
        messages: [stored("u9", "user", "Hi"), stored("r-t9", "assistant", "", "streaming")],
      },
      ev("message.delta", { text: "lo" }, "t9", "c9"),
    );
    const c9 = state.conversations.find((c) => c.id === "c9");
    expect(c9?.messages.map((m) => [m.role, m.text, m.status])).toEqual([
      ["user", "Hi", "complete"],
      ["assistant", "Hello", "streaming"],
    ]);
    expect(c9?.stale).toBe(false);
    // This tab can't send while that turn runs, and it ends here too.
    expect(chatReducer(state, send)).toBe(state);
    expect(chatReducer(state, ev("turn.completed", {}, "t9", "c9")).pending).toBe(null);
    // A chat this tab never listed appears with the turn.
    expect(run(started("t8", "c8")).conversations[0]).toMatchObject({ id: "c8", stale: true });
  });

  it("shows the persisted state after a reload: an interrupted reply, or one still streaming", () => {
    const listed: ChatAction = {
      type: "listed",
      conversations: [{ id: "c1", title: "Plan", updatedAt: 1 }],
    };
    const interrupted = run(listed, {
      type: "loaded",
      id: "c1",
      messages: [stored("u1", "user", "Hi"), stored("r1", "assistant", "Hel", "interrupted")],
    });
    expect(interrupted.conversations).toHaveLength(1);
    expect(interrupted.conversations[0]?.messages[1]).toMatchObject({
      text: "Hel",
      status: "interrupted",
    });

    const streaming = run(
      listed,
      {
        type: "loaded",
        id: "c1",
        messages: [stored("u1", "user", "Hi"), stored("r1", "assistant", "", "streaming")],
      },
      ev("message.delta", { text: "lo" }, "t1"),
      ev("message.completed", { text: "Hello" }, "t1"),
      ev("turn.completed", {}, "t1"),
    );
    expect(streaming.conversations[0]?.messages[1]).toMatchObject({
      text: "Hello",
      status: "complete",
    });
    expect(streaming.pending).toBe(null);
  });

  it("keeps a chat the server hasn't seen and the turn a load raced; ends a turn missed offline", () => {
    const raced = run(
      send,
      { type: "listed", conversations: [] },
      { type: "loaded", id: "c1", messages: [] },
    );
    expect(raced.conversations[0]?.messages.map((m) => m.text)).toEqual(["Plan my week", ""]);

    const offline = run(send, started(), {
      type: "loaded",
      id: "c1",
      messages: [stored("u1", "user", "Plan my week"), stored("r-t1", "assistant", "Done.")],
    });
    expect(offline.pending).toBe(null);
    expect(offline.conversations[0]?.messages[1]).toMatchObject({
      text: "Done.",
      status: "complete",
    });
    // A turn that ended unseen marks its chat for reloading.
    expect(run(ev("turn.completed", {}, "t5")).conversations[0]?.stale).toBe(true);
  });
});
