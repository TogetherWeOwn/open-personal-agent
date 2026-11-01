// SPDX-License-Identifier: Apache-2.0
// What the loop emits, with the names and payloads of EL fix 6 (M3-03 AC8). The host wraps each one
// in the `HarnessEvent` v1 envelope (`v`, `seq`, `sessionId`, `turnId`); M3-03c moves these types
// into `@opa/core`.
import type { ModelUsage } from "@opa/core";
import type { ApprovalScope, PolicyRule, RiskClass, TaintSourceKind } from "@opa/policy";

export type LimitKind = "task_budget" | "daily" | "monthly_hard" | "calls" | "tools" | "tool_rate";

export type ApprovalItem = {
  approvalId: string; // `appr_<toolCallId>`, issued by the loop, never by the model
  tool: string;
  args: string; // canonical JSON
  target?: string;
  risk: RiskClass;
  rule: PolicyRule;
  taint?: { kind: TaintSourceKind | "memory"; label: string }; // what tainted the context first
  scopes: readonly ApprovalScope[];
  expiresAt: number; // epoch ms
  costMicroUsd?: number;
};

export type ApprovalDecision = {
  approvalId: string;
  decision: "approve" | "deny";
  scope: ApprovalScope;
};

type E<T extends string, P> = { type: T; payload: P };

export type LoopEvent =
  | E<"message.delta", { text: string }>
  | E<"message.completed", { text: string }>
  | E<"usage.updated", { usage: ModelUsage; providerId: string; model: string }>
  | E<"step.started", { stepId: string; label: string; toolCallId?: string }>
  | E<"step.completed", { stepId: string; status: "ok" | "error" | "denied"; durationMs: number }>
  | E<"tool.called", { toolCallId: string; tool: string; args: string; risk: RiskClass }>
  | E<
      "tool.result",
      { toolCallId: string; ok: boolean; preview: string; bytes: number; error?: string }
    >
  | E<"approval.requested", { batchId: string; items: ApprovalItem[] }>
  | E<"approval.resolved", { batchId: string; decisions: ApprovalDecision[] }>
  | E<"context.tainted", { stepId: string; source: { kind: TaintSourceKind; label: string } }>
  | E<"artifact.created", { artifactId: string; name: string; type: string; bytes: number }>
  | E<"limit.reached", { kind: LimitKind; detail: string }>
  | E<"turn.completed", Record<string, never>>
  | E<"turn.cancelled", Record<string, never>>
  | E<"turn.failed", { message: string }>;

/** How a run of the loop ended. Only `awaiting_approval` and `limit_reached` can be resumed. */
export type TurnOutcome =
  | "completed"
  | "awaiting_approval"
  | "limit_reached"
  | "cancelled"
  | "failed";
