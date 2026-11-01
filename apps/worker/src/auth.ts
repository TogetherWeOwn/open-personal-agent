// SPDX-License-Identifier: Apache-2.0
// Auth primitives shared by the claim (M2-09) and login (M2-10): random IDs, SHA-256 hashing,
// single-use WebAuthn challenges, session rows and recovery codes (ADR 0010 D2). Every secret
// value is ≥128 bits of randomness, so a plain SHA-256 is the right hash; nothing stores plaintext.
import type { ChallengeKind, NewPasskey, NewSession, SystemStore } from "@opa/db/system";
import {
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";

export const SESSION_COOKIE = "__Host-opa_session";
export const CHALLENGE_COOKIE = "__Host-opa_webauthn";
export const COOKIE_OPTIONS = { path: "/", secure: true, httpOnly: true, sameSite: "Lax" } as const;
export const SESSION_ABSOLUTE_MS = 90 * 86_400_000;
export const CHALLENGE_TTL_MS = 5 * 60_000;
/** The account step-up window: export, credential changes, deletion, loosening a tool. */
export const STEP_UP_MS = 5 * 60_000;
export const RECOVERY_CODE_COUNT = 10;

const encoder = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** 256 random bits, base64url. */
export function randomId(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

/** SHA-256 of `value`, base64url: the form every hash is stored in. */
export async function sha256(value: string): Promise<string> {
  return base64url(await digest(value));
}

/** Compares two secrets in constant time. Hashing first makes the lengths equal. */
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  return crypto.subtle.timingSafeEqual(x, y);
}

/**
 * Stores a challenge and returns the cookie value that redeems it. A claim or recovery challenge
 * carries the setup token hash it was issued under, so rotating the token voids it.
 */
export async function putChallenge(
  store: SystemStore,
  kind: ChallengeKind,
  challenge: string,
  userId: string | null,
  tokenHash: string | null = null,
): Promise<string> {
  const id = randomId();
  const now = Date.now();
  const idHash = await sha256(id);
  await store.challenges.put({
    idHash,
    kind,
    challenge,
    userId,
    tokenHash,
    now,
    expiresAt: now + CHALLENGE_TTL_MS,
  });
  return id;
}

/**
 * Consumes a challenge: a second call with the same cookie finds nothing. A challenge issued under
 * another setup token is consumed too, but not returned.
 */
export async function takeChallenge(
  store: SystemStore,
  cookie: string | undefined,
  kind: ChallengeKind,
  tokenHash: string | null = null,
): Promise<{ challenge: string; user_id: string | null } | null> {
  if (!cookie) return null;
  const row = await store.challenges.take(await sha256(cookie), kind, Date.now());
  if (!row || row.token_hash !== tokenHash) return null;
  return { challenge: row.challenge, user_id: row.user_id };
}

/**
 * A new session for `userId`: the row to store, and the cookie value. The caller hands the row to
 * a store method that writes it in one batch with the rest.
 */
export async function newSession(userId: string): Promise<{ cookie: string; row: NewSession }> {
  const cookie = randomId();
  const row = {
    id: crypto.randomUUID(),
    userId,
    tokenHash: await sha256(cookie),
    expiresAt: Date.now() + SESSION_ABSOLUTE_MS,
  };
  return { cookie, row };
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** A recovery code: 130 random bits as 26 base32 characters, shown in groups of five. */
export function newRecoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(17));
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let code = "";
  for (let i = 0; i < 26; i++) code += BASE32[Number((bits >> BigInt(5 * i)) & 31n)];
  return code.match(/.{1,5}/g)?.join("-") ?? code;
}

/** Hashes a recovery code as typed: case, spaces and dashes don't matter. */
export function hashRecoveryCode(code: string): Promise<string> {
  return sha256(code.toLowerCase().replace(/[\s-]/g, ""));
}

/** Registration options for a new passkey of `userId`, the owner's account on this deployment. */
export function registrationOptions(url: string, userId: string) {
  return generateRegistrationOptions({
    rpName: "Open Personal Agent",
    rpID: new URL(url).hostname,
    userName: "owner",
    userID: encoder.encode(userId) as Uint8Array<ArrayBuffer>,
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
}

/** Verifies a registration response with user verification. `null` if it doesn't verify. */
export async function verifyPasskey(
  requestUrl: string,
  response: unknown,
  challenge: string,
  userId: string,
): Promise<NewPasskey | null> {
  const url = new URL(requestUrl);
  const verification = await verifyRegistrationResponse({
    response: response as RegistrationResponseJSON,
    expectedChallenge: challenge,
    expectedOrigin: url.origin,
    expectedRPID: url.hostname,
    requireUserVerification: true,
  }).catch(() => null);
  if (!verification?.verified) return null;
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  return {
    id: credential.id,
    webauthnUserId: base64url(encoder.encode(userId)),
    publicKey: credential.publicKey,
    counter: credential.counter,
    transports: (credential.transports ?? []).join(","),
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
  };
}
