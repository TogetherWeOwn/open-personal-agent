// SPDX-License-Identifier: Apache-2.0
// A stopped batch as approval rows (M3-07 AC1, AC9), and those rows back as the turn's decisions.
// Both hosts use it: the Durable Object for a chat turn and the Workflow for a task. The rows in
// D1 are the source of truth; the turn state only says which calls wait.
import {
  type ApprovalContext,
  bindApproval,
  jcs,
  openApproval,
  type ToolRegistry,
  toolDefinitionHash,
} from "@opa/policy";
import type { ApprovalDecision } from "./events";
import type { LoopTool, PendingItem, TurnState } from "./loop";

/** One approval row as the host writes it; structurally the repository's `NewApproval`. */
export type BoundApproval = {
  batchId: string;
  approvalId: string;
  position: number;
  conversationId: string;
  turnId: string | null;
  taskId: string | null;
  tool: string;
  toolCallId: string;
  target: string | null;
  risk: string;
  rule: string;
  stepUp: boolean;
  scopes: string;
  taint: string | null;
  costMicroUsd: number | null;
  canonical: string;
  bindingHash: string;
  expiresAt: number;
};

/** Statuses of a row some run already claimed: it ran, or may have. */
const CLAIMED = new Set(["executing", "dispatched", "executed", "failed"]);

/** The parts of a stored row the resume reads. */
export type StoredApproval = {
  approvalId: string;
  toolCallId: string;
  tool: string;
  status: string;
  scope: string | null;
  canonical: string;
  bindingHash: string;
  expiresAt: number;
};

/**
 * Binds every item of the stopped batch to its user, run and call (crypto review C2). The
 * arguments bound are the validated ones the loop stored, so the hash covers what the card shows.
 */
export async function bindBatch(input: {
  userId: string;
  tools: ToolRegistry<LoopTool>;
  pending: NonNullable<TurnState["pending"]>;
  context: ApprovalContext;
}): Promise<BoundApproval[]> {
  const { pending, context } = input;
  return Promise.all(
    pending.items.map(async (item, position) => {
      const manifest = input.tools.get(item.tool)?.manifest;
      if (!manifest) throw new Error(`no manifest for ${item.tool}`);
      const { canonical, bindingHash } = await bindApproval({
        userId: input.userId,
        manifest,
        args: JSON.parse(item.args) as Record<string, unknown>,
        target: item.target ?? null,
        context,
        toolCallId: item.toolCallId,
      });
      return {
        batchId: pending.batchId,
        approvalId: item.approvalId,
        position,
        conversationId: context.conversationId,
        turnId: context.kind === "turn" ? context.id : null,
        taskId: context.kind === "task" ? context.id : null,
        tool: item.tool,
        toolCallId: item.toolCallId,
        target: item.target ?? null,
        risk: item.risk,
        rule: item.rule,
        stepUp: item.stepUp,
        scopes: JSON.stringify(item.scopes),
        taint: item.taint ? JSON.stringify(item.taint) : null,
        costMicroUsd: item.costMicroUsd ?? null,
        canonical,
        bindingHash,
        expiresAt: item.expiresAt,
      };
    }),
  );
}

/** Why a stored approval can't run as bound, or `null` if it can (AC12, crypto review C2). */
export async function bindingProblem(
  row: StoredApproval,
  expect: { userId: string; context: ApprovalContext; tools: ToolRegistry<LoopTool> },
): Promise<string | null> {
  const envelope = await openApproval(row.canonical, row.bindingHash);
  if (!envelope) return "binding_mismatch";
  const { context } = expect;
  if (
    envelope.userId !== expect.userId ||
    envelope.tool !== row.tool ||
    envelope.toolCallId !== row.toolCallId ||
    envelope.context.kind !== context.kind ||
    envelope.context.id !== context.id ||
    envelope.context.conversationId !== context.conversationId
  ) {
    return "binding_mismatch";
  }
  const entry = expect.tools.get(row.tool);
  if (!entry) return "tool_missing";
  // The tool changed since it was approved: the approval covered another definition.
  if ((await toolDefinitionHash(entry.manifest)) !== envelope.toolDefSha256) return "tool_changed";
  // `target` is code, not manifest: derived again, it must still be what the user approved.
  if ((entry.tool.target?.(envelope.args) ?? null) !== envelope.target) return "target_changed";
  return null;
}

/**
 * The batch's decisions as D1 holds them, applied to the turn's pending items: the arguments
 * that run are the ones parsed back out of each row's envelope, and a row that no longer opens
 * is denied. `waiting` when an item is still pending and unexpired: nothing resumes yet. An
 * item expired early (a compromise signal, AC13) counts as expired. Throws on a batch that
 * doesn't match the turn's.
 */
export async function applyStoredDecisions(
  state: TurnState,
  rows: readonly StoredApproval[],
  expect: { userId: string; context: ApprovalContext; tools: ToolRegistry<LoopTool> },
  now: number,
): Promise<{ waiting: boolean; refused: Map<string, string> }> {
  const pending = state.pending;
  if (!pending) throw new Error("the turn has no pending batch");
  const refused = new Map<string, string>(); // toolCallId -> why the approved call can't run
  if (rows.length !== pending.items.length) throw new Error("the batch doesn't match the turn");
  const decisions: ApprovalDecision[] = [];
  for (const item of pending.items) {
    const row = rows.find((r) => r.approvalId === item.approvalId);
    if (!row || row.toolCallId !== item.toolCallId) {
      throw new Error("the batch doesn't match the turn");
    }
    if (row.status === "pending") {
      if (now < row.expiresAt) return { waiting: true, refused };
      continue; // expired undecided: the loop says so
    }
    if (row.status === "expired") {
      item.expiresAt = Math.min(item.expiresAt, now);
      continue;
    }
    if (row.status === "denied") {
      decisions.push({ approvalId: item.approvalId, decision: "deny", scope: "once" });
      continue;
    }
    if (!CLAIMED.has(row.status) && row.status !== "approved") {
      throw new Error(`an approval in status ${row.status}`);
    }
    // Approved. A row a run already claimed never runs again, whatever became of that run.
    const problem =
      row.status === "approved" ? await bindingProblem(row, expect) : "already_claimed";
    if (problem) refused.set(item.toolCallId, problem);
    else {
      const envelope = await openApproval(row.canonical, row.bindingHash);
      if (envelope) item.args = jcs(envelope.args);
    }
    const scope = (row.scope ?? "once") as ApprovalDecision["scope"];
    decisions.push({ approvalId: item.approvalId, decision: "approve", scope });
  }
  for (const d of decisions) {
    const item = pending.items.find((i) => i.approvalId === d.approvalId) as PendingItem;
    item.decision = d;
  }
  return { waiting: false, refused };
}
