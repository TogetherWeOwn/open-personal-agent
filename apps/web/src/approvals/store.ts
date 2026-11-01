// SPDX-License-Identifier: Apache-2.0
// The approvals every screen shows: the chat's inline cards, the Inbox and its badge read one list.
// D1 is the source of truth (M3-07 AC9): socket events only say when to read it again, so a tab
// that was closed, asleep or offline catches up on its next load, focus or reconnect.
import type { ApprovalDecision, HarnessEvent } from "@opa/core";
import { useSyncExternalStore } from "react";
import { type DecideResult, listPending, type PendingBatch } from "./api";
import { actionOf, scopeLabel } from "./copy";

/** A batch this tab saw decided, here or elsewhere: one line, with the card behind Details. */
export type Receipt = {
  batch: PendingBatch;
  decisions: ApprovalDecision[];
  text: string;
  at: number;
};

export type ApprovalsState = {
  status: "loading" | "ready" | "error";
  batches: PendingBatch[];
  receipts: Receipt[];
  /** For the polite live region: a new request, or one resolved in another tab. */
  announcement: string;
};

let state: ApprovalsState = { status: "loading", batches: [], receipts: [], announcement: "" };
const listeners = new Set<() => void>();
const set = (next: Partial<ApprovalsState>) => {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
};

export function useApprovals(): ApprovalsState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

const time = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** "You approved: Save a file (once) · 10:42", or for a batch "You approved 2 of 3 …". */
export function receiptText(
  batch: PendingBatch,
  decisions: readonly ApprovalDecision[],
  at: number,
  result?: DecideResult,
): string {
  const items = new Map(batch.items.map((i) => [i.approvalId, i]));
  const name = (d: ApprovalDecision) => actionOf(items.get(d.approvalId)?.tool ?? "");
  const approved = decisions.filter((d) => d.decision === "approve");
  const denied = decisions.filter((d) => d.decision === "deny");
  const scope = approved[0] ? scopeLabel(approved[0].scope).toLowerCase() : "";
  const when = time(at);
  let text: string;
  if (decisions.length <= 1) {
    const [d] = decisions;
    text = d
      ? approved.length
        ? `You approved: ${name(d)} (${scope}) · ${when}.`
        : `You declined: ${name(d)} · ${when}. I won't do it.`
      : `Answered · ${when}.`;
  } else if (!approved.length) {
    text = `You declined all ${decisions.length} · ${when}. I won't do any of them.`;
  } else {
    text = `You approved ${approved.length} of ${decisions.length} (${scope}) · ${when}.`;
    if (denied.length) text += ` Declined: ${denied.map(name).join(", ")}.`;
  }
  if (result?.kind === "done" && approved.length) {
    if (result.status === "waiting" || result.status === "queued") {
      text += " It runs once the current reply finishes.";
    } else if (result.status === "gone") {
      text += " The task it belonged to has ended, so nothing ran.";
    }
  }
  return text;
}

let generation = 0;
const decidedHere = new Set<string>();

/** Reads the list again; the newest read wins, and a failed read keeps what was shown. */
export async function refreshApprovals(): Promise<void> {
  const mine = ++generation;
  try {
    const batches = await listPending();
    if (mine !== generation) return;
    const known = new Set(state.batches.map((b) => b.batchId));
    const fresh = batches.filter((b) => !known.has(b.batchId));
    const first = fresh[0]?.items[0];
    set({
      status: "ready",
      batches,
      ...(first && state.status === "ready"
        ? { announcement: `Needs your approval: ${actionOf(first.tool)}.` }
        : {}),
    });
  } catch {
    if (mine === generation && state.status !== "ready") set({ status: "error" });
  }
}

/** A submit from this tab: its receipt replaces the card, and the list is read again. */
export function decided(
  batch: PendingBatch,
  decisions: ApprovalDecision[],
  result: DecideResult,
): void {
  decidedHere.add(batch.batchId);
  const at = Date.now();
  const receipt = { batch, decisions, at, text: receiptText(batch, decisions, at, result) };
  set({
    batches: state.batches.filter((b) => b.batchId !== batch.batchId),
    receipts: [receipt, ...state.receipts.filter((r) => r.batch.batchId !== batch.batchId)],
  });
  void refreshApprovals();
}

/** The events that change the list. Another tab's decision leaves a receipt here too, no error. */
export function approvalEvent(event: HarnessEvent): void {
  if (event.type === "approval.requested") {
    void refreshApprovals();
    return;
  }
  if (event.type !== "approval.resolved") return;
  const { batchId, decisions } = event.payload;
  const batch = state.batches.find((b) => b.batchId === batchId);
  if (batch && !decidedHere.has(batchId)) {
    const at = Date.now();
    set({
      batches: state.batches.filter((b) => b.batchId !== batchId),
      receipts: [
        { batch, decisions, at, text: receiptText(batch, decisions, at) },
        ...state.receipts,
      ],
      announcement: "1 item resolved elsewhere.",
    });
  }
  void refreshApprovals();
}
