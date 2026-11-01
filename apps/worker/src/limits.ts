// SPDX-License-Identifier: Apache-2.0
// Per-user rate and spend limits (M2-22, M3-17; ADR 0010 D7 and D10). They live in the user's
// assistant, whose storage is single-threaded, so the counts are exact: unlike the rate-limit
// binding, they can't overshoot. Each model call reserves its worst case (`max_tokens × price`)
// before it starts and settles to its estimated cost when it ends, so calls running at once never
// pass a cap by more than what a call's input estimate missed (A-Co5). The caps are the user's
// Spending settings, kept here beside the counters they limit.
import { estimate, findPrice, type ModelPrice } from "@opa/pricing";

/** Turns a user may start in any 60 seconds (COST-2). */
export const TURNS_PER_MINUTE = 30;
/** Tool calls a user may make in any 60 seconds, chat and tasks together (COST-2). */
export const TOOL_CALLS_PER_MINUTE = 60;
/** Model calls in one turn. A chat turn makes one; the tool loop (M3) raises it. */
export const MAX_CALLS_PER_TURN = 1;
/** The default daily cap, in micro-USD at published prices. */
export const DAILY_SPEND_CAP_MICRO_USD = 5_000_000;
/** `max_tokens` when the budget allows it. */
export const MAX_OUTPUT_TOKENS = 4096;
/** Below this many output tokens a reply would be cut short, so the turn isn't started. */
export const MIN_OUTPUT_TOKENS = 256;

/** The Spending settings (M3-17 AC5), in micro-USD. A null hard cap is off. */
export interface SpendingSettings {
  /** Each task's budget (COST-3), reserved when the task starts. */
  taskBudgetMicroUsd: number;
  dailyCapMicroUsd: number;
  /** The monthly soft cap (COST-4): it warns at 50, 80 and 100% and never stops anything. */
  monthlyBudgetMicroUsd: number;
  /** The optional hard cap: background work stops at it; chat and reading data never do. */
  hardCapMicroUsd: number | null;
}

export const SPENDING_DEFAULTS: SpendingSettings = {
  taskBudgetMicroUsd: 500_000,
  dailyCapMicroUsd: DAILY_SPEND_CAP_MICRO_USD,
  monthlyBudgetMicroUsd: 20_000_000,
  hardCapMicroUsd: null,
};

/** The most any one spending setting may be: $10,000. */
export const MAX_SETTING_MICRO_USD = 10_000_000_000;

/** Which limit refused a call; the names of `limit.reached` (M3-03 AC8). */
export type SpendLimit = "task_budget" | "daily" | "monthly_hard";

const MINUTE = 60_000;
const DAY = 86_400_000;
/** A task envelope untouched this long belongs to a task that can no longer be continued. */
const TASK_TTL = 30 * DAY;

/** The Durable Object's synchronous storage, or a `Map` in tests. */
export type Kv = Pick<SyncKvStorage, "get" | "put">;

interface Spend {
  /** The UTC day's start; a new day starts from zero. */
  day: number;
  spentMicroUsd: number;
  /** Reservations of calls still running, by hold ID. */
  held: Record<string, Hold>;
}

interface Hold {
  microUsd: number;
  /** When the call reserved it. */
  at: number;
  /** The task whose budget the call draws on, if any. */
  task?: string;
}

/** This UTC month's settled spend: the hard cap's counter. */
interface Month {
  month: number;
  spentMicroUsd: number;
}

/** A task's budget (COST-3): set when the task starts, drawn on by its calls, dropped at its end. */
interface TaskEnvelope {
  budgetMicroUsd: number;
  spentMicroUsd: number;
  /** Continue was used: it raises the budget once (A-Co2). */
  raised: boolean;
  at: number;
}

export interface Reservation {
  maxOutputTokens: number;
  reservedMicroUsd: number;
}

export interface Refusal {
  limit: SpendLimit;
  detail: string;
}

/** What a call is for: its task, and whether it runs in the background (the hard cap's reach). */
export interface CallScope {
  taskId?: string;
  background?: boolean;
}

/**
 * A conservative input-token count for `chars` characters of text: two characters a token, where
 * English averages about four. A miss only makes the settled cost exceed the reservation.
 */
const inputTokens = (chars: number) => Math.ceil(chars / 2);

