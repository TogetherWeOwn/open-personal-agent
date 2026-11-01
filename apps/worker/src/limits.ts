// SPDX-License-Identifier: Apache-2.0
// Per-user turn and spend limits v0 (M2-22, ADR 0010 D7 and D10). They live in the user's
// assistant, whose storage is single-threaded, so the counts are exact: unlike the rate-limit
// binding, they can't overshoot. Each model call reserves its worst case (`max_tokens × price`)
// before it starts and settles to its estimated cost when it ends, so calls running at once never
// pass the daily cap by more than what a call's input estimate missed.
import { estimate, findPrice, type ModelPrice } from "@opa/pricing";

/** Turns a user may start in any 60 seconds. */
export const TURNS_PER_MINUTE = 30;
/** Model calls in one turn. A chat turn makes one; the tool loop (M3) raises it. */
export const MAX_CALLS_PER_TURN = 1;
/** Each user's spend a UTC day, in micro-USD, at published prices. Settings take it over in M3. */
export const DAILY_SPEND_CAP_MICRO_USD = 5_000_000;
/** `max_tokens` when the budget allows it. */
export const MAX_OUTPUT_TOKENS = 4096;
/** Below this many output tokens a reply would be cut short, so the turn isn't started. */
export const MIN_OUTPUT_TOKENS = 256;

const MINUTE = 60_000;
const DAY = 86_400_000;

/** The Durable Object's synchronous storage, or a `Map` in tests. */
export type Kv = Pick<SyncKvStorage, "get" | "put">;

interface Spend {
  /** The UTC day's start; a new day starts from zero. */
  day: number;
  spentMicroUsd: number;
  /** Reservations of calls still running, by turn ID. */
  held: Record<string, Hold>;
}

interface Hold {
  microUsd: number;
  /** When the call reserved it. */
  at: number;
}

export interface Reservation {
  maxOutputTokens: number;
  reservedMicroUsd: number;
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

  /** Counts a turn, or returns `false` if the user has started too many in the last minute. */
  startTurn(): boolean {
    const now = this.now();
    const recent = (this.kv.get<number[]>("turns") ?? []).filter((t) => now - t < MINUTE);
    if (recent.length >= TURNS_PER_MINUTE) return false;
    this.kv.put("turns", [...recent, now]);
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
    const holds = Object.entries(spend?.held ?? {}).map(([turnId, hold]): [string, Hold] => [
      turnId,
      typeof hold === "number" ? { microUsd: hold, at: now } : hold,
    ]);
    if (spend?.day === day) return { ...spend, held: Object.fromEntries(holds) };
    const live = holds.filter(([, hold]) => now - hold.at < DAY);
    return { day, spentMicroUsd: 0, held: Object.fromEntries(live) };
  }

  /**
   * Reserves a call's worst case from today's budget and caps its `max_tokens` to what is left.
   * `null` means the budget can't cover a useful reply. A model with no price on file reserves
   * nothing: the Usage page lists its calls as unpriced. `fileTokens` is the attached images'
   * and PDFs' estimated input, which `chars` can't measure.
   */
  reserve(
    turnId: string,
    providerId: string,
    model: string,
    chars: number,
    fileTokens = 0,
  ): Reservation | null {
    const price = findPrice(providerId, model);
    if (!price) return { maxOutputTokens: MAX_OUTPUT_TOKENS, reservedMicroUsd: 0 };
    const spend = this.#spend();
    const held = Object.values(spend.held).reduce((sum, hold) => sum + hold.microUsd, 0);
    const input = cost(price, inputTokens(chars) + fileTokens, 0);
    const left = DAILY_SPEND_CAP_MICRO_USD - spend.spentMicroUsd - held - input;
    const affordable = Math.floor(left / price.outputUsdPerMTok);
    const maxOutputTokens = Math.min(MAX_OUTPUT_TOKENS, affordable);
    if (maxOutputTokens < MIN_OUTPUT_TOKENS) return null;
    const reservedMicroUsd = cost(price, inputTokens(chars) + fileTokens, maxOutputTokens);
    const hold = { microUsd: reservedMicroUsd, at: this.now() };
    this.kv.put("spend", { ...spend, held: { ...spend.held, [turnId]: hold } });
    return { maxOutputTokens, reservedMicroUsd };
  }

  /**
   * Releases a turn's reservation and counts what the call cost. With no usage reported, the
   * whole reservation counts, so a provider that reports none can't spend past the cap. Only a
   * held reservation is charged, so settling twice (a recovery after the turn settled) charges
   * once.
   */
  settle(
    turnId: string,
    providerId: string,
    model: string,
    usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | null,
  ) {
    const price = findPrice(providerId, model);
    this.#end(turnId, (reserved) =>
      price && usage ? estimate(price, usage).costMicroUsd : reserved,
    );
  }

  /** Drops a turn's reservation without a charge: it never called the model. */
  release(turnId: string) {
    this.#end(turnId, () => 0);
  }

  #end(turnId: string, charge: (reserved: number) => number) {
    this.#calls.delete(turnId);
    const spend = this.#spend();
    const { [turnId]: hold, ...held } = spend.held;
    if (hold === undefined) return;
    const spentMicroUsd = spend.spentMicroUsd + charge(hold.microUsd);
    this.kv.put("spend", { ...spend, spentMicroUsd, held });
  }
}

const cost = (price: ModelPrice, inputTokens: number, outputTokens: number) =>
  estimate(price, { inputTokens, outputTokens, cachedInputTokens: 0 }).costMicroUsd;
