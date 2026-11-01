// SPDX-License-Identifier: Apache-2.0
import type { HarnessEvent } from "@opa/core";
import { describe, expect, it } from "vitest";
import { type ChatAction, type ChatState, chatReducer, initialState } from "../src/chat/state";
import type { StoredMessage } from "../src/chat/transport";

let nextSeq = 0; // the server's `seq` never restarts, and the reducer drops one it has applied
const ev = (type: HarnessEvent["type"], payload = {}, turnId = "t1", sessionId = "c1") =>
  ({
    type: "event",
    event: { v: 1, seq: ++nextSeq, sessionId, turnId, type, payload },
  }) as ChatAction;
const started = (turnId = "t1", sessionId = "c1") =>
  ev("turn.started", { messageId: `r-${turnId}` }, turnId, sessionId);
const run = (...actions: ChatAction[]) => actions.reduce(chatReducer, initialState("c1"));
const send: ChatAction = { type: "send", id: "m1", conversationId: "c1", text: "Plan my week" };
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
    const first: ChatAction = { type: "send", id: "m1", conversationId: "c1", text: "New chat" };
    const state = run(first, started(), ev("turn.completed"), { ...send, id: "m2" });
    expect(state.conversations[0]?.title).toBe("New chat");
    expect(state.conversations[0]?.messages).toHaveLength(4);
    expect(
      run(list("c9"), { type: "select", id: "c9" }, { ...send, conversationId: "c9" })
        .conversations[0]?.id,
    ).toBe("c9");
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
    expect(reply(rejected)).not.toHaveProperty("failure");
  });

  it("keeps a vault reset refusal's code on the failed reply, so it can link there (TWO-650)", () => {
    const locked = ev("turn.failed", { message: "Reset.", code: "vault_reset_required" }, "");
    const state = run(send, locked);
    expect(state.pending).toBe(null);
    expect(reply(state)).toMatchObject({ status: "error", failure: "vault_reset_required" });
    expect(state.limit).toBe(null);
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
      // The tab streams the segment's whole text; `message.completed` names the same segment.
      delta("Hel"),
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

  it("takes back a send a limit refused, and keeps the reason until the next send", () => {
    const message = "You're sending messages quickly. Wait a minute, then try again.";
    const refused = ev("turn.failed", { message, reason: "slow_down" }, "");
    const state = run(send, refused);
    expect(state.pending).toBe(null);
    expect(state.conversations[0]).toMatchObject({ title: "New chat", messages: [] });
    expect(state.limit).toEqual({
      reason: "slow_down",
      message,
      conversationId: "c1",
      text: "Plan my week",
      attachments: [],
    });
    expect(state.announcement).toBe(message);
    expect(chatReducer(state, { ...send, id: "m2" }).limit).toBe(null);

    // In a chat with history, only the refused send leaves it.
    const reached = ev("turn.failed", { message: "Limit.", reason: "limit_reached" }, "");
    const later = run(send, started(), ev("turn.completed"), { ...send, id: "m2" }, reached);
    expect(later.conversations[0]?.messages.map((m) => m.id)).toEqual(["m1", "r-t1"]);
    expect(later.conversations[0]?.title).toBe("Plan my week");
    expect(later.limit?.reason).toBe("limit_reached");
    // Another tab's refusal (this tab sent nothing) changes nothing here.
    expect(run(reached).limit).toBe(null);
  });

  it("records a model switch as a system line and the chat's own pick (M3-06 AC3)", () => {
    const notice = "Switched to GPT-4.1 mini via OpenAI";
    const pick = { provider: "p1", model: "gpt-4.1-mini" };
    const state = run(send, started(), ev("turn.completed"), {
      type: "model",
      id: "c1",
      noticeId: "n1",
      pick,
      notice,
    });
    expect(state.conversations[0]?.model).toEqual(pick);
    expect(state.conversations[0]?.messages.at(-1)).toMatchObject({ role: "system", text: notice });
    expect(state.announcement).toBe(notice);

    // A reload from the server keeps the line where it was, and the pick survives a relist.
    const stored: StoredMessage[] = [
      { id: "m1", role: "user", content: "Plan my week", status: "complete" },
      { id: "r-t1", role: "assistant", content: "Done.", status: "complete" },
    ];
    const reloaded = chatReducer(state, load("c1", ...stored));
    expect(reloaded.conversations[0]?.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "system",
    ]);
    const relisted = chatReducer(reloaded, {
      type: "listed",
      conversations: [{ id: "c1", title: "Plan my week", updatedAt: 2, model: pick }],
    });
    expect(relisted.conversations[0]?.model).toEqual(pick);
    // A summary that says nothing about the model (the mock transport) leaves the pick alone.
    expect(chatReducer(relisted, list("c1")).conversations[0]?.model).toEqual(pick);
  });

  it("replaces the 'Switched to' line when the switch fails, so the thread says one thing", () => {
    const pick = { provider: "p1", model: "gpt-4.1-mini" };
    const switched = run(send, {
      type: "model",
      id: "c1",
      noticeId: "n1",
      pick,
      notice: "Switched to GPT-4.1 mini via OpenAI",
    });
    const failed = "Couldn't switch the model, so nothing changed.";
    const rolledBack = chatReducer(switched, {
      type: "model",
      id: "c1",
      noticeId: "n1",
      pick: null,
      notice: failed,
    });
    const system = rolledBack.conversations[0]?.messages.filter((m) => m.role === "system");
    expect(system?.map((m) => m.text)).toEqual([failed]);
    expect(rolledBack.conversations[0]?.model).toBe(null);
  });

  it("keeps a saved switch line once, in the server's place, across reloads (TWO-614)", () => {
    const notice = "Switched to GPT-4.1 mini via OpenAI";
    const switched = run(send, started(), ev("turn.completed"), {
      type: "model",
      id: "c1",
      noticeId: "n1",
      pick: { provider: "p1", model: "gpt-4.1-mini" },
      notice,
    });
    const line: StoredMessage = { id: "s1", role: "system", content: notice, status: "complete" };
    const saved = chatReducer(switched, { type: "saved", id: "c1", noticeId: "n1", message: line });
    expect(saved.conversations[0]?.messages.at(-1)).toMatchObject({ id: "s1", text: notice });

    // The server's thread holds the line: a reload shows it once, where the server put it.
    const stored = [msg("m1", "Plan my week"), msg("r-t1", "Done."), line, msg("u2", "Next?")];
    const ids = (s: ChatState) => s.conversations[0]?.messages.map((m) => m.id);
    expect(ids(chatReducer(saved, load("c1", ...stored)))).toEqual(["m1", "r-t1", "s1", "u2"]);
    // A tab that never saw the switch (a fresh load) shows it too.
    expect(ids(run(load("c1", ...stored)))).toEqual(["m1", "r-t1", "s1", "u2"]);

    // A load that brought the line before the save answered: this tab's copy just goes.
    const early = chatReducer(switched, load("c1", ...stored));
    expect(ids(early)).toEqual(["m1", "r-t1", "n1", "s1", "u2"]);
    const once = chatReducer(early, { type: "saved", id: "c1", noticeId: "n1", message: line });
    expect(ids(once)).toEqual(["m1", "r-t1", "s1", "u2"]);

    // A failed switch after a saved one stays this tab's, after it, through a reload.
    const failed = chatReducer(saved, {
      type: "model",
      id: "c1",
      noticeId: "n2",
      pick: null,
      notice: "Couldn't switch the model, so nothing changed.",
    });
    const reloaded = chatReducer(
      failed,
      load("c1", msg("m1", "Plan my week"), msg("r-t1", "Done."), line),
    );
    expect(ids(reloaded)).toEqual(["m1", "r-t1", "s1", "n2"]);
  });

  it("titles a chat switched before its first message from that message", () => {
    const switched: ChatAction = {
      type: "model",
      id: "c1",
      noticeId: "n1",
      pick: { provider: "p1", model: "gpt-4.1-mini" },
      notice: "Switched to GPT-4.1 mini via OpenAI",
    };
    expect(run(switched, send).conversations[0]?.title).toBe("Plan my week");
    // A limit refusing that first message gives the title back.
    const refused = ev("turn.failed", { message: "Slow down.", reason: "slow_down" }, "");
    expect(run(switched, send, refused).conversations[0]?.title).toBe("New chat");
  });

  it("sends into the chat the send names, not whichever is open", () => {
    // A send that waited on uploads may go after the user switched chats (M3-10).
    const state = run(list("c9"), { ...send, conversationId: "c9" });
    expect(state.activeId).toBe("c1");
    expect(state.pending?.conversationId).toBe("c9");
    expect(state.conversations.find((c) => c.id === "c9")?.messages[0]?.text).toBe("Plan my week");
    expect(state.conversations.find((c) => c.id === "c1")?.messages).toEqual([]);
  });

  it("sends files alone, titles the chat from the first file, and keeps them on a refusal", () => {
    const file = {
      id: "f1",
      name: "cat.png",
      mediaType: "image/png",
      kind: "image",
      sizeBytes: 16,
      sentToModel: false,
    } as const;
    const withFile: ChatAction = {
      type: "send",
      id: "m1",
      conversationId: "c1",
      text: "",
      attachments: [file],
    };
    const sent = run(withFile);
    expect(sent.pending).not.toBeNull();
    expect(sent.conversations[0]?.title).toBe("cat.png");
    expect(sent.conversations[0]?.messages[0]).toMatchObject({ text: "", attachments: [file] });
    // An empty send with no files is still nothing.
    expect(run({ type: "send", id: "m9", conversationId: "c1", text: "  " }).pending).toBeNull();

    // A limit refusal hands the files back with the text, for the composer.
    const refused = ev("turn.failed", { message: "Limit.", reason: "limit_reached" }, "");
    expect(run(withFile, refused).limit?.attachments).toEqual([file]);

    // A reload carries the server's record of what the model was given.
    const done = run(
      withFile,
      started(),
      ev("turn.completed"),
      load(
        "c1",
        { ...msg("u1", ""), attachments: [{ ...file, sentToModel: true }] },
        msg("r-t1", "A cat."),
      ),
    );
    expect(done.conversations[0]?.messages[0]?.attachments?.[0]?.sentToModel).toBe(true);

    // A reload of a chat with a saved model switch keeps both the file and the switch line.
    const mixed = chatReducer(
      done,
      load(
        "c1",
        { ...msg("u1", ""), attachments: [{ ...file, sentToModel: true }] },
        msg("r-t1", "A cat."),
        {
          id: "s1",
          role: "system",
          status: "complete",
          content: "Switched to Other.",
          attachments: [],
        },
      ),
    );
    expect(
      mixed.conversations[0]?.messages.map((m) => [m.role, m.attachments?.length ?? 0]),
    ).toEqual([
      ["user", 1],
      ["assistant", 0],
      ["system", 0],
    ]);
  });

  it("records M3 timeline events on the turn without touching the reply (M3-09b)", () => {
    const state = run(send, started(), delta("Hel"));
    const next = run(
      send,
      started(),
      delta("Hel"),
      ev("step.started", { stepId: "s1", label: "Thinking" }),
      ev("tool.called", { toolCallId: "call-1", tool: "web_fetch", args: "{}", risk: "read" }),
      ev("context.tainted", { stepId: "s1", source: { kind: "web", label: "x.test" } }),
    );
    // The timeline grows; the reply and the announcement don't move for it.
    expect(next.conversations[0]?.turns[0]).toMatchObject({
      steps: [{ stepId: "s1", label: "Thinking", status: "running" }],
      tools: [{ toolCallId: "call-1", tool: "web_fetch", status: "running" }],
      taint: [{ stepId: "s1", kind: "web", label: "x.test" }],
    });
    expect(reply(next)).toMatchObject({ text: "Hel", status: "streaming" });
    expect(next.announcement).toBe(state.announcement);
    expect(next.pending?.turnId).toBe("t1");
  });

  it("stops streaming at an approval or a limit, and a cancel ends the reply (M3-03c)", () => {
    const state = run(send, started(), delta("Hel"));
    const waiting = chatReducer(state, ev("approval.requested", { batchId: "b1", items: [] }));
    expect(waiting.pending).toBe(null);
    // Its card announces itself; "working" no longer holds while the turn waits.
    expect(waiting.announcement).toBe("");
    // The reply stays streaming: the resumed turn's deltas land in the same message.
    expect(reply(waiting)).toMatchObject({ text: "Hel", status: "streaming" });
    const limited = chatReducer(
      state,
      ev("limit.reached", { kind: "calls", detail: "8 model calls" }),
    );
    expect(limited.pending).toBe(null);
    expect(reply(limited)?.status).toBe("streaming");
    const cancelled = chatReducer(state, ev("turn.cancelled"));
    expect(cancelled.pending).toBe(null);
    expect(reply(cancelled)).toMatchObject({ text: "Hel", status: "interrupted" });
  });

  it("joins a turn's message segments as paragraphs (M3-03c)", () => {
    const state = run(
      send,
      started(),
      delta("One"),
      ev("message.completed", { text: "One" }),
      delta("Two"),
      ev("message.completed", { text: "Two" }),
      ev("turn.completed"),
    );
    expect(reply(state)?.text).toBe("One\n\nTwo");
  });

  it("completes an adopted reply with its whole segment, not a copy after the tail", () => {
    // Reloaded mid-reply: D1 has the earlier segment, the tab adopts the turn at its next delta.
    const reloaded = run(load("c1", msg("u1", "Hi"), msg("r-t1", "One", "streaming")));
    const state = run(
      load("c1", msg("u1", "Hi"), msg("r-t1", "One", "streaming")),
      delta("lo"),
      ev("message.completed", { text: "Hello" }),
      delta("Next"),
      ev("message.completed", { text: "Next" }),
    );
    expect(reply(reloaded)?.text).toBe("One");
    expect(reply(state)?.text).toBe("One\n\nHello\n\nNext");
  });

  it("applies a resumed turn's replayed events only once (M3-03 AC11)", () => {
    const at = (seq: number, type: HarnessEvent["type"], payload = {}): ChatAction =>
      ({
        type: "event",
        event: { v: 1, seq, sessionId: "c1", turnId: "t1", type, payload },
      }) as ChatAction;
    const state = run(
      send,
      at(7, "turn.started", { messageId: "r-t1" }),
      at(8, "message.delta", { text: "Hel" }),
    );
    // The socket dropped and resumed: the log replays the turn from its start.
    expect(chatReducer(state, at(7, "turn.started", { messageId: "r-t1" }))).toBe(state);
    expect(chatReducer(state, at(8, "message.delta", { text: "Hel" }))).toBe(state);
    expect(reply(chatReducer(state, at(9, "message.delta", { text: "lo" })))?.text).toBe("Hello");
  });
});

