// SPDX-License-Identifier: Apache-2.0
// R7 M2-8 and M2-8+, and the ADR 0010 D4.1 tests M2-8+V1 to V3 and V6 to V10.
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as surface from "../src/index";
import {
  createVault,
  decrypt,
  encrypt,
  type Purpose,
  retireEpoch,
  rewrap,
  type Vault,
} from "../src/index";
import { importKek } from "../src/kek";
import { MemoryStore } from "./memory-store";

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const newKey = (bytes = 32) => b64(crypto.getRandomValues(new Uint8Array(bytes)));
const CANARY = "sk-canary-0123456789abcdef";
const BINDING = "openai|https://api.openai.com";
const FAILED = { name: "VaultError", message: "vault: decrypt_failed" };
const caller = "test";
type Ask = { userId?: string; id?: string; purpose?: string; binding?: string };
const put = (vault: Vault, { userId = "u1", id = "s1", binding = BINDING }: Ask = {}) =>
  encrypt(
    vault,
    { userId },
    { secretId: id, purpose: "model_api_key", binding, plaintext: CANARY, caller },
  );
const get = (
  vault: Vault,
  { userId = "u1", id = "s1", purpose = "model_api_key", binding = BINDING }: Ask = {},
) => decrypt(vault, { userId }, { secretId: id, purpose: purpose as Purpose, binding, caller });
function only<T>(rows: T[]): T {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new Error(`expected one row, got ${rows.length}`);
  return rows[0];
}

let store: MemoryStore;
let key1: string;
let vault: Vault;
const rotated = () => createVault({ masterKey: `2:${newKey()}`, previousMasterKey: key1, store });
beforeEach(async () => {
  store = new MemoryStore();
  key1 = newKey();
  vault = await createVault({ masterKey: key1, store });
});

describe("envelope encryption (M2-8, M2-8+)", () => {
  it("round-trips and versions, storing neither plaintext nor a raw DEK", async () => {
    expect(await put(vault)).toEqual({ version: 1 });
    expect(await put(vault)).toEqual({ version: 2 });
    expect(await get(vault)).toBe(CANARY);
    const secret = only(store.secrets);
    expect(secret).toMatchObject({ userId: "u1", version: 2, last4: "cdef", binding: BINDING });
    expect(new TextDecoder().decode(secret.ciphertext)).not.toContain(CANARY);
    expect(only(store.keys).wrappedDek.length).toBe(48); // 32-byte DEK + 16-byte GCM tag
  });

  it("rejects a tampered ciphertext, IV or wrapped DEK", async () => {
    await put(vault);
    const secret = only(store.secrets);
    const dek = only(store.keys);
    for (const bytes of [secret.ciphertext, secret.iv, dek.wrappedDek, dek.iv]) {
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      await expect(get(vault)).rejects.toMatchObject(FAILED);
      bytes[0] ^= 1;
    }
    expect(await get(vault)).toBe(CANARY);
  });

  it("rejects ciphertext moved to another secret or user, and a DEK moved to another user", async () => {
    await put(vault);
    await put(vault, { userId: "u2", id: "s2" });
    const own = only(store.secrets.filter((s) => s.userId === "u1"));
    await store.putSecret({ ...own, id: "s3" });
    await expect(get(vault, { id: "s3" })).rejects.toMatchObject(FAILED);
    await store.putSecret({ ...own, id: "s2", userId: "u2" });
    await expect(get(vault, { userId: "u2", id: "s2" })).rejects.toMatchObject(FAILED);
    await put(vault, { userId: "u2", id: "s2" });
    const dek = only(store.keys.filter((k) => k.userId === "u1"));
    store.keys = store.keys.map((k) => (k.userId === "u2" ? { ...dek, userId: "u2" } : k));
    await expect(get(vault, { userId: "u2", id: "s2" })).rejects.toMatchObject(FAILED);
  });

  it("binds a credential to its base URL", async () => {
    await put(vault);
    await expect(get(vault, { binding: "openai|https://evil.example" })).rejects.toMatchObject(
      FAILED,
    );
  });

  it("rejects ids that could make AAD ambiguous, and unknown purposes", async () => {
    await expect(put(vault, { userId: "u|1" })).rejects.toThrow("invalid_input");
    await expect(put(vault, { id: "" })).rejects.toThrow("invalid_input");
    await expect(get(vault, { purpose: "other" })).rejects.toThrow("invalid_input");
  });
});

