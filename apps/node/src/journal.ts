// SPDX-License-Identifier: Apache-2.0
// The Node step journal (M3-23b): the `TaskContext` port over SQLite, the counterpart to the
// Workflows adapter in `apps/worker/src/task-context.ts`. Completed steps persist in the
// `task_steps` table keyed by `(instance_id, name)`, so a resumed run replays them instead of
// re-running their functions, the way the Workflow engine replays `step.do`. Cancel and
// duration guards, the per-task step limit, the persisted envelope, R2-equivalent offload over
// the structural `outputs` port and exact-secret redaction all match the Workflows adapter step
// for step; `test/contract/tasks.ts` pins the shared behaviour against both roots
// (`selfhost-parity` AC3). Steps are at-least-once, as on the engine: a crash between a side
// effect and its journal write reruns the step, so everything with a side effect stays inside
// one step and everything outside stays deterministic.
import {
  type JsonValue,
  redactSecrets,
  STEP_OUTPUT_INLINE_MAX_BYTES,
  type StepOptions,
  TASK_LIMITS,
  type TaskBudget,
  TaskCancelledError,
  type TaskContext,
  TaskLimitError,
  type TaskStepper,
} from "@opa/core";
import type { TaskStatus } from "@opa/db/repository";

export interface SqliteJournalDeps {
  /** The app database binding; the journal tables live beside the task rows. */
  db: D1Database;
  /** The run's Workflow-instance id: the journal's replay key across restarts. */
  instanceId: string;
  now?: () => number;
  /** Pause between event polls in `waitForEvent`. */
  pollIntervalMs?: number;
}

/**
 * A `TaskStepper` over the journal tables. `do` replays a finished step from its row; a step
 * interrupted before its write (crash, restart) simply runs again on resume. Retries and the
 * timeout run inline — there is no engine to own them — with the same option shapes as the
 * port. `sleep` is a plain timer: a restart re-sleeps, which only delays the run.
 */
export function createSqliteJournal(deps: SqliteJournalDeps): TaskStepper {
  const now = deps.now ?? Date.now;
  const pollIntervalMs = deps.pollIntervalMs ?? 25;

  return {
    async do<T extends JsonValue>(name: string, config: StepOptions, fn: () => Promise<T>) {
      const replayed = await deps.db
        .prepare("SELECT output FROM task_steps WHERE instance_id = ? AND name = ?")
        .bind(deps.instanceId, name)
        .first("output");
      if (typeof replayed === "string") return JSON.parse(replayed) as T;
      const value = await runWithRetries(fn, config);
      await deps.db
        .prepare("INSERT INTO task_steps (instance_id, name, output) VALUES (?, ?, ?)")
        .bind(deps.instanceId, name, JSON.stringify(value))
        .run();
      return value;
    },

    async sleep(_name: string, durationMs: number): Promise<void> {
      await delay(durationMs);
    },

    /**
     * Consumes the oldest matching row from `task_events`. One runner owns an instance — the
     * assistant is serialised per user — so a select-then-delete is enough for exactly-once
     * delivery; concurrent waiters on one instance would need an atomic consume.
     */
    async waitForEvent<T extends JsonValue>(
      name: string,
      options: { type: string; timeoutMs: number },
    ): Promise<{ payload: T }> {
      const deadline = now() + options.timeoutMs;
      for (;;) {
        const row = (await deps.db
          .prepare(
            "SELECT id, payload FROM task_events WHERE instance_id = ? AND type = ? ORDER BY id LIMIT 1",
          )
          .bind(deps.instanceId, options.type)
          .first()) as { id: number; payload: string } | null;
        if (row) {
          await deps.db.prepare("DELETE FROM task_events WHERE id = ?").bind(row.id).run();
          return { payload: JSON.parse(row.payload) as T };
        }
        if (now() >= deadline) {
          throw new Error(`waitForEvent "${name}" timed out after ${options.timeoutMs} ms`);
        }
        await delay(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
      }
    },
  };
}

/** Posts an event a journal waiter consumes: an approval decision, a test prod, the 23a resume. */
export async function postTaskEvent(
  db: D1Database,
  instanceId: string,
  type: string,
  payload: JsonValue,
): Promise<void> {
  await db
    .prepare("INSERT INTO task_events (instance_id, type, payload) VALUES (?, ?, ?)")
    .bind(instanceId, type, JSON.stringify(payload))
    .run();
}

const DEFAULT_STEP: Required<StepOptions> = {
  retries: { limit: 3, delayMs: 1_000, backoff: "exponential" },
  timeoutMs: 10 * 60_000,
};

/**
 * Runs `fn` with the step's retries and timeout. A timed-out call keeps running in the
 * background — there is no cancellation handle — so a slow step may still journal its write
 * while its attempt already failed; the journal row wins on resume, as with an engine replay.
 */
async function runWithRetries<T>(fn: () => Promise<T>, config: StepOptions): Promise<T> {
  const retries = { ...DEFAULT_STEP.retries, ...config.retries };
  const timeoutMs = config.timeoutMs ?? DEFAULT_STEP.timeoutMs;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await withTimeout(fn(), timeoutMs);
    } catch (error) {
      if (attempt > retries.limit) throw error;
      await delay(backoffDelay(retries.delayMs, retries.backoff, attempt));
    }
  }
}

