// SPDX-License-Identifier: Apache-2.0
// What the loop emits: the `HarnessEvent` types it can produce, without the envelope. The names
// and payloads are EL fix 6 (M3-03 AC8) and live in `@opa/core`; the host wraps each event with
// `v`, `seq`, `sessionId` and `turnId` when it broadcasts it.
import type { HarnessEvent } from "@opa/core";

export type { ApprovalDecision, ApprovalItem, LimitKind } from "@opa/core";

type E<T extends HarnessEvent["type"]> = {
  type: T;
  payload: Extract<HarnessEvent, { type: T }>["payload"];
};

export type LoopEvent =
  | E<"message.delta">
  | E<"message.completed">
  | E<"usage.updated">
  | E<"step.started">
  | E<"step.completed">
  | E<"tool.called">
  | E<"tool.result">
  | E<"approval.requested">
  | E<"approval.resolved">
  | E<"context.tainted">
  | E<"artifact.created">
  | E<"limit.reached">
  | E<"turn.completed">
  | E<"turn.cancelled">
  // The loop's failure carries no limit reason: a refused send never starts a turn.
  | { type: "turn.failed"; payload: { message: string } };

/** How a run of the loop ended. Only `awaiting_approval` and `limit_reached` can be resumed. */
export type TurnOutcome =
  | "completed"
  | "awaiting_approval"
  | "limit_reached"
  | "cancelled"
  | "failed";
