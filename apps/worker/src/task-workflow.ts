// SPDX-License-Identifier: Apache-2.0
// The Workflow entrypoint for durable tasks (M3-12a, ADR 0003): one instance per task run. It
// mints its scope from the D1 tasks row alone — instance params are data, never authority
// (AC9) — then drives the builtin loop against the TaskContext port, where every LLM and tool
// call is a step that reserves and settles through the user's assistant (AC8) and refuses to
// run for a cancelled task (AC3). Promotion (creating instances from a live turn), progress
// into the DO event log and recovery are M3-12b with M3-03c.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  type JsonValue,
  type ModelEvent,
  type ModelMessage,
  type ModelProvider,
  type ModelUsage,
  redactSecrets,
  TaskCancelledError,
  type TaskContext,
  TaskLimitError,
  type TaskStepper,
} from "@opa/core";
import { createRepository } from "@opa/db/repository";
import {
  applyStoredDecisions,
  bindBatch,
  continueTurn,
  type LimitKind,
  LimitStop,
  type LoopEvent,
  type LoopHost,
  type LoopTool,
  newTurn,
  runTurn,
  type StoredApproval,
  type ToolOutput,
  type TurnState,
} from "@opa/harness-builtin";
import { ToolRegistry } from "@opa/policy";
import { type ChatModelError, type ModelPick, resolveChatModel } from "@opa/server/chat-model";
import { compose, type WorkerEnv, withoutMasterKeys } from "./compose";
import type { Bindings } from "./env";
import { type AssistantTaskRpc, createWorkflowTaskContext } from "./task-context";

/** Advisory only: identity comes from the instance's task row, never from these params (AC9). */
export interface TaskParams {
  taskId?: string;
}

/**
 * What a task row's `state` holds: the conversation context before this turn, the loop's own
 * resumable state, and the turn it belongs to. Whoever creates the task (promotion, M3-12b)
 * writes it; the driver rewrites it at every segment boundary.
 */
export interface TaskTurnState {
  history: ModelMessage[];
  turn: TurnState;
  turnId: string;
  /** The task's own budget (COST-3, A-Co2), when its creator set one; else the user's default. */
  budgetMicroUsd?: number;
  /**
   * Why the task is paused as `budget_limited`, so Continue knows what to lift (M3-17 AC1).
   * `final`: the run ended at an execution limit (steps, duration) and can't be continued.
   */
  paused?: { kind: LimitKind | "steps" | "duration"; detail: string; final?: boolean };
}

/** What an approved call returns when a rerun step finds it may already have acted. */
const OUTCOME_UNKNOWN =
  "The call may already have run, and its outcome is unknown, so it wasn't run again.";
/** How long a task paused by a limit waits for Continue before its run ends (it stays paused). */
export const PAUSE_WAIT_MS = 7 * 86_400_000;
const SLOW_DOWN = "Not run: too many tool calls in the last minute. Try again in a minute.";
type ScopedUser = ReturnType<ReturnType<typeof createRepository>["forUser"]>;

export class TaskWorkflow extends WorkflowEntrypoint<Bindings, TaskParams> {
  /** Picks each task's model. Tests replace it with a scripted provider. */
  resolveModel = resolveChatModel;
  /** The tools a task's loop may call; the builtin set joins with M3-08/M3-12b. */
  taskTools: readonly LoopTool[] = [];
  /** The env with the vault: `compose` stays the only reader of the master keys. */
  readonly #composed: Promise<Awaited<ReturnType<typeof compose>>>;

  constructor(ctx: ExecutionContext, env: WorkerEnv) {
    super(ctx, withoutMasterKeys(env));
    this.#composed = compose(env);
  }

  override async run(event: WorkflowEvent<TaskParams>, step: WorkflowStep): Promise<void> {
    // `event.payload` is never read: the task is whatever row names this instance (AC9).
    await executeTask(
      this.env,
      await this.#composed,
      { resolveModel: this.resolveModel, taskTools: this.taskTools },
      event.instanceId,
      stepperFor(step),
    );
  }
}

/** What a run needs beyond its bindings; the entrypoint's fields, injected for tests. */
export interface TaskWorkflowDeps {
  resolveModel: typeof resolveChatModel;
  taskTools: readonly LoopTool[];
}

/**
 * One task's run, over the structural stepper so tests can drive it without the Workflow
 * engine (the platform class can only be constructed by the runtime).
 */
