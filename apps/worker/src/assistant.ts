// SPDX-License-Identifier: Apache-2.0
// The per-user assistant (ADR 0002), named `u:<userId>` by the server. It owns the hibernating
// WebSockets of all the user's tabs, hosts the builtin loop for one chat turn at a time
// (M3-03c) and sends every event to every tab, so two tabs show the same stream. D1 holds the
// messages and a stopped turn's resumable state (AC5); the DO holds the running turn and the
// event log a reconnected tab replays from (AC10).
import {
  type HarnessEvent,
  type ModelAttachment,
  type ModelMessage,
  type ModelProvider,
  type ModelUsage,
  TASK_LIMITS,
  type TurnFailure,
  type TurnLimit,
} from "@opa/core";
import {
  type AttachmentRow,
  createRepository,
  isId,
  type SavedTurn,
  scopeForAssistant,
  type TurnStatus,
} from "@opa/db/repository";
import { systemStore } from "@opa/db/system";
import {
  type ApprovalDecision,
  type Budget,
  continueTurn,
  type LoopEvent,
  type LoopHost,
  type LoopTool,
  newTurn,
  resolveApprovals,
  runTurn,
  TURN_LIMITS,
  type TurnState,
} from "@opa/harness-builtin";
import { ToolRegistry } from "@opa/policy";
import { type ChatModelError, resolveChatModel } from "@opa/server/chat-model";
import {
  Agent,
  type Connection,
  type ConnectionContext,
  type FiberRecoveryContext,
  type WSMessage,
} from "agents";
import { compose, type WorkerEnv, withoutMasterKeys } from "./compose";
import type { Bindings, Env } from "./env";
import { EventLog } from "./event-log";
import {
  type CallScope,
  checkSpending,
  Limits,
  type Refusal,
  type Reservation,
  SPENDING_DEFAULTS,
  type SpendingSettings,
} from "./limits";

/** Set by the Worker on the upgrade (a client's own value is overwritten): the session's row ID. */
export const SESSION_HEADER = "x-opa-session-id";
const MAX_TEXT = 32_000;
const MAX_ATTACHMENTS = 10;
/** How much of a text file one turn carries to the model; the file itself is kept whole in R2. */
const MAX_ATTACHMENT_TEXT = 100_000;
/** How far a text file is read: enough bytes for `MAX_ATTACHMENT_TEXT` characters of any UTF-8. */
const TEXT_READ_BYTES = MAX_ATTACHMENT_TEXT * 4;
/**
 * The bytes of files one turn hands the model. Images and PDFs go as base64 in one request, so
 * this bounds the Durable Object's memory (128 MB) and the upstream request (about 32 MB at the
 * strictest provider) whatever the conversation holds.
 */
export const TURN_FILE_BYTES = 16 * 1024 * 1024;
const IMAGE_TOKENS = 2_500;
const PDF_MAX_TOKENS = 100_000; // about 100 pages, the providers' usual page limit
const TAB_RECHECK_MS = 30_000; // how often task progress rechecks the tabs' sessions
const STASH_MS = 1_000; // how often a streaming reply is checkpointed, so eviction keeps most

type Emit = <T extends HarnessEvent["type"]>(
  type: T,
  payload: Extract<HarnessEvent, { type: T }>["payload"],
) => void;

/** One progress event from a Workflow task (M3-12 AC8), as its driver numbers them. */
export interface TaskProgress {
  conversationId: string;
  turnId: string;
  taskId: string;
  seq: number;
  type: string;
  payload: unknown;
}

type CallUsage = { inputTokens: number; outputTokens: number; cachedInputTokens: number };

/**
 * A running turn's eviction checkpoint (the fiber snapshot): plain JSON. The loop's own
 * `TurnState` is not in here — a turn evicted mid-run settles interrupted from this alone, and
 * only a turn that stopped cleanly (approval, limit) has its `TurnState` in D1 to resume from.
 */
interface TurnCheckpoint {
  conversationId: string;
  turnId: string;
  replyId: string;
  /** Who bills the turn's calls (`billingProviderId`). */
  providerId: string;
  model: string;
  /** The reply's text so far: its message segments joined with a blank line. */
  reply: string;
  /** The user's message and the streaming reply are in D1. */
  wrote: boolean;
  /** Budget holds of calls still running, `<turnId>:<n>`, unsettled. */
  holds: string[];
  /** A model call has started, so it belongs in the ledger. */
  callStarted: boolean;
  /** This call's ledger row is written. */
  callRecorded: boolean;
  callUsage: CallUsage | null;
}

