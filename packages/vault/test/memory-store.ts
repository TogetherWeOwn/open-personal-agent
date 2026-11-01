// SPDX-License-Identifier: Apache-2.0
import type { SealedSecret, VaultAuditRow, VaultStore, WrappedDek } from "../src/index";

/** An in-memory `VaultStore` whose rows tests can read and tamper with. */
export class MemoryStore implements VaultStore {
  keys: WrappedDek[] = [];
  secrets: SealedSecret[] = [];
  audits: VaultAuditRow[] = [];
  failAudit = false;

  async userKeys(userId: string) {
    return this.keys.filter((k) => k.userId === userId);
  }
  async insertUserKey(row: WrappedDek) {
    if (!this.keys.some((k) => k.userId === row.userId && k.kekVersion === row.kekVersion)) {
      this.keys.push(row);
    }
  }
  async getSecret(userId: string, secretId: string) {
    return this.secrets.find((s) => s.userId === userId && s.id === secretId) ?? null;
  }
  async putSecret(row: SealedSecret) {
    this.secrets = this.secrets.filter((s) => !(s.userId === row.userId && s.id === row.id));
    this.secrets.push(row);
  }
  async audit(row: VaultAuditRow) {
    if (this.failAudit) throw new Error("audit write failed");
    this.audits.push(row);
  }
}
