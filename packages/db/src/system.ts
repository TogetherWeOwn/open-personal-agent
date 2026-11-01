// SPDX-License-Identifier: Apache-2.0
// The system-level store (ADR 0010 D3): the deployment's identity tables, read before any user
// scope exists. Setup state, WebAuthn challenges, passkeys, sessions and their audit rows. Every
// multi-row change is one D1 batch, so it commits or rolls back as a whole.
import { scopeFromSession } from "./repository";

/** The parts of a D1 database used here; the Node root supplies its own. */
export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface SqlDatabase {
  prepare(query: string): SqlStatement;
  batch(statements: SqlStatement[]): Promise<{ meta: { changes: number } }[]>;
}

/** A session not used for this long is over, wherever it is checked. */
export const SESSION_IDLE_MS = 30 * 86_400_000;
const LIVE = "revoked_at IS NULL AND expires_at > ? AND last_seen_at > ?";

/** `step_up_*`: a signed-in user's fresh assertion, good for that one action only. */
export type ChallengeKind =
  | "claim"
  | "recovery"
  | "recovery_code"
  | "login"
  | "step_up"
  | "passkey_add"
  | "step_up_vault_reset";

/** A session row to insert. The cookie value never reaches the store, only its hash. */
export interface NewSession {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: number;
}

export interface NewPasskey {
  id: string;
  webauthnUserId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string;
  deviceType: string;
  backedUp: boolean;
}

/** What a claim or recovery writes besides `setup_state`. */
export interface OwnerCredentials {
  userId: string;
  tokenHash: string;
  passkey: NewPasskey;
  recoveryCodes: { id: string; hash: string }[];
  session: NewSession;
  now: number;
}

