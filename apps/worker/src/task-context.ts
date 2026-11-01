// SPDX-License-Identifier: Apache-2.0
// The Cloudflare Workflows adapter for the TaskContext port (M3-12a): every step is a
// `step.do` whose callback first re-reads the task row, so a step of a cancelled or finished
// task does nothing — no tool, no model call, no write (AC3). Per-task limits (AC6) are checked
// at step boundaries; budget and progress cross to the user's assistant by RPC (AC8); outputs
// over 1 MiB persist as a reference to R2, and no guarded secret reaches a persisted output
// (AC4). The adapter takes a structural stepper, so tests drive it without the Workflow engine.
import {
  type JsonValue,
  STEP_OUTPUT_INLINE_MAX_BYTES,
  TASK_LIMITS,
  type TaskBudget,
  TaskCancelledError,
  type TaskContext,
  TaskLimitError,
  type TaskStepper,
} from "@opa/core";
import type { TaskStatus } from "@opa/db/repository";
import type { CallScope, Refusal, Reservation } from "./limits";

/** The assistant RPC surface a task may use, structural so tests can stand in for the stub. */
export interface AssistantTaskRpc {
  reserveTaskCall(
    key: string,
    providerId: string,
    model: string,
    chars: number,
    scope: CallScope,
  ): Promise<Reservation | Refusal>;
  settleTaskCall(
    key: string,
    providerId: string,
    model: string,
    usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | null,
  ): Promise<void>;
  releaseTaskCall(key: string): Promise<void>;
  startTask(taskId: string, budgetMicroUsd?: number): Promise<{ budgetMicroUsd: number }>;
  endTask(taskId: string): Promise<number>;
  allowToolCall(callKey: string): Promise<boolean>;
  taskProgress(progress: {
    conversationId: string;
    turnId: string;
    taskId: string;
    seq: number;
    type: string;
    payload: unknown;
  }): Promise<void>;
}

export interface WorkflowTaskContextDeps {
  stepper: TaskStepper;
  taskId: string;
  instanceId: string;
  /** Where progress goes: the conversation and turn the task belongs to. */
  conversationId: string;
  turnId: string;
  /** When the task's clock started (its row's `started_at`, else `created_at`). */
  startedAt: number;
  /** Time spent paused at a limit (M3-17), which the duration limit doesn't count. */
  pausedMs?: () => number;
  mode: "interactive" | "background";
  /** A fresh read of the task row's status; `undefined` when the row is gone. */
  readStatus(): Promise<TaskStatus | undefined>;
  /** Scoped step-output storage (the repository's `stepOutputs`). */
  outputs: {
    put(id: string, value: string): Promise<unknown>;
    get(id: string): Promise<{ text(): Promise<string> } | null>;
  };
  assistant: AssistantTaskRpc;
  /** Exact secret values that must never reach a persisted step output (values under 8 chars are ignored). */
  secrets?: readonly string[];
  now?: () => number;
  /** Overrides for tests; the COST-1 defaults otherwise. */
  limits?: { steps?: number; durationMs?: number };
}

/**
 * What a step persists: always this envelope, never `fn`'s value bare, so no value a step returns
 * can pass for the adapter's own markers. `ref` stands in for an output over the inline bound,
 * resolved back from R2 for the caller; `stopped` means the guard stopped the step before `fn`.
 */
type Persisted =
  | { value: JsonValue }
  | { ref: string; bytes: number }
  | { stopped: "cancelled" | "duration" };

const TERMINAL: readonly TaskStatus[] = ["succeeded", "failed", "cancelled", "interrupted"];
const DEFAULT_STEP = {
  retries: { limit: 3, delayMs: 1_000, backoff: "exponential" as const },
  timeoutMs: 10 * 60_000,
};