export async function executeTask(
  env: Bindings,
  composed: Awaited<ReturnType<typeof compose>>,
  deps: TaskWorkflowDeps,
  instanceId: string,
  stepper: TaskStepper,
  now: () => number = Date.now,
): Promise<void> {
  const repo = createRepository(env);
  // Called outside a step on purpose: authority is re-derived from D1 on every replay, and
  // a row's user never changes, so the replay mints the same scope.
  const minted = await repo.scopeForTask(instanceId);
  if (!minted) throw new NonRetryableError("no task row names this Workflow instance");
  const { task } = minted;
  const user = repo.forUser(minted.scope);

  const started = await stepper.do("task:start", {}, async () => {
    const running = await user.tasks.markRunning(task.id, now());
    const row = running ?? (await user.tasks.get(task.id));
    return { status: row?.status ?? "failed", startedAt: row?.startedAt ?? row?.createdAt ?? 0 };
  });
  if (started.status !== "running") return; // cancelled or finished before it began

  const initial = parseState(task.state);
  // Every way out of a started task settles its budget (COST-3); outside `ctx.step`, whose guard
  // would skip it for a task that has already ended.
  const endBudget = () =>
    stepper
      .do("task:budget:end", {}, async () => (ctx ? await ctx.budget.end() : 0))
      .catch(() => 0);
  let secrets: readonly string[] = [];
  let ctx: TaskContext | null = null;
  // Paused time, summed from the wake steps' records, so a replay stops the clock the same way.
  const paused = { ms: 0 };
  try {
    if (!initial) throw new NonRetryableError("the task has no readable turn state");
    // A turn keeps its conversation's model (the pin, else Chat); other work runs on Background.
    const pick: ModelPick =
      task.kind === "turn" ? { conversationId: task.conversationId } : { role: "background" };
    const picked = await deps.resolveModel(composed, minted.scope, "task", pick);
    if ("error" in picked) throw new Error(modelErrorMessage(picked.error));
    secrets = picked.apiKey ? [picked.apiKey] : [];
    // The key must never reach durable state: every step output is redacted for it (AC4).
    // The turn ID never changes across saves, so reading it from the minted row is replay-safe.
    ctx = createWorkflowTaskContext({
      stepper,
      taskId: task.id,
      instanceId,
      conversationId: task.conversationId,
      turnId: initial.turnId,
      startedAt: started.startedAt,
      pausedMs: () => paused.ms,
      mode: task.mode,
      readStatus: async () => (await user.tasks.get(task.id))?.status,
      outputs: user.stepOutputs,
      assistant: user.assistant() as unknown as AssistantTaskRpc,
      secrets,
      now,
    });
    const budgetMicroUsd = initial.budgetMicroUsd;
    const reserved = ctx;
    await ctx.step("task:budget", async () => await reserved.budget.start(budgetMicroUsd));
    const outcome = await driveLoop(
      ctx,
      user,
      { taskId: task.id, userId: minted.scope.userId, conversationId: task.conversationId },
      picked,
      deps.taskTools,
      now,
      paused,
    );
    await stepper.do("task:finish", {}, async () => {
      await user.tasks.finish(task.id, outcome.status, outcome.error);
      return null;
    });
    await endBudget();
  } catch (err) {
    // The row already says cancelled; nothing overwrites it.
    if (isTaskCancelled(err)) return void (await endBudget());
    const limit = isTaskLimit(err);
    const message = redactSecrets(messageOf(err), secrets).slice(0, 500);
    await stepper
      .do("task:finish:error", {}, async () => {
        if (limit) {
          // The run ends here, so this stop can't be continued: say so where Continue looks.
          const state = parseState((await user.tasks.get(task.id))?.state ?? null);
          const paused = { kind: limit.kind, detail: limit.detail, final: true };
          if (state) await user.tasks.saveState(task.id, JSON.stringify({ ...state, paused }));
        }
        await user.tasks.finish(task.id, limit ? "budget_limited" : "failed", message);
        return null;
      })
      .catch(() => {}); // a failed finish must not mask the task's own end
    await endBudget();
    // An execution limit, not money: "Paused: limit" (m3-ux §1.3).
    if (limit)
      ctx?.progress({ type: "limit.reached", payload: { kind: limit.kind, detail: limit.detail } });
    if (err instanceof NonRetryableError) throw err;
  }
}

