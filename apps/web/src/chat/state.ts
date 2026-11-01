// SPDX-License-Identifier: Apache-2.0
import type { HarnessEvent, TurnFailure, TurnLimit } from "@opa/core";
import type { ConversationSummary, StoredAttachment, StoredMessage } from "./transport";

/** A step's payload shapes, so the turn model never imports the policy package. */
type StepPayload = Extract<HarnessEvent, { type: "step.started" }>["payload"];
type ToolCalledPayload = Extract<HarnessEvent, { type: "tool.called" }>["payload"];
type TaintSource = Extract<HarnessEvent, { type: "context.tainted" }>["payload"]["source"];
type UsageEntry = Extract<HarnessEvent, { type: "usage.updated" }>["payload"];

/** The statuses D1 stores, so a loaded message keeps its own. */
type Status = StoredMessage["status"];
/**
 * `system` lines record a model switch. The server keeps each switch it saved; this tab keeps its
 * own until then, and for good when nothing was saved (a failed switch, or a chat's first pick).
 */
export type Message = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  status: Status;
  /** Why a failed reply failed, when the fix is elsewhere (a vault reset in Settings). */
  failure?: TurnFailure;
  attachments?: StoredAttachment[];
};
/** `stale` counts reasons to reload the server's messages since the last load; each loads again. */
export type Conversation = {
  id: string;
  title: string;
  messages: Message[];
  stale: number;
  /** The chat's own model (M3-06 AC3); null follows the Chat role. */
  model: { provider: string; model: string } | null;
  /** The live timeline of each turn this tab has seen (M3-09 AC1-3, 5); settled turns keep
   * their summary and cards for the session, since the server trims settled turns from its
   * log and a reload can't rebuild them. */
  turns: Turn[];
};

/** One row of the turn timeline (M3-09 AC1): a model step, possibly around one tool call. */
export interface TurnStep {
  stepId: string;
  label: string;
  status: "running" | "ok" | "error" | "denied";
  toolCallId: string | null;
  /** How long the step ran, once `step.completed` names it. */
  durationMs: number | null;
}

/** One tool card's facts (M3-09 AC3): canonical arguments, secrets as references. */
export interface TurnTool {
  toolCallId: string;
  stepId: string | null;
  tool: string;
  args: string;
  risk: ToolCalledPayload["risk"];
  status: "running" | "ok" | "error";
  preview: string | null;
  bytes: number | null;
  error?: string;
}

/** Where outside content entered the context (M3-09 AC5, SEC-5). */
export interface TurnTaint {
  stepId: string;
  kind: TaintSource["kind"];
  label: string;
}

/** A send that waits in the conversation's FIFO (M3-09 AC4). */
export interface QueuedSend {
  messageId: string;
  text: string;
  position: number;
}

/** How the turn ended, in the thread's status vocabulary (m3-ux §1.3). */
export type TurnOutcome =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "waiting"
  | "limited";

/**
 * The turn model (m3-ux §3.1): the assistant reply's timeline. `messageId` is the reply the
 * timeline belongs to; steps and tools arrive in socket order, so array order is time order.
 */
export interface Turn {
  turnId: string;
  messageId: string;
  outcome: TurnOutcome;
  steps: TurnStep[];
  tools: TurnTool[];
  taint: TurnTaint[];
  usage: UsageEntry[];
  queued: QueuedSend[];
  /** Steer texts that joined the turn, in arrival order. */
  steered: { messageId: string; text: string }[];
  /** `task.promoted`: the run continues server-side if the tab closes. */
  promotedTaskId: string | null;
  /** When the turn last changed, for the 10 s "still working" timer (M3-09 AC1). */
  updatedAt: number;
}

