// SPDX-License-Identifier: Apache-2.0
// The `HarnessEvent` v1 envelope (ADR 0005 #1) and the subset the M2 chat turn emits: `turn.*`,
// `message.*`, `usage.updated` and `status`. Tool and approval events join in M3.
import type { ModelUsage } from "./model-provider";

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
  | Envelope<"turn.failed", { message: string }>
  | Envelope<"message.delta", { text: string }>
  | Envelope<"message.completed", { text: string }>
  | Envelope<"usage.updated", { usage: ModelUsage; providerId: string; model: string }>
  | Envelope<"status", { text: string }>;