export class Assistant extends Agent<Bindings> {
  // Tabs learn nothing about the instance, and get none of the SDK's own protocol frames.
  static override options = { sendIdentityOnConnect: false };
  /** Picks each turn's model. Tests replace it with a scripted provider. */
  resolveModel = resolveChatModel;
  /**
   * The tools a turn may offer the model, with the policy inputs for them. Tests replace it;
   * the builtin tools (M3-04 and later) register here. Until then a turn offers none.
   */
  resolveTools: () => { tools: ToolRegistry<LoopTool>; policy: LoopHost["policy"] } = () => ({
    tools: new ToolRegistry<LoopTool>(),
    policy: () => ({}),
  });
  #running: AbortController | null = null;
  /** Turn rate and daily spend, in this DO's storage (M2-22). */
  readonly limits = new Limits(this.ctx.storage.kv);
  /** Every broadcast event, per conversation, until its turn settles to D1 (M3-03 AC10). */
  readonly #events = new EventLog(this.ctx.storage.sql);
  /** The env with the vault: `compose` stays the only reader of the master keys. */
  readonly #composed: Promise<Env>;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, withoutMasterKeys(env));
    this.#composed = compose(env);
  }

  /** Liveness check for `/api/health`. */
  ping(): string {
    return "pong";
  }

  /**
   * Budget for a Workflow task's model call (M3-12 AC8), reached over DO RPC. The Workflow holds
   * this stub only through the scope its own task row minted, so a task can only ever spend its
   * own user's budget. Plain methods are Worker-side RPC, not client callables — tabs cannot
   * reach them. The key is the call's idempotency key (`instanceId:stepName`): a retried step
   * may already hold a reservation under it and may already have spent it, so that hold settles
   * at its full reservation before a new one is taken. Settling a key with no hold charges
   * nothing, so the first reserve is unaffected. The scope names the task, whose budget the call
   * draws on, and whether it runs in the background, where the monthly hard cap applies.
   */
  reserveTaskCall(
    key: string,
    providerId: string,
    model: string,
    chars: number,
    scope: CallScope = {},
  ): Reservation | Refusal {
    this.limits.settle(key, providerId, model, null);
    return this.limits.reserveFor(key, providerId, model, chars, 0, scope);
  }

  /** Settles a task's model call to what it used; settling twice charges once. */
  settleTaskCall(
    key: string,
    providerId: string,
    model: string,
    usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | null,
  ): void {
    this.limits.settle(key, providerId, model, usage);
  }

  /** Drops a task call's reservation without a charge: the call never happened. */
  releaseTaskCall(key: string): void {
    this.limits.release(key);
  }

  /** Reserves a task's budget as it starts (COST-3); a replayed start keeps what it spent. */
  startTask(taskId: string, budgetMicroUsd?: number): { budgetMicroUsd: number } {
    return this.limits.startTask(taskId, budgetMicroUsd);
  }

  /** Continue after a task-budget stop: `false` once the budget was already raised (A-Co2). */
  raiseTask(taskId: string): boolean {
    return this.limits.raiseTask(taskId);
  }

  /** Undoes a Continue's raise when the task couldn't be woken, so Continue can try again. */
  unraiseTask(taskId: string): void {
    this.limits.unraiseTask(taskId);
  }

  /** Settles a task's budget at its end: what the task spent. */
  endTask(taskId: string): number {
    return this.limits.endTask(taskId);
  }

  /** A task's budget and spend so far, for its card; `null` once it has ended. */
  taskBudget(taskId: string) {
    return this.limits.task(taskId);
  }

  /**
   * Counts a tool call against 60 a minute (COST-2); `false` means the tool must not run. The
   * key (the step's idempotency key) keeps a retried step from counting the same call twice.
   */
  allowToolCall(callKey?: string): boolean {
    return this.limits.toolCall(callKey);
  }

  /** The Spending settings and what they limit so far, for Settings › Spending (M3-17 AC5). */
  spending() {
    return {
      settings: this.limits.settings(),
      defaults: SPENDING_DEFAULTS,
      // Read-only in M3 (§4.2): shown with the editable limits so every limit is in one place.
      executionLimits: {
        callsPerMessage: TURN_LIMITS.calls,
        toolCallsPerMessage: TURN_LIMITS.tools,
        stepsPerTask: TASK_LIMITS.steps,
      },
      ...this.limits.totals(),
    };
  }

  /**
   * Saves a Spending change if every field is valid (`checkSpending`); `null` if not. Returns
   * the settings before and after together, so an audit of the change can't pair this write
   * with another request's "before", and the write's number for `revertSpending`.
   */
  setSpending(
    body: unknown,
  ): { before: SpendingSettings; after: SpendingSettings; write: number } | null {
    const changes = checkSpending(body);
    if (!changes) return null;
    const before = this.limits.settings();
    const { settings: after, write } = this.limits.saveSettings(changes);
    return { before, after, write };
  }

  /**
   * Undoes a `setSpending` whose audit row couldn't be written. A field goes back only while
   * this write is still the last to have changed it, so a later change that saved meanwhile is
   * never overwritten, even one that set the same value.
   */
  revertSpending(write: number, before: SpendingSettings): void {
    this.limits.revertSettings(write, before);
  }

  /**
   * A Workflow task's progress, broadcast to the user's tabs in the v1 envelope. `seq` is the
   * driver's per-task counter; persisting these into the per-conversation event log is M3-03c's
   * (AC10), which will dedupe replays by it. Until then a Workflow replay can repeat a live
   * progress event, never invent one. Like a chat turn, it first closes tabs whose session has
   * ended; a task streams for longer than a turn, so the check repeats every 30 seconds.
   */
  taskProgress(progress: TaskProgress): Promise<void> {
    // Chained, so a call that skips the recheck can't broadcast ahead of one still awaiting it.
    const sent = this.#progress.then(() => this.#sendProgress(progress));
    this.#progress = sent.catch(() => {});
    return sent;
  }

  async #sendProgress(progress: TaskProgress): Promise<void> {
    if (Date.now() - this.#tabsCheckedAt >= TAB_RECHECK_MS) {
      this.#tabsCheckedAt = Date.now();
      await Promise.all(
        [...this.getConnections()].map((tab) =>
          this.#sessionLive(tab).catch(() => tab.close(1011, "session check failed")),
        ),
      );
    }
    this.broadcast(
      JSON.stringify({
        v: 1,
        seq: progress.seq,
        sessionId: progress.conversationId,
        turnId: progress.turnId,
        taskId: progress.taskId,
        type: progress.type,
        payload: progress.payload,
      }),
    );
  }

  /** When task progress last rechecked the tabs' sessions. */
  #tabsCheckedAt = 0;
  /** The last progress broadcast, so the next waits for it. */
  #progress: Promise<void> = Promise.resolve();

  /** The user's scope, from this DO's own name, which only the server sets. */
  get #scope() {
    return scopeForAssistant(this.name);
  }

  get #repo() {
    return createRepository(this.env).forUser(this.#scope);
  }

  get #chat() {
    return this.#repo.chat;
  }

  override shouldSendProtocolMessages(): boolean {
    return false;
  }

  /** Tabs can't write the SDK's state; they talk only through `onMessage`. */
  override shouldConnectionBeReadonly(): boolean {
    return true;
  }

  override onConnect(connection: Connection, ctx: ConnectionContext): void {
    connection.setState({ sessionId: ctx.request.headers.get(SESSION_HEADER) });
  }

  override onMessage(connection: Connection, message: WSMessage): void {
    const msg = parse(message);
    // A tab whose session is still live may stop the running turn.
    if (msg?.type === "turn.cancel")
      void this.#sessionLive(connection).then((ok) => ok && this.#running?.abort());
    // A reconnected tab replays what it missed (M3-03 AC11): to this tab only, after the same
    // session recheck, and only from this user's own log — the DO is named from the session, so
    // a conversation ID from the client can't reach another user's events.
    if (msg?.type === "resume") {
      void this.#sessionLive(connection).then((ok) => {
        if (!ok) return;
        try {
          for (const frame of this.#events.replay(msg.conversationId, msg.turnId, msg.afterSeq)) {
            connection.send(frame);
          }
        } catch {
          // The tab went away mid-replay; it will resume again on its next connect.
        }
      });
    }
    if (msg?.type !== "chat.send") return;
    const text = msg.text.trim();
    // One turn at a time is the concurrency limit: a second send waits for the first.
    if (this.#running) {
      reject(connection, msg.conversationId, "Another reply is still being written.");
    } else if (
      !isId(msg.conversationId) ||
      (!text && !msg.attachmentIds.length) ||
      text.length > MAX_TEXT
    ) {
      reject(connection, "", "That message can't be sent.");
    } else if (!this.limits.startTurn()) {
      const message = "You're sending messages quickly. Wait a minute, then try again.";
      reject(connection, msg.conversationId, message, "slow_down");
    } else {
      const running = new AbortController();
      this.#running = running;
      void this.runFiber("chat-turn", (fiber) =>
        this.#turn(
          connection,
          msg.conversationId,
          text,
          msg.model,
          msg.attachmentIds,
          running.signal,
          fiber.stash,
        ),
      )
        // The model's failures are reported in the turn; this is D1 failing.
        .catch(() => reject(connection, msg.conversationId, "The reply couldn't be saved."))
        .finally(() => {
          if (this.#running === running) this.#running = null;
        });
    }
  }

  async #turn(
    connection: Connection,
    conversationId: string,
    text: string,
    own: { provider: string; model: string } | undefined,
    attachmentIds: readonly string[],
    signal: AbortSignal,
    stash: (data: TurnCheckpoint) => void,
  ) {
    if (!(await this.#sessionLive(connection))) return;
    const chat = this.#chat;
    // The model context comes from D1, never from memory, so it survives an eviction. A new
    // conversation has none yet.
    const history = await chat.listMessages(conversationId);
    // Picked before `open`, so a send that can't run never creates an empty conversation. A send
    // may name the chat's own model, for a chat picked before the server had it (M3-06 AC3); an
    // existing chat keeps the pin it has, so a newer switch is never overwritten by a send.
    const fresh = history === null ? own : undefined;
    const pick = fresh ?? { conversationId };
    const picked = await this.resolveModel(await this.#composed, this.#scope, "chat", pick);
    if ("error" in picked) {
      const message = MODEL_ERRORS[picked.error] ?? "The model isn't available right now.";
      const code = picked.error === "vault_reset_required" ? picked.error : undefined;
      return reject(connection, conversationId, message, undefined, code);
    }
    const { provider, model } = picked;
    // The send's files, scoped: an ID that isn't this user's upload reads as missing, and the
    // whole send is refused rather than quietly dropping a file the user attached.
    const user = this.#repo;
    const attached = await user.attachments.getMany(attachmentIds);
    if (attached.length !== new Set(attachmentIds).size) {
      return reject(connection, conversationId, "One of those files isn't available anymore.");
    }
    const caps = provider.capabilities(model);
    // A file goes to the model only where its capability flags allow (M3-10 AC2); `skipped`
    // collects the kinds this send turned away, to say so plainly.
    const readable = (row: AttachmentRow) =>
      row.kind === "text" || (row.kind === "image" ? caps.imageInput : caps.pdfInput) === true;
    const skipped = new Set<"image" | "pdf">();
    for (const row of attached) if (row.kind !== "text" && !readable(row)) skipped.add(row.kind);
    // The files one turn hands the model are read into memory and sent as one request, so they
    // share a byte budget: this send's files first, whole or not at all, then earlier turns'
    // newest first while they fit. An earlier file left out was read on its own turn.
    const sending = attached.filter(readable);
    let budget = TURN_FILE_BYTES - sending.reduce((n, row) => n + modelBytes(row), 0);
    if (budget < 0) {
      const message =
        "Those files are too large to send in one message. Try fewer, or smaller, files.";
      return reject(connection, conversationId, message);
    }
    const cp: TurnCheckpoint = {
      conversationId,
      turnId: crypto.randomUUID(),
      replyId: crypto.randomUUID(),
      providerId: picked.billingId ?? provider.id,
      model,
      reply: "",
      wrote: false,
      holds: [],
      callStarted: false,
      callRecorded: false,
      callUsage: null,
    };
    const past = history ?? [];
    const replayed = new Set<string>();
    for (const m of past.toReversed()) {
      if (m.role !== "user") continue;
      for (const row of m.attachments.filter(readable)) {
        if (modelBytes(row) > budget) continue;
        budget -= modelBytes(row);
        replayed.add(row.id);
      }
    }
    const messages: ModelMessage[] = [];
    let fileTokens = 0;
    const read = async (rows: readonly AttachmentRow[]) => {
      const files: ModelAttachment[] = [];
      const ids = new Set<string>();
      for (const row of rows) {
        const file = await this.#modelFile(row);
        if (!file) continue;
        files.push(file);
        ids.add(row.id);
        fileTokens += fileTokenEstimate(row);
      }
      return { files, ids };
    };
    for (const m of past) {
      if (m.role === "user" && m.attachments.length) {
        const { files } = await read(m.attachments.filter((row) => replayed.has(row.id)));
        // A file-only message whose files aren't replayed leaves nothing to say: skip it, as an
        // empty message always was.
        if (!m.content && !files.length) continue;
        messages.push({
          role: "user",
          content: m.content,
          ...(files.length ? { attachments: files } : {}),
        });
      } else if (m.content !== "") {
        messages.push({ role: m.role, content: m.content });
      }
    }
    const { files: sent, ids: sentIds } = await read(sending);
    messages.push({ role: "user", content: text, ...(sent.length ? { attachments: sent } : {}) });
    // Reserved before anything is written, so a refused send leaves no trace, not even a
    // conversation.
    const chars = messages.reduce(
      (sum, m) =>
        sum +
        m.content.length +
        (m.role === "user"
          ? (m.attachments ?? []).reduce((n, f) => n + (f.text?.length ?? 0), 0)
          : 0),
      0,
    );
    // Checkpoint before the reservation and the first write, so a recovery can always name the
    // turn and release what it holds.
    stash(cp);
    // The first call is reserved before anything is written, so a refused send leaves no trace,
    // not even a conversation. The loop's budget spends this reservation on its first call and
    // reserves later calls itself.
    const firstHold = `${cp.turnId}:0`;
    const reservation = this.limits.reserve(firstHold, cp.providerId, model, chars, fileTokens);
    if (!reservation) {
      const message = "You've reached today's spending limit. It resets at midnight UTC.";
      return reject(connection, conversationId, message, "limit_reached");
    }
    cp.holds = [firstHold];
    stash(cp);
    const emit = this.#emitter(conversationId, cp.turnId);
    const title = (text.split("\n", 1)[0] || attached[0]?.name || "").slice(0, 40);
    try {
      if (!(await chat.open(conversationId, title, fresh))) {
        this.limits.release(firstHold);
        return reject(connection, conversationId, "That conversation doesn't exist.");
      }
      await picked.used?.();
      await chat.startTurn(
        conversationId,
        text,
        cp.replyId,
        attached.map((row) => ({ id: row.id, sentToModel: sentIds.has(row.id) })),
      );
    } catch (err) {
      this.limits.release(firstHold); // no call was made
      throw err;
    }
    cp.wrote = true;
    stash(cp);
    await this.#sweepTabs();
    // The host names the turn; the loop never emits `turn.started` itself.
    emit("turn.started", { messageId: cp.replyId });
    // Plainly, per m3-ux §3.2: the file stays with the message, but this model won't read it.
    for (const kind of skipped) emit("status", { text: UNREAD[kind] });
    await this.#drive({
      checkpoint: cp,
      stash,
      provider,
      model,
      firstHold: { id: firstHold, maxOutputTokens: reservation.maxOutputTokens },
      history: messages,
      state: newTurn(),
      signal,
    });
  }

  /**
   * Resumes a turn stopped at an approval with the user's decisions (M3-03 AC5). Server routes
   * (M3-07a) reach this through the scoped repository's `assistant()`: this DO is named from
   * the caller's session and `turns.load` is scope-filtered, so a turn ID can only ever
   * address this user's saved turns. Tabs can't call it — `onMessage` routes only `chat.send`,
   * `turn.cancel` and `resume`.
   *
   * `false` when a turn is already running, the saved turn is missing or not awaiting
   * approval, or no model is available (the saved turn stays for a retry). A decision against
   * an unknown, stale or decided approval throws `ApprovalError` before anything changes.
   */
  async resumeWithDecisions(input: {
    turnId: string;
    batchId: string;
    decisions: ApprovalDecision[];
  }): Promise<boolean> {
    // Claimed before the first await: D1 and vault I/O don't hold the DO's input gate, so two
    // decision calls for one turn (a double-clicked Approve, two tabs, a retried 07a request)
    // would otherwise both load the same `awaiting_approval` row and run its approved tools
    // twice. A `chat.send` arriving mid-resume is rejected the same way.
    if (this.#running) return false;
    const running = new AbortController();
    this.#running = running;
    let started = false;
    try {
      const saved = await this.#repo.turns.load(input.turnId);
      if (saved?.status !== "awaiting_approval") return false;
      const state = parseTurnState(saved.state);
      if (!state) {
        await this.#dropCorrupt(saved);
        return false;
      }
      resolveApprovals(state, input.batchId, input.decisions, Date.now());
      started = await this.#resume(saved, state, running);
      return started;
    } finally {
      // The fiber owns the claim once a drive starts; every other exit — `false`, an
      // `ApprovalError`, a D1 failure — releases it here. (`#resume` releases the claim itself
      // on its re-stop path, where it returns `true` without starting a fiber.)
      if (!started && this.#running === running) this.#running = null;
    }
  }

  /** Resumes a turn stopped at its call or tool limit, with a fresh allowance (its Continue). */
  async resumeAfterLimit(turnId: string): Promise<boolean> {
    // Claimed before the first await, as above: a second Continue, or a `chat.send`, arriving
    // mid-resume must not start a second loop for the turn.
    if (this.#running) return false;
    const running = new AbortController();
    this.#running = running;
    let started = false;
    try {
      const saved = await this.#repo.turns.load(turnId);
      if (saved?.status !== "limit_reached") return false;
      const state = parseTurnState(saved.state);
      if (!state) {
        await this.#dropCorrupt(saved);
        return false;
      }
      continueTurn(state);
      started = await this.#resume(saved, state, running);
      return started;
    } finally {
      if (!started && this.#running === running) this.#running = null;
    }
  }

  /**
   * Runs a saved turn again from its D1 state: a fresh model pick, history and first hold.
   * `running` is the caller's claim, held since before the first await; the fiber owns it once a
   * drive starts, and every path that starts no fiber releases it.
   */
  async #resume(saved: SavedTurn, state: TurnState, running: AbortController): Promise<boolean> {
    const picked = await this.resolveModel(await this.#composed, this.#scope, "chat");
    if ("error" in picked) return false; // the saved turn stays for a retry once a model is set
    const { provider, model } = picked;
    const repo = this.#repo;
    const cp: TurnCheckpoint = {
      conversationId: saved.conversationId,
      turnId: saved.turnId,
      replyId: saved.replyId,
      providerId: picked.billingId ?? provider.id,
      model,
      reply: "",
      wrote: true,
      holds: [],
      callStarted: false,
      callRecorded: false,
      callUsage: null,
    };
    // History is D1's, as at the turn's start, minus the still-streaming reply: its text so
    // far is inside `state`, where the loop left it.
    const history: ModelMessage[] = ((await repo.chat.listMessages(saved.conversationId)) ?? [])
      .filter((m) => m.id !== saved.replyId && m.content !== "")
      .map(({ role, content }) => ({ role, content }));
    const firstHold = `${saved.turnId}:0`;
    const chars = [...history, ...state.messages].reduce((sum, m) => sum + m.content.length, 0);
    const reservation = this.limits.reserve(firstHold, cp.providerId, model, chars);
    if (!reservation) {
      // Stops again at today's limit. Decisions recorded on the state stay recorded. No fiber
      // starts, so the caller's claim is released here.
      const restopped = await repo.turns.save({
        ...saved,
        providerId: cp.providerId,
        model,
        status: "limit_reached",
        state: JSON.stringify(state),
      });
      if (!restopped) throw new Error("the turn's conversation is gone");
      this.#emitter(saved.conversationId, saved.turnId)("limit.reached", {
        kind: "daily",
        detail: "Today's spending limit",
      });
      if (this.#running === running) this.#running = null;
      return true;
    }
    cp.holds = [firstHold];
    void this.runFiber("chat-turn", async (fiber) => {
      fiber.stash(cp);
      await this.#sweepTabs();
      await this.#drive({
        checkpoint: cp,
        stash: fiber.stash,
        provider,
        model,
        firstHold: { id: firstHold, maxOutputTokens: reservation.maxOutputTokens },
        history,
        state,
        signal: running.signal,
      });
    })
      .catch(() => {}) // a D1 failure surfaces as the interrupted recovery, never silently
      .finally(() => {
        if (this.#running === running) this.#running = null;
      });
    return true;
  }

  /** A saved state that no longer parses is dropped fail-closed: settle interrupted, tell tabs. */
  async #dropCorrupt(saved: SavedTurn): Promise<void> {
    const repo = this.#repo;
    const stored = (await repo.chat.listMessages(saved.conversationId).catch(() => null)) ?? [];
    const reply = stored.find((m) => m.id === saved.replyId)?.content ?? "";
    await repo.chat.settle({ replyId: saved.replyId, reply }, "interrupted").catch(() => {});
    await repo.turns.remove(saved.turnId).catch(() => {});
    this.#emitter(saved.conversationId, saved.turnId)("turn.interrupted", { message: "Retry?" });
    this.#events.trim(saved.conversationId, saved.turnId);
  }

  /**
   * Drives the loop over `state` and owns everything around it: forwarding its events, the
   * reply's text, one ledger row per model call, the budget's holds, and the turn's end —
   * settled to D1 before its terminal event is sent, or, at an approval or limit, saved to D1
   * to resume later (its event log stays, so a reconnect still replays the whole turn).
   */
  async #drive(run: {
    checkpoint: TurnCheckpoint;
    stash: (data: TurnCheckpoint) => void;
    provider: ModelProvider;
    model: string;
    firstHold: { id: string; maxOutputTokens: number };
    history: ModelMessage[];
    state: TurnState;
    signal: AbortSignal;
  }): Promise<void> {
    const { checkpoint: cp, stash, state, signal } = run;
    const { conversationId, turnId, replyId } = cp;
    const repo = this.#repo;
    const chat = repo.chat;
    const emit = (event: LoopEvent) =>
      this.#send(conversationId, turnId, event.type, event.payload);

    // One hold per model call. The first spends the caller's pre-reservation; a later call the
    // day's budget can't cover stops the turn at its daily limit instead.
    let calls = 0;
    let pendingHold: string | null = run.firstHold.id;
    let first = true;
    const budget: Budget = {
      reserve: (messages) => {
        if (first) {
          first = false;
          return { maxOutputTokens: run.firstHold.maxOutputTokens };
        }
        const hold = `${turnId}:${++calls}`;
        const chars = messages.reduce((sum, m) => sum + m.content.length, 0);
        const reserved = this.limits.reserve(
          hold,
          cp.providerId,
          cp.model,
          chars,
          messageFileTokens(messages),
        );
        if (!reserved) return { limit: "daily", detail: "Today's spending limit" };
        pendingHold = hold;
        cp.holds = [hold];
        stash(cp);
        return { maxOutputTokens: reserved.maxOutputTokens };
      },
      settle: (usage) => {
        if (!pendingHold) return;
        this.limits.settle(pendingHold, cp.providerId, cp.model, usage ? pickUsage(usage) : null);
        pendingHold = null;
        cp.holds = [];
      },
    };

    const { tools, policy } = this.resolveTools();
    const host: LoopHost = {
      provider: run.provider,
      model: run.model,
      tools,
      policy,
      budget,
      now: Date.now,
      newId: () => crypto.randomUUID(),
    };

    // The reply's text: one segment per model call that spoke, joined as paragraphs. A resumed
    // turn's earlier segments come back from its saved state.
    const segments = state.messages.flatMap((m) =>
      m.role === "assistant" && m.content ? [m.content] : [],
    );
    let current = "";
    const syncReply = () => {
      cp.reply = [...segments, current].filter((s) => s !== "").join("\n\n");
    };
    syncReply();

    const recordCall = async () => {
      await repo.usage.record({
        providerId: cp.providerId,
        model: cp.model,
        usage: cp.callUsage,
        conversationId,
        messageId: replyId,
      });
      cp.callRecorded = true;
      stash(cp);
    };
    // Mid-turn a failed row is retried at the call's end and again before settling; only a
    // failure there fails the turn, as D1 failing did before the loop.
    const tryRecord = async () => {
      if (cp.callStarted && !cp.callRecorded) await recordCall().catch(() => {});
    };

    let persisted = false;
    const persistStop = async (status: TurnStatus) => {
      const saved = await repo.turns.save({
        turnId,
        conversationId,
        replyId,
        providerId: cp.providerId,
        model: cp.model,
        status,
        state: JSON.stringify(state),
      });
      if (!saved) throw new Error("the turn's conversation is gone");
      await chat.checkpointReply(replyId, cp.reply);
      persisted = true;
    };
    const failSave = async () => {
      await chat.settle({ replyId, reply: cp.reply }, "error").catch(() => {});
      this.#send(conversationId, turnId, "turn.failed", {
        message: "The reply couldn't be saved.",
      });
      this.#events.trim(conversationId, turnId);
    };

    const gen = runTurn(host, run.history, state, signal);
    let thinking = "";
    let stashedAt = 0;
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        // A resume still waiting on undecided approvals names no stop event; save it anyway,
        // with the decisions recorded so far.
        if (!persisted && (next.value === "awaiting_approval" || next.value === "limit_reached")) {
          await persistStop(next.value).catch(failSave);
        }
        return;
      }
      const event = next.value;
      if (
        event.type === "turn.completed" ||
        event.type === "turn.cancelled" ||
        event.type === "turn.failed"
      ) {
        const status =
          event.type === "turn.completed"
            ? "complete"
            : event.type === "turn.cancelled"
              ? "interrupted" // D1 has no "cancelled": a stopped reply is an interrupted one
              : "error";
        try {
          if (cp.callStarted && !cp.callRecorded) await recordCall();
          await chat.settle({ replyId, reply: cp.reply }, status);
          await repo.turns.remove(turnId);
        } catch {
          await failSave();
          await gen.return("failed");
          return;
        }
        emit(event);
        // The turn is in D1 now, so its events leave the log; a later tab reloads from D1.
        this.#events.trim(conversationId, turnId);
        continue;
      }
      if (event.type === "approval.requested" || event.type === "limit.reached") {
        // The state is complete at these events; save it before any tab can act on them.
        try {
          await persistStop(
            event.type === "approval.requested" ? "awaiting_approval" : "limit_reached",
          );
        } catch {
          await failSave();
          await gen.return("failed");
          return;
        }
        emit(event);
        continue;
      }
      switch (event.type) {
        case "step.started":
          if (!event.payload.toolCallId) {
            thinking = event.payload.stepId;
            cp.callStarted = true;
            cp.callRecorded = false;
            cp.callUsage = null;
            stash(cp);
          }
          break;
        case "message.delta":
          current += event.payload.text;
          syncReply();
          if (Date.now() - stashedAt > STASH_MS) {
            stash(cp);
            stashedAt = Date.now();
          }
          break;
        case "message.completed":
          if (event.payload.text) segments.push(event.payload.text);
          current = "";
          syncReply();
          stash(cp);
          break;
        case "usage.updated":
          cp.callUsage = pickUsage(event.payload.usage);
          await tryRecord();
          stash(cp);
          break;
        case "step.completed":
          if (event.payload.stepId === thinking) {
            await tryRecord(); // a call that reported no usage still gets its row
            stash(cp);
          }
          break;
        default:
          break;
      }
      emit(event);
    }
  }

  /**
   * Every tab gets the reply, so first close those whose session has ended since they opened.
   * A check that fails closes its tab too, but retryably (1011, not 4401): the tab reconnects
   * and the upgrade rechecks its session. The turn itself goes on.
   */
  async #sweepTabs(): Promise<void> {
    await Promise.all(
      [...this.getConnections()].map((tab) =>
        this.#sessionLive(tab).catch(() => tab.close(1011, "session check failed")),
      ),
    );
  }

  /**
   * One file as the model receives it, or `null` when its object is gone. A text file rides as
   * text and is read only as far as the model will see it; an image or PDF goes whole as base64,
   * which the model APIs take, and the caller has already fitted it to the turn's byte budget.
   */
  async #modelFile(row: AttachmentRow): Promise<ModelAttachment | null> {
    const object = await this.#repo.attachments.getObject(row.id);
    if (!object?.body) return null;
    if (row.kind === "text") {
      const { bytes, more } = await readPrefix(object.body, TEXT_READ_BYTES);
      // `stream` holds back a character the cut split, rather than decoding it as garbage.
      const whole = new TextDecoder().decode(bytes, { stream: more });
      const text =
        more || whole.length > MAX_ATTACHMENT_TEXT
          ? `${whole.slice(0, MAX_ATTACHMENT_TEXT)}\n[Only the first part of this file is shown: it is long.]`
          : whole;
      return { kind: "text", mediaType: row.mediaType, name: row.name, text };
    }
    const data = base64(new Uint8Array(await object.arrayBuffer()));
    return { kind: row.kind, mediaType: row.mediaType, name: row.name, data };
  }

  /** A socket outlives logout and revocation, so each action rechecks the session it opened with. */
  async #sessionLive(connection: Connection): Promise<boolean> {
    const { sessionId } = (connection.state ?? {}) as { sessionId?: string | null };
    const sessions = systemStore(this.env).sessions;
    if (sessionId && (await sessions.isLive(sessionId, this.#scope.userId, Date.now())))
      return true;
    connection.close(4401, "unauthenticated");
    return false;
  }

  /**
   * A turn's fiber outlived its process: an eviction or a deploy. Keep the reply checkpointed so
   * far, mark it interrupted and tell the tabs, so the turn never fails silently (ADR 0003 #1).
   */
  override async onFiberRecovered(ctx: FiberRecoveryContext): Promise<void> {
    if (ctx.name !== "chat-turn") return;
    const cp = ctx.snapshot as TurnCheckpoint | null;
    if (!cp) return;
    const repo = this.#repo;
    // A turn that stopped cleanly saved its state to D1 before its fiber ended; if the process
    // died between that save and the fiber's end, the turn is waiting, not interrupted.
    if (await repo.turns.load(cp.turnId)) {
      for (const hold of cp.holds) this.limits.release(hold);
      return;
    }
    if (!cp.wrote) {
      // Evicted before its first write: no messages exist, and no call was made.
      for (const hold of cp.holds) this.limits.release(hold);
      return;
    }
    // Settling twice charges once, so a recovery after the turn settled costs nothing more.
    for (const hold of cp.holds) this.limits.settle(hold, cp.providerId, cp.model, cp.callUsage);
    if (cp.callStarted && !cp.callRecorded) {
      await repo.usage.record({
        providerId: cp.providerId,
        model: cp.model,
        usage: cp.callUsage,
        conversationId: cp.conversationId,
        messageId: cp.replyId,
      });
    }
    await repo.chat.settle({ replyId: cp.replyId, reply: cp.reply }, "interrupted");
    await repo.turns.remove(cp.turnId);
    this.#emitter(cp.conversationId, cp.turnId)("turn.interrupted", { message: "Retry?" });
    this.#events.trim(cp.conversationId, cp.turnId);
  }

  #send(sessionId: string, turnId: string, type: HarnessEvent["type"], payload: unknown): void {
    const frame = this.#events.append(sessionId, turnId, (seq) =>
      JSON.stringify({ v: 1, seq, sessionId, turnId, type, payload }),
    );
    this.broadcast(frame);
  }

  #emitter(sessionId: string, turnId: string): Emit {
    return (type, payload) => this.#send(sessionId, turnId, type, payload);
  }
}

