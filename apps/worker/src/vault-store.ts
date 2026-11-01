// SPDX-License-Identifier: Apache-2.0
// The vault's storage and audit port over D1: the `user_keys`, `secrets` and `audit_log` tables
// of schema v0. Moves into the scoped repository layer with M2-11.
import type { SealedSecret, VaultStore, WrappedDek } from "@opa/vault";

type Row = Record<string, unknown>;

/** D1 returns a BLOB as an `ArrayBuffer` or an array of byte values. */
function bytes(value: unknown): Uint8Array<ArrayBuffer> {
  return new Uint8Array(value as ArrayBuffer | number[]);
}

const KEY_COLUMNS = "user_id, kek_version, wrapped_dek, iv";
const keyRow = (r: Row): WrappedDek => ({
  userId: r.user_id as string,
  kekVersion: r.kek_version as number,
  wrappedDek: bytes(r.wrapped_dek),
  iv: bytes(r.iv),
});

export function d1VaultStore(db: D1Database): VaultStore {
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
    async replaceUserKey(row, oldKekVersion) {
      // An existing row at the new epoch fails the primary key, so neither DEK is lost.
      await db
        .prepare(
          "UPDATE user_keys SET kek_version = ?, wrapped_dek = ?, iv = ? WHERE user_id = ? AND kek_version = ?",
        )
        .bind(row.kekVersion, row.wrappedDek, row.iv, row.userId, oldKekVersion)
        .run();
    },
    async getSecret(userId, secretId) {
      const r = await db
        .prepare(
          "SELECT id, user_id, purpose, binding, version, ciphertext, iv, last4 FROM secrets WHERE id = ? AND user_id = ?",
        )
        .bind(secretId, userId)
        .first<Row>();
      if (!r) return null;
      return {
        id: r.id as string,
        userId: r.user_id as string,
        purpose: r.purpose as string,
        binding: r.binding as string,
        version: r.version as number,
        ciphertext: bytes(r.ciphertext),
        iv: bytes(r.iv),
        last4: r.last4 as string | null,
      } satisfies SealedSecret;
    },
    async putSecret(s) {
      // The `WHERE` stops a write over another user's row with the same id.
      const { meta } = await db
        .prepare(
          `INSERT INTO secrets (id, user_id, purpose, binding, version, ciphertext, iv, last4)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET purpose = excluded.purpose, binding = excluded.binding,
             version = excluded.version, ciphertext = excluded.ciphertext, iv = excluded.iv,
             last4 = excluded.last4, updated_at = (unixepoch('subsec') * 1000)
           WHERE secrets.user_id = excluded.user_id`,
        )
        .bind(s.id, s.userId, s.purpose, s.binding, s.version, s.ciphertext, s.iv, s.last4)
        .run();
      if (meta.changes !== 1) throw new Error("secret not written");
    },
    async audit(a) {
      await db
        .prepare(
          "INSERT INTO audit_log (user_id, action, module, target_id, result, detail) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(a.userId, a.action, a.module, a.targetId, a.result, a.detail)
        .run();
    },
  };
}
