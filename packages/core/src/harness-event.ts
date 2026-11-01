// SPDX-License-Identifier: Apache-2.0
// The `HarnessEvent` v1 envelope (ADR 0005 #1) and the subset the M2 chat turn emits: `turn.*`,
// `message.*`, `usage.updated` and `status`. Tool and approval events join in M3.
import type { ModelUsage } from "./model-provider";

/**
 * Why a send was refused by a limit (M2-22): `slow_down` passes within a minute, `limit_reached`
 * at the next UTC day.
 */
export type TurnLimit = "slow_down" | "limit_reached";

/**
 * A refusal the user fixes somewhere else, so the tab can link there: `vault_reset_required` when
 * their saved keys no longer open and Settings › Models offers the reset (TWO-650).
 */
export type TurnFailure = "vault_reset_required";

type Envelope<T extends string, P> = {
  v: 1; // the envelope's version: persisted events keep theirs (ADR 0005)
  seq: number; // increases by one per event within a turn, from 1; 0 is a rejection outside any turn
  sessionId: string; // the conversation the turn belongs to
  turnId: string;
  type: T;
  payload: P;
};

export type HarnessEvent =
  | Envelope<"turn.started", { messageId: string }>
  | Envelope<"turn.completed", Record<string, never>>
  | Envelope<"turn.interrupted", { message: string }>
  | Envelope<"turn.failed", { message: string; reason?: TurnLimit; code?: TurnFailure }>
  | Envelope<"message.delta", { text: string }>
  | Envelope<"message.completed", { text: string }>
  | Envelope<"usage.updated", { usage: ModelUsage; providerId: string; model: string }>
  | Envelope<"status", { text: string }>;
