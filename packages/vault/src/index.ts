// SPDX-License-Identifier: Apache-2.0
// Envelope encryption for per-user secrets (ADR 0010 D4, D4.1). Each user has a random 256-bit
// DEK, AES-GCM-wrapped under the deployment KEK with AAD `user_id|kek_version`. Each secret is
// AES-256-GCM under its user's DEK with AAD `user_id|secret_id|purpose|binding|version`.
// No runtime dependencies, and no export returns key material, a DEK or a `CryptoKey` (D4.1 #4,
// #5). Storage and audit are a port that the composition root implements.
import { importKek, type Kek, vaultError } from "./kek";

/** The closed set of things a secret can be used for (D4.1 #5). */
export type Purpose = "model_api_key" | "connector_token";
const PURPOSES: readonly string[] = ["model_api_key", "connector_token"] satisfies Purpose[];

/** The signed-in user, from the repository layer (ADR 0010 D3). */
export interface UserScope {
  readonly userId: string;
}

type Bytes = Uint8Array<ArrayBuffer>;
/** A `user_keys` row: one user's DEK wrapped under KEK epoch `kekVersion`. */
export interface WrappedDek {
  userId: string;
  kekVersion: number;
  wrappedDek: Bytes;
  iv: Bytes;
}
/** A `secrets` row. */
export interface SealedSecret {
  id: string;
  userId: string;
  purpose: string;
  binding: string;
  version: number;
  ciphertext: Bytes;
  iv: Bytes;
  last4: string | null;
}
/** An `audit_log` row; `module` is the calling module. */
export interface VaultAuditRow {
  userId: string | null;
  action: "vault.encrypt" | "vault.decrypt";
  module: string;
  targetId: string | null;
  result: "ok" | "denied" | "error";
  detail: string | null;
}

export interface VaultStore {
  userKeys(userId: string): Promise<WrappedDek[]>;
  /** Inserts the row unless the user already has one for that epoch. */
  insertUserKey(row: WrappedDek): Promise<void>;
  getSecret(userId: string, secretId: string): Promise<SealedSecret | null>;
  /** Inserts or replaces the user's row with this id; rejects if it writes nothing. */
  putSecret(row: SealedSecret): Promise<void>;
  /** Rejects if the row isn't written: vault calls fail closed on audit (D4.1 #6). */
  audit(row: VaultAuditRow): Promise<void>;
}

export interface VaultConfig {
  /** `OPA_MASTER_KEY`: 32 bytes, base64, optionally prefixed `<epoch>:` (bare means epoch 1). */
  masterKey: string | undefined;
  /** `OPA_MASTER_KEY_PREV`: the previous epoch's key, set only while a rotation migrates. */
  previousMasterKey?: string | undefined;
  store: VaultStore;
}

declare const brand: unique symbol;
/** An opaque handle. Its state lives in a module-private map, so the handle carries no key. */
export type Vault = { readonly [brand]: true };

interface State {
  current: Kek;
  keks: Map<number, Kek>;
  store: VaultStore;
}
const states = new WeakMap<Vault, State>();
const encoder = new TextEncoder();

/** Rejects with `unavailable` if a key is malformed or PREV's epoch isn't older (D4.1 #7). */
export async function createVault(config: VaultConfig): Promise<Vault> {
  const current = await importKek(config.masterKey);
  const keks = new Map([[current.version, current]]);
  if (config.previousMasterKey) {
    const previous = await importKek(config.previousMasterKey);
    if (previous.version >= current.version) throw vaultError("unavailable");
    keks.set(previous.version, previous);
  }
  const vault = Object.freeze(Object.create(null)) as Vault;
  states.set(vault, { current, keks, store: config.store });
  return vault;
}

interface SecretRef {
  secretId: string;
  purpose: Purpose;
  /** What the secret may be used with; for a model key, `credentialBinding(provider, baseUrl)`. */
  binding: string;
  /** The calling module, for the audit row. */
  caller: string;
}

/** Encrypts and stores a secret, replacing any earlier version. Returns the new version. */
export async function encrypt(
  vault: Vault,
  scope: UserScope,
  input: SecretRef & { plaintext: string },
): Promise<{ version: number }> {
  const state = stateOf(vault);
  return audited(state, scope, input, "vault.encrypt", async () => {
    const { userId } = scope;
    const { secretId, purpose, binding, plaintext } = input;
    const version = ((await state.store.getSecret(userId, secretId))?.version ?? 0) + 1;
    const dek = await userDek(state, userId, true);
    const iv = randomIv();
    const aad = encodeAad(userId, secretId, purpose, binding, version);
    const ciphertext = await gcm("encrypt", dek, iv, aad, encoder.encode(plaintext));
    const last4 = plaintext.length >= 8 ? plaintext.slice(-4) : null;
    await state.store.putSecret({
      id: secretId,
      userId,
      purpose,
      binding,
      version,
      ciphertext,
      iv,
      last4,
    });
    return { version };
  });
}

