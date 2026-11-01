// SPDX-License-Identifier: Apache-2.0
// Envelope encryption for per-user secrets (ADR 0010 D4, D4.1). Each user has a random 256-bit
// DEK, AES-GCM-wrapped under the deployment KEK with AAD `(user_id, kek_version)`. Each secret is
// AES-256-GCM under its user's DEK with AAD `(user_id, secret_id, purpose, binding, version)`,
// both in the versioned encoding of `aad.ts`. A KEK rotation re-keys: every user gets a new DEK.
// No runtime dependencies, and no export returns key material, a DEK or a `CryptoKey` (D4.1 #4,
// #5). No DEK is ever unwrapped as extractable. Storage and audit are a port that the composition
// root implements.
import { type AadFormat, dekAad, secretAad } from "./aad";
import { importKek, type Kek, vaultError } from "./kek";

/** The closed set of things a secret can be used for (D4.1 #5). */
export type Purpose = "model_api_key" | "connector_token";
const PURPOSES: readonly string[] = ["model_api_key", "connector_token"] satisfies Purpose[];

declare const scopeBrand: unique symbol;
/** The signed-in user. Only the repository layer mints one, from the session (ADR 0010 D3). */
export interface UserScope {
  readonly userId: string;
  readonly [scopeBrand]: true;
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
  action:
    | "vault.encrypt"
    | "vault.decrypt"
    | "vault.rewrap"
    | "vault.retire_epoch"
    | "vault.reset_user";
  module: string;
  targetId: string | null;
  result: "ok" | "denied" | "error";
  detail: string | null;
}

export interface VaultStore {
  userKeys(userId: string): Promise<WrappedDek[]>;
  userKeysAt(kekVersion: number, limit: number): Promise<WrappedDek[]>;
  countUserKeys(kekVersion: number): Promise<number>;
  /** `user_keys` plus `secrets` rows of users with no DEK row under any of `heldEpochs`. */
  countOrphans(heldEpochs: number[]): Promise<number>;
  /**
   * Atomically inserts the row only if the user has no DEK under any epoch and no row is under a
   * newer epoch: during a rolling rotation, an old-epoch Worker can't enrol a user.
   */
  insertUserKey(row: WrappedDek): Promise<void>;
  /** Every `secrets` row of the user. */
  userSecrets(userId: string): Promise<SealedSecret[]>;
  /**
   * One batch: replaces the DEK row `from` with `to` and the user's secrets `before` with `after`
   * (same ids). It writes nothing and returns false unless `from` is still stored and `before` is
   * still exactly the user's secrets. Rejects, writing nothing, if `to`'s epoch row exists.
   */
  rekeyUser(change: {
    from: WrappedDek;
    to: WrappedDek;
    before: SealedSecret[];
    after: SealedSecret[];
  }): Promise<boolean>;
  getSecret(userId: string, secretId: string): Promise<SealedSecret | null>;
  /**
   * One batch: inserts or replaces the user's secret with this id, and writes `audit`, only while
   * the DEK row `dek` it was sealed under is stored. Rejects, writing neither, otherwise.
   */
  putSecret(row: SealedSecret, dek: WrappedDek, audit: VaultAuditRow): Promise<void>;
  /**
   * One batch: deletes the DEK rows `keys` and every secret of their user, and writes `audit`. It
   * writes nothing and returns false unless `keys` are still exactly the user's DEK rows.
   */
  resetUser(keys: WrappedDek[], audit: VaultAuditRow): Promise<boolean>;
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
  /** PREV's epoch, while it is configured; retiring it doesn't clear this. */
  previous: number | null;
  store: VaultStore;
}
const states = new WeakMap<Vault, State>();
const encoder = new TextEncoder();

