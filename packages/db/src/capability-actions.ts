// SPDX-License-Identifier: Apache-2.0
import type { CapabilityScope } from "./capability-tokens";
import type { SqlDatabase } from "./system";

/** Used in the publication statement itself: a pre-stream verification is not a commit check. */
export const LIVE_CAPABILITY = `FROM capability_tokens ct
  JOIN tasks ON tasks.id = ct.task_id AND tasks.user_id = ct.user_id
  JOIN users ON users.id = ct.user_id
  JOIN computers ON computers.id = ct.computer_id AND computers.task_id = tasks.id AND computers.user_id = ct.user_id
  WHERE ct.id = ? AND ct.user_id = ? AND ct.task_id = ? AND ct.computer_id = ? AND ct.aud = ?
    AND ct.revoked_at IS NULL AND ct.expires_at > ?
    AND ct.task_epoch = tasks.token_epoch AND ct.user_epoch = users.token_epoch
    AND tasks.status NOT IN ('succeeded', 'failed', 'cancelled', 'interrupted')
    AND computers.state = 'ready' AND computers.ended_at IS NULL
    AND computers.profile <> 'subscription_cli' AND computers.lifetime_deadline > ?`;

export const capabilityParams = (scope: CapabilityScope, now = Date.now()) => [
  scope.tokenId,
  scope.userId,
  scope.taskId,
  scope.computerId,
  scope.aud,
  now,
  now,
];

/** Four files' worth per token, sixteen per task; the attachment cap governs each upload. */
export function uploadBudget(db: SqlDatabase, scope: CapabilityScope, maxBytes: number) {
  return {
    reserve: async (id: string) =>
      (
        await db
          .prepare(`INSERT INTO capability_uploads (id, user_id, task_id, token_id)
      SELECT ?, ct.user_id, ct.task_id, ct.id ${LIVE_CAPABILITY}
      AND (SELECT count(*) FROM capability_uploads WHERE token_id = ct.id) < 16
      AND (SELECT count(*) FROM capability_uploads WHERE task_id = ct.task_id) < 64`)
          .bind(id, ...capabilityParams(scope))
          .run()
      ).meta.changes === 1,
    charge: async (id: string, bytes: number) => {
      if (!Number.isSafeInteger(bytes) || bytes < 0) return false;
      return (
        (
          await db
            .prepare(`UPDATE capability_uploads SET bytes = bytes + ?
        WHERE id = ? AND token_id = ? AND task_id = ? AND user_id = ? AND bytes + ? <= ?
        AND (SELECT coalesce(sum(bytes), 0) FROM capability_uploads WHERE token_id = ?) + ? <= ?
        AND (SELECT coalesce(sum(bytes), 0) FROM capability_uploads WHERE task_id = ?) + ? <= ?
        AND EXISTS (SELECT 1 ${LIVE_CAPABILITY})`)
            .bind(
              bytes,
              id,
              scope.tokenId,
              scope.taskId,
              scope.userId,
              bytes,
              maxBytes,
              scope.tokenId,
              bytes,
              maxBytes * 4,
              scope.taskId,
              bytes,
              maxBytes * 16,
              ...capabilityParams(scope),
            )
            .run()
        ).meta.changes === 1
      );
    },
  };
}

export interface GatewayCall {
  id: string;
  tokenId: string;
  requestHash: string;
  status: "new" | "preparing" | "pending" | "executing" | "completed";
  response: string | null;
  statusCode: number | null;
}

/** Serialized conditional writes, not in-memory locks: Worker and Node share these claims. */
export function gatewayCalls(db: SqlDatabase, scope: CapabilityScope) {
  const load = (id: string) =>
    db
      .prepare(`SELECT id, token_id AS tokenId, request_hash AS requestHash,
    status, response, status_code AS statusCode FROM capability_calls
    WHERE id = ? AND user_id = ? AND task_id = ? AND computer_id = ?`)
      .bind(id, scope.userId, scope.taskId, scope.computerId)
      .first<GatewayCall>();
  return {
    load,
    begin: async (clientKey: string, requestHash: string) => {
      const id = crypto.randomUUID();
      const now = Date.now();
      await db
        .prepare(`INSERT INTO capability_calls
        (id, user_id, task_id, token_id, computer_id, client_key, request_hash, master_id, status, created_at)
        SELECT ?, ct.user_id, ct.task_id, ct.id, ct.computer_id, ?, ?,
          coalesce((SELECT id FROM capability_calls WHERE task_id = ct.task_id AND computer_id = ct.computer_id
            AND request_hash = ? AND master_id = id AND status IN ('new', 'preparing', 'pending') LIMIT 1), ?), 'new', ?
        ${LIVE_CAPABILITY}
        AND (SELECT count(*) FROM capability_calls WHERE token_id = ct.id) < 60
        AND (SELECT count(*) FROM capability_calls WHERE token_id = ct.id AND created_at > ?) < 10
        AND NOT EXISTS (SELECT 1 FROM capability_calls WHERE task_id = ct.task_id AND client_key = ?)
        ON CONFLICT(task_id, client_key) DO NOTHING`)
        .bind(
          id,
          clientKey,
          requestHash,
          requestHash,
          id,
          now,
          ...capabilityParams(scope, now),
          now - 60_000,
          clientKey,
        )
        .run();
      const key = await db
        .prepare(`SELECT master_id AS masterId, request_hash AS requestHash FROM capability_calls
        WHERE task_id = ? AND user_id = ? AND computer_id = ? AND client_key = ?`)
        .bind(scope.taskId, scope.userId, scope.computerId, clientKey)
        .first<{ masterId: string; requestHash: string }>();
      if (!key) return { kind: "quota" as const };
      if (key.requestHash !== requestHash) return { kind: "conflict" as const };
      const call = await load(key.masterId);
      return call ? { kind: "call" as const, call } : { kind: "conflict" as const };
    },
    transition: async (call: GatewayCall, from: GatewayCall["status"], to: GatewayCall["status"]) =>
      (
        await db
          .prepare(`UPDATE capability_calls SET status = ? WHERE id = ? AND user_id = ? AND task_id = ?
        AND computer_id = ? AND status = ? AND master_id = id
        AND EXISTS (SELECT 1 ${LIVE_CAPABILITY}) AND EXISTS (SELECT 1 ${LIVE_CAPABILITY})`)
          .bind(
            to,
            call.id,
            scope.userId,
            scope.taskId,
            scope.computerId,
            from,
            ...capabilityParams(scope),
            ...capabilityParams({ ...scope, tokenId: call.tokenId }),
          )
          .run()
      ).meta.changes === 1,
    finish: async (call: GatewayCall, statusCode: number, response: unknown) => {
      await db
        .prepare(`UPDATE capability_calls SET status = 'completed', status_code = ?, response = ?
        WHERE id = ? AND user_id = ? AND task_id = ? AND computer_id = ? AND status = 'executing' AND master_id = id`)
        .bind(
          statusCode,
          JSON.stringify(response),
          call.id,
          scope.userId,
          scope.taskId,
          scope.computerId,
        )
        .run();
    },
  };
}

export async function capabilityBinding(db: SqlDatabase, scope: CapabilityScope) {
  return db
    .prepare(`SELECT tasks.conversation_id AS conversationId ${LIVE_CAPABILITY}`)
    .bind(...capabilityParams(scope))
    .first<{ conversationId: string }>();
}
