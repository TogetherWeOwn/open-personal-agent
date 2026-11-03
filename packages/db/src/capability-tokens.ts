// SPDX-License-Identifier: Apache-2.0
// Task capability tokens (M4-00a AC1–AC3, m4-spec §5 Wave 0): mint, verify and revoke over one
// strongly consistent store. The audience endpoints that consume these tokens land in M4-00b
// (`model_proxy`) and M4-00c (`artifact_upload`, `tool_gateway`); this module owns the service.
//
// Design pins from the M4-00 crypto review (`m4-00-crypto-review` §9, carried verbatim in the
// spec as AC1a–AC3a): an opaque 32-byte CSPRNG bearer with a single versioned prefix, only the
// SHA-256 stored (the session pattern), one audience per token, `expires_at` as the minimum of
// TTL (≤ 1 h), task deadline and computer lifetime, per-task and per-user epochs, at most one
// live token per (task, audience, computer), revocation through one code path, and no token
// value or hash in any log, event, step state or export. No JWT, PASETO, MAC'd or derived
// formats: a different design needs a fresh crypto review first.
import type { SqlDatabase } from "./system";

/** The three computer audiences. No multi-audience token, no `aud` array (AC1b). */
export const CAPABILITY_AUDIENCES = ["model_proxy", "artifact_upload", "tool_gateway"] as const;
export type CapabilityAudience = (typeof CAPABILITY_AUDIENCES)[number];

const AUDIENCES: ReadonlySet<string> = new Set(CAPABILITY_AUDIENCES);

/** Single versioned prefix, identical across audiences (AC1a). */
export const CAPABILITY_TOKEN_PREFIX = "ocap1_";

/** 32 random bytes as base64url (43 chars) after the prefix: the only canonical form. */
const TOKEN_BODY_PATTERN = "[A-Za-z0-9_-]{43}";
const TOKEN_FORMAT = new RegExp(`^${CAPABILITY_TOKEN_PREFIX}${TOKEN_BODY_PATTERN}$`);

/**
 * Rejected before hashing (AC1a): an attacker must not make the verifier hash unbounded
 * input, and alternate encodings of the "same" token must not verify.
 */
export const MAX_TOKEN_LENGTH = 128;

/**
 * Per-audience TTL defaults (V1.1-OQ3, named by the Security Engineer on TWO-2019, copied here
 * verbatim for AC1c): `expires_at = min(now + TTL(aud), task deadline, computer max-lifetime)`.
 * - `model_proxy`: 30 min — spend is bounded per call by the live budget reserve/settle and
 *   the model allowlist, so this TTL bounds replay of a leaked token; 30 min forces at least
 *   one rotation in a full-length default computer session (max lifetime 3600 s).
 * - `artifact_upload`: 60 min — lowest blast radius (write-only, server-generated keys,
 *   byte/count quotas, tainted serving) and the only audience with long streams whose liveness
 *   is re-checked before the object becomes visible; equalling the default computer max
 *   lifetime means no rotation can revoke a predecessor mid-upload in the default config.
 * - `tool_gateway`: 15 min — the only audience that can cause host-side effects; its calls are
 *   discrete, idempotency-keyed and retryable, so the shortest replay window costs the least.
 *
 * Unchanged pins: the ≤ 1 h ceiling is a hard clamp on any future configuration, TTLs are
 * server-side constants (never caller-supplied, not a user setting), and no refresh path is
 * callable with a capability token — only the control plane mints.
 */
export const AUDIENCE_TTL_MS: Record<CapabilityAudience, number> = {
  model_proxy: 30 * 60_000,
  artifact_upload: 60 * 60_000,
  tool_gateway: 15 * 60_000,
};

/** The D5 ceiling: no capability token outlives one hour, whatever calls it (AC1c). */
export const MAX_TTL_MS = 60 * 60_000;

/** Computers with this profile are never issued a token, for any audience (AC2b). */
export const SUBSCRIPTION_CLI_PROFILE = "subscription_cli";