const pickUsage = (usage: ModelUsage): CallUsage => ({
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  cachedInputTokens: usage.cachedInputTokens,
});

/**
 * A saved `TurnState` back from D1, or `null` if it isn't one. The row is only ever written by
 * this host, so this is defense in depth: anything unexpected closes the turn instead of
 * running the loop over it (`#dropCorrupt`).
 */
function parseTurnState(json: string): TurnState | null {
  try {
    const s = JSON.parse(json) as Partial<TurnState> | null;
    if (!s || typeof s !== "object") return null;
    const counts = s.counts;
    const taint = s.taint;
    const usage = s.usage;
    if (!counts || typeof counts.calls !== "number" || typeof counts.tools !== "number")
      return null;
    if (!taint || (taint.taint !== "trusted" && taint.taint !== "untrusted")) return null;
    if (!Array.isArray(taint.sources)) return null;
    if (!usage || typeof usage.inputTokens !== "number") return null;
    if (!Array.isArray(s.messages)) return null;
    for (const m of s.messages) {
      if (!m || typeof m !== "object" || typeof m.content !== "string") return null;
      if (m.role !== "user" && m.role !== "assistant" && m.role !== "tool" && m.role !== "system")
        return null;
    }
    const pending = s.pending;
    if (pending !== null) {
      if (!pending || typeof pending.batchId !== "string" || !Array.isArray(pending.items))
        return null;
    }
    return s as TurnState;
  } catch {
    return null;
  }
}

