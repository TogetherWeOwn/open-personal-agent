// SPDX-License-Identifier: Apache-2.0
// Approve, deny and step-up (M3-07 AC3, AC4, AC10, AC11): `POST /api/approvals/:batchId`, behind
// the session guard and the exact-Origin check like every write, and never a WebSocket frame. The
// route loads the batch from D1, checks it is the session user's and, for a task, that the task
// isn't cancelled, before it records anything or wakes the run that waits on it.
//
// A batch with an irreversible item needs a passkey assertion over a challenge derived from the
// exact decision set and a fresh server nonce (crypto review W1-W5): `POST .../options` issues
// it and the decision POST consumes it. Nothing else counts: not the account step-up window,
// not a fresh login, not an assertion for another batch or another ceremony kind (D1). And an
// approval assertion never opens the account window either (D2).
import { type ApprovalRow, createRepository, isBatchId } from "@opa/db/repository";
import { systemStore } from "@opa/db/system";
import {
  type ApprovalScope,
  type BatchDecisionItem,
  batchDigest,
  fromBase64Url,
  newNonce,
  type StandingGrant,
  stepUpChallenge,
  type TaintState,
  TRUSTED,
  toBase64Url,
} from "@opa/policy";
import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  generateAuthenticationOptions,
} from "@simplewebauthn/server";
import { type Context, Hono } from "hono";
import { CHALLENGE_TTL_MS } from "./auth";
import type { AppEnv } from "./env";
import { verifyAssertion } from "./session";

type Ctx = Context<AppEnv>;

/** What the run waiting on a decided batch did with it. */
export type ForwardResult = "resumed" | "waiting" | "queued" | "gone";

/**
 * Wakes whatever waits on a decided batch: the user's assistant for a turn, the task's Workflow
 * for a task. It passes the batch ID only; the run re-reads the rows (AC10, M3-12 AC3). Only the
 * Worker has either, so it supplies this.
 */
export type ApprovalForward = (c: Ctx, batch: readonly ApprovalRow[]) => Promise<ForwardResult>;

type Decision = { approvalId: string; decision: "approve" | "deny"; scope: ApprovalScope };

const SCOPES: readonly ApprovalScope[] = ["once", "task", "hour", "destination"];
const HOUR_MS = 3_600_000;
const MAX_DECISIONS = 100;

/** The submitted decisions, or `null` if the body isn't a well-formed list of them. */
function readDecisions(body: unknown): Decision[] | null {
  const list = (body as { decisions?: unknown } | null)?.decisions;
  if (!Array.isArray(list) || list.length > MAX_DECISIONS) return null;
  const out: Decision[] = [];
  for (const d of list as Record<string, unknown>[]) {
    const { approvalId, decision, scope = "once" } = d ?? {};
    if (typeof approvalId !== "string" || (decision !== "approve" && decision !== "deny")) {
      return null;
    }
    if (!SCOPES.includes(scope as ApprovalScope)) return null;
    out.push({
      approvalId,
      decision,
      scope: decision === "deny" ? "once" : (scope as ApprovalScope),
    });
  }
  return out;
}

/**
 * The decisions in the batch's stored order, each with its row, or why they can't stand: every
 * pending item decided exactly once, nothing else, and only with a scope its card offered
 * (AC3: irreversible items and tainted egress are "once" only).
 */
function match(
  rows: readonly ApprovalRow[],
  decisions: readonly Decision[],
): { items: { row: ApprovalRow; d: Decision }[] } | { error: string } {
  const pending = rows.filter((r) => r.status === "pending");
  if (new Set(decisions.map((d) => d.approvalId)).size !== decisions.length) {
    return { error: "duplicate_decision" };
  }
  if (decisions.length !== pending.length) return { error: "incomplete" };
  const items = [];
  for (const row of pending) {
    const d = decisions.find((x) => x.approvalId === row.approvalId);
    if (!d) return { error: "incomplete" };
    const offered = JSON.parse(row.scopes) as ApprovalScope[];
    if (d.decision === "approve" && !offered.includes(d.scope)) return { error: "invalid_scope" };
    items.push({ row, d });
  }
  return { items };
}

