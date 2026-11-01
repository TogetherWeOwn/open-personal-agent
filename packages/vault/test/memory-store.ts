// SPDX-License-Identifier: Apache-2.0
import type { SealedSecret, VaultAuditRow, VaultStore, WrappedDek } from "../src/index";

const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * An in-memory `VaultStore` whose rows tests can read and tamper with. Its batches are atomic like
 * D1's: `failBatchAt` makes the next batch fail after that many of its writes, and roll back.
 */
export class MemoryStore implements VaultStore {
  keys: WrappedDek[] = [];
  secrets: SealedSecret[] = [];
  audits: VaultAuditRow[] = [];
  failAudit = false;
  failBatchAt: number | null = null;

  async userKeys(userId: string) {
    return this.keys.filter((k) => k.userId === userId);
  }
  async userKeysAt(kekVersion: number, limit: number) {
    return this.keys.filter((k) => k.kekVersion === kekVersion).slice(0, limit);
  }
  async countUserKeys(kekVersion: number) {
    return this.keys.filter((k) => k.kekVersion === kekVersion).length;
  }
  async countOrphans(heldEpochs: number[]) {
    const held = new Set(
      this.keys.filter((k) => heldEpochs.includes(k.kekVersion)).map((k) => k.userId),
    );
    const orphan = (r: { userId: string }) => !held.has(r.userId);
    return this.keys.filter(orphan).length + this.secrets.filter(orphan).length;
  }
  async insertUserKey(row: WrappedDek) {
    if (!this.keys.some((k) => k.userId === row.userId || k.kekVersion > row.kekVersion)) {
      this.keys.push(row);
    }
  }
  async userSecrets(userId: string) {
    return this.secrets.filter((s) => s.userId === userId);
  }
  async rekeyUser({ from, to, before, after }: Parameters<VaultStore["rekeyUser"]>[0]) {
    const stored = (k: WrappedDek) => k.userId === from.userId && k.kekVersion === from.kekVersion;
    const now = this.secrets.filter((s) => s.userId === from.userId);
    const unchanged =
      this.keys.some((k) => stored(k) && same(k.iv, from.iv)) &&
      now.length === before.length &&
      now.every((s) => before.some((b) => b.id === s.id && same(b.iv, s.iv)));
    if (!unchanged) return false;
    return this.batch(() => {
      if (this.keys.some((k) => k.userId === to.userId && k.kekVersion === to.kekVersion)) {
        throw new Error("primary key conflict");
      }
      this.keys = this.keys.map((k) => (stored(k) ? to : k));
      this.step();
      for (const s of after) {
        this.secrets = this.secrets.map((r) => (r.userId === s.userId && r.id === s.id ? s : r));
        this.step();
      }
      return true;
    });
  }
  async getSecret(userId: string, secretId: string) {
    return this.secrets.find((s) => s.userId === userId && s.id === secretId) ?? null;
  }
  async putSecret(row: SealedSecret, dek: WrappedDek, audit: VaultAuditRow) {
    const held = this.keys.some(
      (k) => k.userId === dek.userId && k.kekVersion === dek.kekVersion && same(k.iv, dek.iv),
    );
    if (!held) throw new Error("secret not written");
    this.batch(() => {
      this.secrets = this.secrets.filter((s) => !(s.userId === row.userId && s.id === row.id));
      this.secrets.push(row);
      this.step();
      if (this.failAudit) throw new Error("audit write failed");
      this.audits.push(audit);
    });
  }
  async resetUser(keys: WrappedDek[], audit: VaultAuditRow) {
    const userId = keys[0]?.userId;
    const now = this.keys.filter((k) => k.userId === userId);
    const unchanged =
      now.length === keys.length && now.every((k) => keys.some((r) => same(r.iv, k.iv)));
    if (!userId || !unchanged) return false;
    return this.batch(() => {
      this.keys = this.keys.filter((k) => k.userId !== userId);
      this.step();
      if (this.failAudit) throw new Error("audit write failed");
      this.audits.push(audit);
      this.step();
      this.secrets = this.secrets.filter((s) => s.userId !== userId);
      this.step();
      return true;
    });
  }
  async audit(row: VaultAuditRow) {
    if (this.failAudit) throw new Error("audit write failed");
    this.audits.push(row);
  }

  private writes = 0;
  /** Counts a write in the running batch, failing it if `failBatchAt` says so. */
  private step() {
    if (++this.writes === this.failBatchAt) throw new Error("injected batch failure");
  }
  private batch<T>(run: () => T): T {
    const saved = { keys: this.keys, secrets: this.secrets, audits: [...this.audits] };
    this.writes = 0;
    try {
      return run();
    } catch (error) {
      Object.assign(this, saved);
      throw error;
    } finally {
      this.failBatchAt = null;
    }
  }
}