/**
 * What a tab may send: `chat.send`, with the chat's own model if it names one and any uploaded
 * files by ID, `turn.cancel`, or `resume`. Anything else is ignored.
 */
function parse(message: WSMessage) {
  if (typeof message !== "string") return null;
  try {
    const msg = JSON.parse(message) as Partial<Record<string, unknown>>;
    if (msg.type === "turn.cancel") return { type: "turn.cancel" } as const;
    if (msg.type === "resume") {
      const { conversationId, turnId, afterSeq } = msg;
      const at = typeof afterSeq === "number" && Number.isSafeInteger(afterSeq) && afterSeq >= 0;
      return isId(conversationId) && isId(turnId) && at
        ? ({ type: "resume", conversationId, turnId, afterSeq } as const)
        : null;
    }
    const conversationId = String(msg.conversationId);
    if (msg.type === "chat.send" && typeof msg.text === "string") {
      const { provider, model } = (msg.model ?? {}) as Partial<Record<string, unknown>>;
      const own =
        typeof provider === "string" && typeof model === "string" && provider && model
          ? { provider, model }
          : undefined;
      const ids = Array.isArray(msg.attachmentIds) ? msg.attachmentIds.filter(isId) : [];
      return {
        type: "chat.send",
        conversationId,
        text: msg.text,
        model: own,
        attachmentIds: [...new Set(ids)].slice(0, MAX_ATTACHMENTS),
      } as const;
    }
  } catch {}
  return null;
}

