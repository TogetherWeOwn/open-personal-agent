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

export type ChallengeKind = "claim" | "recovery" | "login";

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
  const audit = (userId: string | null, action: string, module: string, result: string) =>
    db
      .prepare("INSERT INTO audit_log (user_id, action, module, result) VALUES (?, ?, ?, ?)")
      .bind(userId, action, module, result);

  /** The rows a claim and a recovery both write, after their `setup_state` change. */
  const credentials = (o: OwnerCredentials, mode: "claim" | "recovery") => [
    db
      .prepare(
        "INSERT INTO passkeys (id, user_id, webauthn_user_id, public_key, counter, transports, device_type, backed_up) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
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
      ),
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
    audit: (userId: string | null, action: string, module: string, result: string) =>
      audit(userId, action, module, result).run(),

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
          db.prepare("INSERT INTO setup_state (id) SELECT 0 WHERE changes() = 0"),
          db.prepare("DELETE FROM passkeys WHERE user_id = ?").bind(o.userId),
          db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").bind(o.userId),
          db.prepare("UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL").bind(o.now),
          ...credentials(o, "recovery"),
        ]);
      },
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
    },

    sessions: {
      /**
       * A live session: not revoked, not past its absolute expiry, seen after `idleSince`. Its
       * `scope` is the only `UserScope` the app gets: one exists only for a live session row.
       */
      find: async (tokenHash: string, now: number, idleSince: number) => {
        const row = await db
          .prepare(
            `SELECT id, user_id, last_seen_at FROM sessions
             WHERE token_hash = ? AND ${LIVE}`,
          )
          .bind(tokenHash, now, idleSince)
          .first<{ id: string; user_id: string; last_seen_at: number }>();
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
          audit(userId, "auth.sign_out_everywhere", "auth", "ok"),
        ]);
      },
    },
  };
}

export type SystemStore = ReturnType<typeof systemStore>;