export interface ChatState {
  conversations: Conversation[];
  activeId: string;
  /**
   * The assistant message the running turn streams into, from this tab or another. One turn runs
   * at a time. `turnId` is `null` until `turn.started` names the turn this tab sent. `seq` is
   * the last event applied for it, so a replay after a reconnect can't apply one twice.
   */
  pending: {
    conversationId: string;
    turnId: string | null;
    messageId: string;
    seq: number;
    /**
     * Set when this tab adopted a turn mid-reply: the reply's length then. Its first deltas came
     * before, so the first `message.completed` replaces the text from here with the whole segment.
     */
    base?: number;
  } | null;
  /** Text for the polite live region: start, finish and failure, never each token. */
  announcement: string;
  /**
   * The last send a limit refused (M2-22), until the next send. It wrote nothing, so its message
   * leaves the chat and its text goes back to the composer.
   */
  limit: {
    reason: TurnLimit;
    message: string;
    conversationId: string;
    text: string;
    attachments: StoredAttachment[];
  } | null;
}

export type ChatAction =
  | { type: "new"; id: string }
  | { type: "select"; id: string }
  | {
      type: "send";
      id: string;
      // Named, not "the active chat": a send that waited on uploads may go after a switch.
      conversationId: string;
      text: string;
      attachments?: StoredAttachment[];
    }
  | { type: "event"; event: HarnessEvent }
  | { type: "connected" }
  | { type: "listed"; conversations: ConversationSummary[] }
  | { type: "loaded"; id: string; messages: StoredMessage[] }
  /**
   * A model switch in this tab: the new pick, and the system line that records it. A line that
   * reuses an earlier `noticeId` replaces that line, so a failed switch doesn't leave both.
   */
  | {
      type: "model";
      id: string;
      noticeId: string;
      pick: Conversation["model"];
      notice: string;
    }
  /** A switch saved: the server's line takes the place of this tab's `noticeId` line. */
  | { type: "saved"; id: string; noticeId: string; message: StoredMessage };

const NEW_TITLE = "New chat";
const blank = (id: string): Conversation => ({
  id,
  title: NEW_TITLE,
  messages: [],
  stale: 0,
  model: null,
  turns: [],
});

/** A turn shell for a turn this tab meets mid-run; steps fill it in as they arrive. */
const shellTurn = (turnId: string, messageId: string): Turn => ({
  turnId,
  messageId,
  outcome: "running",
  steps: [],
  tools: [],
  taint: [],
  usage: [],
  queued: [],
  steered: [],
  promotedTaskId: null,
  updatedAt: Date.now(),
});

export const initialState = (id: string): ChatState => ({
  conversations: [blank(id)],
  activeId: id,
  pending: null,
  announcement: "",
  limit: null,
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
      const attachments = action.attachments ?? [];
      // Files alone are a message too; their first name titles a new chat, as the server's does.
      if (state.pending || (!text && !attachments.length)) return state;
      const pending = {
        conversationId: action.conversationId,
        turnId: null,
        messageId: `${action.id}-reply`,
        seq: 0,
      };
      const firstLine = text.split("\n", 1)[0] ?? "";
      const sent: Message = {
        id: action.id,
        role: "user",
        text,
        status: "complete",
        ...(attachments.length ? { attachments } : {}),
      };
      return {
        ...toTop(state, pending.conversationId, (c) => ({
          // The first message names the chat (or its first file); a model switch before it
          // doesn't count.
          title: c.messages.some((m) => m.role === "user")
            ? c.title
            : (firstLine || (attachments[0]?.name ?? "")).slice(0, 40) || c.title,
          messages: [
            ...c.messages,
            sent,
            { id: pending.messageId, role: "assistant", text: "", status: "streaming" },
          ],
        })),
        pending,
        limit: null,
      };
    }
    case "connected": {
      // A send whose `turn.started` was lost with the socket: the reload shows whether it ran.
      const { pending } = state;
      if (pending?.turnId !== null) return state;
      const drop = (c: Conversation) => ({ messages: c.messages.slice(0, -2), stale: c.stale + 1 });
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
          ...action.conversations.map(({ id, title, model }) => ({
            id,
            title: title || NEW_TITLE,
            messages: known.get(id)?.messages ?? [],
            turns: known.get(id)?.turns ?? [],
            stale: (known.get(id)?.stale ?? 0) + 1,
            // The server's pin wins; a summary without one (the mock transport) keeps this tab's.
            model: model === undefined ? (known.get(id)?.model ?? null) : model,
          })),
        ],
      };
    }
    case "model": {
      const line: Message = {
        id: action.noticeId,
        role: "system",
        text: action.notice,
        status: "complete",
      };
      return {
        ...update(state, action.id, (c) => ({
          model: action.pick,
          messages: c.messages.some((m) => m.id === line.id)
            ? c.messages.map((m) => (m.id === line.id ? line : m))
            : [...c.messages, line],
        })),
        announcement: action.notice,
      };
    }
    case "saved": {
      const { id, content } = action.message;
      const line: Message = { id, role: "system", text: content, status: "complete" };
      return update(state, action.id, (c) => ({
        // A load may have brought the saved line already; then this tab's copy just goes.
        messages: c.messages.some((m) => m.id === id)
          ? c.messages.filter((m) => m.id !== action.noticeId)
          : c.messages.map((m) => (m.id === action.noticeId ? line : m)),
      }));
    }
    case "loaded":
      return loaded(state, action.id, action.messages);
    case "event":
      return onEvent(state, action.event);
  }
}