/**
 * Runs the loop segment by segment. Each segment loads the state fresh from D1 (so a wake-up
 * after an approval reads the row the decision was written to, never the event payload),
 * forwards the loop's events as progress, and saves the state before it waits or ends. A limit
 * pauses the task as `budget_limited` until Continue (M3-17 AC1) or, for the daily and hard
 * caps, until the cap resets.
 */
async function driveLoop(
  ctx: TaskContext,
  user: ScopedUser,
  task: { taskId: string; userId: string; conversationId: string },
  picked: {
    provider: ModelProvider;
    model: string;
    billingId?: string;
    used?: () => Promise<void>;
  },
  taskTools: readonly LoopTool[],
  now: () => number,
  paused: { ms: number },
): Promise<{ status: "succeeded" | "failed" | "budget_limited"; error?: string }> {
  const { taskId } = task;
  const billingId = picked.billingId ?? picked.provider.id;
  let llmSeq = 0;
  let toolSeq = 0;
  let ids = 0;

  // Each model call is one step: reserve, call and settle inside it, so a Workflow replay
  // returns the recorded events without reserving or calling again (AC8). The loop sees the
  // recorded stream replayed; a background task has no tab waiting on token-by-token text.
  const provider: ModelProvider = {
    id: picked.provider.id,
    listModels: () => picked.provider.listModels(),
    capabilities: (m) => picked.provider.capabilities(m),
    stream: (req) =>
      (async function* () {
        llmSeq += 1;
        const result = await ctx.step(`llm:${llmSeq}`, async (key) => {
          const chars =
            req.messages.reduce((sum, m) => sum + m.content.length, 0) +
            JSON.stringify(req.tools ?? []).length;
          const reservation = await ctx.budget.reserve(key, billingId, req.model, chars);
          if ("limit" in reservation) return { refused: { ...reservation }, events: [] };
          // Once the hold is taken, only the model call itself may fail the step, so a retry
          // never pays for a second answer to a call that already succeeded. The key's
          // last-used stamp and the display ledger are bookkeeping: they fail quietly.
          await picked.used?.().catch(() => {});
          let usage: ModelUsage | null = null;
          const events: ModelEvent[] = [];
          try {
            for await (const e of picked.provider.stream({
              ...req,
              maxOutputTokens: reservation.maxOutputTokens,
            })) {
              events.push(e);
              if (e.type === "usage") usage = e.usage;
            }
          } finally {
            // A settle that fails leaves the hold charged at its full reservation (the retry's
            // reserve settles it so), which errs on the side of the cap.
            await ctx.budget.settle(key, billingId, req.model, usage).catch(() => {});
          }
          await user.usage
            .record({ providerId: billingId, model: req.model, usage })
            .catch(() => {});
          return { refused: null, events: events as unknown as JsonValue };
        });
        // Thrown before anything is yielded: the loop stops resumably, the call never counted.
        if (result.refused) throw new LimitStop(result.refused.limit, result.refused.detail);
        yield* result.events as unknown as ModelEvent[];
      })(),
  };

  // The batch whose approved calls this segment runs, and those that came back unknown.
  let batch: string | null = null;
  const unknown = new Set<string>();
  const registry = new ToolRegistry<LoopTool>();
  for (const tool of taskTools) {
    registry.register({
      manifest: tool.manifest,
      ...(tool.target ? { target: tool.target } : {}),
      execute: async (input, _signal, call) => {
        toolSeq += 1;
        const under = call?.approved && batch ? { batchId: batch, id: call.toolCallId } : null;
        // Only a read retries: a write that acted and then failed must not act again. Steps are
        // still at-least-once (an engine crash mid-step reruns it), so an approved call first
        // marks its row dispatched inside this step: a rerun finds it so and doesn't run the
        // call again (crypto review W3), unless it is a read, which may run twice. A step that
        // completed replays from its record.
        // The per-minute tool limit is counted in the same step, first, so a replay never counts
        // twice; a refused call doesn't run, and the loop stops with `tool_rate` (COST-2).
        const read = tool.manifest.riskClass === "read";
        const { unknownOutcome, ...out } = (await ctx.step(
          `tool:${toolSeq}`,
          async (key): Promise<ToolOutput & { unknownOutcome?: true }> => {
            // An approved call counts towards the minute but isn't refused by it: the user's
            // approval already gates it, and its row is claimed by now, so a refusal here would
            // end the approved call without running it.
            if (!(await ctx.budget.allowToolCall(key)) && !under) {
              return { ok: false, content: SLOW_DOWN, slowDown: true };
            }
            if (
              under &&
              !(await user.approvals.dispatch(under.batchId, `appr_${under.id}`, read))
            ) {
              return { ok: false, content: OUTCOME_UNKNOWN, unknownOutcome: true };
            }
            return tool.execute(input, new AbortController().signal);
          },
          read ? undefined : { retries: { limit: 0, delayMs: 0 } },
        )) as ToolOutput & { unknownOutcome?: true };
        if (under && unknownOutcome) unknown.add(under.id);
        return out;
      },
    });
  }

  const host: LoopHost = {
    provider,
    model: picked.model,
    tools: registry,
    policy: () => ({}), // stored overrides and grants join the read in M3-12b
    taskId,
    now,
    // A counter, so a replay names the same steps the same way; prefixed so ids stay unique
    // across tasks and next to the ids a promoted turn already carries.
    newId: () => `${ctx.instanceId}_s${++ids}`,
  };

  const context = { kind: "task", id: taskId, conversationId: task.conversationId } as const;
  const expect = { userId: task.userId, context, tools: registry };
  for (let cycle = 0; ; cycle += 1) {
    const loaded = await ctx.step(`task:load:${cycle}`, async () => {
      // After an approval wait the task is running again; markRunning never revives an ending.
      if (cycle > 0) await user.tasks.markRunning(taskId, now());
      const row = await user.tasks.get(taskId);
      return row?.state ?? null;
    });
    const state = parseState(loaded);
    if (!state) return { status: "failed", error: "the task's turn state could not be read" };
    const turn = state.turn;
    // A stopped batch resumes from its rows in D1, never from an event's payload (M3-07 AC10,
    // M3-12 AC3): the decisions, and the arguments bound in each row's envelope.
    if (turn.pending) {
      const { batchId } = turn.pending;
      batch = batchId;
      // The rows and the time they were read, recorded together: a replay past the expiry must
      // take the branch the first run took (waiting, if they were pending then), not expire them.
      const decided = await ctx.step(`task:decisions:${cycle}`, async () => ({
        rows: (await user.approvals.batch(batchId)).map(storedApproval),
        at: now(),
      }));
      const applied = await applyStoredDecisions(turn, decided.rows, expect, decided.at);
      if (applied.waiting) {
        // Woken before the decision: the load marked the task running, so it says waiting
        // again, where a compromise signal (AC13) and the UI look for it.
        const rewaited = await ctx.step(`task:rewait:${cycle}`, async () =>
          user.tasks.saveState(taskId, loaded as string, "waiting_for_approval"),
        );
        if (!rewaited) throw new TaskCancelledError(taskId);
        await waitForDecision(ctx, cycle, turn, now);
        continue;
      }
      host.approvals = {
        // Each a step, so a replay returns what happened instead of claiming again.
        claim: (toolCallId) =>
          ctx.step(`task:claim:${cycle}:${toolCallId}`, async () => {
            const refused = applied.refused.get(toolCallId);
            const id = `appr_${toolCallId}`;
            if (refused) {
              await user.approvals.finish(batchId, id, { status: "denied", reason: refused });
              return "The approval doesn't hold for this call, so it didn't run.";
            }
            const row = await user.approvals.claim(batchId, id, now());
            return row ? null : "The approval is no longer valid, so the call didn't run.";
          }),
        finish: async (toolCallId, outcome) => {
          await ctx.step(`task:approval-end:${cycle}:${toolCallId}`, async () => {
            const ended = unknown.has(toolCallId)
              ? { status: "failed" as const, reason: "outcome_unknown" }
              : outcome;
            await user.approvals.finish(batchId, `appr_${toolCallId}`, ended);
            return null;
          });
        },
      };
    } else {
      batch = null;
      delete host.approvals;
    }
    // Continued after an execution limit: a fresh allowance of calls and tools for the turn.
    if (state.paused?.kind === "calls" || state.paused?.kind === "tools") continueTurn(turn);
    let limit: { kind: LimitKind; detail: string } | undefined;
    const gen = runTurn(host, state.history, turn, new AbortController().signal);
    let outcome: Awaited<ReturnType<typeof gen.next>>["value"];
    let asked: LoopEvent | null = null;
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        outcome = next.value;
        break;
      }
      if (next.value.type === "limit.reached") limit = next.value.payload;
      // The card goes out once its rows exist, so a decision never finds no batch.
      if (next.value.type === "approval.requested") asked = next.value;
      else ctx.progress(next.value);
    }
    const saved = await ctx.step(`task:save:${cycle}`, async () => {
      const paused = outcome === "limit_reached" ? limit : undefined;
      const { budgetMicroUsd, turnId, history } = state;
      const body = JSON.stringify({ history, turn, turnId, budgetMicroUsd, paused });
      const ok = await user.tasks.saveState(
        taskId,
        body,
        outcome === "awaiting_approval" ? "waiting_for_approval" : "running",
      );
      return ok;
    });
    if (!saved) throw new TaskCancelledError(taskId); // cancelled while the segment ran
    if (outcome === "limit_reached" && limit) {
      if (await pause(ctx, user, taskId, cycle, limit.kind, now, paused)) continue;
      return { status: "budget_limited" };
    }
    if (outcome !== "awaiting_approval") {
      if (outcome === "completed") return { status: "succeeded" };
      if (outcome === "cancelled") throw new TaskCancelledError(taskId);
      return { status: "failed", error: "the model call failed" };
    }
    const pending = turn.pending;
    if (asked && pending) {
      await ctx.step(`task:approvals:${cycle}`, async () => {
        // A retried step may find the batch it already wrote.
        if ((await user.approvals.batch(pending.batchId)).length > 0) return null;
        const rows = await bindBatch({ userId: task.userId, tools: registry, pending, context });
        if (!(await user.approvals.create(rows))) throw new TaskCancelledError(taskId);
        return null;
      });
      ctx.progress(asked);
    }
    await waitForDecision(ctx, cycle, turn, now);
  }
}