/** Terminal task statuses: a token bound to one fails verification (AC2a). */
const TASK_TERMINAL_STATUSES = ["succeeded", "failed", "cancelled", "interrupted"] as const;

/** A minted (`provider_id`, `model`) ceiling entry (AC1). */
export interface ModelCeiling {
  providerId: string;
  model: string;
}

/** What a verified token proves: the row's scope, never the token value. */
export interface CapabilityScope {
  tokenId: string;
  userId: string;
  taskId: string;
  computerId: string;
  aud: CapabilityAudience;
  expiresAt: number;
  /**
   * The (`provider_id`, `model`) ceiling snapshotted at mint, for `model_proxy` routes to
   * intersect with the live provider configuration at use (M4-00b owns that intersection:
   * there is no live-config reader on this side yet). Null when the mint named none.
   */
  modelAllowlist: readonly ModelCeiling[] | null;
}

/** Mint parameters. Every bound is server-side: no caller-supplied TTL or expiry (AC1c). */
export interface MintOptions {
  userId: string;
  taskId: string;
  computerId: string;
  /** The computer's profile, from the D1 row — never a caller-supplied flag (AC2b). */
  computerProfile: string;
  aud: string;
  /** Snapshotted at mint for `model_proxy`; verification intersects it with live config. */
  modelAllowlist?: readonly ModelCeiling[];
  /** The task's deadline and the computer's lifetime end, when the caller knows them. */
  taskDeadlineMs?: number;
  computerEndsAtMs?: number;
  now?: number;
}

/** A mint refusal: the caller asked for something the service never issues (AC2b). */
export class MintRefusedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`capability mint refused: ${reason}`);
    this.name = "MintRefusedError";
    this.reason = reason;
  }
}

const encoder = new TextEncoder();

/** base64url without padding, as the session helper stores hashes. */
function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** SHA-256 of the token string as UTF-8: the only form ever stored (AC1a). */
export async function hashCapabilityToken(token: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token))));
}

