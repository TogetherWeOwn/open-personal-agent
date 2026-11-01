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
  applyStoredDecisions,
  type Budget,
  bindBatch,
  continueTurn,
  type LoopEvent,
  type LoopHost,
  type LoopTool,
  newTurn,
  runTurn,
  TURN_LIMITS,
  type TurnState,
} from "@opa/harness-builtin";
import { ToolRegistry } from "@opa/policy";
import type { AllowanceWarnings } from "@opa/server/allowances";
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
/** Decided batches waiting for the running turn to end (M3-07 AC14, M3-09 AC4's FIFO). */
const QUEUE_KEY = "approvals:queue";
/** How much of the original request a late approval's label quotes. */
const LABEL_CHARS = 80;

/** What `resumeBatch` did with a decided batch. */
export type ResumeResult = "resumed" | "waiting" | "queued" | "gone";

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

/** A stored message as `listMessages` returns it, with its attachments. */
type StoredMessage = NonNullable<
  Awaited<
    ReturnType<ReturnType<ReturnType<typeof createRepository>["forUser"]>["chat"]["listMessages"]>
  >
>[number];
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
  /** This call's ledger row ID, fixed when it starts, so a recovery's write can't add a second. */
  callId?: string;
  /**
   * It runs again from a saved stop, so its `turn_states` row predates this run: the row alone
   * no longer shows that the turn stopped cleanly.
   */
  resumed?: boolean;
  /** It is saving a stop (approval, limit) now: a row found on recovery is that stop's. */
  stopping?: boolean;
}

/** A resumed batch, for the loop's approval hooks. */
type ApprovalRun = {
  batchId: string;
  /** Approved calls the stored rows already refuse, by tool call ID, with why. */
  refused: Map<string, string>;
};

