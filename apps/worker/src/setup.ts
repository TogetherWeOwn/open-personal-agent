// SPDX-License-Identifier: Apache-2.0
// Claiming a deployment and recovering it (ADR 0010 D2, TWO-375 F14). The owner proves they hold
// `OPA_SETUP_TOKEN` in a POST body, never a URL, and registers a passkey. D1 keeps
// `sha256(token)` from claim time. Once that matches the secret, `/setup` is closed for good. If
// the operator rotates the secret, `/setup` reopens in recovery mode for the new token only. Every
// token that claimed or recovered is recorded, so putting an old one back never reopens `/setup`.
import {
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import * as auth from "./auth";
import type { Env } from "./env";
import { checkHealth } from "./health";

type Mode = "claim" | "recovery" | "closed";
interface SetupState {
  mode: Mode;
  /** The owner's ID in recovery mode. */
  ownerId: string | null;
  /** `sha256(OPA_SETUP_TOKEN)` as the Worker holds it now. */
  hash: string;
}

/** Routes reachable before the claim. Everything else answers 403 until then. */
const PUBLIC_BEFORE_CLAIM = ["/api/health", "/setup", "/setup/options"];
/** 128 bits as base64. A shorter secret keeps `/setup` closed. */
const MIN_TOKEN_LENGTH = 22;
/**
 * A cheap guard against placeholder secrets like `aaaa…`. Random base64 or hex of the minimum
 * length has far more distinct characters than this, except with negligible probability.
 */
const MIN_DISTINCT_CHARS = 8;
const encoder = new TextEncoder();

/** 403 on every route except the public list until the deployment is claimed (R7 M2-2). */
export const claimGuard: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (PUBLIC_BEFORE_CLAIM.includes(c.req.path)) return next();
  // An unmigrated or unreachable database counts as unclaimed: fail closed. `prepare` itself can
  // throw, so it sits inside the try as well.
  let claimed: unknown = null;
  try {
    claimed = await c.env.DB.prepare("SELECT 1 FROM setup_state WHERE id = 1").first();
  } catch {
    claimed = null;
  }
  if (!claimed) return c.json({ error: "not_claimed" }, 403);
  return next();
};

/** Why the configured secret can't open `/setup`, or `null` if it can. */
function weakToken(secret: string): "setup_token_too_short" | "setup_token_weak" | null {
  if (secret.length < MIN_TOKEN_LENGTH) return "setup_token_too_short";
  if (new Set(secret).size < MIN_DISTINCT_CHARS) return "setup_token_weak";
  return null;
}

/** The mode follows from the stored claim hash and the secret the Worker holds now. */
async function readState(env: Env): Promise<SetupState> {
  const hash = await auth.sha256(env.OPA_SETUP_TOKEN ?? "");
  const row = await env.DB.prepare(
    "SELECT claim_token_hash, claimed_by_user_id, EXISTS (SELECT 1 FROM used_setup_tokens WHERE token_hash = ?1) AS used FROM setup_state WHERE id = 1",
  )
    .bind(hash)
    .first<{ claim_token_hash: string | null; claimed_by_user_id: string | null; used: number }>();
  if (!row) return { mode: "claim", ownerId: null, hash };
  // A claimed row with no owner has nothing to recover, and a used token never opens recovery.
  if (row.claim_token_hash === hash || row.used || !row.claimed_by_user_id) {
    return { mode: "closed", ownerId: null, hash };
  }
  return { mode: "recovery", ownerId: row.claimed_by_user_id, hash };
}

/** For `GET /setup`: whether the claim or recovery page may be shown. */
export async function setupOpen(env: Env): Promise<boolean> {
  if (weakToken(env.OPA_SETUP_TOKEN ?? "")) return false;
  return (await readState(env)).mode !== "closed";
}

/**
 * The checks every setup POST shares, in order: exact Origin, a configured deployment, the token,
 * an open mode. Returns the parsed body and state, or the error response. A wrong token is
 * audited; the coarse per-address rate limit on `/setup` is the rate-limit binding (M2-22).
 */
async function authorize(
  c: Context<{ Bindings: Env }>,
): Promise<Response | (SetupState & { body: Record<string, unknown> })> {
  if (c.req.header("Origin") !== new URL(c.req.url).origin) {
    return c.json({ error: "bad_origin" }, 403);
  }
  if ((await checkHealth(c.env)).status === "setup_required") {
    return c.json({ error: "setup_required" }, 503);
  }
  const secret = c.env.OPA_SETUP_TOKEN ?? "";
  const weak = weakToken(secret);
  if (weak) return c.json({ error: weak }, 503);
  const body = await c.req.json().catch(() => null);
  if (!(await auth.secretsEqual(typeof body?.token === "string" ? body.token : "", secret))) {
    await c.env.DB.prepare(
      "INSERT INTO audit_log (action, module, result) VALUES ('setup.token', 'setup', 'denied')",
    ).run();
    return c.json({ error: "invalid_token" }, 403);
  }
  const state = await readState(c.env);
  if (state.mode === "closed") return c.json({ error: "already_claimed" }, 403);
  return { ...state, body };
}

export const setup = new Hono<{ Bindings: Env }>();

