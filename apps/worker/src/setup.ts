// SPDX-License-Identifier: Apache-2.0
// Claiming a deployment and recovering it (ADR 0010 D2, TWO-375 F14). The owner proves they hold
// `OPA_SETUP_TOKEN` in a POST body, never a URL, and registers a passkey. D1 keeps
// `sha256(token)` from claim time. Once that matches the secret, `/setup` is closed for good. If
// the operator rotates the secret, `/setup` reopens in recovery mode for the new token only. Every
// token that claimed or recovered is recorded, so putting an old one back never reopens `/setup`.
import { systemStore } from "@opa/db/system";
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
  // An unmigrated or unreachable database counts as unclaimed: fail closed. `isClaimed` is async,
  // so even a throwing `prepare` arrives here as a rejection.
  const claimed = await systemStore(c.env)
    .setup.isClaimed()
    .catch(() => false);
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
  const row = await systemStore(env).setup.state(hash);
  if (!row) return { mode: "claim", ownerId: null, hash };
  // A claimed row with no owner has nothing to recover, and a used token never opens recovery.
  if (row.claim_token_hash === hash || row.used || !row.claimed_by_user_id) {
    return { mode: "closed", ownerId: null, hash };
  }
  return { mode: "recovery", ownerId: row.claimed_by_user_id, hash };
}

/**
 * For `GET /setup`: which page to show. A weak secret keeps `/setup` closed whatever the state;
 * the setup POSTs already name it in their 503.
 */
export async function setupPageState(env: Env): Promise<"open" | "closed" | "weak_token"> {
  if (weakToken(env.OPA_SETUP_TOKEN ?? "")) return "weak_token";
  return (await readState(env)).mode === "closed" ? "closed" : "open";
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
    await systemStore(c.env).audit(null, "setup.token", "setup", "denied");
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
  const cookie = await auth.putChallenge(
    systemStore(c.env),
    mode,
    options.challenge,
    userId,
    state.hash,
  );
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
  const store = systemStore(c.env);
  // A challenge issued under an earlier token is void: the token must not change mid-ceremony.
  const cookie = getCookie(c, auth.CHALLENGE_COOKIE);
  const challenge = await auth.takeChallenge(store, cookie, mode, state.hash);
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

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const codes = Array.from({ length: auth.RECOVERY_CODE_COUNT }, auth.newRecoveryCode);
  const codeHashes = await Promise.all(codes.map(auth.hashRecoveryCode));
  const session = await auth.newSession(userId);
  const owner = {
    userId,
    tokenHash: state.hash,
    passkey: {
      id: credential.id,
      webauthnUserId: auth.base64url(encoder.encode(userId)),
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: (credential.transports ?? []).join(","),
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
    },
    recoveryCodes: codeHashes.map((hash) => ({ id: auth.randomId(), hash })),
    session: session.row,
    now: Date.now(),
  };
  try {
    await (mode === "claim" ? store.setup.claim(owner) : store.setup.recover(owner));
  } catch {
    return c.json({ error: "setup_conflict" }, 409);
  }

  const maxAge = auth.SESSION_ABSOLUTE_MS / 1000;
  setCookie(c, auth.SESSION_COOKIE, session.cookie, { ...auth.COOKIE_OPTIONS, maxAge });
  c.header("Cache-Control", "no-store");
  // The only time the codes leave the server in plaintext.
  return c.json({ mode, recoveryCodes: codes });
});
