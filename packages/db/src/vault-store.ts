// SPDX-License-Identifier: Apache-2.0
// The vault's storage and audit port over D1: the `user_keys`, `secrets` and `audit_log` tables
// of schema v0. System-level (ADR 0010 D3): the vault scopes each call by `userId` itself, and KEK
// rotation walks every user's key.
import type { SealedSecret, VaultAuditRow, VaultStore, WrappedDek } from "@opa/vault";
import type { SqlDatabase } from "./system";

type Row = Record<string, unknown>;

/** D1 returns a BLOB as an `ArrayBuffer` or an array of byte values. */
function bytes(value: unknown): Uint8Array<ArrayBuffer> {
  return new Uint8Array(value as ArrayBuffer | number[]);
}

/** A blob literal. Only for bytes the vault made, such as IVs: hex can't break out of the SQL. */
const hex = (value: Uint8Array) =>
  `X'${Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("")}'`;

const KEY_COLUMNS = "user_id, kek_version, wrapped_dek, iv";
const SECRET_COLUMNS = "id, user_id, purpose, binding, version, ciphertext, iv, last4";
const keyRow = (r: Row): WrappedDek => ({
  userId: r.user_id as string,
  kekVersion: r.kek_version as number,
  wrappedDek: bytes(r.wrapped_dek),
  iv: bytes(r.iv),
});

const secretRow = (r: Row): SealedSecret => ({
  id: r.id as string,
  userId: r.user_id as string,
  purpose: r.purpose as string,
  binding: r.binding as string,
  version: r.version as number,
  ciphertext: bytes(r.ciphertext),
  iv: bytes(r.iv),
  last4: r.last4 as string | null,
});

/** The DEK row a write depends on, by its wrap IV: a re-key replaces the IV. */
const DEK_HELD =
  "EXISTS (SELECT 1 FROM user_keys WHERE user_id = ? AND kek_version = ? AND iv = ?)";
const dekHeld = (k: WrappedDek) => [k.userId, k.kekVersion, k.iv];

export function d1VaultStore({ DB: db }: { DB: SqlDatabase }): VaultStore {
  const audit = (a: VaultAuditRow, where = "", ...whereValues: unknown[]) =>
    db
      .prepare(
        `INSERT INTO audit_log (user_id, action, module, target_id, result, detail)
         SELECT ?, ?, ?, ?, ?, ? ${where}`,
      )
      .bind(a.userId, a.action, a.module, a.targetId, a.result, a.detail, ...whereValues);
  return {
    async userKeys(userId) {
      const { results } = await db
        .prepare(`SELECT ${KEY_COLUMNS} FROM user_keys WHERE user_id = ?`)
        .bind(userId)
        .all<Row>();
      return results.map(keyRow);
    },
    async userKeysAt(kekVersion, limit) {
      const { results } = await db
        .prepare(`SELECT ${KEY_COLUMNS} FROM user_keys WHERE kek_version = ? LIMIT ?`)
        .bind(kekVersion, limit)
        .all<Row>();
      return results.map(keyRow);
    },
    async countUserKeys(kekVersion) {
      const row = await db
        .prepare("SELECT count(*) AS n FROM user_keys WHERE kek_version = ?")
        .bind(kekVersion)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },
    async insertUserKey(row) {
      await db
        .prepare(
          `INSERT INTO user_keys (${KEY_COLUMNS}) SELECT ?, ?, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM user_keys WHERE user_id = ? OR kek_version > ?)`,
        )
        .bind(row.userId, row.kekVersion, row.wrappedDek, row.iv, row.userId, row.kekVersion)
        .run();
    },
    async userSecrets(userId) {
      const { results } = await db
        .prepare(`SELECT ${SECRET_COLUMNS} FROM secrets WHERE user_id = ?`)
        .bind(userId)
        .all<Row>();
      return results.map(secretRow);
    },
    async rekeyUser({ from, to, before, after }) {
      // The DEK row moves only if it and the user's secrets are as the vault read them: same count,
      // and every IV still there (each write gets a fresh one). The IVs are inlined as literals so
      // the number of bound parameters doesn't grow with the user's secrets.
      const ivs = before.map((s) => hex(s.iv)).join(", ");
      const unchanged = `(SELECT count(*) FROM secrets WHERE user_id = ?) = ?${
        before.length
          ? ` AND (SELECT count(*) FROM secrets WHERE user_id = ? AND iv IN (${ivs})) = ?`
          : ""
      }`;
      const counts = before.length ? [from.userId, before.length] : [];
      // An existing row at the new epoch fails the primary key, which rolls back the whole batch.
      const key = db
        .prepare(
          `UPDATE user_keys SET kek_version = ?, wrapped_dek = ?, iv = ?
           WHERE user_id = ? AND kek_version = ? AND iv = ? AND ${unchanged}`,
        )
        .bind(
          to.kekVersion,
          to.wrappedDek,
          to.iv,
          from.userId,
          from.kekVersion,
          from.iv,
          from.userId,
          before.length,
          ...counts,
        );
      // Each secret moves only if the new DEK row went in, so the batch applies whole or not at all.
      const secrets = after.map((s, i) =>
        db
          .prepare(
            `UPDATE secrets SET ciphertext = ?, iv = ?, last4 = ?
             WHERE id = ? AND user_id = ? AND iv = ? AND ${DEK_HELD}`,
          )
          .bind(s.ciphertext, s.iv, s.last4, s.id, s.userId, before[i]?.iv ?? null, ...dekHeld(to)),
      );
      const [result] = await db.batch([key, ...secrets]);
      return result?.meta.changes === 1;
    },
    async getSecret(userId, secretId) {
      const r = await db
        .prepare(`SELECT ${SECRET_COLUMNS} FROM secrets WHERE id = ? AND user_id = ?`)
        .bind(secretId, userId)
        .first<Row>();
      return r ? secretRow(r) : null;
    },
    async putSecret(s, dek, a) {
      // The `WHERE` on the update stops a write over another user's row with the same id; the one
      // on the select, a write under a DEK a rotation has replaced. The audit row goes in only if
      // the secret did, so the two commit together.
      const [secret] = await db.batch([
        db
          .prepare(
            `INSERT INTO secrets (${SECRET_COLUMNS})
             SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${DEK_HELD}
             ON CONFLICT (id) DO UPDATE SET purpose = excluded.purpose, binding = excluded.binding,
               version = excluded.version, ciphertext = excluded.ciphertext, iv = excluded.iv,
               last4 = excluded.last4, updated_at = (unixepoch('subsec') * 1000)
             WHERE secrets.user_id = excluded.user_id`,
          )
          .bind(
            s.id,
            s.userId,
            s.purpose,
            s.binding,
            s.version,
            s.ciphertext,
            s.iv,
            s.last4,
            ...dekHeld(dek),
          ),
        audit(
          a,
          "WHERE EXISTS (SELECT 1 FROM secrets WHERE id = ? AND user_id = ? AND iv = ?)",
          s.id,
          s.userId,
          s.iv,
        ),
      ]);
      if (secret?.meta.changes !== 1) throw new Error("secret not written");
    },
    async audit(a) {
      await audit(a).run();
    },
  };
}