/**
 * Waits for the approvals route's wake-up, then loops: the next load reads what was decided
 * from D1, never this event's payload (M3-12 AC3). A timeout just wakes the loop, which expires
 * the batch itself.
 */
async function waitForDecision(
  ctx: TaskContext,
  cycle: number,
  turn: TurnState,
  now: () => number,
): Promise<void> {
  const expiresAt = Math.min(...(turn.pending?.items.map((i) => i.expiresAt) ?? [now()]));
  await ctx
    .waitForEvent(`task:approval:${cycle}`, {
      type: "approval",
      timeoutMs: Math.max(1_000, expiresAt - now()),
    })
    .catch(() => ({ payload: null }));
}

/** A row as the resume reads it: never its ceremony columns, which must not reach a step output. */
const storedApproval = (r: StoredApproval): StoredApproval => ({
  approvalId: r.approvalId,
  toolCallId: r.toolCallId,
  tool: r.tool,
  status: r.status,
  scope: r.scope,
  canonical: r.canonical,
  bindingHash: r.bindingHash,
  expiresAt: r.expiresAt,
});

/**
 * Pauses a task at a limit: `budget_limited` ("Paused: budget", or "Paused: limit" for an
 * execution limit), then waits for Continue. The Continue route lifts the limit and moves the row
 * back to `running` before it wakes the run, so what happened is read from D1, never from the
 * event. The daily and hard caps also lift themselves at the next UTC day or month. The time spent
 * paused doesn't count towards the task's duration limit.
 */