/** What the model reads for an approved call that can't run as bound. */
const REFUSED: Record<string, string> = {
  binding_mismatch: "The approval doesn't match this call, so it didn't run.",
  tool_changed: "The tool changed after it was approved, so the call didn't run.",
  tool_missing: "The tool is no longer available, so the call didn't run.",
  already_claimed: "This approval was already used, so the call didn't run again.",
};

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
  /** Whether a `#drain` owns the resume queue: there is only ever one, so batches keep order. */
  #draining = false;
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
      // Only the owner's assistant gets these: the reconciler writes them there (COST-5).
      allowance: this.ctx.storage.kv.get<AllowanceWarnings>("allowance-warnings") ?? null,
    };
  }

  /** The reconciler's latest allowance warnings (M3-17 AC4); each run replaces the last. */
  setAllowanceWarnings(warnings: AllowanceWarnings): void {
    this.ctx.storage.kv.put("allowance-warnings", warnings);
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
    // A reconnecting tab (`?resume`) gets no live frames until its `resume` has replayed the log:
    // a live frame arriving first would raise its applied seq past the frames it missed, which
    // its dedupe would then drop. The log holds every frame sent meanwhile, so none is lost.
    const replaying = new URL(ctx.request.url).searchParams.has("resume");
    connection.setState({ sessionId: ctx.request.headers.get(SESSION_HEADER), replaying });
  }

  /** Lets live frames reach a tab again once its replay is sent, or it isn't resuming after all. */
  #endReplay(connection: Connection): void {
    const state = (connection.state ?? {}) as { sessionId?: string | null; replaying?: boolean };
    if (state.replaying) connection.setState({ ...state, replaying: false });
  }

  override onMessage(connection: Connection, message: WSMessage): void {
    const msg = parse(message);
    if (msg?.type !== "resume") this.#endReplay(connection);
    // A tab whose session is still live may stop the running turn.
    if (msg?.type === "turn.cancel")
      void this.#sessionLive(connection).then((ok) => ok && this.#running?.abort());
    // A reconnected tab replays what it missed (M3-03 AC11): to this tab only, after the same
    // session recheck, and only from this user's own log — the DO is named from the session, so
    // a conversation ID from the client can't reach another user's events.
    if (msg?.type === "resume") {
      void this.#sessionLive(connection)
        .then((ok) => {
          if (!ok) return;
          try {
            for (const frame of this.#events.replay(msg.conversationId, msg.turnId, msg.afterSeq)) {
              connection.send(frame);
            }
          } catch {
            // The tab went away mid-replay; it will resume again on its next connect.
          }
          // Synchronous since the replay read the log, so no live frame can fall in between.
          this.#endReplay(connection);
        })
        .catch(() => connection.close(1011, "session check failed"));
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
        .finally(() => this.#release(running));
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
    const budget = TURN_FILE_BYTES - sending.reduce((n, row) => n + modelBytes(row), 0);
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
    const { messages, fileTokens: pastTokens } = await this.#modelHistory(
      history ?? [],
      readable,
      budget,
    );
    const { files: sent, ids: sentIds, tokens: sentTokens } = await this.#readFiles(sending);
    const fileTokens = pastTokens + sentTokens;
    messages.push({ role: "user", content: text, ...(sent.length ? { attachments: sent } : {}) });
    // Reserved before anything is written, so a refused send leaves no trace, not even a
    // conversation.
    const chars = messageChars(messages);
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
   * Resumes a turn stopped at an approval once its batch is decided (M3-03 AC5, M3-07 AC10).
   * The decisions are read from the batch's rows in D1, never taken from the caller: the
   * approvals route writes them there first, after its checks and any step-up. Server routes
   * reach this through the scoped repository's `assistant()`: this DO is named from the
   * caller's session and every read here is scope-filtered, so a batch ID can only ever
   * address this user's turns. Tabs can't call it — `onMessage` routes only `chat.send`,
   * `turn.cancel` and `resume`.
   *
   * `waiting` while an item is still undecided; `queued` while another turn runs (the batch
   * resumes when it ends, AC14); `gone` when no stopped turn waits on the batch (a task's
   * batch, a turn already resumed, a missing batch) or no model is available.
   */
  async resumeBatch(batchId: string): Promise<ResumeResult> {
    // Claimed before the first await: D1 and vault I/O don't hold the DO's input gate, so two
    // calls for one batch (a double-clicked Approve, two tabs, a retried request) would
    // otherwise both load the same `awaiting_approval` row. A `chat.send` arriving
    // mid-resume is rejected the same way.
    if (this.#running) return this.#enqueue(batchId);
    const running = new AbortController();
    this.#running = running;
    let started = false;
    try {
      const repo = this.#repo;
      const rows = await repo.approvals.batch(batchId);
      const turnId = rows[0]?.turnId;
      if (!turnId) return "gone";
      const saved = await repo.turns.load(turnId);
      if (saved?.status !== "awaiting_approval") return "gone";
      const state = parseTurnState(saved.state);
      if (!state) {
        await this.#dropCorrupt(saved);
        return "gone";
      }
      if (state.pending?.batchId !== batchId) return "gone";
      const { tools } = this.resolveTools();
      const context = { kind: "turn", id: turnId, conversationId: saved.conversationId } as const;
      const applied = await applyStoredDecisions(
        state,
        rows,
        { userId: this.#scope.userId, context, tools },
        Date.now(),
      );
      if (applied.waiting) return "waiting";
      started = await this.#resume(saved, state, running, {
        batchId,
        refused: applied.refused,
      });
      return started ? "resumed" : "gone";
    } finally {
      // The fiber owns the claim once a drive starts; every other exit releases it here.
      // (`#resume` releases the claim itself on its re-stop path, where it returns `true`
      // without starting a fiber.)
      if (!started) this.#release(running);
    }
  }

  /**
   * Releases a claim on the turn slot, then resumes whatever queued behind it: a batch decided
   * while this claim was held waits on that, whether or not a fiber ever started.
   */
  #release(running: AbortController): void {
    if (this.#running !== running) return;
    this.#running = null;
    void this.#drain();
  }

  /** Holds a decided batch until the running turn ends; it resumes then, in order. */
  #enqueue(batchId: string): ResumeResult {
    const queue = this.ctx.storage.kv.get<string[]>(QUEUE_KEY) ?? [];
    if (!queue.includes(batchId)) this.ctx.storage.kv.put(QUEUE_KEY, [...queue, batchId]);
    return "queued";
  }

  /**
   * Resumes the next queued batch, if no turn runs. Called as every turn's fiber ends. A resume
   * that fails releases its claim before this drain puts its batch back, so a second drain then
   * would run the next batch first; instead the one running re-checks the slot after each resume.
   */
  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      await this.#drainQueue();
    } finally {
      this.#draining = false;
    }
  }

  async #drainQueue(): Promise<void> {
    while (!this.#running) {
      const [next, ...rest] = this.ctx.storage.kv.get<string[]>(QUEUE_KEY) ?? [];
      if (next === undefined) return;
      this.ctx.storage.kv.put(QUEUE_KEY, rest);
      const result = await this.resumeBatch(next).catch(() => "failed" as const);
      if (result === "queued") return; // something else started first; it drains again
      if (result === "failed") {
        // D1 or the vault failed, not the batch: it goes back to the front, and the next
        // turn's end or the route's retry tries it again, rather than spin on it here.
        const now = this.ctx.storage.kv.get<string[]>(QUEUE_KEY) ?? [];
        if (!now.includes(next)) this.ctx.storage.kv.put(QUEUE_KEY, [next, ...now]);
        return;
      }
    }
  }

  /**
   * A late approval appends; it never re-plans (M3-07 AC14). If the conversation moved on
   * since the turn stopped, the stopped turn is settled where it is and the approved calls run
   * in a new turn at the end of the chat: a new reply after a thread line naming the original
   * request, and a model context that ends with that request's label, the calls and their
   * results — so the model continues from the end of the conversation. `null` when nothing
   * newer exists: the turn resumes in place.
   */
  async #late(saved: SavedTurn, state: TurnState): Promise<SavedTurn | null> {
    const repo = this.#repo;
    const thread = (await repo.chat.listMessages(saved.conversationId)) ?? [];
    const at = thread.findIndex((m) => m.id === saved.replyId);
    if (at < 0 || at === thread.length - 1) return null;
    const asked = thread.slice(0, at).findLast((m) => m.role === "user")?.content ?? "";
    const quote = asked.length > LABEL_CHARS ? `${asked.slice(0, LABEL_CHARS)}…` : asked;
    const tools = [...new Set(state.pending?.items.map((i) => i.tool))].join(", ");
    // The gated calls' assistant message and what follows it: the calls the user decided on,
    // with any results already recorded beside them. Its text is in the old reply already.
    const from = state.messages.findLastIndex((m) => m.role === "assistant");
    const calls = state.messages
      .slice(Math.max(from, 0))
      .map((m) => (m.role === "assistant" ? { ...m, content: "" } : m));
    state.messages = [
      {
        role: "user",
        content:
          `[Approved later] I approved ${tools} from my earlier request "${quote}". ` +
          "Its result follows. Continue from here; don't redo that earlier request.",
      },
      ...calls,
    ];
    const next: SavedTurn = { ...saved, turnId: crypto.randomUUID(), replyId: crypto.randomUUID() };
    const old = thread[at];
    await repo.turns.supersede({
      old: { turnId: saved.turnId, replyId: saved.replyId, reply: old?.content ?? "" },
      conversationId: saved.conversationId,
      replyId: next.replyId,
      line: { id: crypto.randomUUID(), content: `Approved later: ${tools}, from "${quote}"` },
    });
    // The old turn is settled; tabs showing it learn so before the new one starts.
    this.#emitter(saved.conversationId, saved.turnId)("turn.completed", {});
    this.#events.trim(saved.conversationId, saved.turnId);
    this.#emitter(saved.conversationId, next.turnId)("turn.started", { messageId: next.replyId });
    return next;
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
      // Approved calls run only through their batch's rows (`resumeBatch`), never a Continue.
      if (state.pending) return false;
      continueTurn(state);
      started = await this.#resume(saved, state, running);
      return started;
    } finally {
      if (!started) this.#release(running);
    }
  }

  /**
   * Runs a saved turn again from its D1 state: a fresh model pick, history and first hold.
   * `running` is the caller's claim, held since before the first await; the fiber owns it once a
   * drive starts, and every path that starts no fiber releases it.
   */
  async #resume(
    stopped: SavedTurn,
    state: TurnState,
    running: AbortController,
    approvals?: ApprovalRun,
  ): Promise<boolean> {
    // The conversation's own model, its pin if it has one, as the turn's start picked it.
    const picked = await this.resolveModel(await this.#composed, this.#scope, "chat", {
      conversationId: stopped.conversationId,
    });
    if ("error" in picked) return false; // the saved turn stays for a retry once a model is set
    const { provider, model } = picked;
    const repo = this.#repo;
    const caps = provider.capabilities(model);
    const readable = (row: AttachmentRow) =>
      row.kind === "text" || (row.kind === "image" ? caps.imageInput : caps.pdfInput) === true;
    // History is D1's, as at the turn's start, files included, minus the still-streaming reply:
    // its text so far is inside `state`, where the loop left it.
    const historyOf = async (replyId: string) =>
      this.#modelHistory(
        ((await repo.chat.listMessages(stopped.conversationId)) ?? []).filter(
          (m) => m.id !== replyId,
        ),
        readable,
        TURN_FILE_BYTES,
      );
    const first = await historyOf(stopped.replyId);
    let history = first.messages;
    const providerId = picked.billingId ?? provider.id;
    const firstHold = `${stopped.turnId}:0`;
    const chars = messageChars([...history, ...state.messages]);
    const reservation = this.limits.reserve(firstHold, providerId, model, chars, first.fileTokens);
    if (!reservation) {
      // Stops again at today's limit. No fiber starts, so the caller's claim is released here.
      // A batch's decisions stay in its rows, so it stays waiting on them: resuming it again
      // (the approvals route does on a retry) re-reads them. A Continue never runs approved
      // calls without their rows' claims.
      const restopped = await repo.turns.save({
        ...stopped,
        providerId,
        model,
        status: approvals ? "awaiting_approval" : "limit_reached",
        state: JSON.stringify(state),
      });
      if (!restopped) throw new Error("the turn's conversation is gone");
      this.#emitter(stopped.conversationId, stopped.turnId)("limit.reached", {
        kind: "daily",
        detail: "Today's spending limit",
      });
      this.#release(running);
      return true;
    }
    // A late approval moves the turn to the end of the chat (AC14), once it is sure to run.
    let saved = stopped;
    if (approvals) {
      try {
        const late = await this.#late(stopped, state);
        if (late) {
          saved = late;
          ({ messages: history } = await historyOf(late.replyId));
        }
      } catch (err) {
        this.limits.release(firstHold); // no call was made
        throw err;
      }
    }
    const cp: TurnCheckpoint = {
      conversationId: saved.conversationId,
      turnId: saved.turnId,
      replyId: saved.replyId,
      providerId,
      model,
      reply: "",
      wrote: true,
      holds: [firstHold],
      callStarted: false,
      callRecorded: false,
      callUsage: null,
      resumed: true,
    };
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
        ...(approvals ? { approvals } : {}),
      });
    })
      .catch(() => {}) // a D1 failure surfaces as the interrupted recovery, never silently
      .finally(() => this.#release(running));
    return true;
  }

  /** A saved state that no longer parses is dropped fail-closed: settle interrupted, tell tabs. */
  async #dropCorrupt(saved: SavedTurn): Promise<void> {
    const repo = this.#repo;
    const stored = (await repo.chat.listMessages(saved.conversationId).catch(() => null)) ?? [];
    const reply = stored.find((m) => m.id === saved.replyId)?.content ?? "";
    const settled = await repo.chat.settle({ replyId: saved.replyId, reply }, "interrupted").then(
      () => true,
      () => false,
    );
    await repo.turns.remove(saved.turnId).catch(() => {});
    this.#emitter(saved.conversationId, saved.turnId)("turn.interrupted", { message: "Retry?" });
    if (settled) this.#events.trim(saved.conversationId, saved.turnId);
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
    approvals?: ApprovalRun;
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
      ...(run.approvals ? { approvals: this.#approvalHooks(run.approvals) } : {}),
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
        ...(cp.callId ? { id: cp.callId } : {}),
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
      cp.stopping = true;
      stash(cp);
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
      const settled = await chat.settle({ replyId, reply: cp.reply }, "error").then(
        () => true,
        () => false,
      );
      this.#send(conversationId, turnId, "turn.failed", {
        message: "The reply couldn't be saved.",
      });
      // Only a turn D1 holds leaves the log; otherwise its frames, this failure included, are
      // all a reconnecting tab can learn it from.
      if (settled) this.#events.trim(conversationId, turnId);
    };

    const gen = runTurn(host, run.history, state, signal);
    let thinking = "";
    let stashedAt = 0;
    try {
      for (;;) {
        const next = await gen.next();
        if (next.done) {
          // A resume still waiting on undecided approvals names no stop event; save it anyway,
          // with the decisions recorded so far.
          if (
            !persisted &&
            (next.value === "awaiting_approval" || next.value === "limit_reached")
          ) {
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
          // The state is complete at these events; save it before any tab can act on them. An
          // approval's rows go first: the route reads its decisions from them (M3-07 AC9).
          try {
            if (event.type === "approval.requested" && state.pending) {
              const rows = await bindBatch({
                userId: this.#scope.userId,
                tools,
                pending: state.pending,
                context: { kind: "turn", id: turnId, conversationId },
              });
              if (!(await repo.approvals.create(rows))) throw new Error("the conversation is gone");
            }
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
              cp.callId = crypto.randomUUID();
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
    } finally {
      // The first call's hold was taken before the loop ran; if the loop never spent it (a Stop
      // before its first call, a resume that stopped again first), it goes back uncharged.
      if (first && pendingHold) {
        this.limits.release(pendingHold);
        pendingHold = null;
        cp.holds = [];
        stash(cp);
      }
    }
  }

  /**
   * The loop's view of a resumed batch's rows (M3-07 AC12, crypto review W3). `claim` refuses a
   * call whose row didn't open as bound or whose tool changed since, then moves the row from
   * `approved` to `executing` — only one run ever gets it, and only before it expires. `finish`
   * records how the call ended. Both write the audit row with the change.
   */
  #approvalHooks(run: ApprovalRun): NonNullable<LoopHost["approvals"]> {
    const approvals = this.#repo.approvals;
    const id = (toolCallId: string) => `appr_${toolCallId}`;
    return {
      claim: async (toolCallId) => {
        const refused = run.refused.get(toolCallId);
        if (refused) {
          // A row an earlier run claimed (left `executing` by a restart) may have acted: it
          // ends failed with an unknown outcome, as on the Workflow path. Any other refusal
          // ends an `approved` row denied.
          const outcome =
            refused === "already_claimed"
              ? ({ status: "failed", reason: "outcome_unknown" } as const)
              : ({ status: "denied", reason: refused } as const);
          await approvals.finish(run.batchId, id(toolCallId), outcome);
          return REFUSED[refused] ?? (REFUSED.binding_mismatch as string);
        }
        // The row's envelope was opened and checked when the batch was read; `canonical` is
        // never rewritten, so the claim only has to win the row before its expiry.
        const row = await approvals.claim(run.batchId, id(toolCallId), Date.now());
        return row ? null : "The approval is no longer valid, so the call didn't run.";
      },
      finish: (toolCallId, outcome) =>
        approvals.finish(run.batchId, id(toolCallId), outcome).then(() => {}),
    };
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
   * The model context from a conversation's stored messages, with the files of earlier turns:
   * newest first while they fit in `budget` bytes and the model can read them. A file left out
   * was read on its own turn; a file-only message with none of its files left says nothing.
   */
  async #modelHistory(
    past: readonly StoredMessage[],
    readable: (row: AttachmentRow) => boolean,
    budget: number,
  ): Promise<{ messages: ModelMessage[]; fileTokens: number }> {
    const replayed = new Set<string>();
    let left = budget;
    for (const m of past.toReversed()) {
      if (m.role !== "user") continue;
      for (const row of m.attachments.filter(readable)) {
        if (modelBytes(row) > left) continue;
        left -= modelBytes(row);
        replayed.add(row.id);
      }
    }
    const messages: ModelMessage[] = [];
    let fileTokens = 0;
    for (const m of past) {
      if (m.role === "user" && m.attachments.length) {
        const { files, tokens } = await this.#readFiles(
          m.attachments.filter((row) => replayed.has(row.id)),
        );
        fileTokens += tokens;
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
    return { messages, fileTokens };
  }

  /** Reads files for the model; one whose object is gone is left out. */
  async #readFiles(rows: readonly AttachmentRow[]) {
    const files: ModelAttachment[] = [];
    const ids = new Set<string>();
    let tokens = 0;
    for (const row of rows) {
      const file = await this.#modelFile(row);
      if (!file) continue;
      files.push(file);
      ids.add(row.id);
      tokens += fileTokenEstimate(row);
    }
    return { files, ids, tokens };
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
    // died between that save and the fiber's end, the turn is waiting, not interrupted. A resumed
    // turn's row is the stop it resumed from, unless it was saving a new one: evicted mid-run, it
    // is interrupted like any other, and its stale row goes, so the stop can't be resumed again.
    if ((!cp.resumed || cp.stopping) && (await repo.turns.load(cp.turnId))) {
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
        ...(cp.callId ? { id: cp.callId } : {}),
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
    const replaying = [...this.getConnections()].flatMap((tab) =>
      (tab.state as { replaying?: boolean } | null)?.replaying ? [tab.id] : [],
    );
    this.broadcast(frame, replaying);
  }

  #emitter(sessionId: string, turnId: string): Emit {
    return (type, payload) => this.#send(sessionId, turnId, type, payload);
  }
}

/** The characters a request's messages carry, a text file's included, for its reservation. */
const messageChars = (messages: readonly ModelMessage[]) =>
  messages.reduce(
    (sum, m) =>
      sum +
      m.content.length +
      (m.role === "user"
        ? (m.attachments ?? []).reduce((n, f) => n + (f.text?.length ?? 0), 0)
        : 0),
    0,
  );

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