/** Rejects with `unavailable` if a key is malformed or PREV's epoch isn't older (D4.1 #7). */
export async function createVault(config: VaultConfig): Promise<Vault> {
  const current = await importKek(config.masterKey);
  const keks = new Map([[current.version, current]]);
  let previous: number | null = null;
  // An empty PREV is a misconfiguration, not "unset": it fails closed too.
  if (config.previousMasterKey !== undefined) {
    const kek = await importKek(config.previousMasterKey);
    if (kek.version >= current.version) throw vaultError("unavailable");
    keks.set(kek.version, kek);
    previous = kek.version;
  }
  const vault = Object.freeze(Object.create(null)) as Vault;
  states.set(vault, { current, keks, previous, store: config.store });
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
  return audited(state, scope, input, "vault.encrypt", async (audit) => {
    const { userId } = scope;
    const { secretId: id, purpose, binding, plaintext } = input;
    const version = ((await state.store.getSecret(userId, id))?.version ?? 0) + 1;
    const { key, format, row: dekRow } = await userDek(state, userId, true);
    const iv = randomIv();
    const aad = secretAad(format, { userId, id, purpose, binding, version });
    const ciphertext = await gcm("encrypt", key, iv, aad, encoder.encode(plaintext));
    const row = { id, userId, purpose, binding, version, ciphertext, iv, last4: last4(plaintext) };
    // The audit row commits with the secret, or neither does (L-2). The write also fails if a
    // rotation re-keyed the user since `userDek`, so nothing is sealed under a replaced DEK.
    await state.store.putSecret(row, dekRow, audit);
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
    const { key, format } = await userDek(state, scope.userId, false);
    const aad = secretAad(format, { ...row, userId: scope.userId });
    return new TextDecoder().decode(await gcm("decrypt", key, row.iv, aad, row.ciphertext));
  });
}

/**
 * Re-keys every user whose DEK is under an older epoch: a new DEK, wrapped under the current KEK,
 * and each of the user's secrets re-sealed under it in the v2 AAD format, one batch per user. So a
 * KEK or DEK taken before the rotation opens nothing written after it, and once the old epoch is
 * retired, no copy of the data from before it opens either (crypto review C-2).
 */
export async function rewrap(
  vault: Vault,
  options: { caller: string; limit?: number },
): Promise<{ rewrapped: number; remaining: number }> {
  const state = stateOf(vault);
  const { current, store } = state;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  let rewrapped = 0;
  // A user whose secrets change while being re-keyed is retried, a few times at most.
  const conflicts = new Map<string, number>();
  for (const old of state.keks.values()) {
    if (old === current) continue;
    for (let rows = await store.userKeysAt(old.version, 100); rows.length > 0; ) {
      for (const row of rows) {
        if (rewrapped >= limit) break;
        if (await rekeyUser(state, old, row)) {
          rewrapped++;
          continue;
        }
        const tries = (conflicts.get(row.userId) ?? 0) + 1;
        if (tries > 3) throw vaultError("rewrap_conflict");
        conflicts.set(row.userId, tries);
      }
      rows = rewrapped >= limit ? [] : await store.userKeysAt(old.version, 100);
    }
  }
  let remaining = 0;
  for (const old of state.keks.values()) {
    if (old !== current) remaining += await store.countUserKeys(old.version);
  }
  const detail = `kek_version=${current.version} rewrapped=${rewrapped} remaining=${remaining}`;
  await record(state, {
    userId: null,
    action: "vault.rewrap",
    module: options.caller,
    targetId: null,
    result: "ok",
    detail,
  });
  return { rewrapped, remaining };
}

/**
 * Stops this vault using an old KEK epoch once no DEK references it. The operator then deletes
 * `OPA_MASTER_KEY_PREV`; after that, old copies of the data (Time Travel) can't be decrypted.
 * Retire only after every Worker instance runs the new key: on a deployment with no users yet,
 * an old-epoch instance could still enrol a first user.
 */
export async function retireEpoch(
  vault: Vault,
  kekVersion: number,
  options: { caller: string },
): Promise<void> {
  const state = stateOf(vault);
  if (kekVersion === state.current.version) throw vaultError("epoch_current");
  if ((await state.store.countUserKeys(kekVersion)) > 0) throw vaultError("epoch_in_use");
  const detail = `kek_version=${kekVersion}`;
  await record(state, {
    userId: null,
    action: "vault.retire_epoch",
    module: options.caller,
    targetId: null,
    result: "ok",
    detail,
  });
  state.keks.delete(kekVersion);
}

/** A rotation's progress, and how many rows no held epoch can open. Counts only, no ids. */
export interface VaultStatus {
  /** `none`: no PREV. `pending`: DEKs remain under PREV. `complete`: PREV can be deleted. */
  rotation: "none" | "pending" | "complete";
  /** PREV's epoch, while it is configured. */
  previousEpoch: number | null;
  /** `user_keys` and `secrets` rows of users with no DEK under an epoch this vault holds. */
  orphanedRows: number;
}