/**
 * Timeline events that adopt a running turn this tab meets mid-reply: its `turn.started`
 * went to another tab or a dropped socket, but its reply streams here, so both tabs show the
 * same live timeline (M3-09 AC6). `message.delta` keeps its own adoption below; `turn.*` keeps
 * the stale mark, since a turn ending unseen leaves nothing to stream into.
 */
const ADOPTABLE: ReadonlySet<HarnessEvent["type"]> = new Set([
  "step.started",
  "step.completed",
  "tool.called",
  "tool.result",
  "context.tainted",
  "usage.updated",
  "turn.queued",
  "turn.steered",
  "approval.requested",
  "approval.resolved",
  "limit.reached",
  "task.promoted",
]);

function onEvent(state: ChatState, event: HarnessEvent): ChatState {
  const { pending } = state;
  if (event.type === "turn.started") {
    const { messageId } = event.payload;
    const turn = {
      conversationId: event.sessionId,
      turnId: event.turnId,
      messageId,
      seq: event.seq,
    };
    if (pending?.turnId === null && pending.conversationId === event.sessionId) {
      // The turn this tab sent: its reply takes the server's message ID.
      const next = updateMessage(state, pending, () => ({ id: messageId }));
      const started = addTurn(next, event.sessionId, shellTurn(event.turnId, messageId));
      return { ...started, pending: turn, announcement: "Assistant is working." };
    }
    if (pending) return state;
    // Another tab's turn. Its user message comes with the next load of the conversation.
    const reply: Message = { id: messageId, role: "assistant", text: "", status: "streaming" };
    const next = toTop(state, event.sessionId, (c) => ({
      messages: [...c.messages, reply],
      stale: c.stale + 1,
    }));
    return {
      ...addTurn(next, event.sessionId, shellTurn(event.turnId, messageId)),
      pending: turn,
      announcement: "Assistant is working.",
    };
  }
  // A limit refused this tab's send: the server wrote nothing, so neither does this tab.
  if (event.type === "turn.failed" && event.payload.reason && event.turnId === "") {
    if (pending?.turnId !== null) return state;
    const { conversationId } = pending;
    const chat = state.conversations.find((c) => c.id === conversationId);
    const sent = chat?.messages.at(-2);
    const text = sent?.text ?? "";
    const attachments = sent?.attachments ?? [];
    const next = update(state, conversationId, (c) => {
      const messages = c.messages.slice(0, -2);
      return { messages, ...(messages.some((m) => m.role === "user") ? {} : { title: NEW_TITLE }) };
    });
    const { reason, message } = event.payload;
    const limit = { reason, message, conversationId, text, attachments };
    return { ...next, pending: null, limit, announcement: message };
  }
  // A rejection (`seq` 0) answers this tab's send before any turn started.
  const ours =
    pending && (event.turnId === "" ? pending.turnId === null : event.turnId === pending.turnId);
  if (!ours) {
    // A turn that was already running when this tab (re)connected: stream into its reply.
    // A reply a tracked turn already owns belongs to that turn (a late approval for an older
    // turn never hijacks the streaming reply), so only an unowned reply adopts.
    const conversation = state.conversations.find((c) => c.id === event.sessionId);
    const last = conversation?.messages.at(-1);
    const owner = conversation?.turns.find((t) => t.messageId === last?.id);
    if (
      !pending &&
      event.turnId &&
      last?.status === "streaming" &&
      (!owner || owner.turnId === event.turnId) &&
      (event.type === "message.delta" || ADOPTABLE.has(event.type))
    ) {
      const adopted = {
        conversationId: event.sessionId,
        turnId: event.turnId,
        messageId: last.id,
        seq: 0,
        base: last.text.length,
      };
      return onEvent({ ...state, pending: adopted }, event);
    }
    // A turn ended unseen: the next load of its conversation shows how.
    if (!pending && event.turnId && event.type.startsWith("turn.")) {
      return update(state, event.sessionId, (c) => ({ stale: c.stale + 1 }));
    }
    return state;
  }
  // A replayed event this tab already applied live: on a reconnect the log replays what the
  // dropped socket missed, and the live stream can deliver the same event too (M3-03 AC11).
  let seen = state;
  if (event.seq > 0 && event.turnId === pending.turnId) {
    if (event.seq <= pending.seq) return state;
    seen = { ...state, pending: { ...pending, seq: event.seq } };
  }
  switch (event.type) {
    case "status":
      return touchTurn({ ...seen, announcement: event.payload.text }, event);
    case "message.delta":
      return touchTurn(
        updateMessage(seen, pending, (m) => ({ text: m.text + event.payload.text })),
        event,
      );
    case "message.completed": {
      // An adopted reply's text from `base` is only the segment's tail: the whole segment
      // replaces it, once; later segments streamed whole here.
      const { base, ...unbased } = seen.pending ?? pending;
      const next = base === undefined ? seen : { ...seen, pending: unbased };
      const from = (text: string) => (base === undefined ? text : text.slice(0, base));
      return touchTurn(
        {
          ...updateMessage(next, pending, (m) => ({
            text: withSegment(from(m.text), event.payload.text),
          })),
          announcement: `Assistant replied: ${event.payload.text}`,
        },
        event,
      );
    }
    case "turn.completed":
      return finish(seen, "complete", seen.announcement, {}, "succeeded");
    // `turn.cancelled` is the user's Stop; `turn.interrupted` is the server going away
    // mid-reply (M3-03 AC6). On screen both are the same cut-short reply.
    case "turn.cancelled":
      return finish(seen, "interrupted", "The reply stopped before it finished.", {}, "cancelled");
    case "turn.interrupted":
      return finish(
        seen,
        "interrupted",
        "The reply stopped before it finished.",
        {},
        "interrupted",
      );
    case "turn.failed": {
      const { message, code } = event.payload;
      return finish(
        seen,
        "error",
        `Something went wrong: ${message}`,
        code ? { failure: code } : {},
        "failed",
      );
    }
    // The turn stopped without settling: it waits in D1 for a decision or a Continue, and its
    // reply stays `streaming`, so its later deltas stream into the same message. The approval
    // card reads D1, not this event, and announces itself (approvals/store.ts); the composer
    // frees up either way, and "working" is no longer true. The timeline still records the
    // waiting outcome, so the turn's status chip survives the approval round-trip.
    case "approval.requested":
      return { ...setOutcome(seen, event, "waiting"), pending: null, announcement: "" };
    case "limit.reached":
      return {
        ...setOutcome(seen, event, "limited"),
        pending: null,
        announcement: "The assistant stopped at a limit.",
      };
    case "usage.updated":
      return updateTurn(seen, event, (t) => ({ ...t, usage: [...t.usage, event.payload] }));
    case "step.started":
      return updateTurn(seen, event, (t) => startStep(t, event.payload));
    case "step.completed":
      return updateTurn(seen, event, (t) => ({
        ...t,
        steps: t.steps.map((s) =>
          s.stepId === event.payload.stepId
            ? { ...s, status: event.payload.status, durationMs: event.payload.durationMs }
            : s,
        ),
      }));
    case "tool.called":
      return updateTurn(seen, event, (t) => callTool(t, event.payload));
    case "tool.result":
      return updateTurn(seen, event, (t) => ({
        ...t,
        tools: t.tools.map((tool) =>
          tool.toolCallId === event.payload.toolCallId
            ? {
                ...tool,
                status: event.payload.ok ? ("ok" as const) : ("error" as const),
                preview: event.payload.preview,
                bytes: event.payload.bytes,
                ...(event.payload.error === undefined ? {} : { error: event.payload.error }),
              }
            : tool,
        ),
      }));
    case "context.tainted":
      return updateTurn(seen, event, (t) => ({
        ...t,
        taint: [
          ...t.taint,
          {
            stepId: event.payload.stepId,
            kind: event.payload.source.kind,
            label: event.payload.source.label,
          },
        ],
      }));
    case "turn.queued":
      return updateTurn(seen, event, (t) => ({
        ...t,
        queued: [
          ...t.queued.filter((q) => q.messageId !== event.payload.messageId),
          { ...event.payload },
        ],
      }));
    case "turn.steered":
      return updateTurn(seen, event, (t) => ({
        ...t,
        steered: [...t.steered, { ...event.payload }],
      }));
    case "turn.dequeued":
      return clearQueued(seen, event.sessionId, event.payload.messageId);
    case "task.promoted":
      return updateTurn(seen, event, (t) => ({
        ...t,
        promotedTaskId: event.payload.taskId,
      }));
    case "approval.resolved":
      // The turn continues after the decision; a late approval appends at the end, never
      // re-planning the old turn (M3-07 AC14), so the timeline just resumes running.
      return updateTurn(seen, event, (t) => ({
        ...t,
        outcome: t.outcome === "waiting" ? ("running" as const) : t.outcome,
      }));
    // The artifact and memory cards that render these belong to M3-10 and M3-15; the turn
    // model leaves them for those cards.
    case "artifact.created":
    case "memory.proposed":
      return seen;
  }
}

