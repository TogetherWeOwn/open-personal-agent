// SPDX-License-Identifier: Apache-2.0
// The TaskContext port (M3-12a, ADR 0003): what durable task code is written against. The
// Cloudflare adapter runs each step as a Workflow `step.do`; the Node journal (M3-23b) implements
// the same port over SQLite. Platform types stay structural, so this package imports no runtime.
import type { ModelUsage } from "./model-provider";

/** What a step may return: it is persisted, so it must survive JSON. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Retries and timeout for one step, mirroring the Workflow step config. */
export interface StepOptions {
  retries?: { limit: number; delayMs: number; backoff?: "constant" | "linear" | "exponential" };
  timeoutMs?: number;
}

/**
 * The stepper under the port: a Workflow step on Cloudflare, the SQLite journal on Node. A step's
 * return value is persisted and replayed instead of re-running `fn`, so everything outside `step`
 * must be deterministic, and everything with a side effect goes inside one.
 */
export interface TaskStepper {
  do<T extends JsonValue>(name: string, config: StepOptions, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, durationMs: number): Promise<void>;
  waitForEvent<T extends JsonValue>(
    name: string,
    options: { type: string; timeoutMs: number },
  ): Promise<{ payload: T }>;
}

/** A progress event for the user's tabs. The loop's events take this shape (M3-03 AC8). */
export interface TaskProgressEvent {
  type: string;
  payload: unknown;
}

/** A reservation against the user's limits, as the assistant's limits issue it. */
export interface TaskReservation {
  maxOutputTokens: number;
  reservedMicroUsd: number;
}

/** A call the limits refused, and which one: the task's budget, the daily cap or the hard cap. */
export interface TaskRefusal {
  limit: "task_budget" | "daily" | "monthly_hard";
  detail: string;
}

/**
 * The budget for a task's model calls. Every call reserves before it starts and settles after,
 * through the user's own assistant (M3-12 AC8), so the daily cap holds for background work the
 * same way it holds for chat. Keys are idempotency keys: reserving a key that already holds
 * first settles that hold at its full reservation, because a retried step may already have
 * spent it. The task's own budget (COST-3) is reserved by `start` and settled by `end`; every
 * call draws on it, and a background task's calls also stop at the monthly hard cap.
 */
export interface TaskBudget {
  /** Reserves the task's budget; a replayed start keeps what the task has spent. */
  start(budgetMicroUsd?: number): Promise<{ budgetMicroUsd: number }>;
  reserve(
    key: string,
    providerId: string,
    model: string,
    chars: number,
  ): Promise<TaskReservation | TaskRefusal>;
  settle(
    key: string,
    providerId: string,
    model: string,
    usage: Pick<ModelUsage, "inputTokens" | "outputTokens" | "cachedInputTokens"> | null,
  ): Promise<void>;
  /** Drops a reservation without a charge: the call never happened. */
  release(key: string): Promise<void>;
  /** Settles the task's budget at its end, returning what the task spent. */
  end(): Promise<number>;
  /**
   * Counts a tool call against the user's 60 a minute (COST-2); `false`: the tool must not run.
   * `key` is the call's idempotency key, so a retried step isn't counted twice. An `approved`
   * call is counted but always allowed: the user's approval gates it.
   */
  allowToolCall(key: string, approved?: boolean): Promise<boolean>;
}

/**
 * What task code runs against. Each LLM and tool call is one `step`, named once per task; its
 * idempotency key is `instanceId:stepName` and is handed to `fn` for the calls (budget, storage)
 * that key off it. A step of a cancelled task does nothing: the adapter checks the task row
 * inside every step before `fn` runs and throws `TaskCancelledError` instead.
 */
export interface TaskContext {
  readonly taskId: string;
  readonly instanceId: string;
  step<T extends JsonValue>(
    name: string,
    fn: (idempotencyKey: string) => Promise<T>,
    options?: StepOptions,
  ): Promise<T>;
  sleep(name: string, durationMs: number): Promise<void>;
  /**
   * Waits for an external event (an approval decision). The payload is a wake-up call, never
   * evidence: callers re-read the authoritative row before they act on it (M3-12 AC3).
   */
  waitForEvent<T extends JsonValue>(
    name: string,
    options: { type: string; timeoutMs: number },
  ): Promise<{ payload: T }>;
  /** Sends a progress event to the user's tabs. Fire-and-forget; never a persisted step. */
  progress(event: TaskProgressEvent): void;
  readonly budget: TaskBudget;
  /** `instanceId:stepName`, the key every idempotent call in that step shares. */
  idempotencyKey(stepName: string): string;
}

/** Per-task execution limits (COST-1, M3-12 AC6). */
export const TASK_LIMITS = {
  steps: 200,
  interactiveMs: 30 * 60_000,
  backgroundMs: 6 * 3_600_000,
} as const;

/** Step outputs larger than this are persisted as a reference to object storage (M3-12 AC4). */
export const STEP_OUTPUT_INLINE_MAX_BYTES = 1024 * 1024;

/**
 * Replaces every exact occurrence of a guarded secret in a step output's strings, object keys
 * included. Step outputs are persisted (and replayed from storage), so a provider or tool that
 * echoes a key back must not fix it in durable state. One implementation for both task runtimes
 * (the Workflows adapter and the Node journal, M3-23b); values under 8 chars are ignored by the
 * callers, since they match too eagerly.
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

/** The step did not run because the task was cancelled first. Terminal for the task. */
export class TaskCancelledError extends Error {
  constructor(readonly taskId: string) {
    super(`task ${taskId} was cancelled`);
    this.name = "TaskCancelledError";
  }
}

/** The task reached a COST-1 execution limit; it stops as `budget_limited`, not failed. */
export class TaskLimitError extends Error {
  constructor(
    readonly kind: "steps" | "duration",
    readonly detail: string,
  ) {
    super(`task limit reached (${kind}): ${detail}`);
    this.name = "TaskLimitError";
  }
}