/** Step 1: registration options for the owner's passkey. */
setup.post("/options", async (c) => {
  const state = await authorize(c);
  if (state instanceof Response) return state;
  const mode = state.mode as "claim" | "recovery";
  // Recovery keeps the owner's account, so the new passkey replaces the old one on the device.
  const userId = state.ownerId ?? crypto.randomUUID();
  const options = await generateRegistrationOptions({
    rpName: "Open Personal Agent",
    rpID: new URL(c.req.url).hostname,
    userName: "owner",
    userID: encoder.encode(userId) as Uint8Array<ArrayBuffer>,
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  const cookie = await auth.putChallenge(c.env.DB, mode, options.challenge, userId, state.hash);
  const maxAge = auth.CHALLENGE_TTL_MS / 1000;
  setCookie(c, auth.CHALLENGE_COOKIE, cookie, { ...auth.COOKIE_OPTIONS, maxAge });
  c.header("Cache-Control", "no-store");
  return c.json({ mode, options });
});

/** Step 2: verify the passkey, then claim or recover in one transaction. */
setup.post("/", async (c) => {
  const state = await authorize(c);
  if (state instanceof Response) return state;
  const mode = state.mode as "claim" | "recovery";
  const db = c.env.DB;
  // A challenge issued under an earlier token is void: the token must not change mid-ceremony.
  const cookie = getCookie(c, auth.CHALLENGE_COOKIE);
  const challenge = await auth.takeChallenge(db, cookie, mode, state.hash);
  deleteCookie(c, auth.CHALLENGE_COOKIE, auth.COOKIE_OPTIONS);
  const userId = challenge?.user_id;
  if (!challenge || !userId) return c.json({ error: "no_challenge" }, 400);

  const url = new URL(c.req.url);
  const verification = await verifyRegistrationResponse({
    response: state.body.credential as RegistrationResponseJSON,
    expectedChallenge: challenge.challenge,
    expectedOrigin: url.origin,
    expectedRPID: url.hostname,
    requireUserVerification: true,
  }).catch(() => null);
  if (!verification?.verified) return c.json({ error: "not_verified" }, 400);

  const now = Date.now();
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const codes = Array.from({ length: auth.RECOVERY_CODE_COUNT }, auth.newRecoveryCode);
  const codeHashes = await Promise.all(codes.map(auth.hashRecoveryCode));
  const session = await auth.newSession(db, userId);
  const credentials = [
    db
      .prepare(
        "INSERT INTO passkeys (id, user_id, webauthn_user_id, public_key, counter, transports, device_type, backed_up) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        credential.id,
        userId,
        auth.base64url(encoder.encode(userId)),
        credential.publicKey,
        credential.counter,
        (credential.transports ?? []).join(","),
        credentialDeviceType,
        credentialBackedUp ? 1 : 0,
      ),
    ...codeHashes.map((hash) =>
      db
        .prepare("INSERT INTO recovery_codes (id, user_id, code_hash) VALUES (?, ?, ?)")
        .bind(auth.randomId(), userId, hash),
    ),
    session.insert,
    // Primary key: a token that is already recorded fails here and rolls back the batch.
    db.prepare("INSERT INTO used_setup_tokens (token_hash) VALUES (?)").bind(state.hash),
    db
      .prepare(
        "INSERT INTO audit_log (user_id, action, module, result) VALUES (?, ?, 'setup', 'ok')",
      )
      .bind(userId, `setup.${mode}`),
  ];

  // Onboarding asks for the owner's name after the claim (M2-15).
  const statements =
    mode === "claim"
      ? [
          db
            .prepare("INSERT INTO users (id, display_name, role) VALUES (?, 'Owner', 'owner')")
            .bind(userId),
          // The primary key makes this fail if another claim won, which rolls back the batch.
          db
            .prepare(
              "INSERT INTO setup_state (id, claim_token_hash, claimed_by_user_id, claimed_at) VALUES (1, ?, ?, ?)",
            )
            .bind(state.hash, userId, now),
          ...credentials,
        ]
      : [
          db
            .prepare(
              "UPDATE setup_state SET claim_token_hash = ?, updated_at = ? WHERE id = 1 AND claim_token_hash IS NOT ?",
            )
            .bind(state.hash, now, state.hash),
          // If a concurrent recovery already stored this hash, the update changed nothing: break
          // the single-row CHECK so the whole batch rolls back.
          db.prepare("INSERT INTO setup_state (id) SELECT 0 WHERE changes() = 0"),
          // Replace the owner's credentials and end every session. Data stays untouched.
          db.prepare("DELETE FROM passkeys WHERE user_id = ?").bind(userId),
          db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").bind(userId),
          db.prepare("UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL").bind(now),
          ...credentials,
        ];
  try {
    await db.batch(statements);
  } catch {
    return c.json({ error: "setup_conflict" }, 409);
  }

  const maxAge = auth.SESSION_ABSOLUTE_MS / 1000;
  setCookie(c, auth.SESSION_COOKIE, session.cookie, { ...auth.COOKIE_OPTIONS, maxAge });
  c.header("Cache-Control", "no-store");
  // The only time the codes leave the server in plaintext.
  return c.json({ mode, recoveryCodes: codes });
});