/**
 * Appends a turn to its conversation, replacing a shell with the same ID. Starting a queued
 * send takes the head of the FIFO, so the queued bubble clears as its turn starts (M3-09 AC4).
 */
function addTurn(state: ChatState, conversationId: string, turn: Turn): ChatState {
  return update(state, conversationId, (c) => {
    const queued = c.turns.flatMap((t) => t.queued);
    const head =
      queued.length > 0
        ? queued.reduce((a, b) => (a.position <= b.position ? a : b)).messageId
        : null;
    const turns = [...c.turns.filter((t) => t.turnId !== turn.turnId), turn];
    return {
      turns:
        head === null
          ? turns
          : turns.map((t) => ({ ...t, queued: t.queued.filter((q) => q.messageId !== head) })),
    };
  });
}

/**
 * The event's turn, creating its shell when this tab meets the turn mid-stream. Null when the
 * event belongs to no turn this tab tracks, and the thread stays as it is.
 */
function ensureTurn(
  state: ChatState,
  event: HarnessEvent,
): { state: ChatState; turn: Turn } | null {
  const at = state.pending;
  if (!at || at.turnId !== event.turnId || !event.turnId) return null;
  const conversation = state.conversations.find((c) => c.id === at.conversationId);
  if (!conversation) return null;
  const found = conversation.turns.find((t) => t.turnId === event.turnId);
  if (found) return { state, turn: found };
  const turn = shellTurn(event.turnId, at.messageId);
  return {
    state: update(state, conversation.id, (c) => ({ turns: [...c.turns, turn] })),
    turn,
  };
}