/** 32 bytes from the platform CSPRNG: `crypto.getRandomValues` on Workers, `crypto.randomBytes` on Node. */
function randomTokenValue(): string {
  return `${CAPABILITY_TOKEN_PREFIX}${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

function auditRow(
  userId: string,
  action: string,
  result: string,
  targetId: string | null,
  detail: string | null,
) {
  return {
    sql: "INSERT INTO audit_log (user_id, action, module, result, target_id, detail) VALUES (?, ?, 'capability-token', ?, ?, ?)",
    params: [userId, action, result, targetId, detail] as const,
  };
}

interface TokenRow {
  id: string;
  user_id: string;
  task_id: string;
  computer_id: string;
  aud: string;
  model_allowlist: string | null;
  task_epoch: number;
  user_epoch: number;
  expires_at: number;
  revoked_at: number | null;
}

/**
 * Mints one token for one audience (AC1). The predecessor for the same (task, audience,
 * computer) is revoked in the same batch, so at most one token per triple is ever live (AC1c).
 * Returns the token value once: the caller delivers it over the provider control channel and
 * never logs it. Throws `MintRefusedError` for `subscription_cli` computers and undeclared
 * audiences (AC2b).
 */
export async function mintCapabilityToken(
  db: SqlDatabase,
  options: MintOptions,
): Promise<{ token: string; id: string; expiresAt: number }> {
  const {
    userId,
    taskId,
    computerId,
    computerProfile,
    aud,
    modelAllowlist,
    taskDeadlineMs,
    computerEndsAtMs,
  } = options;
  const now = options.now ?? Date.now();
  if (!AUDIENCES.has(aud)) throw new MintRefusedError("unknown_audience");
  if (computerProfile === SUBSCRIPTION_CLI_PROFILE) throw new MintRefusedError("subscription_cli");
  if (modelAllowlist !== undefined) {
    const valid =
      Array.isArray(modelAllowlist) &&
      modelAllowlist.length > 0 &&
      modelAllowlist.every(
        (entry) =>
          typeof entry?.providerId === "string" &&
          entry.providerId.length > 0 &&
          typeof entry?.model === "string" &&
          entry.model.length > 0,
      );
    if (!valid) throw new MintRefusedError("invalid_allowlist");
  }
  // TTLs are server-side constants (AC1c): the per-audience default, clamped to the ≤ 1 h
  // ceiling. There is no caller-supplied TTL or expiry.
  const ttl = Math.min(AUDIENCE_TTL_MS[aud as CapabilityAudience], MAX_TTL_MS);
  if (!(ttl > 0)) throw new MintRefusedError("invalid_ttl");
  const expiresAt = Math.min(
    now + ttl,
    taskDeadlineMs ?? Number.POSITIVE_INFINITY,
    computerEndsAtMs ?? Number.POSITIVE_INFINITY,
  );
  if (!(expiresAt > now)) throw new MintRefusedError("already_expired");
  const binding = await db
    .prepare(
      `SELECT tasks.id AS task_id, tasks.token_epoch AS task_epoch,
              users.token_epoch AS user_epoch
       FROM tasks JOIN users ON users.id = tasks.user_id
       WHERE tasks.id = ? AND tasks.user_id = ?`,
    )
    .bind(taskId, userId)
    .first<{ task_id: string; task_epoch: number; user_epoch: number }>();
  if (!binding) throw new MintRefusedError("unknown_task");

  const token = randomTokenValue();
  const tokenHash = await hashCapabilityToken(token);
  const id = crypto.randomUUID();
  const allowlistJson = modelAllowlist === undefined ? null : JSON.stringify([...modelAllowlist]);
  await db.batch([
    // The handover: the predecessor dies as the successor is born (AC1c, T3 invariant).
    db
      .prepare(
        `UPDATE capability_tokens SET revoked_at = ?, revoked_reason = 'rotated'
         WHERE task_id = ? AND aud = ? AND computer_id = ? AND revoked_at IS NULL`,
      )
      .bind(now, taskId, aud, computerId),
    db
      .prepare(
        `INSERT INTO audit_log (user_id, action, module, result, target_id, detail)
         VALUES (?, 'capability_token.rotate', 'capability-token',
                 CASE WHEN changes() > 0 THEN 'ok' ELSE 'skipped' END, ?, ?)`,
      )
      .bind(userId, taskId, JSON.stringify({ aud, computerId, at: now })),
    db
      .prepare(
        `INSERT INTO capability_tokens
           (id, token_hash, user_id, task_id, computer_id, aud, model_allowlist,
            task_epoch, user_epoch, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        tokenHash,
        userId,
        taskId,
        computerId,
        aud,
        allowlistJson,
        binding.task_epoch,
        binding.user_epoch,
        expiresAt,
      ),
    db
      .prepare(
        `INSERT INTO audit_log (user_id, action, module, result, target_id, detail)
         VALUES (?, 'capability_token.mint', 'capability-token', 'ok', ?, ?)`,
      )
      .bind(userId, id, JSON.stringify({ taskId, computerId, aud, expiresAt, at: now })),
  ]);
  return { token, id, expiresAt };
}

/**
 * Parses an `Authorization` header value into the bearer candidate, or `null`. Only the exact
 * `Bearer <token>` shape passes: multiple headers arrive comma-joined and are rejected, as is
 * anything that is not one opaque token (AC1a).
 */
export function parseBearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header.trim());
  if (match?.[1] === undefined) return null;
  return match[1];
}

/** Whether the string is the one canonical form (AC1a): prefix plus 43 base64url chars. */
export function isCanonicalTokenFormat(token: string): boolean {
  return token.length <= MAX_TOKEN_LENGTH && TOKEN_FORMAT.test(token);
}

export interface VerifyOptions {
  token: string;
  /** From the route table, never from the caller: missing means fail closed (AC1b). */
  expectedAud: string | null | undefined;
  now?: number;
}

