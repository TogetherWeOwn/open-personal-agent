// SPDX-License-Identifier: Apache-2.0
// Model credentials are bound to `(provider_id, canonical base_url origin)` (ADR 0006 #5). The
// binding string goes into the `binding` field of the secret's AES-GCM AAD (ADR 0010 D4), so a
// key saved for one origin can't be decrypted for another: changing the URL means re-entering
// the key.

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * The canonical origin of a provider base URL: scheme, lowercased (punycode) host and a
 * non-default port. Paths don't matter. Rejects non-HTTP schemes and embedded credentials.
 */
export function canonicalOrigin(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("Base URL is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Base URL must use https or http");
  }
  if (url.username || url.password) {
    throw new Error("Base URL must not contain credentials");
  }
  return url.origin;
}

/** The `binding` value for a model credential's AAD. */
export function credentialBinding(providerId: string, baseUrl: string): string {
  if (!PROVIDER_ID.test(providerId)) throw new Error("Invalid provider id");
  return `model:${providerId}|${canonicalOrigin(baseUrl)}`;
}