/** m3-ux §3.2, for a file the chosen model can't read. The file is kept with the message. */
const UNREAD = {
  image: "This model can't see images. I'll keep the file in Outputs, but it won't read it.",
  pdf: "This model can't read PDFs. I'll keep the file in Outputs, but it won't read it.",
} as const;

/** Encoded in slices a multiple of 3 bytes long, so no binary string of the whole file is built. */
function base64(bytes: Uint8Array): string {
  const slices: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x6000)
    slices.push(btoa(String.fromCharCode(...bytes.subarray(i, i + 0x6000))));
  return slices.join("");
}

/** Up to `limit` bytes from the start of a stream, and whether it held more; the rest is not read. */
async function readPrefix(body: ReadableStream<Uint8Array>, limit: number) {
  const bytes = new Uint8Array(limit);
  let filled = 0;
  let more = false;
  const reader = body.getReader();
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    const take = Math.min(next.value.byteLength, limit - filled);
    bytes.set(next.value.subarray(0, take), filled);
    filled += take;
    if (take < next.value.byteLength || filled === limit) {
      more = take < next.value.byteLength || !(await reader.read()).done;
      break;
    }
  }
  await reader.cancel().catch(() => {});
  return { bytes: bytes.subarray(0, filled), more };
}

/** What a file costs the turn's byte budget: a text file only as far as it is read. */
const modelBytes = (row: AttachmentRow) =>
  row.kind === "text" ? Math.min(row.sizeBytes, TEXT_READ_BYTES) : row.sizeBytes;