/**
 * Verifies a bearer for the route's expected audience (AC1b, AC2a). Every failure mode returns
 * `null` so callers answer an indistinguishable 401; reasons stay audit-internal. A revoked
 * token's use-after-revoke attempt is audited against its row id — never the value or hash.
 * Store errors fail closed (R7 M4-2): `null`, with zero side effects.
 */
export async function verifyCapabilityToken(
  db: SqlDatabase,
  options: VerifyOptions,
): Promise<CapabilityScope | null> {
  const { token, expectedAud } = options;
  const now = options.now ?? Date.now();
  try {
    if (typeof token !== "string" || !isCanonicalTokenFormat(token)) return null;
    if (!expectedAud || !AUDIENCES.has(expectedAud)) return null;
    const row = await db
      .prepare(
        `SELECT id, user_id, task_id, computer_id, aud, model_allowlist, task_epoch,
                user_epoch, expires_at, revoked_at
         FROM capability_tokens WHERE token_hash = ?`,
      )
      .bind(await hashCapabilityToken(token))
      .first<TokenRow>();
    if (!row) return null;
    const deny = async (reason: string) => {
      await db
        .prepare(
          `INSERT INTO audit_log (user_id, action, module, result, target_id, detail)
           VALUES (?, 'capability_token.use_denied', 'capability-token', 'denied', ?, ?)`,
        )
        .bind(row.user_id, row.id, JSON.stringify({ reason, at: now }))
        .run();
      return null;
    };
    if (row.revoked_at !== null) return deny("revoked");
    if (!(row.expires_at > now)) return null;
    if (row.aud !== expectedAud) return deny("wrong_audience");
    const epochs = await db
      .prepare(
        `SELECT tasks.token_epoch AS task_epoch, users.token_epoch AS user_epoch,
                tasks.status AS task_status
         FROM tasks JOIN users ON users.id = tasks.user_id
         WHERE tasks.id = ? AND tasks.user_id = ?`,
      )
      .bind(row.task_id, row.user_id)
      .first<{ task_epoch: number; user_epoch: number; task_status: string }>();
    if (!epochs) return null;
    if (epochs.task_epoch !== row.task_epoch || epochs.user_epoch !== row.user_epoch) {
      return deny("epoch");
    }
    if ((TASK_TERMINAL_STATUSES as readonly string[]).includes(epochs.task_status)) {
      return deny("task_ended");
    }
    // The stored ceiling rides along for the consumer's intersection. Mint wrote it as
    // JSON (or null); anything else is a corrupt row, so fail closed. A throw here is
    // caught below and verifies as `null`, like every other store failure.
    const modelAllowlist =
      row.model_allowlist === null
        ? null
        : (JSON.parse(row.model_allowlist) as readonly ModelCeiling[]);
    if (modelAllowlist !== null && !Array.isArray(modelAllowlist)) return null;
    return {
      tokenId: row.id,
      userId: row.user_id,
      taskId: row.task_id,
      computerId: row.computer_id,
      aud: row.aud as CapabilityAudience,
      expiresAt: row.expires_at,
      modelAllowlist,
    };
  } catch {
    // The verification store is unreachable: fail closed, never a cached or assumed pass.
    return null;
  }
}

export interface RevokeOptions {
  userId?: string;
  taskId?: string;
  computerId?: string;
  /** For `model_proxy` tokens naming a removed provider (AC2a, sign-off N2). */
  providerId?: string;
  reason: string;
  auditAction: string;
  /** Bump the task epoch so a missed row still kills the task's tokens. */
  bumpTaskEpoch?: boolean;
  /** Bump the user epoch so a missed row still kills the user's tokens. */
  bumpUserEpoch?: boolean;
  now?: number;
}

/**
 * The one revocation code path (AC2a): every trigger — task cancel/end, computer stop/destroy,
 * sign-out-everywhere, account deletion, profile-condition loss, rotation and
 * provider-credential removal — revokes rows and bumps epochs here, atomically in one batch.
 * Returns the revoked row count. Audit rows name the scope and the count, never a token value.
 */
