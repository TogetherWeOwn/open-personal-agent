// SPDX-License-Identifier: Apache-2.0
// The approvals every screen shows: the chat's inline cards, the Inbox and its badge read one list.
// D1 is the source of truth (M3-07 AC9): socket events only say when to read it again, so a tab
// that was closed, asleep or offline catches up on its next load, focus or reconnect.
import type { ApprovalDecision, HarnessEvent } from "@opa/core";
import { useSyncExternalStore } from "react";
import { type DecideResult, decide, listPending, type PendingBatch } from "./api";
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
  if (next.batches) watchExpiry();
  for (const listener of listeners) listener();
};

let expiry: ReturnType<typeof setTimeout> | undefined;
/** How long to wait before asking again about a batch the server listed but this clock calls expired. */
export const SKEW_RECHECK_MS = 5_000;
/**
 * One timer for the whole list: when the soonest batch expires it leaves, and the list is read
 * again, so neither the badge nor "1 approval waiting" outlives what the server still accepts.
 * A batch that looks expired already when it arrives means this clock runs ahead of the server's:
 * the server decides, so it stays and the list is read again after a pause, not in a loop.
 */
function watchExpiry() {
  clearTimeout(expiry);
  const soonest = Math.min(...state.batches.map((b) => b.expiresAt));
  if (!Number.isFinite(soonest)) return;
  const wait = soonest - Date.now();
  if (wait <= 0) {
    expiry = setTimeout(() => void refreshApprovals(), SKEW_RECHECK_MS);
    return;
  }
  expiry = setTimeout(
    () => {
      const now = Date.now();
      set({ batches: state.batches.filter((b) => b.expiresAt > now) });
      void refreshApprovals();
    },
    Math.min(wait, 2 ** 31 - 1),
  );
}

export const approvalsSnapshot = (): ApprovalsState => state;

export function useApprovals(): ApprovalsState {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, approvalsSnapshot);
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
  // The card offers one scope for the whole batch; another client could send several.
  const scopes = new Set(approved.map((d) => d.scope));
  const [only] = scopes;
  const scope = scopes.size === 1 && only ? scopeLabel(only).toLowerCase() : "";
  const when = time(at);
  // Decided before this answer counted: which answer won isn't known here, so it isn't claimed.
  if (result?.kind === "handled") {
    return `Already answered: ${batch.items.map((i) => actionOf(i.tool)).join(", ")} · ${when}.`;
  }
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
    const each = approved.map((d) => `${name(d)} (${scopeLabel(d.scope).toLowerCase()})`);
    text = scope
      ? `You approved ${approved.length} of ${decisions.length} (${scope}) · ${when}.`
      : `You approved ${approved.length} of ${decisions.length} · ${when}: ${each.join(", ")}.`;
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

/**
 * Reads the list again; the newest read wins, and a failed read keeps what was shown. True when
 * this read is the one now shown.
 */
export async function refreshApprovals(): Promise<boolean> {
  const mine = ++generation;
  try {
    const batches = await listPending();
    if (mine !== generation) return false;
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
    return true;
  } catch {
    if (mine !== generation) return false;
    // Nothing new to set, so arm the timer again here: a batch this clock calls expired is
    // asked about once more after the same pause, not left on screen until focus or reconnect.
    watchExpiry();
    if (state.status !== "ready") set({ status: "error" });
    return false;
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

/**
 * Sends this tab's answer. The batch counts as decided here before the request goes out: the run
 * it wakes can send `approval.resolved` before the response arrives, and that isn't "elsewhere".
 * The server records a decision before it wakes the run, so a lost response may still have
 * decided it: the list is read again, and a batch it no longer holds is already handled, not an
 * error to retry into `already_decided`.
 */
export async function submitDecision(
  batch: PendingBatch,
  decisions: ApprovalDecision[],
): Promise<DecideResult> {
  decidedHere.add(batch.batchId);
  let result = await decide(batch.batchId, batch.items, decisions);
  if (result.kind === "offline" && (await refreshApprovals())) {
    const listed = state.batches.some((b) => b.batchId === batch.batchId);
    if (!listed) result = batch.expiresAt > Date.now() ? { kind: "handled" } : { kind: "expired" };
  }
  if (result.kind === "done" || result.kind === "handled") decided(batch, decisions, result);
  else decidedHere.delete(batch.batchId);
  return result;
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