/**
 * A file's input tokens for the spend reservation; its text is counted as characters. The
 * providers scale an image down to a bounded size, so it costs at most a few thousand tokens; a
 * PDF is read page by page, so it is counted by size up to the providers' page limit.
 */
const fileTokenEstimate = (row: AttachmentRow) =>
  row.kind === "image"
    ? IMAGE_TOKENS
    : row.kind === "pdf"
      ? Math.min(PDF_MAX_TOKENS, Math.ceil(row.sizeBytes / 4))
      : 0;

/**
 * A history's files for a later call's spend reservation. Text rides in `chars`, as in the first
 * call; a PDF is measured from its base64, which decodes to about three quarters of its length.
 */
const messageFileTokens = (messages: readonly ModelMessage[]) =>
  messages.reduce(
    (sum, m) =>
      sum +
      (m.role === "user"
        ? (m.attachments ?? []).reduce(
            (n, f) =>
              n +
              (f.kind === "image"
                ? IMAGE_TOKENS
                : f.kind === "pdf"
                  ? Math.min(PDF_MAX_TOKENS, Math.ceil(((f.data?.length ?? 0) * 3) / 16))
                  : 0),
            0,
          )
        : 0),
    0,
  );

const MODEL_ERRORS: Partial<Record<ChatModelError, string>> = {
  no_model: "Pick a model in Settings first.",
  key_required: "Enter your model key again in Settings.",
  vault_reset_required:
    "Your saved keys can't be opened. Reset them in Settings, then enter your key again.",
};

/**
 * Fails a send for the tab that made it only. No turn started, so it has no turn ID, and `seq` 0
 * keeps it outside the sequence of a turn the tab may be receiving.
 */
function reject(
  connection: Connection,
  sessionId: string,
  message: string,
  reason?: TurnLimit,
  code?: TurnFailure,
) {
  const event: HarnessEvent = {
    v: 1,
    seq: 0,
    sessionId,
    turnId: "",
    type: "turn.failed",
    payload: { message, ...(reason && { reason }), ...(code && { code }) },
  };
  connection.send(JSON.stringify(event));
}