export async function revokeCapabilityTokens(
  db: SqlDatabase,
  options: RevokeOptions,
): Promise<number> {
  const { userId, taskId, computerId, providerId, reason, auditAction } = options;
  const now = options.now ?? Date.now();
  const filters: string[] = ["revoked_at IS NULL"];
  const params: unknown[] = [];
  if (userId !== undefined) {
    filters.push("user_id = ?");
    params.push(userId);
  }
  if (taskId !== undefined) {
    filters.push("task_id = ?");
    params.push(taskId);
  }
  if (computerId !== undefined) {
    filters.push("computer_id = ?");
    params.push(computerId);
  }
  if (providerId !== undefined) {
    filters.push(
      `aud = 'model_proxy' AND EXISTS (
         SELECT 1 FROM json_each(model_allowlist)
         WHERE json_extract(value, '$.providerId') = ?
       )`,
    );
    params.push(providerId);
  }
  const statements = [
    db
      .prepare(
        `UPDATE capability_tokens SET revoked_at = ?, revoked_reason = ? WHERE ${filters.join(" AND ")}`,
      )
      .bind(now, reason, ...params),
  ];
  // Epochs are read by verification, so the bumps join the same batch as the revocation.
  if (options.bumpTaskEpoch && taskId !== undefined) {
    statements.push(
      db.prepare("UPDATE tasks SET token_epoch = token_epoch + 1 WHERE id = ?").bind(taskId),
    );
  }
  if (options.bumpUserEpoch && userId !== undefined) {
    statements.push(
      db.prepare("UPDATE users SET token_epoch = token_epoch + 1 WHERE id = ?").bind(userId),
    );
  }
  const [update] = await db.batch(statements);
  const revoked = update?.meta.changes ?? 0;
  await db
    .prepare(
      `INSERT INTO audit_log (user_id, action, module, result, target_id, detail)
       VALUES (?, ?, 'capability-token', 'ok', ?, ?)`,
    )
    .bind(
      userId ?? null,
      auditAction,
      (taskId ?? computerId ?? userId ?? null) as string | null,
      JSON.stringify({ reason, revoked, at: now }),
    )
    .run();
  return revoked;
}

/** Task cancel or end: the task's tokens die now, and the epoch bump covers a missed row. */
export async function revokeTaskTokens(
  db: SqlDatabase,
  taskId: string,
  userId: string,
  reason: string,
  now = Date.now(),
): Promise<number> {
  return revokeCapabilityTokens(db, {
    userId,
    taskId,
    reason,
    auditAction: "capability_token.revoke_task",
    bumpTaskEpoch: true,
    now,
  });
}

/** Computer stop or destroy: only that computer's tokens die; the task's others survive. */
export async function revokeComputerTokens(
  db: SqlDatabase,
  computerId: string,
  userId: string,
  reason: string,
  now = Date.now(),
): Promise<number> {
  return revokeCapabilityTokens(db, {
    userId,
    computerId,
    reason,
    auditAction: "capability_token.revoke_computer",
    now,
  });
}

/** Sign-out-everywhere or account deletion: every token of the user dies, epoch and all. */
export async function revokeUserTokens(
  db: SqlDatabase,
  userId: string,
  reason: string,
  now = Date.now(),
): Promise<number> {
  return revokeCapabilityTokens(db, {
    userId,
    reason,
    auditAction: "capability_token.revoke_user",
    bumpUserEpoch: true,
    now,
  });
}

/**
 * Provider-credential removal: the user's `model_proxy` tokens naming that provider die
 * through the same code path (AC2a, sign-off N2 on TWO-1167).
 */
export async function revokeProviderTokens(
  db: SqlDatabase,
  userId: string,
  providerId: string,
  now = Date.now(),
): Promise<number> {
  return revokeCapabilityTokens(db, {
    userId,
    providerId,
    reason: "provider_removed",
    auditAction: "capability_token.revoke_provider",
    now,
  });
}

export const __testing = { TOKEN_FORMAT, auditRow };