/** The digest a step-up signs for these decisions (W5): ids, hashes, decisions, scopes, in order. */
const digestOf = (c: Ctx, batchId: string, items: { row: ApprovalRow; d: Decision }[]) =>
  batchDigest({
    batchId,
    userId: c.var.session.userId,
    decisions: items.map(
      ({ row, d }): BatchDecisionItem => ({
        approvalId: row.approvalId,
        bindingHash: row.bindingHash,
        decision: d.decision,
        scope: d.scope,
      }),
    ),
  });

/** A step-up is needed when any approved item is irreversible (AC4); denying needs none. */
const needsStepUp = (items: { row: ApprovalRow; d: Decision }[]) =>
  items.some(({ row, d }) => row.stepUp && d.decision === "approve");

/** The batch, if it is the user's and its task (if any) can still take a decision (AC10). */
async function load(c: Ctx, batchId: string) {
  if (!isBatchId(batchId)) return { error: "not_found", status: 404 as const };
  const user = createRepository(c.env).forUser(c.var.session.scope);
  const rows = await user.approvals.batch(batchId);
  if (!rows.length) return { error: "not_found", status: 404 as const };
  const taskId = rows[0]?.taskId;
  if (taskId) {
    const task = await user.tasks.get(taskId);
    if (!task || task.status === "cancelled" || task.finishedAt !== null) {
      return { error: "task_cancelled", status: 409 as const };
    }
  }
  return { user, rows };
}

/** A standing grant from an approval's scope (AC3), or `null` for "once". */
function grantFor(row: ApprovalRow, scope: ApprovalScope, now: number): StandingGrant | null {
  switch (scope) {
    case "hour":
      return { tool: row.tool, scope: "hour", expiresAt: now + HOUR_MS };
    case "destination":
      return row.target ? { tool: row.tool, scope: "destination", destination: row.target } : null;
    case "task":
      return row.taskId ? { tool: row.tool, scope: "task", taskId: row.taskId } : null;
    default:
      return null;
  }
}

export function approvalRoutes(forward: ApprovalForward) {
  const routes = new Hono<AppEnv>();
  routes.use(async (c, next) => {
    c.header("Cache-Control", "no-store");
    return next();
  });

  /**
   * Step-up, step 1 (W1-W3): a challenge bound to the exact decision set in the body, for one of
   * the user's own passkeys with user verification. The nonce is minted here, replaces any
   * earlier ceremony on the batch, and lives five minutes at most (never past the approvals'
   * own expiry). Only the derived challenge leaves the server.
   */
  routes.post("/:batchId/options", async (c) => {
    const batchId = c.req.param("batchId");
    const loaded = await load(c, batchId);
    if ("error" in loaded) return c.json({ error: loaded.error }, loaded.status);
    const decisions = readDecisions(await c.req.json().catch(() => null));
    if (!decisions) return c.json({ error: "invalid_decisions" }, 400);
    const matched = match(loaded.rows, decisions);
    if ("error" in matched) return c.json({ error: matched.error }, 400);
    if (!needsStepUp(matched.items)) return c.json({ error: "step_up_not_needed" }, 400);
    const now = Date.now();
    const digest = await digestOf(c, batchId, matched.items);
    const nonce = newNonce();
    const pending = matched.items.map(({ row }) => row);
    const expiresAt = Math.min(now + CHALLENGE_TTL_MS, ...pending.map((r) => r.expiresAt));
    const { session } = c.var;
    const begun = await loaded.user.approvals.beginStepUp(
      batchId,
      pending.length,
      { nonce: toBase64Url(nonce), digest: toBase64Url(digest), expiresAt, sessionId: session.id },
      now,
    );
    if (!begun) return c.json({ error: "stale" }, 409);
    const passkeys = await systemStore(c.env).passkeys.ofUser(session.userId);
    const options = await generateAuthenticationOptions({
      rpID: new URL(c.req.url).hostname,
      userVerification: "required",
      // Bytes, not a string: a string challenge would be UTF-8 encoded and sign other bytes.
      challenge: (await stepUpChallenge(digest, nonce)) as Uint8Array<ArrayBuffer>,
      allowCredentials: passkeys.map((p) => ({
        id: p.id,
        transports: (p.transports?.split(",").filter(Boolean) ?? []) as AuthenticatorTransport[],
      })),
    });
    return c.json({ options });
  });

  /**
   * Approve or deny every pending item of the batch at once, with the assertion when a step-up
   * is needed. The order is the review's: load the rows, check the user and the task, recompute
   * the challenge from the rows and the submitted decisions, verify the assertion, decide
   * atomically with the audit rows, then wake the run. A batch already decided is only woken
   * again (a retry after a failure to resume).
   */
  routes.post("/:batchId", async (c) => {
    const batchId = c.req.param("batchId");
    const loaded = await load(c, batchId);
    if ("error" in loaded) return c.json({ error: loaded.error }, loaded.status);
    const { user, rows } = loaded;
    const body = await c.req.json().catch(() => null);
    const decisions = readDecisions(body);
    if (!decisions) return c.json({ error: "invalid_decisions" }, 400);
    const now = Date.now();
    const live = rows.filter((r) => r.status === "pending" && r.expiresAt > now);
    if (!live.length) {
      if (!decisions.length) return c.json({ status: await forward(c, rows) });
      const expired = rows.some((r) => r.status === "pending" || r.status === "expired");
      return c.json({ error: expired ? "expired" : "already_decided" }, 409);
    }
    const matched = match(rows, decisions);
    if ("error" in matched) return c.json({ error: matched.error }, 400);
    if (matched.items.some(({ row }) => row.expiresAt <= now)) {
      return c.json({ error: "expired" }, 409);
    }

    if (needsStepUp(matched.items)) {
      const refused = await stepUpProblem(c, batchId, matched.items, body?.credential, now);
      if (refused) {
        await user.approvals.audit(batchId, "approval.step_up", "denied", { reason: refused });
        return c.json({ error: refused }, 403);
      }
      await user.approvals.audit(batchId, "approval.step_up", "ok");
    }

    try {
      await user.approvals.decide(
        batchId,
        matched.items.map(({ row, d }) => ({
          ...d,
          detail: { tool: row.tool, risk: row.risk, rule: row.rule, stepUp: row.stepUp },
        })),
        now,
      );
    } catch {
      return c.json({ error: "stale" }, 409); // decided, expired or cancelled meanwhile
    }
    // Standing grants come only from an untainted context (M3-02 AC2); the card offered only
    // "once" otherwise, and the store refuses a tainted one again.
    for (const { row, d } of matched.items) {
      const grant = d.decision === "approve" ? grantFor(row, d.scope, now) : null;
      const taint: TaintState = row.taint ? { taint: "untrusted", sources: [] } : TRUSTED;
      if (grant) await user.policy.grant(grant, taint).catch(() => {});
    }
    return c.json({ status: await forward(c, rows) });
  });

  return routes;
}

