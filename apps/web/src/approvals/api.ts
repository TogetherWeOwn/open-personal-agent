// SPDX-License-Identifier: Apache-2.0
// The approvals API (M3-07 AC10, AC11): decisions go over `POST /api/approvals/:batchId`, never the
// socket. A batch approving an irreversible item needs a passkey over a challenge the server binds
// to the exact decisions, so the options are fetched at submit time and never reused.
import type { ApprovalDecision, ApprovalItem } from "@opa/core";
import {
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
} from "@simplewebauthn/browser";
import { needsPasskey } from "./copy";

/** A batch waiting for the user, as `GET /api/approvals` lists it. */
export type PendingBatch = {
  batchId: string;
  conversationId: string;
  conversationTitle: string | null;
  taskId: string | null;
  createdAt: number;
  expiresAt: number;
  items: ApprovalItem[];
};

export async function listPending(): Promise<PendingBatch[]> {
  const res = await fetch("/api/approvals?status=pending", { cache: "no-store" });
  if (!res.ok) throw new Error(`approvals: ${res.status}`);
  return ((await res.json()) as { batches: PendingBatch[] }).batches;
}

/**
 * How a submit ended. `done` carries what the run did with it: `waiting` and `queued` mean the
 * call runs later, which the receipt says, so it never reads as finished.
 */
export type DecideResult =
  | { kind: "done"; status: "resumed" | "waiting" | "queued" | "gone" }
  | { kind: "not_confirmed" } // the passkey prompt was dismissed or failed: nothing was done
  | { kind: "changed" } // decided elsewhere, or the request changed: reload and look again
  | { kind: "expired" }
  | { kind: "cancelled" } // the task was stopped, or the batch is gone
  | { kind: "offline" }; // it never reached the server, or the server failed

const STALE = new Set(["stale", "already_decided"]);
const STEP_UP = new Set([
  "assertion_required",
  "no_challenge",
  "decisions_changed",
  "not_verified",
]);

async function postJson(path: string, body: unknown) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { res, json, error: typeof json.error === "string" ? json.error : "" };
}

/** A fresh assertion for exactly these decisions, or `null` if the user didn't confirm. */
async function assert(batchId: string, decisions: ApprovalDecision[]) {
  const path = `/api/approvals/${encodeURIComponent(batchId)}/options`;
  const { res, json } = await postJson(path, { decisions });
  if (!res.ok) return { refused: { status: res.status, error: String(json.error) } };
  const optionsJSON = json.options as PublicKeyCredentialRequestOptionsJSON;
  try {
    return { credential: await startAuthentication({ optionsJSON }) };
  } catch {
    // Dismissed, timed out or refused: "Not confirmed. Nothing was done." either way.
    return { credential: null };
  }
}

function outcome(status: number, error: string): DecideResult {
  if (status === 404 || error === "task_cancelled") return { kind: "cancelled" };
  if (error === "expired") return { kind: "expired" };
  if (STALE.has(error) || status === 400) return { kind: "changed" };
  if (STEP_UP.has(error)) return { kind: "not_confirmed" };
  return { kind: "offline" };
}

/**
 * Decides every pending item of the batch in one request. With a step-up, a refused assertion
 * (a lapsed or replaced challenge) gets one fresh prompt; a second refusal is reported. A batch
 * that approves nothing irreversible goes without a passkey, and the server's own
 * `assertion_required` brings the prompt in anyway.
 */
export async function decide(
  batchId: string,
  items: readonly ApprovalItem[],
  decisions: ApprovalDecision[],
): Promise<DecideResult> {
  const byId = new Map(items.map((i) => [i.approvalId, i]));
  let stepUp = decisions.some(
    (d) => d.decision === "approve" && needsPasskey(byId.get(d.approvalId) as ApprovalItem),
  );
  try {
    for (let attempt = 0; ; attempt++) {
      let credential: unknown;
      if (stepUp) {
        const got = await assert(batchId, decisions);
        if (got.refused) return outcome(got.refused.status, got.refused.error);
        if (!got.credential) return { kind: "not_confirmed" };
        credential = got.credential;
      }
      const path = `/api/approvals/${encodeURIComponent(batchId)}`;
      const { res, json, error } = await postJson(path, {
        decisions,
        ...(credential ? { credential } : {}),
      });
      if (res.ok) return { kind: "done", status: json.status as "resumed" };
      if (res.status === 403 && STEP_UP.has(error) && attempt === 0) {
        stepUp = true;
        continue;
      }
      return outcome(res.status, error);
    }
  } catch {
    return { kind: "offline" };
  }
}