async function pause(
  ctx: TaskContext,
  user: ScopedUser,
  taskId: string,
  cycle: number,
  kind: LimitKind,
  now: () => number,
  paused: { ms: number },
): Promise<boolean> {
  // When the cap lifts is fixed in the pause step and whether to run on in the wake step, so a
  // replay on a later day takes the same path the run took (only steps replay; `now` doesn't).
  const { at, resets } = await ctx.step(`task:pause:${cycle}`, async () => {
    await user.tasks.finish(taskId, "budget_limited");
    const at = now();
    return {
      at,
      resets: kind === "daily" ? nextUtcDay(at) : kind === "monthly_hard" ? nextUtcMonth(at) : null,
    };
  });
  const before = paused.ms;
  // A wait is at most 7 days; a cap that lifts later (the hard cap, at the next month) is waited
  // for in turns, each recorded, until it lifts or Continue comes.
  for (let turn = 0; ; turn += 1) {
    const name = turn === 0 ? `${cycle}` : `${cycle}:${turn}`;
    const wait = Math.min(PAUSE_WAIT_MS, (resets ?? Number.POSITIVE_INFINITY) - now());
    await ctx
      .waitForEvent(`task:continue:${name}`, { type: "continue", timeoutMs: Math.max(1_000, wait) })
      .catch(() => ({ payload: null }));
    // The wake step's own guard must not count the pause either; once the step has recorded
    // how long it was, that record (which a replay returns) is what counts.
    paused.ms = before + Math.max(0, now() - at);
    // A cancelled (stopped) task's step throws here, which ends the run as cancelled.
    const woke = await ctx.step(`task:wake:${name}`, async () => {
      const pausedMs = Math.max(0, now() - at);
      const status = (await user.tasks.get(taskId))?.status;
      // Continue moved it back before waking the run; else a daily or hard cap may have lifted.
      if (status === "running") return { resume: true, again: false, pausedMs };
      if (resets === null) return { resume: false, again: false, pausedMs };
      if (now() < resets) return { resume: false, again: status === "budget_limited", pausedMs };
      return { resume: await user.tasks.resume(taskId), again: false, pausedMs };
    });
    paused.ms = before + woke.pausedMs;
    if (!woke.again) return woke.resume;
  }
}