describe("turn timeline (M3-09)", () => {
  const step = (stepId = "s1", label = "Reading example.com", toolCallId?: string) =>
    ev("step.started", { stepId, label, ...(toolCallId ? { toolCallId } : {}) });
  const called = (toolCallId = "c1", tool = "web_fetch", args = '{"url":"https://x.example"}') =>
    ev("tool.called", { toolCallId, tool, args, risk: "read_only" });
  const turnOf = (state: ChatState, turnId = "t1") =>
    state.conversations[0]?.turns.find((t) => t.turnId === turnId);

  it("builds the timeline as steps and tools stream in, then marks the turn succeeded", () => {
    const state = run(
      send,
      started(),
      step("s1", "Reading example.com", "c1"),
      called(),
      ev("tool.result", { toolCallId: "c1", ok: true, preview: "ok", bytes: 2 }),
      ev("step.completed", { stepId: "s1", status: "ok", durationMs: 120 }),
      ev("message.completed", { text: "Done." }),
      ev("turn.completed"),
    );
    const turn = turnOf(state);
    expect(turn).toMatchObject({
      messageId: "r-t1",
      outcome: "succeeded",
      steps: [{ stepId: "s1", label: "Reading example.com", status: "ok", durationMs: 120 }],
      tools: [
        {
          toolCallId: "c1",
          stepId: "s1",
          tool: "web_fetch",
          status: "ok",
          preview: "ok",
          bytes: 2,
        },
      ],
    });
    expect(turn?.updatedAt).toBeGreaterThan(0);
    expect(reply(state)).toMatchObject({ text: "Done.", status: "complete" });
  });

  it("links a tool to its step whichever event arrives first", () => {
    const late = run(send, started(), called(), step("s1", "Reading", "c1"));
    expect(turnOf(late)?.tools[0]).toMatchObject({ toolCallId: "c1", stepId: "s1" });
    const early = run(send, started(), step("s1", "Reading", "c1"), called());
    expect(early.conversations[0]?.turns[0]?.steps[0]).toMatchObject({
      stepId: "s1",
      toolCallId: "c1",
    });
    expect(turnOf(early)?.tools[0]).toMatchObject({ stepId: "s1" });
  });

  it("ignores a completion for a step it never saw, and replays only once", () => {
    const state = run(
      send,
      started(),
      ev("step.completed", { stepId: "s9", status: "ok", durationMs: 1 }),
    );
    expect(turnOf(state)?.steps).toHaveLength(0);
    const at = (seq: number): ChatAction =>
      ({
        type: "event",
        event: {
          v: 1,
          seq,
          sessionId: "c1",
          turnId: "t1",
          type: "step.started",
          payload: { stepId: "s1", label: "L" },
        },
      }) as ChatAction;
    const once = chatReducer(run(send, started()), at(1000000));
    expect(turnOf(once)?.steps).toHaveLength(1);
    expect(chatReducer(once, at(1000000))).toBe(once);
  });

  it("records taint, usage and steers on the turn, and the queue on the conversation", () => {
    const state = run(
      send,
      started(),
      ev("context.tainted", { stepId: "s1", source: { kind: "web", label: "example.com" } }),
      ev("usage.updated", {
        usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, reasoningTokens: 0 },
        providerId: "openai",
        model: "gpt-4.1-mini",
      }),
      ev("turn.steered", { messageId: "u2", text: "actually tomorrow" }),
      ev("turn.queued", {
        messageId: "u3",
        text: "and Friday",
        position: 1,
        conversationId: "c1",
      }),
    );
    expect(turnOf(state)).toMatchObject({
      taint: [{ stepId: "s1", kind: "web", label: "example.com" }],
      usage: [{ providerId: "openai", model: "gpt-4.1-mini" }],
      steered: [{ messageId: "u2", text: "actually tomorrow" }],
    });
    expect(turnOf(state)).not.toHaveProperty("queued");
    expect(state.conversations[0]?.queued).toEqual([
      { messageId: "u3", text: "and Friday", position: 1 },
    ]);
  });

  it("clears a queued send when it is taken back, or when its turn starts", () => {
    const queued = (id: string, text: string, position: number) =>
      ev("turn.queued", { messageId: id, text, position, conversationId: "c1" });
    const back = run(
      send,
      started(),
      queued("u3", "later", 1),
      ev("turn.dequeued", { messageId: "u3", conversationId: "c1" }),
    );
    expect(back.conversations[0]?.queued).toHaveLength(0);
    // The queued send's turn starts under a new turn ID and names its send: exactly that
    // bubble clears, and the send still waiting stays (M3-09 AC4).
    const waiting = run(
      send,
      started(),
      queued("u2", "two", 1),
      queued("u3", "three", 2),
      ev("turn.completed"),
    );
    const running = chatReducer(
      waiting,
      ev("turn.started", { messageId: "r-t2", sendMessageId: "u2" }, "t2"),
    );
    expect(running.conversations[0]?.queued).toEqual([
      { messageId: "u3", text: "three", position: 2 },
    ]);
    expect(running.conversations[0]?.turns.find((t) => t.turnId === "t2")).toMatchObject({
      messageId: "r-t2",
      outcome: "running",
    });
    // A start that answers no queued send — a fresh send, or a late approval moved to a new
    // turn — leaves the queue alone instead of guessing at its head.
    const moved = chatReducer(waiting, ev("turn.started", { messageId: "r-t2" }, "t2"));
    expect(moved.conversations[0]?.queued).toHaveLength(2);
  });

  it("tracks waiting, limited and settled outcomes without touching the streaming reply", () => {
    const waiting = run(send, started(), ev("approval.requested", { batchId: "b1", items: [] }));
    expect(turnOf(waiting)?.outcome).toBe("waiting");
    expect(waiting.pending).toBe(null);
    expect(reply(waiting)?.status).toBe("streaming");

    const resumed = chatReducer(waiting, ev("approval.resolved", { batchId: "b1", decisions: [] }));
    expect(turnOf(resumed, "t1")?.outcome).toBe("running");

    const limited = run(send, started(), ev("limit.reached", { kind: "tools", detail: "20" }));
    expect(turnOf(limited)?.outcome).toBe("limited");

    const promoted = run(send, started(), ev("task.promoted", { taskId: "task1" }));
    expect(turnOf(promoted)?.promotedTaskId).toBe("task1");
    expect(turnOf(promoted)?.outcome).toBe("running");

    expect(turnOf(run(send, started(), ev("turn.cancelled")))?.outcome).toBe("cancelled");
    expect(turnOf(run(send, started(), ev("turn.interrupted", { message: "gone" })))?.outcome).toBe(
      "interrupted",
    );
    expect(turnOf(run(send, started(), ev("turn.failed", { message: "bad" })))?.outcome).toBe(
      "failed",
    );
  });

  it("adopts a running turn's timeline events when this tab meets it mid-reply (AC6)", () => {
    // Tab B loads the streaming reply, then hears the turn's steps live.
    const loaded = load("c1", msg("u1", "Hi"), msg("r-t1", "", "streaming"));
    const state = run(
      loaded,
      ev("step.started", { stepId: "s1", label: "Thinking" }, "t9", "c1"),
      ev(
        "tool.called",
        { toolCallId: "c1", tool: "web_fetch", args: "{}", risk: "read_only" },
        "t9",
        "c1",
      ),
    );
    // Adoption keys the shell to the loaded reply, and the other tab's next load agrees.
    const turn = state.conversations[0]?.turns.find((t) => t.turnId === "t9");
    expect(turn).toMatchObject({
      messageId: "r-t1",
      outcome: "running",
      steps: [{ stepId: "s1", label: "Thinking", status: "running" }],
      tools: [{ toolCallId: "c1", tool: "web_fetch" }],
    });
  });

  it("another tab's turn.started opens the same timeline shell", () => {
    const other = run(list("c1"), ev("turn.started", { messageId: "r-t2" }, "t2", "c1"));
    expect(other.conversations[0]?.turns).toMatchObject([{ turnId: "t2", messageId: "r-t2" }]);
    expect(other.pending).toMatchObject({ turnId: "t2" });
  });

  it("routes queue events to the queued send's conversation, not the running turn", () => {
    // c1 runs while c2's send parks behind it. The worker logs under c1's turn, but the
    // payload names c2 — so c2's thread bubbles and c1's stays clean (M3-09 AC4).
    const both = run(list("c1", "c2"), send, started("t1", "c1"));
    const parked = chatReducer(
      both,
      ev(
        "turn.queued",
        { messageId: "u9", text: "from the other chat", position: 1, conversationId: "c2" },
        "t1",
        "c1",
      ),
    );
    expect(parked.conversations.find((c) => c.id === "c1")?.queued).toHaveLength(0);
    expect(parked.conversations.find((c) => c.id === "c2")?.queued).toEqual([
      { messageId: "u9", text: "from the other chat", position: 1 },
    ]);
    // The take-back logs under the still-running turn and clears c2's entry.
    const back = chatReducer(
      parked,
      ev("turn.dequeued", { messageId: "u9", conversationId: "c2" }, "t1", "c1"),
    );
    expect(back.conversations.find((c) => c.id === "c2")?.queued).toHaveLength(0);
    // A replayed announcement applies once, and an unknown conversation stays untouched.
    const twice = chatReducer(
      parked,
      ev(
        "turn.queued",
        { messageId: "u9", text: "from the other chat", position: 1, conversationId: "c2" },
        "t1",
        "c1",
      ),
    );
    expect(twice.conversations.find((c) => c.id === "c2")?.queued).toHaveLength(1);
    expect(twice.conversations).toHaveLength(parked.conversations.length);
  });

  it("takes a queued send back after its run ends, without marking the chat stale", () => {
    // The Cancel button outlives the run: a dequeue after the turn completed still takes
    // its bubble back, carrying its own address with no running turn (M3-09 AC4).
    const done = run(
      send,
      started(),
      ev("turn.queued", { messageId: "u3", text: "later", position: 1, conversationId: "c1" }),
      ev("turn.completed"),
    );
    const back = chatReducer(
      done,
      ev("turn.dequeued", { messageId: "u3", conversationId: "c1" }, "t1"),
    );
    expect(back.conversations[0]?.queued).toHaveLength(0);
    expect(back.conversations[0]?.stale).toBe(0);
  });

  it("runs a paused turn again on its first progressing event", () => {
    const limited = run(send, started(), ev("limit.reached", { kind: "tools", detail: "20" }));
    // A late usage flush while paused never resumes the turn on its own.
    const flushed = chatReducer(
      limited,
      ev("usage.updated", {
        usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, reasoningTokens: 0 },
        providerId: "openai",
        model: "gpt-4.1-mini",
      }),
    );
    expect(turnOf(flushed)?.outcome).toBe("limited");
    // A queued send behind the paused turn leaves the outcome alone too.
    const parked = chatReducer(
      limited,
      ev("turn.queued", { messageId: "u3", text: "later", position: 1, conversationId: "c1" }),
    );
    expect(turnOf(parked)?.outcome).toBe("limited");
    // The Continue's first step runs the turn again without an outcome event.
    const resumed = chatReducer(limited, ev("step.started", { stepId: "s1", label: "L" }));
    expect(turnOf(resumed)?.outcome).toBe("running");

    const waiting = run(send, started(), ev("approval.requested", { batchId: "b1", items: [] }));
    const delta = chatReducer(waiting, ev("message.delta", { text: "back" }));
    expect(turnOf(delta)?.outcome).toBe("running");
  });

  it("settles a tracked turn with its loaded reply after a disconnect", () => {
    const running = run(send, started(), ev("step.started", { stepId: "s1", label: "L" }));
    expect(turnOf(running)?.outcome).toBe("running");
    // The terminal event trimmed with the settled turn; the load is the only word.
    const settled = chatReducer(running, load("c1", msg("u1", "Hi"), msg("r-t1", "Done.")));
    expect(settled.pending).toBe(null);
    expect(turnOf(settled)?.outcome).toBe("succeeded");

    const failed = chatReducer(running, load("c1", msg("u1", "Hi"), msg("r-t1", "Bad.", "error")));
    expect(turnOf(failed)?.outcome).toBe("failed");

    const cut = chatReducer(
      running,
      load("c1", msg("u1", "Hi"), msg("r-t1", "Half.", "interrupted")),
    );
    expect(turnOf(cut)?.outcome).toBe("interrupted");

    // A still-streaming reply leaves the running turn alone.
    const live = chatReducer(
      running,
      load("c1", msg("u1", "Hi"), msg("r-t1", "Half", "streaming")),
    );
    expect(turnOf(live)?.outcome).toBe("running");
    expect(live.pending).toMatchObject({ turnId: "t1" });
  });
});
