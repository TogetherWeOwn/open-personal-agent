// SPDX-License-Identifier: Apache-2.0
import type { HarnessEvent } from "@opa/core";
import { describe, expect, it } from "vitest";
import { type ChatAction, type ChatState, chatReducer, initialState } from "../src/chat/state";
import type { StoredMessage } from "../src/chat/transport";

const ev = (type: HarnessEvent["type"], payload = {}, turnId = "t1", sessionId = "c1") =>
  ({ type: "event", event: { v: 1, seq: 1, sessionId, turnId, type, payload } }) as ChatAction;
const started = (turnId = "t1", sessionId = "c1") =>
  ev("turn.started", { messageId: `r-${turnId}` }, turnId, sessionId);
const run = (...actions: ChatAction[]) => actions.reduce(chatReducer, initialState("c1"));
const send: ChatAction = { type: "send", id: "m1", text: "Plan my week" };
const msg = (id: string, content: string, status: StoredMessage["status"] = "complete") =>
  ({ id, role: id.startsWith("u") ? "user" : "assistant", content, status }) as const;
const load = (id: string, ...messages: StoredMessage[]): ChatAction => ({
  type: "loaded",
  id,
  messages,
});
const list = (...ids: string[]): ChatAction => ({
  type: "listed",
  conversations: ids.map((id) => ({ id, title: id, updatedAt: 1 })),
});
/** The reply in the top chat. */
const reply = (state: ChatState) => state.conversations[0]?.messages[1];
const delta = (text: string) => ev("message.delta", { text });

describe("chatReducer", () => {
  it("streams a reply into the chat it was sent from and announces it once", () => {
    const state = run(send, started(), delta("Hel"), { type: "new", id: "c2" }, delta("lo"));
    expect(state.conversations[1]?.title).toBe("Plan my week");
    expect(state.conversations[1]?.messages[1]).toMatchObject({ id: "r-t1", text: "Hello" });
    expect(state.announcement).toBe("Assistant is working.");

    const done = run(
      send,
      started(),
      ev("message.completed", { text: "Hi." }),
      ev("turn.completed"),
    );
    expect(done.pending).toBe(null);
    expect(reply(done)).toMatchObject({ text: "Hi.", status: "complete" });
    expect(done.announcement).toBe("Assistant replied: Hi.");
  });

  it("titles a chat from its first message only, and moves a chat it sends in to the top", () => {
    const first: ChatAction = { type: "send", id: "m1", text: "New chat" };
    const state = run(first, started(), ev("turn.completed"), { ...send, id: "m2" });
    expect(state.conversations[0]?.title).toBe("New chat");
    expect(state.conversations[0]?.messages).toHaveLength(4);
    expect(run(list("c9"), { type: "select", id: "c9" }, send).conversations[0]?.id).toBe("c9");
  });

  it("marks an interrupted, failed or rejected reply, and ignores sends while one streams", () => {
    expect(run(send, { ...send, id: "m2" }).conversations[0]?.messages.length).toBe(2);
    const stopped = run(send, started(), ev("turn.interrupted", { message: "Stopped." }));
    expect(reply(stopped)?.status).toBe("interrupted");
    const failed = run(send, started(), ev("turn.failed", { message: "timeout" }));
    expect(reply(failed)?.status).toBe("error");
    expect(failed.announcement).toBe("Something went wrong: timeout");
    // A rejection has no turn: it answers the send that hasn't started yet.
    const rejected = run(send, ev("turn.failed", { message: "busy" }, ""));
    expect(rejected.pending).toBe(null);
    expect(reply(rejected)?.status).toBe("error");
  });

  it("renders a turn another tab started, with its user message from the next load", () => {
    const state = run(
      list("c9"),
      started("t9", "c9"),
      ev("message.delta", { text: "Hel" }, "t9", "c9"),
      // Loaded mid-stream: D1 has the user message and the empty streaming reply.
      load("c9", msg("u9", "Hi"), msg("r-t9", "", "streaming")),
      ev("message.delta", { text: "lo" }, "t9", "c9"),
    );
    const c9 = state.conversations[0];
    expect(c9?.messages.map((m) => [m.role, m.text, m.status])).toEqual([
      ["user", "Hi", "complete"],
      ["assistant", "Hello", "streaming"],
    ]);
    expect(c9?.stale).toBe(0);
    // This tab can't send while that turn runs, and it ends here too.
    expect(chatReducer(state, send)).toBe(state);
    expect(chatReducer(state, ev("turn.completed", {}, "t9", "c9")).pending).toBe(null);
    // A chat this tab never listed appears with the turn.
    expect(run(started("t8", "c8")).conversations[0]).toMatchObject({ id: "c8", stale: 1 });
  });

  it("shows the persisted state after a reload: an interrupted reply, or one still streaming", () => {
    const loadedC1 = load("c1", msg("u1", "Hi"), msg("r1", "Hel", "interrupted"));
    const interrupted = run(list("c1"), loadedC1);
    expect(interrupted.conversations).toHaveLength(1);
    expect(reply(interrupted)).toMatchObject({ text: "Hel", status: "interrupted" });

    const streaming = run(
      list("c1"),
      load("c1", msg("u1", "Hi"), msg("r1", "", "streaming")),
      delta("lo"),
      ev("message.completed", { text: "Hello" }),
      ev("turn.completed"),
    );
    expect(reply(streaming)).toMatchObject({ text: "Hello", status: "complete" });
    expect(streaming.pending).toBe(null);
  });

  it("keeps the turn a load raced; ends a turn missed offline; reloads after a reconnect", () => {
    const raced = run(send, list(), load("c1"));
    expect(raced.conversations[0]?.messages.map((m) => m.text)).toEqual(["Plan my week", ""]);

    const done = load("c1", msg("u1", "Plan my week"), msg("r-t1", "Done."));
    const offline = run(send, started(), done);
    expect(offline.pending).toBe(null);
    expect(reply(offline)).toMatchObject({ text: "Done.", status: "complete" });
    // A turn that ended unseen marks its chat for reloading.
    expect(run(ev("turn.completed", {}, "t5")).conversations[0]?.stale).toBe(1);
    // A send whose turn.started was lost with the socket: the reload shows whether it ran.
    const lost = run(send, { type: "connected" });
    expect(lost.pending).toBe(null);
    expect(lost.conversations[0]).toMatchObject({ messages: [], stale: 1 });
    // If it did run, its start reloads the chat again, even after a load that came too early.
    expect(chatReducer(lost, started()).conversations[0]?.stale).toBe(2);
  });
});