const nextUtcDay = (t: number) => t - (t % 86_400_000) + 86_400_000;
const nextUtcMonth = (t: number) => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
};

/** The platform stepper's surface used here, without its serializable-type machinery. */
type PlatformStepper = {
  do(name: string, config: Record<string, unknown>, fn: () => Promise<unknown>): Promise<unknown>;
  sleep(name: string, duration: number): Promise<void>;
  waitForEvent(
    name: string,
    options: { type: string; timeout: number },
  ): Promise<{ payload: unknown }>;
};

/** Maps the platform stepper to the port's: ms durations in, step outputs hidden from logs. */
function stepperFor(step: WorkflowStep): TaskStepper {
  const platform = step as unknown as PlatformStepper;
  return {
    do: (name, config, fn) =>
      platform.do(
        name,
        {
          ...(config.retries
            ? {
                retries: {
                  limit: config.retries.limit,
                  delay: config.retries.delayMs,
                  ...(config.retries.backoff ? { backoff: config.retries.backoff } : {}),
                },
              }
            : {}),
          ...(config.timeoutMs ? { timeout: config.timeoutMs } : {}),
          sensitive: "output", // step outputs are the user's content, not telemetry
        },
        () => fn(),
      ) as never,
    sleep: (name, durationMs) => platform.sleep(name, durationMs),
    waitForEvent: (name, options) =>
      platform.waitForEvent(name, { type: options.type, timeout: options.timeoutMs }) as never,
  };
}

function parseState(json: string | null): TaskTurnState | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as TaskTurnState;
    if (!Array.isArray(parsed.history) || typeof parsed.turnId !== "string") return null;
    if (!parsed.turn || !Array.isArray(parsed.turn.messages)) return null;
    const { history, turn, turnId, budgetMicroUsd, paused } = parsed;
    return {
      history,
      turn,
      turnId,
      ...(Number.isSafeInteger(budgetMicroUsd) && (budgetMicroUsd as number) > 0
        ? { budgetMicroUsd }
        : {}),
      ...(paused ? { paused } : {}),
    };
  } catch {
    return null;
  }
}

/** A fresh task state for whoever creates the task (promotion fills in a live turn instead). */
export function newTaskTurnState(history: ModelMessage[], turnId: string): TaskTurnState {
  return { history, turn: newTurn(), turnId };
}

const isTaskCancelled = (err: unknown) =>
  err instanceof TaskCancelledError || (err as Error)?.name === "TaskCancelledError";
const isTaskLimit = (err: unknown): TaskLimitError | null =>
  err instanceof TaskLimitError ? err : null;
const messageOf = (err: unknown) => (err instanceof Error ? err.message : "the task failed");

function modelErrorMessage(error: ChatModelError): string {
  return (
    {
      no_model: "No model is configured.",
      ai_unavailable: "The model isn't available right now.",
      vault_unavailable: "The model isn't available right now.",
      key_required: "The model key needs to be entered again.",
      vault_reset_required: "The saved model keys need to be reset in Settings.",
      invalid_base_url: "The model isn't available right now.",
    } satisfies Record<ChatModelError, string>
  )[error];
}