export async function vaultStatus(vault: Vault): Promise<VaultStatus> {
  const { previous, keks, store } = stateOf(vault);
  const orphanedRows = await store.countOrphans([...keks.keys()]);
  if (previous === null) return { rotation: "none", previousEpoch: null, orphanedRows };
  const left = await store.countUserKeys(previous);
  return { rotation: left > 0 ? "pending" : "complete", previousEpoch: previous, orphanedRows };
}

/**
 * Whether the user's DEK opens. `reset_required`: they have DEK rows and none opens with a key this
 * vault holds, so nothing of theirs can be read or written until they reset. `unavailable`: a row
 * is under an epoch newer than this vault's, so this instance runs an old key; never a reset.
 */
export type UserState = "ok" | "empty" | "reset_required" | "unavailable";

export async function userState(vault: Vault, scope: UserScope): Promise<UserState> {
  const state = stateOf(vault);
  const userId = checkedUser(scope);
  return stateOfRows(state, userId, await state.store.userKeys(userId));
}

/**
 * Deletes the user's DEK rows and every secret of theirs, with an audit row, in one batch. Only
 * for a user in `reset_required`: it refuses (`reset_refused`) a user whose DEK still opens, and
 * nothing calls it but the user's own confirmed request. The secrets it drops can't be opened
 * with any key this vault holds; the user enters them again.
 */
export async function resetUser(
  vault: Vault,
  scope: UserScope,
  options: { caller: string },
): Promise<void> {
  const state = stateOf(vault);
  const userId = checkedUser(scope);
  const keys = await state.store.userKeys(userId);
  if ((await stateOfRows(state, userId, keys)) !== "reset_required") {
    throw vaultError("reset_refused");
  }
  const epochs = [...new Set(keys.map((k) => k.kekVersion))].sort((a, b) => a - b);
  const audit: VaultAuditRow = {
    userId,
    action: "vault.reset_user",
    module: options.caller,
    targetId: null,
    result: "ok",
    detail: `kek_versions=${epochs.join(",")}`,
  };
  const done = await state.store.resetUser(keys, audit).catch(() => {
    throw vaultError("reset_failed");
  });
  // The rows changed since they were read, by a rotation or another reset: the caller retries.
  if (!done) throw vaultError("reset_conflict");
}

function checkedUser(scope: UserScope): string {
  const userId = scope?.userId;
  if (typeof userId !== "string" || userId === "" || userId.includes("|")) {
    throw vaultError("invalid_input");
  }
  return userId;
}

async function stateOfRows(state: State, userId: string, rows: WrappedDek[]): Promise<UserState> {
  if (rows.length === 0) return "empty";
  if (rows.some((r) => r.kekVersion > state.current.version)) return "unavailable";
  const row = heldRow(state, rows);
  const kek = row && state.keks.get(row.kekVersion);
  if (!row || !kek || row.userId !== userId) return "reset_required";
  // A key regenerated under the same epoch holds the epoch but opens nothing: GCM tells.
  return unwrapDek(kek, row).then(
    () => "ok" as const,
    () => "reset_required" as const,
  );
}

/** The row `userDek` uses: the current epoch's, or else one under a still-held older epoch. */
function heldRow(state: State, rows: WrappedDek[]): WrappedDek | undefined {
  return (
    rows.find((r) => r.kekVersion === state.current.version) ??
    rows.find((r) => state.keks.has(r.kekVersion))
  );
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

/**
 * Runs an encrypt or decrypt and audits it. No audit row, no result (D4.1 #6). An encrypt writes
 * its `ok` row itself, in the same batch as the secret.
 */
async function audited<T>(
  state: State,
  scope: UserScope,
  input: SecretRef,
  action: "vault.encrypt" | "vault.decrypt",
  run: (ok: VaultAuditRow) => Promise<T>,
): Promise<T> {
  // `|` separates v1 AAD fields, so the free-form ones before `binding` can't contain it.
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
    value = await run({ ...row, result: "ok" });
  } catch {
    // Best effort: the call fails either way, with a fixed message and no cause.
    await state.store.audit({ ...row, result: encrypting ? "error" : "denied" }).catch(() => {});
    throw vaultError(encrypting ? "encrypt_failed" : "decrypt_failed");
  }
  if (!encrypting) await record(state, { ...row, result: "ok" });
  return value;
}