export function systemStore({ DB: db }: { DB: SqlDatabase }) {
  const insertSession = (s: NewSession) =>
    db
      .prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)")
      .bind(s.id, s.userId, s.tokenHash, s.expiresAt);
  const audit = (
    userId: string | null,
    action: string,
    module: string,
    result: string,
    detail: string | null = null,
  ) =>
    db
      .prepare(
        "INSERT INTO audit_log (user_id, action, module, result, detail) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(userId, action, module, result, detail);

  const insertPasskey = (o: { userId: string; passkey: NewPasskey; name?: string | null }) =>
    db
      .prepare(
        "INSERT INTO passkeys (id, user_id, webauthn_user_id, public_key, counter, transports, device_type, backed_up, name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        o.passkey.id,
        o.userId,
        o.passkey.webauthnUserId,
        o.passkey.publicKey,
        o.passkey.counter,
        o.passkey.transports,
        o.passkey.deviceType,
        o.passkey.backedUp ? 1 : 0,
        o.name ?? null,
      );
  /**
   * A possible-compromise signal (M3-07 AC13): recovery-code redemption, recovery with the setup
   * token, "sign out everywhere" and, with M3-19, passkey removal. Every approval of the user
   * that hasn't run yet, pending or approved but unclaimed, expires, interactive and background,
   * with its ceremony burned, and every task waiting on one is cancelled as on expiry. An
   * approved row keeps its `decided_at`: that is when the user answered, which its receipt
   * shows. Part of the signal's own batch, so the two can't diverge.
   */
  const expireApprovals = (userId: string, now: number, signal: string) => [
    db
      .prepare(
        `UPDATE approvals SET status = 'expired', reason = ?,
           decided_at = CASE WHEN status = 'approved' THEN decided_at ELSE ? END, nonce = NULL,
           step_up_digest = NULL, step_up_expires_at = NULL, step_up_session_id = NULL
         WHERE user_id = ? AND status IN ('pending', 'approved')`,
      )
      .bind(`signal:${signal}`, now, userId),
    // Matched by the signal's reason, not by `decided_at`, which an approved row keeps. A task
    // still waiting can only be waiting on a row this batch expired: an earlier signal's tasks
    // were cancelled with it.
    db
      .prepare(
        `UPDATE tasks SET status = 'cancelled', finished_at = ?, updated_at = ?
         WHERE user_id = ? AND status = 'waiting_for_approval' AND id IN (
           SELECT task_id FROM approvals WHERE user_id = ? AND status = 'expired'
             AND reason = ? AND task_id IS NOT NULL)`,
      )
      .bind(now, now, userId, userId, `signal:${signal}`),
    audit(userId, "approval.expire_all", "approvals", "ok", signal),
  ];

  /** Breaks the single-row CHECK when the statement before it changed nothing: rolls back a batch. */
  const requireChange = () =>
    db.prepare("INSERT INTO setup_state (id) SELECT 0 WHERE changes() = 0");

  /** The rows a claim and a recovery both write, after their `setup_state` change. */
  const credentials = (o: OwnerCredentials, mode: "claim" | "recovery") => [
    insertPasskey(o),
    ...o.recoveryCodes.map((code) =>
      db
        .prepare("INSERT INTO recovery_codes (id, user_id, code_hash) VALUES (?, ?, ?)")
        .bind(code.id, o.userId, code.hash),
    ),
    insertSession(o.session),
    // Primary key: a token that is already recorded fails here and rolls back the batch.
    db.prepare("INSERT INTO used_setup_tokens (token_hash) VALUES (?)").bind(o.tokenHash),
    audit(o.userId, `setup.${mode}`, "setup", "ok"),
  ];

  return {
    audit: (...row: Parameters<typeof audit>) => audit(...row).run(),

    setup: {
      /** Throws if the database is unmigrated or unreachable; the caller fails closed. */
      isClaimed: async () =>
        (await db.prepare("SELECT 1 FROM setup_state WHERE id = 1").first()) !== null,
      /** The claim row, and whether `tokenHash` ever claimed or recovered. `null` if unclaimed. */
      state: (tokenHash: string) =>
        db
          .prepare(
            "SELECT claim_token_hash, claimed_by_user_id, EXISTS (SELECT 1 FROM used_setup_tokens WHERE token_hash = ?1) AS used FROM setup_state WHERE id = 1",
          )
          .bind(tokenHash)
          .first<{
            claim_token_hash: string | null;
            claimed_by_user_id: string | null;
            used: number;
          }>(),
      /** Creates the owner and claims the deployment. Throws if another claim won. */
      claim: async (o: OwnerCredentials) => {
        // Onboarding asks for the owner's name after the claim (M2-15).
        await db.batch([
          db
            .prepare("INSERT INTO users (id, display_name, role) VALUES (?, 'Owner', 'owner')")
            .bind(o.userId),
          // The primary key makes this fail if another claim won, which rolls back the batch.
          db
            .prepare(
              "INSERT INTO setup_state (id, claim_token_hash, claimed_by_user_id, claimed_at) VALUES (1, ?, ?, ?)",
            )
            .bind(o.tokenHash, o.userId, o.now),
          ...credentials(o, "claim"),
        ]);
      },
      /** Replaces the owner's credentials and ends every session. Data stays untouched. */
      recover: async (o: OwnerCredentials) => {
        await db.batch([
          db
            .prepare(
              "UPDATE setup_state SET claim_token_hash = ?, updated_at = ? WHERE id = 1 AND claim_token_hash IS NOT ?",
            )
            .bind(o.tokenHash, o.now, o.tokenHash),
          // If a concurrent recovery already stored this hash, the update changed nothing: break
          // the single-row CHECK so the whole batch rolls back.
          requireChange(),
          db.prepare("DELETE FROM passkeys WHERE user_id = ?").bind(o.userId),
          db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").bind(o.userId),
          db.prepare("UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL").bind(o.now),
          ...expireApprovals(o.userId, o.now, "setup_recovery"),
          ...credentials(o, "recovery"),
        ]);
      },
    },

    /** Redeeming a recovery code (M2-10b). Only the owner has codes. */
    recovery: {
      /**
       * Writes a `denied` row for `address` before its code is checked, unless the address already
       * has `limit` denied rows since `since`. Count and insert are one statement, so parallel
       * requests can't all pass the check. Returns the row ID, or null when the address is limited.
       * Denied rows have no user, so the `(user_id, created_at)` index serves the count.
       */
      attempt: async (address: string, since: number, limit: number) =>
        (
          await db
            .prepare(
              `INSERT INTO audit_log (action, module, result, detail)
               SELECT 'recovery.code', 'auth', 'denied', ?1
               WHERE (SELECT count(*) FROM audit_log WHERE user_id IS NULL AND created_at > ?2
                 AND action = 'recovery.code' AND result = 'denied' AND detail = ?1) < ?3
               RETURNING id`,
            )
            .bind(address, since, limit)
            .first<{ id: number }>()
        )?.id ?? null,
      /** Turns an attempt whose code matched into `allowed`, so it no longer counts. */
      allow: (attemptId: number, userId: string) =>
        db
          .prepare("UPDATE audit_log SET result = 'allowed', user_id = ? WHERE id = ?")
          .bind(userId, attemptId)
          .run(),
      /** The owner's unused codes. */
      unused: async () =>
        (
          await db
            .prepare(
              `SELECT r.id, r.user_id, r.code_hash FROM recovery_codes r
               JOIN setup_state s ON s.id = 1 AND r.user_id = s.claimed_by_user_id
               WHERE r.used_at IS NULL`,
            )
            .all<{ id: string; user_id: string; code_hash: string }>()
        ).results,
      /**
       * Burns the code and replaces every credential the owner had, as a recovery with the setup
       * token does: the new passkey and codes take the place of the old ones, and the new session
       * ends every other one. One batch: throws if the code was already used or replaced, which
       * rolls the whole batch back, so of two parallel redemptions only one wins.
       */
      redeem: async (r: {
        codeId: string;
        passkey: NewPasskey;
        recoveryCodes: { id: string; hash: string }[];
        session: NewSession;
        now: number;
      }) => {
        const userId = r.session.userId;
        await db.batch([
          db
            .prepare(
              "UPDATE recovery_codes SET used_at = ? WHERE id = ? AND user_id = ? AND used_at IS NULL",
            )
            .bind(r.now, r.codeId, userId),
          requireChange(),
          db.prepare("DELETE FROM passkeys WHERE user_id = ?").bind(userId),
          insertPasskey({ userId, passkey: r.passkey }),
          db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").bind(userId),
          ...r.recoveryCodes.map((code) =>
            db
              .prepare("INSERT INTO recovery_codes (id, user_id, code_hash) VALUES (?, ?, ?)")
              .bind(code.id, userId, code.hash),
          ),
          db
            .prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
            .bind(r.now, userId),
          insertSession(r.session),
          ...expireApprovals(userId, r.now, "recovery_code"),
          audit(userId, "recovery.code", "auth", "redeemed"),
        ]);
      },
      /**
       * Replaces the user's recovery codes (M3-19 AC2): the old set stops working and the new
       * one takes its place in one batch, with the audit row. Unlike redeeming a code this is
       * a routine rotation, not a compromise signal, so pending approvals are untouched. The
       * caller shows the new codes once: they never come back from the store.
       */
      regenerate: async (r: {
        userId: string;
        codes: { id: string; hash: string }[];
        now: number;
      }) => {
        await db.batch([
          db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").bind(r.userId),
          ...r.codes.map((code) =>
            db
              .prepare("INSERT INTO recovery_codes (id, user_id, code_hash) VALUES (?, ?, ?)")
              .bind(code.id, r.userId, code.hash),
          ),
          audit(r.userId, "auth.recovery_regenerate", "auth", "ok"),
        ]);
      },
      /** How many of the user's recovery codes are still unused, for the Security page. */
      remaining: async (userId: string) =>
        (
          await db
            .prepare(
              "SELECT count(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL",
            )
            .bind(userId)
            .first<{ n: number }>()
        )?.n ?? 0,
    },

    challenges: {
      /** Stores a challenge and purges expired rows nobody redeemed, in the same batch. */
      put: async (c: {
        idHash: string;
        kind: ChallengeKind;
        challenge: string;
        userId: string | null;
        tokenHash: string | null;
        now: number;
        expiresAt: number;
      }) => {
        await db.batch([
          db.prepare("DELETE FROM webauthn_challenges WHERE expires_at <= ?").bind(c.now),
          db
            .prepare(
              "INSERT INTO webauthn_challenges (id_hash, kind, challenge, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(c.idHash, c.kind, c.challenge, c.userId, c.tokenHash, c.expiresAt),
        ]);
      },
      /** Deletes and returns a live challenge: a second call with the same hash finds nothing. */
      take: (idHash: string, kind: ChallengeKind, now: number) =>
        db
          .prepare(
            "DELETE FROM webauthn_challenges WHERE id_hash = ? AND kind = ? AND expires_at > ? RETURNING challenge, user_id, token_hash",
          )
          .bind(idHash, kind, now)
          .first<{ challenge: string; user_id: string | null; token_hash: string | null }>(),
    },

    passkeys: {
      get: (id: string) =>
        db
          .prepare("SELECT id, user_id, public_key, counter, transports FROM passkeys WHERE id = ?")
          .bind(id)
          .first<{
            id: string;
            user_id: string;
            public_key: ArrayBuffer | number[];
            counter: number;
            transports: string | null;
          }>(),
      /** The user's passkeys, for a step-up's `allowCredentials`. */
      ofUser: async (userId: string) =>
        (
          await db
            .prepare("SELECT id, transports FROM passkeys WHERE user_id = ?")
            .bind(userId)
            .all<{ id: string; transports: string | null }>()
        ).results,
      /** Records a step-up: the passkey's counter and the audit row, together. */
      steppedUp: async (s: {
        passkeyId: string;
        userId: string;
        counter: number;
        action: string;
        now: number;
      }) => {
        await db.batch([
          db
            .prepare(
              "UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ? AND user_id = ?",
            )
            .bind(s.counter, s.now, s.passkeyId, s.userId),
          audit(s.userId, "auth.step_up", "auth", "ok", s.action),
        ]);
      },
      /**
       * The user's passkeys for Settings › Privacy & security (M3-19 AC2): newest first, with
       * the names and dates the page shows. Secrets never leave the store: no public keys here.
       */
      list: async (userId: string) =>
        (
          await db
            .prepare(
              `SELECT id, name, created_at, last_used_at FROM passkeys
               WHERE user_id = ? ORDER BY created_at DESC`,
            )
            .bind(userId)
            .all<{
              id: string;
              name: string | null;
              created_at: number;
              last_used_at: number | null;
            }>()
        ).results,
      /**
       * Adds a passkey the user just registered on this signed-in session. Throws on a
       * duplicate credential id, so registering the same authenticator twice is a 409.
       */
      add: async (a: { userId: string; passkey: NewPasskey; name: string; now: number }) => {
        await db.batch([
          insertPasskey({ userId: a.userId, passkey: a.passkey, name: a.name }),
          audit(a.userId, "auth.passkey_add", "auth", "ok", a.passkey.id),
        ]);
      },
      /** Renames one of the user's own passkeys. `false` when it is missing or another's. */
      rename: async (r: { id: string; userId: string; name: string; now: number }) => {
        const [update] = await db.batch([
          db
            .prepare("UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?")
            .bind(r.name, r.id, r.userId),
          db
            .prepare(
              "INSERT INTO audit_log (user_id, action, module, result, detail) VALUES (?, 'auth.passkey_rename', 'auth', CASE WHEN changes() > 0 THEN 'ok' ELSE 'denied' END, ?)",
            )
            .bind(r.userId, r.id),
        ]);
        return (update?.meta.changes ?? 0) > 0;
      },
      /**
       * Removes one of the user's own passkeys (M3-19 AC2, M3-07 AC13): the row goes, every
       * pending approval expires with the `passkey_removal` signal, and the audit row lands in
       * the same batch, so the two can't diverge. `false` when it is missing or another's.
       */
      remove: async (r: { id: string; userId: string; now: number }) => {
        try {
          await db.batch([
            db.prepare("DELETE FROM passkeys WHERE id = ? AND user_id = ?").bind(r.id, r.userId),
            // A concurrent removal already took it: break the single-row CHECK so the batch
            // rolls back instead of expiring approvals for a passkey that isn't going anywhere.
            requireChange(),
            ...expireApprovals(r.userId, r.now, "passkey_removal"),
            audit(r.userId, "auth.passkey_remove", "auth", "ok", r.id),
          ]);
          return true;
        } catch {
          return false;
        }
      },
    },

    approvals: {
      /**
       * Expires every pending approval of the user on a compromise signal (AC13), on its own:
       * the signals above already include it in their batches. M3-19's passkey removal puts
       * `expireAllStatements` in its batch instead.
       */
      expireAll: async (userId: string, now: number, signal: string) => {
        await db.batch(expireApprovals(userId, now, signal));
      },
      expireAllStatements: expireApprovals,
      /**
       * The reconciler's expiry (M3-07 AC1, M3-18 AC2): every user's undecided approvals past
       * `expires_at` move to `expired`, each with its audit row, and every task waiting on one
       * is cancelled as on a compromise signal (AC13). D1 only, so no Durable Object wakes.
       * The audit rows and the cancel are written first, from the same ordered selection the
       * update then expires, all in one transaction: a tick that finds nothing due writes
       * nothing. Up to `limit` approvals a tick; returns how many expired.
       */
      expireDue: async (now: number, limit = 500) => {
        const due = `rowid IN (SELECT rowid FROM approvals
          WHERE status = 'pending' AND expires_at <= ? ORDER BY rowid LIMIT ?)`;
        const results = await db.batch([
          db
            .prepare(
              `INSERT INTO audit_log (user_id, action, module, target_id, result, detail)
               SELECT user_id, 'approval.expire', 'approvals', batch_id || '/' || approval_id,
                 'denied', '{"reason":"expired"}'
               FROM approvals WHERE ${due}`,
            )
            .bind(now, limit),
          db
            .prepare(
              `UPDATE tasks SET status = 'cancelled', finished_at = ?, updated_at = ?
               WHERE status = 'waiting_for_approval' AND id IN (
                 SELECT task_id FROM approvals WHERE ${due} AND task_id IS NOT NULL
                   AND user_id = tasks.user_id)`,
            )
            .bind(now, now, now, limit),
          db
            .prepare(
              `UPDATE approvals SET status = 'expired', reason = 'expired', decided_at = ?,
                 nonce = NULL, step_up_digest = NULL, step_up_expires_at = NULL,
                 step_up_session_id = NULL
               WHERE ${due}`,
            )
            .bind(now, now, limit),
        ]);
        return results[2]?.meta.changes ?? 0;
      },
    },

    sessions: {
      /**
       * A live session: not revoked, not past its absolute expiry, seen after `idleSince`. Its
       * `scope` is the only `UserScope` the app gets: one exists only for a live session row.
       */
      find: async (tokenHash: string, now: number, idleSince: number) => {
        const row = await db
          .prepare(
            `SELECT id, user_id, last_seen_at, step_up_at FROM sessions
             WHERE token_hash = ? AND ${LIVE}`,
          )
          .bind(tokenHash, now, idleSince)
          .first<{
            id: string;
            user_id: string;
            last_seen_at: number;
            step_up_at: number | null;
          }>();
        return row && { ...row, scope: scopeFromSession({ userId: row.user_id }) };
      },
      /** Whether the user's session `id` is still live by `find`'s rules: a socket rechecks it. */
      isLive: async (id: string, userId: string, now: number) =>
        (await db
          .prepare(`SELECT 1 FROM sessions WHERE id = ? AND user_id = ? AND ${LIVE}`)
          .bind(id, userId, now, now - SESSION_IDLE_MS)
          .first()) !== null,
      touch: async (id: string, now: number) => {
        await db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").bind(now, id).run();
      },
      /** Records the login: the passkey's counter, the new session, the old one revoked. */
      login: async (l: {
        passkeyId: string;
        counter: number;
        previousTokenHash: string;
        session: NewSession;
        now: number;
      }) => {
        await db.batch([
          db
            .prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?")
            .bind(l.counter, l.now, l.passkeyId),
          db
            .prepare(
              "UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
            )
            .bind(l.now, l.previousTokenHash),
          insertSession(l.session),
          audit(l.session.userId, "auth.login", "auth", "ok"),
        ]);
      },
      /** Records a passkey step-up in the user's session `id`: the counter, the time, the audit row. */
      stepUp: async (s: {
        id: string;
        userId: string;
        passkeyId: string;
        counter: number;
        now: number;
      }) => {
        await db.batch([
          db
            .prepare(
              "UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ? AND user_id = ?",
            )
            .bind(s.counter, s.now, s.passkeyId, s.userId),
          db
            .prepare("UPDATE sessions SET step_up_at = ? WHERE id = ? AND user_id = ?")
            .bind(s.now, s.id, s.userId),
          audit(s.userId, "auth.step_up", "auth", "ok"),
        ]);
      },
      /** The user's live sessions, newest first. */
      list: async (userId: string, now: number, idleSince: number) =>
        (
          await db
            .prepare(
              `SELECT id, created_at, last_seen_at, expires_at FROM sessions
               WHERE user_id = ? AND ${LIVE} ORDER BY created_at DESC`,
            )
            .bind(userId, now, idleSince)
            .all<{ id: string; created_at: number; last_seen_at: number; expires_at: number }>()
        ).results,
      logout: async (id: string, userId: string, now: number) => {
        await db.batch([
          db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?").bind(now, id),
          audit(userId, "auth.logout", "auth", "ok"),
        ]);
      },
      /** Revokes one of the user's own sessions; `false` if it is missing or someone else's. */
      revoke: async (id: string, userId: string, now: number) => {
        // One transaction: if the audit fails, the revocation rolls back and the client can retry.
        // `changes()` is the update's row count, so the audit records what the update did.
        const [update] = await db.batch([
          db
            .prepare(
              "UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
            )
            .bind(now, id, userId),
          db
            .prepare(
              "INSERT INTO audit_log (user_id, action, module, result) VALUES (?, 'auth.session_revoke', 'auth', CASE WHEN changes() > 0 THEN 'ok' ELSE 'denied' END)",
            )
            .bind(userId),
        ]);
        return (update?.meta.changes ?? 0) > 0;
      },
      /** Sign out everywhere: every session of this user. */
      revokeAll: async (userId: string, now: number) => {
        await db.batch([
          db
            .prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
            .bind(now, userId),
          ...expireApprovals(userId, now, "sign_out_everywhere"),
          audit(userId, "auth.sign_out_everywhere", "auth", "ok"),
        ]);
      },
    },
  };
}

export type SystemStore = ReturnType<typeof systemStore>;