/** Decrypts one of the scope's secrets. Fails unless purpose, binding and every AAD field match. */
export async function decrypt(vault: Vault, scope: UserScope, input: SecretRef): Promise<string> {
  const state = stateOf(vault);
  return audited(state, scope, input, "vault.decrypt", async () => {
    const row = await state.store.getSecret(scope.userId, input.secretId);
    const { secretId, purpose, binding } = input;
    if (!row || row.id !== secretId || row.purpose !== purpose || row.binding !== binding) {
      throw vaultError("decrypt_failed");
    }
    const dek = await userDek(state, scope.userId, false);
    const aad = encodeAad(scope.userId, secretId, purpose, binding, row.version);
    return new TextDecoder().decode(await gcm("decrypt", dek, row.iv, aad, row.ciphertext));
  });
}

function stateOf(vault: Vault): State {
  const state = states.get(vault);
  if (!state) throw vaultError("unavailable");
  return state;
}

function record(state: State, row: VaultAuditRow): Promise<void> {
  return state.store.audit(row).catch(() => {
    throw vaultError("audit_failed");
  });
}

/** Runs an encrypt or decrypt and audits it. No audit row, no result (D4.1 #6). */
async function audited<T>(
  state: State,
  scope: UserScope,
  input: SecretRef,
  action: "vault.encrypt" | "vault.decrypt",
  run: () => Promise<T>,
): Promise<T> {
  // `|` separates AAD fields, so the free-form ones before `binding` can't contain it.
  const ids = [scope?.userId, input.secretId, input.caller];
  if (
    ids.some((id) => typeof id !== "string" || id === "" || id.includes("|")) ||
    !PURPOSES.includes(input.purpose) ||
    typeof input.binding !== "string" ||
    input.binding === ""
  ) {
    throw vaultError("invalid_input");
  }
  const row = {
    userId: scope.userId,
    action,
    module: input.caller,
    targetId: input.secretId,
    detail: input.purpose,
  };
  const encrypting = action === "vault.encrypt";
  let value: T;
  try {
    value = await run();
  } catch {
    // Best effort: the call fails either way, with a fixed message and no cause.
    await state.store.audit({ ...row, result: encrypting ? "error" : "denied" }).catch(() => {});
    throw vaultError(encrypting ? "encrypt_failed" : "decrypt_failed");
  }
  await record(state, { ...row, result: "ok" });
  return value;
}

/**
 * The user's DEK as a non-extractable key, from the current epoch or else a still-held older one.
 * With `create`, a user with no DEK gets a new one. A user whose only DEK is under an unknown or
 * retired epoch gets none: a new DEK would silently orphan their old secrets.
 */
async function userDek(state: State, userId: string, create: boolean): Promise<CryptoKey> {
  const rows = await state.store.userKeys(userId);
  const row =
    rows.find((r) => r.kekVersion === state.current.version) ??
    rows.find((r) => state.keks.has(r.kekVersion));
  const kek = row && state.keks.get(row.kekVersion);
  if (row && kek && row.userId === userId) return unwrapDek(kek, row, false);
  if (rows.length > 0 || !create) throw vaultError("decrypt_failed");

  const fresh = (await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ])) as CryptoKey;
  await state.store.insertUserKey(await wrapDek(state.current, userId, fresh));
  // Re-read, so two concurrent first encrypts agree on whichever row was stored.
  return userDek(state, userId, false);
}

async function wrapDek(kek: Kek, userId: string, dek: CryptoKey): Promise<WrappedDek> {
  const iv = randomIv();
  const params = { name: "AES-GCM", iv, additionalData: encodeAad(userId, kek.version) };
  const wrappedDek = new Uint8Array(await crypto.subtle.wrapKey("raw", dek, kek.key, params));
  return { userId, kekVersion: kek.version, wrappedDek, iv };
}

function unwrapDek(kek: Kek, row: WrappedDek, extractable: boolean): Promise<CryptoKey> {
  const params = {
    name: "AES-GCM",
    iv: row.iv,
    additionalData: encodeAad(row.userId, row.kekVersion),
  };
  return crypto.subtle.unwrapKey("raw", row.wrappedDek, kek.key, params, "AES-GCM", extractable, [
    "encrypt",
    "decrypt",
  ]);
}

async function gcm(
  op: "encrypt" | "decrypt",
  key: CryptoKey,
  iv: Bytes,
  aad: Bytes,
  data: BufferSource,
) {
  return new Uint8Array(
    await crypto.subtle[op]({ name: "AES-GCM", iv, additionalData: aad }, key, data),
  );
}

function encodeAad(...fields: (string | number)[]): Bytes {
  return new Uint8Array(encoder.encode(fields.join("|")));
}

/** A fresh random 96-bit GCM IV. */
function randomIv(): Bytes {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  return iv;
}