interface Dek {
  key: CryptoKey;
  format: AadFormat;
  row: WrappedDek;
}

/**
 * The user's DEK as a non-extractable key, from the current epoch or else a still-held older one.
 * With `create`, a user with no DEK gets a new one. A user whose only DEK is under an unknown or
 * retired epoch gets none: a new DEK would silently orphan their old secrets.
 */
async function userDek(state: State, userId: string, create: boolean): Promise<Dek> {
  const rows = await state.store.userKeys(userId);
  const row = heldRow(state, rows);
  const kek = row && state.keks.get(row.kekVersion);
  if (row && kek && row.userId === userId) return { ...(await unwrapDek(kek, row)), row };
  if (rows.length > 0 || !create) throw vaultError("decrypt_failed");

  await state.store.insertUserKey((await newDek(state.current, userId)).row);
  // Re-read, so two concurrent first encrypts agree on whichever row was stored.
  return userDek(state, userId, false);
}

/**
 * Moves one user from `old` to a new DEK under the current KEK, re-sealing each secret with a fresh
 * IV. False if the user's rows changed meanwhile; then nothing was written.
 */
async function rekeyUser(state: State, old: Kek, from: WrappedDek): Promise<boolean> {
  const { userId } = from;
  const { key: oldKey, format } = await unwrapDek(old, from);
  const before = await state.store.userSecrets(userId);
  const { key, row: to } = await newDek(state.current, userId);
  const after: SealedSecret[] = [];
  for (const secret of before) {
    if (secret.userId !== userId) throw vaultError("rewrap_failed");
    // A secret that no longer opens stops the rotation: re-keying would drop it for good.
    const plaintext = await gcm(
      "decrypt",
      oldKey,
      secret.iv,
      secretAad(format, secret),
      secret.ciphertext,
    ).catch(() => {
      throw vaultError("rewrap_failed");
    });
    const iv = randomIv();
    const ciphertext = await gcm("encrypt", key, iv, secretAad(2, secret), plaintext);
    // Recomputed, so a last4 kept before L-1 for a short secret goes with its old ciphertext.
    const shown = last4(new TextDecoder().decode(plaintext));
    plaintext.fill(0);
    after.push({ ...secret, ciphertext, iv, last4: shown });
  }
  return state.store.rekeyUser({ from, to, before, after });
}

/** Only for long secrets: four characters of a short one are too much of it (crypto review L-1). */
function last4(plaintext: string): string | null {
  return plaintext.length >= 20 ? plaintext.slice(-4) : null;
}

/**
 * A fresh DEK wrapped under `kek` in the v2 format, and the same DEK unwrapped again as a
 * non-extractable key: the extractable one exists only to be wrapped, and never leaves here.
 */
async function newDek(kek: Kek, userId: string): Promise<{ key: CryptoKey; row: WrappedDek }> {
  const fresh = (await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ])) as CryptoKey;
  const iv = randomIv();
  const params = { name: "AES-GCM", iv, additionalData: dekAad(2, userId, kek.version) };
  const wrappedDek = new Uint8Array(await crypto.subtle.wrapKey("raw", fresh, kek.key, params));
  const row = { userId, kekVersion: kek.version, wrappedDek, iv };
  return { key: (await unwrapDek(kek, row)).key, row };
}

/** Unwraps a DEK as non-extractable, trying the v2 AAD and then v1. GCM accepts only the right one. */
async function unwrapDek(
  kek: Kek,
  row: WrappedDek,
): Promise<{ key: CryptoKey; format: AadFormat }> {
  for (const format of [2, 1] as const) {
    const params = {
      name: "AES-GCM",
      iv: row.iv,
      additionalData: dekAad(format, row.userId, row.kekVersion),
    };
    try {
      const key = await crypto.subtle.unwrapKey(
        "raw",
        row.wrappedDek,
        kek.key,
        params,
        "AES-GCM",
        false,
        ["encrypt", "decrypt"],
      );
      return { key, format };
    } catch {
      // The other format, or a key that isn't this KEK's.
    }
  }
  throw vaultError("decrypt_failed");
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

/** A fresh random 96-bit GCM IV. */
function randomIv(): Bytes {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  return iv;
}