/**
 * Why the request's assertion doesn't authorise these decisions, or `null` if it does (AC4, W3,
 * W4, D1, D2). The ceremony is taken, and so burned, before anything is checked: a failed or
 * replayed verify leaves nothing to retry with. The challenge is recomputed from the stored
 * nonce and the submitted decisions; nothing the client sends stands in for it. A verified
 * assertion moves the passkey's counter and nothing else: it never stamps the session's
 * account step-up (D2).
 */
async function stepUpProblem(
  c: Ctx,
  batchId: string,
  items: { row: ApprovalRow; d: Decision }[],
  credential: unknown,
  now: number,
): Promise<string | null> {
  const { session } = c.var;
  const user = createRepository(c.env).forUser(session.scope);
  const ceremony = await user.approvals.takeStepUp(batchId);
  if (!credential) return "assertion_required";
  if (!ceremony || ceremony.expiresAt <= now) return "no_challenge";
  if (ceremony.sessionId !== session.id) return "no_challenge";
  const digest = await digestOf(c, batchId, items);
  // The decisions differ from those the ceremony was issued for: a flipped decision or scope.
  if (toBase64Url(digest) !== ceremony.digest) return "decisions_changed";
  const challenge = toBase64Url(await stepUpChallenge(digest, fromBase64Url(ceremony.nonce)));
  const response = credential as AuthenticationResponseJSON;
  const store = systemStore(c.env);
  const passkey = await store.passkeys.get(typeof response?.id === "string" ? response.id : "");
  if (!passkey || passkey.user_id !== session.userId) return "not_verified";
  const counter = await verifyAssertion(c, passkey, response, challenge);
  if (counter === null) return "not_verified";
  await store.passkeys.steppedUp({
    passkeyId: passkey.id,
    userId: session.userId,
    counter,
    action: `approval:${batchId}`,
    now,
  });
  return null;
}