/**
 * Events only a progressing loop emits: a step, a tool call, taint, a steer joining, or the
 * reply moving. A turn paused at an approval or a limit that receives one has resumed, so it
 * runs again — even when the resume carried no explicit outcome event (M3-09 AC1). Usage and
 * status can flush while paused, so they never resume a turn on their own.
 */
const PROGRESS: ReadonlySet<HarnessEvent["type"]> = new Set([
  "step.started",
  "step.completed",
  "tool.called",
  "tool.result",
  "context.tainted",
  "turn.steered",
  "message.delta",
  "message.completed",
]);

/**
 * Runs `mutate` on the event's turn and stamps it, so the "still working" timer restarts on
 * every visible change (M3-09 AC1). Events for untracked turns leave the thread as it is.
 */
function updateTurn(
  state: ChatState,
  event: HarnessEvent,
  mutate: (turn: Turn) => Turn,
): ChatState {
  const ensured = ensureTurn(state, event);
  const at = ensured?.state.pending;
  if (!ensured || !at) return state;
  const mutated = mutate(ensured.turn);
  const outcome =
    (mutated.outcome === "waiting" || mutated.outcome === "limited") && PROGRESS.has(event.type)
      ? ("running" as const)
      : mutated.outcome;
  const turn = { ...mutated, outcome, updatedAt: Date.now() };
  return update(ensured.state, at.conversationId, (c) => ({
    turns: c.turns.map((t) => (t.turnId === at.turnId ? turn : t)),
  }));
}