function backoffDelay(
  delayMs: number,
  backoff: "constant" | "linear" | "exponential" | undefined,
  attempt: number,
): number {
  if (backoff === "linear") return delayMs * attempt;
  if (backoff === "exponential") return delayMs * 2 ** (attempt - 1);
  return delayMs;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`step timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  const settled = promise.then((value) => {
    clearTimeout(timer);
    return value;
  });
  return Promise.race([settled, timeout]);
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface SqliteTaskContextDeps {
  /** The app database binding; the journal tables live beside the task rows. */
  db: D1Database;
  taskId: string;
  instanceId: string;
  /** Where progress goes: the conversation and turn the task belongs to. */
  conversationId: string;
  turnId: string;
  /** When the task's clock started (its row's `started_at`, else `created_at`). */
  startedAt: number;
  mode: "interactive" | "background";
  /** A fresh read of the task row's status; `undefined` when the row is gone. */
  readStatus(): Promise<TaskStatus | undefined>;
  /** Scoped step-output storage (the repository's `stepOutputs`, local files on Node). */
  outputs: {
    put(id: string, value: string): Promise<unknown>;
    get(id: string): Promise<{ text(): Promise<string> } | null>;
  };
  /** The task's budget: the in-process assistant's reserve/settle until 23a wires it. */
  budget: TaskBudget;
  /** Progress sink; fire-and-forget, so a throwing sink never fails a step. */
  onProgress(event: {
    conversationId: string;
    turnId: string;
    taskId: string;
    seq: number;
    type: string;
    payload: unknown;
  }): void;
  /** Exact secret values that must never reach a persisted step output (values under 8 chars are ignored). */
  secrets?: readonly string[];
  now?: () => number;
  /** Overrides for tests; the COST-1 defaults otherwise. */
  limits?: { steps?: number; durationMs?: number };
}

/**
 * What a step persists: always this envelope, never `fn`'s value bare, so no value a step
 * returns can pass for the journal's own markers — the same envelope as the Workflows adapter.
 * `ref` stands in for an output over the inline bound, resolved back from the outputs store
 * for the caller; `stopped` means the guard stopped the step before `fn`.
 */
type Persisted =
  | { value: JsonValue }
  | { ref: string; bytes: number }
  | { stopped: "cancelled" | "duration" };

const TERMINAL: readonly TaskStatus[] = ["succeeded", "failed", "cancelled", "interrupted"];

/**
 * The `TaskContext` port over the SQLite journal. Semantics match `createWorkflowTaskContext`:
 * names are claimed once against the per-task limit, every step re-reads the task row before
 * it acts (a cancelled task's step does nothing), a stop persists as the step's output so a
 * resume replays the stop instead of re-running the step, and progress never persists.
 */
export function createSqliteTaskContext(deps: SqliteTaskContextDeps): TaskContext {
  const journal = createSqliteJournal({
    db: deps.db,
    instanceId: deps.instanceId,
    ...(deps.now ? { now: deps.now } : {}),
  });
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
   * the run (M3-12 AC3). A stop is returned, not thrown: a throw would retry and re-run `fn`,
   * while a returned marker persists, replays the same, and is turned into the real error
   * outside the step.
   */
  async function guard(): Promise<"cancelled" | "duration" | null> {
    const status = await deps.readStatus();
    if (status === undefined || TERMINAL.includes(status)) return "cancelled";
    if (now() - deps.startedAt > durationMs) return "duration";
    return null;
  }

  function stop(why: "cancelled" | "duration"): never {
    if (why === "cancelled") throw new TaskCancelledError(deps.taskId);
    throw new TaskLimitError("duration", `${durationMs} ms`);
  }

  /**
   * The same guard before a sleep or wait, outside any step: a task that has ended or run out
   * of time does not park first. On a resume it can only stop a task that has since ended,
   * which is the right answer for that task anyway.
   */
  async function beforeWait(): Promise<void> {
    const why = await guard();
    if (why) stop(why);
  }

  return {
    taskId: deps.taskId,
    instanceId: deps.instanceId,
    idempotencyKey,
    budget: deps.budget,

    async step<T extends JsonValue>(
      name: string,
      fn: (idempotencyKey: string) => Promise<T>,
      options?: Parameters<TaskContext["step"]>[2],
    ): Promise<T> {
      claim(name);
      const persisted = (await journal.do<JsonValue>(
        name,
        options ?? {},
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
      await journal.sleep(name, durationMs);
    },

    async waitForEvent(name, options) {
      claim(name);
      await beforeWait();
      return journal.waitForEvent(name, options);
    },

    progress(event) {
      progressSeq += 1;
      try {
        deps.onProgress({
          conversationId: deps.conversationId,
          turnId: deps.turnId,
          taskId: deps.taskId,
          seq: progressSeq,
          type: event.type,
          payload: redactSecrets(event.payload as JsonValue, secrets),
        });
      } catch {
        // progress is best-effort; the task's state lives in the database
      }
    },
  };
}

/** The storage id of a step's offloaded output: the hex SHA-256 of its idempotency key. */
async function outputId(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
