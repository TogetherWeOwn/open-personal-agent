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
  TaskCancelledError,
  type TaskContext,
  TaskLimitError,
  type TaskStepper,
} from "@opa/core";
import { createRepository } from "@opa/db/repository";
import {
  type LoopHost,
  type LoopTool,
  newTurn,
  runTurn,
  type ToolOutput,
  type TurnState,
} from "@opa/harness-builtin";
import { ToolRegistry } from "@opa/policy";
import { type ChatModelError, resolveChatModel } from "@opa/server/chat-model";
import { compose, type WorkerEnv, withoutMasterKeys } from "./compose";
import type { Bindings } from "./env";
import { type AssistantTaskRpc, createWorkflowTaskContext, redactSecrets } from "./task-context";

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
}

const DAILY_LIMIT_MESSAGE = "You've reached today's spending limit. It resets at midnight UTC.";
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
  let secrets: readonly string[] = [];
  let ctx: TaskContext | null = null;
  try {
    if (!initial) throw new NonRetryableError("the task has no readable turn state");
    const picked = await deps.resolveModel(composed, minted.scope, "task");
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
      mode: task.mode,
      readStatus: async () => (await user.tasks.get(task.id))?.status,
      outputs: user.stepOutputs,
      assistant: user.assistant() as unknown as AssistantTaskRpc,
      secrets,
      now,
    });
    const outcome = await driveLoop(ctx, user, task.id, picked, deps.taskTools, now);
    await stepper.do("task:finish", {}, async () => {
      await user.tasks.finish(task.id, outcome.status, outcome.error);
      return null;
    });
    if (outcome.limit) {
      ctx.progress({ type: "limit.reached", payload: outcome.limit });
    }
  } catch (err) {
    if (isTaskCancelled(err)) return; // the row already says cancelled; nothing overwrites it
    const limit = isTaskLimit(err);
    const message = redactSecrets(messageOf(err), secrets).slice(0, 500);
    await stepper
      .do("task:finish:error", {}, async () => {
        await user.tasks.finish(task.id, limit ? "budget_limited" : "failed", message);
        return null;
      })
      .catch(() => {}); // a failed finish must not mask the task's own end
    if (limit) {
      ctx?.progress({
        type: "limit.reached",
        payload: { kind: "task_budget", detail: limit.detail },
      });
    }
    if (err instanceof NonRetryableError) throw err;
  }
}

/**
 * Runs the loop segment by segment. Each segment loads the state fresh from D1 (so a wake-up
 * after an approval reads the row the decision was written to, never the event payload),
 * forwards the loop's events as progress, and saves the state before it waits or ends.
 */
async function driveLoop(
  ctx: TaskContext,
  user: ScopedUser,
  taskId: string,
  picked: {
    provider: ModelProvider;
    model: string;
    billingId?: string;
    used?: () => Promise<void>;
  },
  taskTools: readonly LoopTool[],
  now: () => number,
): Promise<{
  status: "succeeded" | "failed" | "budget_limited";
  error?: string;
  limit?: { kind: string; detail: string };
}> {
  const billingId = picked.billingId ?? picked.provider.id;
  let dailyLimited = false;
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
          if (!reservation) return { limited: true, events: [] as JsonValue };
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
          return { limited: false, events: events as unknown as JsonValue };
        });
        if (result.limited) {
          dailyLimited = true;
          yield { type: "error", code: "upstream", message: DAILY_LIMIT_MESSAGE } as const;
          return;
        }
        yield* result.events as unknown as ModelEvent[];
      })(),
  };

  const registry = new ToolRegistry<LoopTool>();
  for (const tool of taskTools) {
    registry.register({
      manifest: tool.manifest,
      ...(tool.target ? { target: tool.target } : {}),
      execute: async (input) => {
        toolSeq += 1;
        // Only a read retries: a write that acted and then failed must not act again. (Steps
        // are still at-least-once: an engine crash mid-step reruns it.)
        const out = await ctx.step(
          `tool:${toolSeq}`,
          async () => tool.execute(input, new AbortController().signal),
          tool.manifest.riskClass === "read" ? undefined : { retries: { limit: 0, delayMs: 0 } },
        );
        return out as ToolOutput;
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
    const gen = runTurn(host, state.history, turn, new AbortController().signal);
    let outcome: Awaited<ReturnType<typeof gen.next>>["value"];
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        outcome = next.value;
        break;
      }
      ctx.progress(next.value);
    }
    const saved = await ctx.step(`task:save:${cycle}`, async () => {
      const body = JSON.stringify({ history: state.history, turn, turnId: state.turnId });
      const ok = await user.tasks.saveState(
        taskId,
        body,
        outcome === "awaiting_approval" ? "waiting_for_approval" : "running",
      );
      return ok;
    });
    if (!saved) throw new TaskCancelledError(taskId); // cancelled while the segment ran
    if (outcome !== "awaiting_approval") {
      if (dailyLimited)
        return { status: "budget_limited", limit: { kind: "daily", detail: "daily spend cap" } };
      if (outcome === "completed") return { status: "succeeded" };
      if (outcome === "limit_reached") return { status: "budget_limited" };
      if (outcome === "cancelled") throw new TaskCancelledError(taskId);
      return { status: "failed", error: "the model call failed" };
    }
    // Wait for the approval decision, then loop: the next load reads what was decided from
    // D1 (M3-07's route writes it there), never from this event's payload (AC3). A timeout
    // just wakes the loop, which expires the batch itself.
    const expiresAt = turn.pending?.items[0]?.expiresAt ?? now();
    await ctx
      .waitForEvent(`task:approval:${cycle}`, {
        type: "approval",
        timeoutMs: Math.max(1_000, expiresAt - now()),
      })
      .catch(() => ({ payload: null }));
  }
}

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
    return { history: parsed.history, turn: parsed.turn, turnId: parsed.turnId };
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
