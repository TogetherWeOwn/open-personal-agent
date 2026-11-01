// SPDX-License-Identifier: Apache-2.0
// Auth primitives shared by the claim (M2-09) and login (M2-10): random IDs, SHA-256 hashing,
// single-use WebAuthn challenges, session rows and recovery codes (ADR 0010 D2). Every secret
// value is ≥128 bits of randomness, so a plain SHA-256 is the right hash; nothing stores plaintext.
export const SESSION_COOKIE = "__Host-opa_session";
export const CHALLENGE_COOKIE = "__Host-opa_webauthn";
export const COOKIE_OPTIONS = { path: "/", secure: true, httpOnly: true, sameSite: "Lax" } as const;
export const SESSION_ABSOLUTE_MS = 90 * 86_400_000;
export const CHALLENGE_TTL_MS = 5 * 60_000;
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

/** Stores a challenge and returns the cookie value that redeems it. */
export async function putChallenge(
  db: D1Database,
  kind: "claim" | "recovery" | "login",
  challenge: string,
  userId: string | null,
): Promise<string> {
  const id = randomId();
  const now = Date.now();
  // Abandoned ceremonies are purged here, so the table holds at most five minutes of them.
  await db.batch([
    db.prepare("DELETE FROM webauthn_challenges WHERE expires_at <= ?").bind(now),
    db
      .prepare(
        "INSERT INTO webauthn_challenges (id_hash, kind, challenge, user_id, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(await sha256(id), kind, challenge, userId, now + CHALLENGE_TTL_MS),
  ]);
  return id;
}

/** Consumes a challenge: a second call with the same cookie finds nothing. */
export async function takeChallenge(
  db: D1Database,
  cookie: string | undefined,
  kind: "claim" | "recovery" | "login",
): Promise<{ challenge: string; user_id: string | null } | null> {
  if (!cookie) return null;
  return db
    .prepare(
      "DELETE FROM webauthn_challenges WHERE id_hash = ? AND kind = ? AND expires_at > ? RETURNING challenge, user_id",
    )
    .bind(await sha256(cookie), kind, Date.now())
    .first();
}

/**
 * A new session for `userId`: the statement that stores its hash, and the cookie value. The caller
 * runs the statement in its own batch, so the session is created atomically with the rest.
 */
export async function newSession(
  db: D1Database,
  userId: string,
): Promise<{ cookie: string; insert: D1PreparedStatement }> {
  const cookie = randomId();
  const insert = db
    .prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)")
    .bind(crypto.randomUUID(), userId, await sha256(cookie), Date.now() + SESSION_ABSOLUTE_MS);
  return { cookie, insert };
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