/**
 * Takes a queued send out of every turn of its conversation. Queue entries stay on the turn
 * that was running when they were admitted, so a dequeue logged under a later turn still
 * finds one parked on an earlier turn (M3-09 AC4).
 */
function clearQueued(state: ChatState, conversationId: string, messageId: string): ChatState {
  return update(state, conversationId, (c) => ({
    turns: c.turns.map((t) =>
      t.queued.some((q) => q.messageId === messageId)
        ? { ...t, queued: t.queued.filter((q) => q.messageId !== messageId), updatedAt: Date.now() }
        : t,
    ),
  }));
}

/** Stamps the event's turn without changing it: the reply moved, so the run is visibly alive. */
const touchTurn = (state: ChatState, event: HarnessEvent): ChatState =>
  updateTurn(state, event, (t) => t);

/** Names the turn's outcome, creating its shell first when this tab adopted the turn. */
const setOutcome = (state: ChatState, event: HarnessEvent, outcome: TurnOutcome): ChatState =>
  updateTurn(state, event, (t) => ({ ...t, outcome }));

/** Records a starting step, linking a tool call that already arrived to its step. */
function startStep(turn: Turn, payload: StepPayload): Turn {
  const { stepId, label, toolCallId } = payload;
  const link = toolCallId ?? null;
  const steps = turn.steps.some((s) => s.stepId === stepId)
    ? turn.steps.map((s) => (s.stepId === stepId ? { ...s, label, status: "running" as const } : s))
    : [
        ...turn.steps,
        { stepId, label, status: "running" as const, toolCallId: link, durationMs: null },
      ];
  const tools = link
    ? turn.tools.map((t) => (t.toolCallId === link && !t.stepId ? { ...t, stepId } : t))
    : turn.tools;
  return { ...turn, steps, tools };
}