export function createWorkflowTaskContext(deps: WorkflowTaskContextDeps): TaskContext {
  const now = deps.now ?? Date.now;
  const maxSteps = deps.limits?.steps ?? TASK_LIMITS.steps;
  const durationMs =
    deps.limits?.durationMs ??
    (deps.mode === "interactive" ? TASK_LIMITS.interactiveMs : TASK_LIMITS.backgroundMs);
  const secrets = (deps.secrets ?? []).filter((s) => s.length >= 8);
  const names = new Set<string>();
  let steps = 0;
  let progressSeq = 0;

  const idempotencyKey = (stepName: string) => `${deps.instanceId}:${stepName}`;

  /** Names a step once and counts it against the per-task limit, before anything runs. */
  function claim(name: string): void {
    if (names.has(name)) throw new Error(`task step "${name}" was already used`);
    names.add(name);
    steps += 1;
    if (steps > maxSteps) throw new TaskLimitError("steps", `${maxSteps} steps`);
  }

  /**
   * The guard inside every step, run before the step acts: a cancelled (or already finished)
   * task's step does nothing, and a task past its duration stops. A cancel that lands after
   * this check is mid-step by definition: the step finishes, and the next step's guard stops
   * the run (M3-12 AC3). A stop is returned, not thrown: the engine would retry a throw and
   * hand back a serialized error, while a returned marker persists, replays the same, and is
   * turned into the real error outside the step.
   */
  async function guard(): Promise<"cancelled" | "duration" | null> {
    const status = await deps.readStatus();
    if (status === undefined || TERMINAL.includes(status)) return "cancelled";
    if (now() - deps.startedAt - (deps.pausedMs?.() ?? 0) > durationMs) return "duration";
    return null;
  }

  function stop(why: "cancelled" | "duration"): never {
    if (why === "cancelled") throw new TaskCancelledError(deps.taskId);
    throw new TaskLimitError("duration", `${durationMs} ms`);
  }

  /**
   * The same guard before a sleep or wait, outside any step: a task that has ended or run out
   * of time does not park for hours first. On a replay it can only stop a task that has since
   * ended, which is the right answer for that task anyway.
   */
  async function beforeWait(): Promise<void> {
    const why = await guard();
    if (why) stop(why);
  }

  // Every call draws on this task's budget; a background task's also stops at the hard cap.
  const scope: CallScope = { taskId: deps.taskId, background: deps.mode === "background" };
  const budget: TaskBudget = {
    start: (budgetMicroUsd) => deps.assistant.startTask(deps.taskId, budgetMicroUsd),
    reserve: (key, providerId, model, chars) =>
      deps.assistant.reserveTaskCall(key, providerId, model, chars, scope),
    settle: (key, providerId, model, usage) =>
      deps.assistant.settleTaskCall(key, providerId, model, usage),
    release: (key) => deps.assistant.releaseTaskCall(key),
    end: () => deps.assistant.endTask(deps.taskId),
    allowToolCall: (key) => deps.assistant.allowToolCall(key),
  };

  return {
    taskId: deps.taskId,
    instanceId: deps.instanceId,
    idempotencyKey,
    budget,

    async step<T extends JsonValue>(
      name: string,
      fn: (idempotencyKey: string) => Promise<T>,
      options?: Parameters<TaskContext["step"]>[2],
    ): Promise<T> {
      claim(name);
      const persisted = (await deps.stepper.do<JsonValue>(
        name,
        { ...DEFAULT_STEP, ...options },
        async (): Promise<Persisted> => {
          const stopped = await guard();
          if (stopped) return { stopped };
          const value = redactSecrets(await fn(idempotencyKey(name)), secrets);
          const json = JSON.stringify(value);
          const bytes = new TextEncoder().encode(json).length;
          if (bytes <= STEP_OUTPUT_INLINE_MAX_BYTES) return { value };
          const id = await outputId(idempotencyKey(name));
          await deps.outputs.put(id, json);
          return { ref: id, bytes };
        },
      )) as Persisted;
      if ("stopped" in persisted) stop(persisted.stopped);
      if ("value" in persisted) return persisted.value as T;
      // The object is immutable under its key, so reading it back outside a step replays to
      // the same value; a step here would just persist the large output it exists to avoid.
      const stored = await deps.outputs.get(persisted.ref);
      if (!stored) throw new Error(`step output ${persisted.ref} is missing`);
      return JSON.parse(await stored.text()) as T;
    },

    async sleep(name, durationMs) {
      claim(name);
      await beforeWait();
      await deps.stepper.sleep(name, durationMs);
    },

    async waitForEvent(name, options) {
      claim(name);
      await beforeWait();
      return deps.stepper.waitForEvent(name, options);
    },

    progress(event) {
      progressSeq += 1;
      const clean = redactSecrets(event.payload as JsonValue, secrets);
      void deps.assistant
        .taskProgress({
          conversationId: deps.conversationId,
          turnId: deps.turnId,
          taskId: deps.taskId,
          seq: progressSeq,
          type: event.type,
          payload: clean,
        })
        .catch(() => {}); // progress is best-effort; the task's state lives in D1
    },
  };
}

/**
 * Replaces every exact occurrence of a guarded secret in a step output's strings, object keys
 * included. Step outputs
 * are persisted (and replayed from storage), so a provider or tool that echoes a key back —
 * the failure M3-06a had to guard in the Test reply — must not fix it in durable state.
 */
export function redactSecrets<T>(value: T, secrets: readonly string[]): T {
  if (secrets.length === 0) return value;
  if (typeof value === "string") {
    let out: string = value;
    for (const secret of secrets) out = out.split(secret).join("[redacted]");
    return out as T;
  }
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, secrets)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [redactSecrets(k, secrets), redactSecrets(v, secrets)]),
    ) as T;
  }
  return value;
}

/** The storage id of a step's offloaded output: the hex SHA-256 of its idempotency key. */
async function outputId(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