describe("D4.1 key hygiene", () => {
  it("V1: the KEK is non-extractable in every format", async () => {
    const { key } = await importKek(newKey());
    expect(key.extractable).toBe(false);
    for (const format of ["raw", "jwk", "pkcs8", "spki"]) {
      await expect(crypto.subtle.exportKey(format as "raw", key)).rejects.toThrow();
    }
  });

  it("V2: changing any AAD field on a stored secret or DEK makes decryption fail", async () => {
    await put(vault);
    const original = only(store.secrets);
    const changes = [
      { userId: "u2" },
      { id: "s2" },
      { purpose: "connector_token" },
      { binding: `${BINDING}:8443` },
      { version: 2 },
    ];
    for (const change of changes) {
      store.secrets = [{ ...original, ...change }];
      // Asking for the original fields or for the changed ones fails alike.
      await expect(get(vault)).rejects.toMatchObject(FAILED);
      await expect(get(vault, { ...original, ...change })).rejects.toMatchObject(FAILED);
    }
    // Relabel the DEK's epoch while the vault holds the right KEK under the new label.
    store.secrets = [original];
    store.keys = store.keys.map((k) => ({ ...k, kekVersion: 2 }));
    const relabelled = await createVault({ masterKey: `2:${key1}`, store });
    await expect(get(relabelled)).rejects.toMatchObject(FAILED);
  });

  it("V3: every encryption and re-wrap uses a fresh 96-bit IV", async () => {
    const ivs = new Set<string>();
    const putSecret = store.putSecret.bind(store);
    store.putSecret = async (row) => {
      expect(row.iv.length).toBe(12);
      ivs.add(b64(row.iv));
      return putSecret(row);
    };
    for (let i = 0; i < 10_000; i++) await put(vault);
    expect(ivs.size).toBe(10_000);
    const before = b64(only(store.keys).iv);
    await rewrap(await rotated(), { caller });
    expect(b64(only(store.keys).iv)).not.toBe(before);
  }, 30_000);

  it("V6: exports exactly the D4.1 #5 names, and no call returns key material", async () => {
    const names = ["createVault", "decrypt", "encrypt", "retireEpoch", "rewrap"];
    expect(Object.keys(surface).sort()).toEqual(names);
    expect(Reflect.ownKeys(vault)).toEqual([]);
    expect(Object.getPrototypeOf(vault)).toBeNull();
    const next = await rotated();
    const results: unknown[] = [await put(vault), await get(vault), await rewrap(next, { caller })];
    results.push(await retireEpoch(next, 1, { caller }));
    for (const value of results.flatMap((r) =>
      r && typeof r === "object" ? Object.values(r) : r,
    )) {
      expect(value).not.toBeInstanceOf(CryptoKey);
      expect(value).not.toBeInstanceOf(ArrayBuffer);
      expect(ArrayBuffer.isView(value)).toBe(false);
    }
  });

  it("V7: each call writes one audit row, and decrypt fails closed without one", async () => {
    await put(vault);
    await get(vault);
    const row = {
      userId: "u1",
      module: "test",
      targetId: "s1",
      result: "ok",
      detail: "model_api_key",
    };
    expect(store.audits).toEqual([
      { ...row, action: "vault.encrypt" },
      { ...row, action: "vault.decrypt" },
    ]);
    await expect(get(vault, { binding: "other" })).rejects.toMatchObject(FAILED);
    expect(store.audits.at(-1)).toMatchObject({ action: "vault.decrypt", result: "denied" });

    store.failAudit = true;
    const outcome = await get(vault).then(
      (plaintext) => ({ plaintext }),
      (error: Error) => error,
    );
    expect(outcome).toMatchObject({ message: "vault: audit_failed" });
    expect(outcome).not.toHaveProperty("plaintext");
    await expect(put(vault)).rejects.toThrow("vault: audit_failed");
  });

  it("V8: refuses to start with a missing, malformed or short key", async () => {
    const bad = [
      undefined,
      "",
      "not base64!",
      key1.slice(0, -1),
      newKey(16),
      newKey(48),
      `0:${key1}`,
    ];
    for (const masterKey of bad) {
      await expect(createVault({ masterKey, store })).rejects.toThrow("vault: unavailable");
    }
    // So does a malformed PREV, or one whose epoch isn't older.
    for (const previousMasterKey of [newKey(16), newKey()]) {
      await expect(createVault({ masterKey: key1, previousMasterKey, store })).rejects.toThrow();
    }
  });

  it("V9: failures leak no plaintext, key bytes or DEK bytes", async () => {
    const consoles = (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m));
    await put(vault);
    // Recover the DEK with an extractable copy of the KEK, as only a test can.
    const raw = Uint8Array.from(atob(key1), (c) => c.charCodeAt(0));
    const kek = await crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["decrypt"]);
    const { iv, wrappedDek } = only(store.keys);
    const params = { name: "AES-GCM", iv, additionalData: new TextEncoder().encode("u1|1") };
    const dek = new Uint8Array(await crypto.subtle.decrypt(params, kek, wrappedDek));
    const hex = (bytes: Uint8Array) =>
      [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    const forbidden = [CANARY, key1, b64(dek), hex(dek), hex(raw)];
    const failures = [
      get(vault, { binding: "other" }),
      get(vault, { userId: "u2" }),
      createVault({ masterKey: `${key1}x`, store }),
      createVault({ masterKey: key1, previousMasterKey: key1, store }),
    ];
    for (const failure of failures) {
      const error = await failure.then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error?.cause).toBeUndefined();
      const text = `${error?.message} ${error?.stack} ${JSON.stringify(error)}`;
      for (const value of forbidden) expect(text).not.toContain(value);
    }
    for (const spy of consoles) expect(spy).not.toHaveBeenCalled();
  });

  it("V10: PREV decrypts and re-wraps old epochs; a retired epoch no longer decrypts", async () => {
    await put(vault);
    await put(vault, { userId: "u2" });
    const oldRows = store.keys.map((k) => ({ ...k }));
    const key2 = `2:${newKey()}`;
    const migrating = await createVault({ masterKey: key2, previousMasterKey: key1, store });
    expect(await get(migrating)).toBe(CANARY);
    await expect(retireEpoch(migrating, 1, { caller })).rejects.toThrow("epoch_in_use");
    await expect(retireEpoch(migrating, 2, { caller })).rejects.toThrow("epoch_current");

    expect(await rewrap(migrating, { caller })).toEqual({ rewrapped: 2 });
    expect(store.keys.map((k) => k.kekVersion)).toEqual([2, 2]);
    expect(await get(migrating, { userId: "u2" })).toBe(CANARY);
    await put(migrating, { userId: "u3" });
    expect(store.keys.find((k) => k.userId === "u3")?.kekVersion).toBe(2);
    await retireEpoch(migrating, 1, { caller });
    expect(store.audits.at(-1)).toMatchObject({
      action: "vault.retire_epoch",
      detail: "kek_version=1",
    });

    // With PREV removed, or the epoch retired, an old copy of the DEKs (Time Travel) fails.
    const after = await createVault({ masterKey: key2, store });
    expect(await get(after)).toBe(CANARY);
    store.keys = oldRows;
    await expect(get(after)).rejects.toMatchObject(FAILED);
    await expect(get(migrating)).rejects.toMatchObject(FAILED);
    // And no fresh DEK silently replaces the unreadable one.
    await expect(put(after, { id: "s9" })).rejects.toThrow("encrypt_failed");
  });

  it("an old-epoch vault can't enroll once a newer epoch exists; rewrap never drops a DEK", async () => {
    const migrating = await rotated();
    await put(migrating);
    // A rolling deploy still running epoch 1 can't give u2 a DEK that retirement would strand.
    await expect(put(vault, { userId: "u2" })).rejects.toThrow("encrypt_failed");
    expect(store.keys.map((k) => [k.userId, k.kekVersion])).toEqual([["u1", 2]]);
    // Two DEKs for one user under both epochs: rewrap fails instead of deleting either.
    const older = new MemoryStore();
    await put(await createVault({ masterKey: key1, store: older }));
    store.keys.push(only(older.keys));
    await expect(rewrap(migrating, { caller })).rejects.toThrow();
    expect(store.keys).toHaveLength(2);
  });

  it("keeps the epoch when the retirement audit fails", async () => {
    const migrating = await rotated();
    store.failAudit = true;
    await expect(retireEpoch(migrating, 1, { caller })).rejects.toThrow("audit_failed");
    store.failAudit = false;
    await put(vault);
    expect(await get(migrating)).toBe(CANARY);
  });
});