export class Limits {
  /** Model calls per running turn. A turn runs in one process, so memory is enough. */
  readonly #calls = new Map<string, number>();

  constructor(
    private readonly kv: Kv,
    private readonly now: () => number = Date.now,
  ) {}

  /** The user's Spending settings, with the default for any not set. */
  settings(): SpendingSettings {
    return { ...SPENDING_DEFAULTS, ...this.kv.get<Partial<SpendingSettings>>("settings") };
  }

  /** Saves the settings given; the caller has checked them with `checkSpending`. */
  setSettings(changes: Partial<SpendingSettings>): SpendingSettings {
    const next = { ...this.settings(), ...changes };
    this.kv.put("settings", next);
    return next;
  }

  /** Counts a turn, or returns `false` if the user has started too many in the last minute. */
  startTurn(): boolean {
    return this.#rate("turns", TURNS_PER_MINUTE);
  }

  /**
   * Counts a tool call, or returns `false` past 60 in the last minute: the tool must not run.
   * `callKey` names the call, so a retried step asking again for the same call isn't counted
   * twice while it is still in the window.
   */
  toolCall(callKey?: string): boolean {
    return this.#rate("tools", TOOL_CALLS_PER_MINUTE, callKey);
  }

  #rate(key: string, perMinute: number, callKey?: string): boolean {
    const now = this.now();
    // Entries are times, or `[time, callKey]` for a call that names itself.
    const recent = (this.kv.get<(number | [number, string])[]>(key) ?? []).filter(
      (e) => now - (typeof e === "number" ? e : e[0]) < MINUTE,
    );
    if (callKey !== undefined && recent.some((e) => typeof e !== "number" && e[1] === callKey))
      return true;
    if (recent.length >= perMinute) return false;
    this.kv.put(key, [...recent, callKey === undefined ? now : [now, callKey]]);
    return true;
  }

  /** Counts a model call in a turn, or returns `false` past the per-turn cap. */
  call(turnId: string): boolean {
    const calls = (this.#calls.get(turnId) ?? 0) + 1;
    if (calls > MAX_CALLS_PER_TURN) return false;
    this.#calls.set(turnId, calls);
    return true;
  }

  /**
   * Today's spend. A new UTC day starts from zero but keeps the reservations of calls still
   * running, so a call that started before midnight is charged when it settles: to the new day,
   * since nothing is left to limit on the old one. No call runs for a day, so an older hold was
   * lost with its turn and is dropped rather than carried forever.
   */
  #spend(): Spend {
    const now = this.now();
    const day = now - (now % DAY);
    const spend = this.kv.get<Spend>("spend");
    // Holds stored before they kept a time are plain amounts; count them as made now.
    const holds = Object.entries(spend?.held ?? {}).map(([id, hold]): [string, Hold] => [
      id,
      typeof hold === "number" ? { microUsd: hold, at: now } : hold,
    ]);
    if (spend?.day === day) return { ...spend, held: Object.fromEntries(holds) };
    const live = holds.filter(([, hold]) => now - hold.at < DAY);
    return { day, spentMicroUsd: 0, held: Object.fromEntries(live) };
  }

  /** This UTC month's settled spend; a new month starts from zero. */
  #month(): Month {
    const d = new Date(this.now());
    const month = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const stored = this.kv.get<Month>("month");
    return stored?.month === month ? stored : { month, spentMicroUsd: 0 };
  }

  #tasks(): Record<string, TaskEnvelope> {
    const now = this.now();
    const all = Object.entries(this.kv.get<Record<string, TaskEnvelope>>("tasks") ?? {});
    return Object.fromEntries(all.filter(([, t]) => now - t.at < TASK_TTL));
  }

  /**
   * Reserves a task's budget when it starts (COST-3): the default, or the task's own. Starting
   * a task that has started is a no-op, so a replayed start keeps what the task has spent.
   */
  startTask(taskId: string, budgetMicroUsd?: number): { budgetMicroUsd: number } {
    const tasks = this.#tasks();
    const task = tasks[taskId] ?? {
      budgetMicroUsd: budgetMicroUsd ?? this.settings().taskBudgetMicroUsd,
      spentMicroUsd: 0,
      raised: false,
      at: this.now(),
    };
    this.kv.put("tasks", { ...tasks, [taskId]: task });
    return { budgetMicroUsd: task.budgetMicroUsd };
  }

  /**
   * Continue after a task-budget stop: raises the budget once, by the task's own budget again
   * (A-Co2). `false` when it was already raised or the task has no budget here.
   */
  raiseTask(taskId: string): boolean {
    const tasks = this.#tasks();
    const task = tasks[taskId];
    if (!task || task.raised) return false;
    const raised = {
      ...task,
      budgetMicroUsd: task.budgetMicroUsd * 2,
      raised: true,
      at: this.now(),
    };
    this.kv.put("tasks", { ...tasks, [taskId]: raised });
    return true;
  }

  /** Undoes `raiseTask` when the Continue it was for couldn't wake the task. */
  unraiseTask(taskId: string): void {
    const tasks = this.#tasks();
    const task = tasks[taskId];
    if (!task?.raised) return;
    const budgetMicroUsd = task.budgetMicroUsd / 2;
    this.kv.put("tasks", { ...tasks, [taskId]: { ...task, budgetMicroUsd, raised: false } });
  }

  /** A task's budget and what it has spent so far; `null` when it never started or has ended. */
  task(taskId: string): Omit<TaskEnvelope, "at"> | null {
    const task = this.#tasks()[taskId];
    return task
      ? {
          budgetMicroUsd: task.budgetMicroUsd,
          spentMicroUsd: task.spentMicroUsd,
          raised: task.raised,
        }
      : null;
  }

  /**
   * Settles a task's budget at its end and returns what it spent. A call still held (its step
   * was lost mid-call) settles on its own later, so its whole reservation is counted here: the
   * figure is never below what the task really cost.
   */
  endTask(taskId: string): number {
    const { [taskId]: task, ...rest } = this.#tasks();
    this.kv.put("tasks", rest);
    const held = Object.values(this.#spend().held)
      .filter((hold) => hold.task === taskId)
      .reduce((n, hold) => n + hold.microUsd, 0);
    return (task?.spentMicroUsd ?? 0) + held;
  }

  /**
   * Reserves a call's worst case and caps its `max_tokens` to what is left under every limit
   * that applies: the daily cap always, the task's budget for a task's call, and the monthly
   * hard cap for background work. `null` means one of them can't cover a useful reply. A model
   * with no price on file reserves nothing (the Usage page lists its calls as unpriced) unless a
   * limit is already used up. `fileTokens` is the attached images' and PDFs' estimated input,
   * which `chars` can't measure.
   */
  reserve(
    holdId: string,
    providerId: string,
    model: string,
    chars: number,
    fileTokens = 0,
    scope: CallScope = {},
  ): Reservation | null {
    const r = this.reserveFor(holdId, providerId, model, chars, fileTokens, scope);
    return "limit" in r ? null : r;
  }

  /** `reserve`, saying which limit refused the call. */
  reserveFor(
    holdId: string,
    providerId: string,
    model: string,
    chars: number,
    fileTokens = 0,
    scope: CallScope = {},
  ): Reservation | Refusal {
    const settings = this.settings();
    const spend = this.#spend();
    const holds = Object.values(spend.held);
    const sum = (list: Hold[]) => list.reduce((n, hold) => n + hold.microUsd, 0);
    // What each applicable limit has left before this call; the smallest binds.
    const room: [SpendLimit, number, string][] = [];
    const task = scope.taskId === undefined ? undefined : this.#tasks()[scope.taskId];
    // A task's call draws on its budget; with none (never started, or ended), nothing is left.
    if (scope.taskId !== undefined && !task) {
      return { limit: "task_budget", detail: "the task has no budget left to draw on" };
    }
    if (task) {
      const taskHeld = sum(holds.filter((hold) => hold.task === scope.taskId));
      room.push([
        "task_budget",
        task.budgetMicroUsd - task.spentMicroUsd - taskHeld,
        usd(task.budgetMicroUsd),
      ]);
    }
    room.push([
      "daily",
      settings.dailyCapMicroUsd - spend.spentMicroUsd - sum(holds),
      usd(settings.dailyCapMicroUsd),
    ]);
    if (scope.background && settings.hardCapMicroUsd !== null) {
      const left = settings.hardCapMicroUsd - this.#month().spentMicroUsd - sum(holds);
      room.push(["monthly_hard", left, usd(settings.hardCapMicroUsd)]);
    }
    const [limit, left, cap] = room.reduce((a, b) => (b[1] < a[1] ? b : a));
    const refusal = { limit, detail: `${cap} ${LIMIT_NAMES[limit]}` };
    if (left <= 0) return refusal;
    const price = findPrice(providerId, model);
    if (!price) return { maxOutputTokens: MAX_OUTPUT_TOKENS, reservedMicroUsd: 0 };
    const input = cost(price, inputTokens(chars) + fileTokens, 0);
    const affordable = Math.floor((left - input) / price.outputUsdPerMTok);
    const maxOutputTokens = Math.min(MAX_OUTPUT_TOKENS, affordable);
    if (maxOutputTokens < MIN_OUTPUT_TOKENS) return refusal;
    const reservedMicroUsd = cost(price, inputTokens(chars) + fileTokens, maxOutputTokens);
    const hold: Hold = {
      microUsd: reservedMicroUsd,
      at: this.now(),
      ...(task ? { task: scope.taskId } : {}),
    };
    this.kv.put("spend", { ...spend, held: { ...spend.held, [holdId]: hold } });
    return { maxOutputTokens, reservedMicroUsd };
  }

  /**
   * Releases a call's reservation and counts what it cost. With no usage reported, the whole
   * reservation counts, so a provider that reports none can't spend past the cap. Only a held
   * reservation is charged, so settling twice (a recovery after the turn settled) charges once.
   */
  settle(
    holdId: string,
    providerId: string,
    model: string,
    usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | null,
  ) {
    const price = findPrice(providerId, model);
    this.#end(holdId, (reserved) =>
      price && usage ? estimate(price, usage).costMicroUsd : reserved,
    );
  }

  /** Drops a call's reservation without a charge: it never called the model. */
  release(holdId: string) {
    this.#end(holdId, () => 0);
  }

  /** Today's and this month's settled spend, and what calls running now hold. */
  totals(): { todayMicroUsd: number; monthMicroUsd: number; heldMicroUsd: number } {
    const spend = this.#spend();
    return {
      todayMicroUsd: spend.spentMicroUsd,
      monthMicroUsd: this.#month().spentMicroUsd,
      heldMicroUsd: Object.values(spend.held).reduce((n, hold) => n + hold.microUsd, 0),
    };
  }

  #end(holdId: string, charge: (reserved: number) => number) {
    this.#calls.delete(holdId);
    const spend = this.#spend();
    const { [holdId]: hold, ...held } = spend.held;
    if (hold === undefined) return;
    const charged = charge(hold.microUsd);
    this.kv.put("spend", { ...spend, spentMicroUsd: spend.spentMicroUsd + charged, held });
    const month = this.#month();
    this.kv.put("month", { ...month, spentMicroUsd: month.spentMicroUsd + charged });
    if (hold.task === undefined) return;
    const tasks = this.#tasks();
    const task = tasks[hold.task];
    if (!task) return; // the task ended while its call ran; the day and month still count it
    const spent = { ...task, spentMicroUsd: task.spentMicroUsd + charged, at: this.now() };
    this.kv.put("tasks", { ...tasks, [hold.task]: spent });
  }
}

const LIMIT_NAMES: Record<SpendLimit, string> = {
  task_budget: "task budget",
  daily: "daily limit",
  monthly_hard: "monthly hard limit",
};

/**
 * Checks a change to the Spending settings: whole micro-USD from $0.01 to $10,000, and a hard
 * cap that is a number or `null` (off). Returns the change, or `null` if any field is wrong.
 */
export function checkSpending(body: unknown): Partial<SpendingSettings> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const valid = (v: unknown) =>
    Number.isSafeInteger(v) && (v as number) >= 10_000 && (v as number) <= MAX_SETTING_MICRO_USD;
  const out: Partial<SpendingSettings> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === "hardCapMicroUsd" && value === null) out.hardCapMicroUsd = null;
    else if (Object.hasOwn(SPENDING_DEFAULTS, key) && valid(value))
      out[key as keyof SpendingSettings] = value as number;
    else return null;
  }
  return out;
}

const usd = (microUsd: number) => `$${(microUsd / 1_000_000).toFixed(2)}`;

const cost = (price: ModelPrice, inputTokens: number, outputTokens: number) =>
  estimate(price, { inputTokens, outputTokens, cachedInputTokens: 0 }).costMicroUsd;
