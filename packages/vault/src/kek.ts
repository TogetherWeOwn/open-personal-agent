// SPDX-License-Identifier: Apache-2.0
// KEK parsing and import (ADR 0010 D4, D4.1 #7). Internal: nothing here is re-exported.

/** A KEK epoch: its version and the non-extractable `CryptoKey` imported from the secret. */
export interface Kek {
  version: number;
  key: CryptoKey;
}

/** The error every vault failure throws. Its message is a fixed code, never input or key data. */
export function vaultError(code: string): Error {
  const error = new Error(`vault: ${code}`);
  error.name = "VaultError";
  return Object.assign(error, { code });
}

// `<version>:<base64>` or bare `<base64>` (epoch 1, as the deploy script generates it).
const KEY_FORMAT = /^(?:([1-9]\d{0,5}):)?([A-Za-z0-9+/]{43}=)$/;

/**
 * Imports a master key as a non-extractable AES-GCM KEK. Throws `unavailable` when the value is
 * missing, isn't strict base64, or doesn't decode to exactly 256 bits: there is no fallback key.
 */
export async function importKek(raw: unknown): Promise<Kek> {
  const match = typeof raw === "string" ? KEY_FORMAT.exec(raw) : null;
  if (!match?.[2]) throw vaultError("unavailable");
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
  } catch {
    throw vaultError("unavailable");
  }
  if (bytes.length !== 32) throw vaultError("unavailable");
  try {
    const key = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
      "wrapKey",
      "unwrapKey",
    ]);
    return { version: match[1] ? Number(match[1]) : 1, key };
  } finally {
    bytes.fill(0);
  }
}
