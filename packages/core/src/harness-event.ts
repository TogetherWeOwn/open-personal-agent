// SPDX-License-Identifier: Apache-2.0
// The `HarnessEvent` v1 envelope (ADR 0005 #1): the M2 chat events (`turn.*`, `message.*`,
// `usage.updated`, `status`) and the M3 set with the names and payloads fixed by EL fix 6
// (M3-03 AC8). The M3 events join under `v: 1` with no version bump: none is persisted yet.
import type { ApprovalScope, PolicyRule, RiskClass, TaintSourceKind } from "@opa/policy";
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

/** What kind of limit stopped a run (`limit.reached`): a budget, or a per-turn execution cap. */
export type LimitKind = "task_budget" | "daily" | "monthly_hard" | "calls" | "tools" | "tool_rate";

/** One gated tool call on an approval card, exactly as the user is asked to judge it. */
export type ApprovalItem = {
  approvalId: string; // `appr_<toolCallId>`, issued by the loop, never by the model
  tool: string;
  args: string; // canonical JSON, secrets as refs
  target?: string;
  risk: RiskClass;
  rule: PolicyRule;
  taint?: { kind: TaintSourceKind | "memory"; label: string }; // what tainted the context first
  scopes: readonly ApprovalScope[];
  expiresAt: number; // epoch ms
  costMicroUsd?: number;
};

/** The user's answer to one item of an approval batch. */
export type ApprovalDecision = {
  approvalId: string;
  decision: "approve" | "deny";
  scope: ApprovalScope;
};

type Envelope<T extends string, P> = {
  v: 1; // the envelope's version: persisted events keep theirs (ADR 0005)
  // Increases by one per event within a conversation and never restarts per turn (M3-03 AC10),
  // so a tab can name the last event it applied and replay the rest; 0 is a rejection outside
  // any turn, sent to one tab and never logged. A task's progress frame (it carries `taskId`)
  // is numbered by its task's own counter instead, and is never logged or replayed.
  seq: number;
  sessionId: string; // the conversation the turn belongs to
  turnId: string;
  type: T;
  payload: P;
};

export type HarnessEvent =
  | Envelope<"turn.started", { messageId: string }>
  | Envelope<"turn.completed", Record<string, never>>
  | Envelope<"turn.cancelled", Record<string, never>>
  | Envelope<"turn.interrupted", { message: string }>
  | Envelope<"turn.failed", { message: string; reason?: TurnLimit; code?: TurnFailure }>
  /**
   * A send that arrived mid-run and waits in the conversation's FIFO (M3-09 AC4): the sending
   * tab's message row is already in D1, and `position` is its place in the queue (1-based).
   * Logged under the running turn, so it trims with it and replays to a reconnected tab.
   */
  | Envelope<"turn.queued", { messageId: string; text: string; position: number }>
  /**
   * A steer that joined the running turn (M3-09 AC4): the text is a user message in D1 and in
   * the turn's next step. Yielded by the loop when the text enters the turn, so the timeline
   * shows it exactly where the model reads it.
   */
  | Envelope<"turn.steered", { messageId: string; text: string }>
  /** A queued send the user cancelled before it started (M3-09 AC4); its D1 row is gone. */
  | Envelope<"turn.dequeued", { messageId: string }>
  | Envelope<"message.delta", { text: string }>
  | Envelope<"message.completed", { text: string }>
  | Envelope<"usage.updated", { usage: ModelUsage; providerId: string; model: string }>
  | Envelope<"status", { text: string }>
  | Envelope<"step.started", { stepId: string; label: string; toolCallId?: string }>
  | Envelope<
      "step.completed",
      { stepId: string; status: "ok" | "error" | "denied"; durationMs: number }
    >
  | Envelope<
      "tool.called",
      { toolCallId: string; tool: string; args: string; risk: RiskClass } // args is canonical JSON
    >
  | Envelope<
      "tool.result",
      { toolCallId: string; ok: boolean; preview: string; bytes: number; error?: string }
    >
  | Envelope<"approval.requested", { batchId: string; items: ApprovalItem[] }>
  | Envelope<"approval.resolved", { batchId: string; decisions: ApprovalDecision[] }>
  | Envelope<
      "context.tainted",
      { stepId: string; source: { kind: TaintSourceKind; label: string } }
    >
  | Envelope<"task.promoted", { taskId: string }>
  | Envelope<"limit.reached", { kind: LimitKind; detail: string }>
  | Envelope<"artifact.created", { artifactId: string; name: string; type: string; bytes: number }>
  | Envelope<"memory.proposed", { memoryId: string; text: string; source: string }>;