/** Records a tool call, linking the step that already named it. */
function callTool(turn: Turn, payload: ToolCalledPayload): Turn {
  const { toolCallId, tool, args, risk } = payload;
  if (turn.tools.some((t) => t.toolCallId === toolCallId)) return turn;
  const stepId = turn.steps.find((s) => s.toolCallId === toolCallId)?.stepId ?? null;
  return {
    ...turn,
    tools: [
      ...turn.tools,
      { toolCallId, stepId, tool, args, risk, status: "running", preview: null, bytes: null },
    ],
  };
}

/**
 * A turn can speak before and after its tools, so each `message.completed` is one segment of
 * the reply (already streamed by its deltas). Segments join as paragraphs, as D1 stores them.
 */
function withSegment(text: string, segment: string): string {
  const base = text.endsWith(segment) ? text.slice(0, text.length - segment.length) : text;
  return base && segment ? `${base}\n\n${segment}` : base + segment;
}

/** Replaces a conversation's messages with the server's, keeping what streams here meanwhile. */
function loaded(state: ChatState, id: string, stored: StoredMessage[]): ChatState {
  const { pending } = state;
  const current = state.conversations.find((c) => c.id === id);
  if (!current) return state;
  const local = new Map(current.messages.map((m) => [m.id, m]));
  // D1 holds a streaming reply's text only at its stops; the stream here is ahead.
  const messages = stored.map(({ id, role, status, content, attachments }): Message => {
    const m = local.get(id);
    return m?.status === "streaming" && status === "streaming"
      ? m
      : { id, role, status, text: content, ...(attachments?.length ? { attachments } : {}) };
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
  // This tab's system lines the server doesn't have (unsaved model switches): put each back after
  // the last message before it that the server kept, or at the end when that message is gone.
  const saved = new Set(stored.map((s) => s.id));
  const kept = (m: Message) => m.role !== "system" || saved.has(m.id);
  const lines: { line: Message; after: string | null }[] = [];
  current.messages.forEach((m, i) => {
    if (!kept(m))
      lines.push({
        line: m,
        after: [...current.messages.slice(0, i)].reverse().find(kept)?.id ?? null,
      });
  });
  // Backwards, so several lines after one message keep their order. A line whose message is
  // gone goes last: it still happened after everything the server kept.
  for (const { line, after } of [...lines].reverse()) {
    const found = after === null ? -1 : messages.findIndex((m) => m.id === after);
    const at = after !== null && found === -1 ? messages.length - 1 : found;
    messages.splice(at + 1, 0, line);
  }
  const next = update(state, id, () => ({ messages, stale: 0 }));
  // The turn ended while this tab was disconnected: the terminal event trimmed with the
  // settled turn, so the load is the only word. A tracked turn still marked live settles
  // with its reply — complete reads succeeded, error reads failed, and an interrupted
  // reply reads interrupted, since D1 cannot tell a cancel from an interruption (M3-09 AC1).
  // Turns the tab already settled keep their outcome.
  if (!reply || reply.status === "streaming") return next;
  const outcome =
    reply.status === "complete"
      ? ("succeeded" as const)
      : reply.status === "error"
        ? ("failed" as const)
        : ("interrupted" as const);
  return {
    ...update(next, id, (c) => ({
      turns: c.turns.map((t) =>
        t.messageId === reply.id &&
        (t.outcome === "running" || t.outcome === "waiting" || t.outcome === "limited")
          ? { ...t, outcome, updatedAt: Date.now() }
          : t,
      ),
    })),
    pending: null,
  };
}

function finish(
  state: ChatState,
  status: Status,
  announcement: string,
  patch: Partial<Message> | undefined = {},
  outcome: TurnOutcome,
): ChatState {
  if (!state.pending) return state;
  const { conversationId, turnId } = state.pending;
  const next = updateMessage(state, state.pending, () => ({ status, ...patch }));
  if (!turnId) return { ...next, pending: null, announcement };
  return {
    ...update(next, conversationId, (c) => ({
      turns: c.turns.map((t) =>
        t.turnId === turnId ? { ...t, outcome, updatedAt: Date.now() } : t,
      ),
    })),
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
