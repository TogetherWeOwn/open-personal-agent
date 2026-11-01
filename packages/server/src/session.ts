// SPDX-License-Identifier: Apache-2.0
// Passkey login, sessions and the route-auth guard (ADR 0010 D2). The guard denies by default:
// a route is reachable without a session only if it is on `PUBLIC_ROUTES`, so a new route that
// forgets to declare itself stays closed. apps/worker/test/routes.test.ts enumerates the route
// table.
import { SESSION_IDLE_MS as IDLE_MS, type SystemStore, systemStore } from "@opa/db/system";
import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import * as auth from "./auth";
import type { AppEnv, Session } from "./env";
import { sameOrigin } from "./security";

/** The only routes that answer without a session, as `METHOD /path`. Keep this list exact. */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  "GET /api/health",
  "GET /setup",
  "POST /setup",
  "POST /setup/options",
  "POST /api/auth/login/options",
  "POST /api/auth/login",
  "POST /api/auth/recover/options",
  "POST /api/auth/recover",
]);

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** `last_seen_at` is written at most this often, so reads don't each cost a D1 write. */
const TOUCH_MS = 60 * 60_000;

/**
 * Runs on every route after the claim guard. Every state change needs an exact Origin match:
 * same-site is never enough. Then every route not on the public list needs a live session.
 */
export const sessionGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method) && !sameOrigin(c)) {
    return c.json({ error: "bad_origin" }, 403);
  }
  // Hono answers HEAD with the GET handler, so the list's GET entries cover HEAD too.
  const method = c.req.method === "HEAD" ? "GET" : c.req.method;
  if (PUBLIC_ROUTES.has(`${method} ${c.req.path}`)) return next();
  const session = await currentSession(c);
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  c.set("session", session);
  return next();
};

/** The live session the request's cookie names, or `null`. Public routes may call it themselves. */
export async function currentSession(c: Context<AppEnv>): Promise<Session | null> {
  const cookie = getCookie(c, auth.SESSION_COOKIE);
  if (!cookie) return null;
  const now = Date.now();
  const store = systemStore(c.env);
  const row = await store.sessions.find(await auth.sha256(cookie), now, now - IDLE_MS);
  if (!row) return null;
  if (now - row.last_seen_at > TOUCH_MS) await store.sessions.touch(row.id, now);
  return { id: row.id, userId: row.user_id, scope: row.scope, stepUpAt: row.step_up_at };
}

/**
 * Whether the session confirmed a passkey within the account step-up window. A future stamp
 * fails closed: without the lower bound it would stay valid until stamp + the window.
 */
export const hasStepUp = (session: Session, now = Date.now()) => {
  if (session.stepUpAt === null) return false;
  const age = now - session.stepUpAt;
  return age >= 0 && age < auth.STEP_UP_MS;
};

export const authRoutes = new Hono<AppEnv>();

/** Step 1: a challenge for any of the user's discoverable passkeys. */
authRoutes.post("/login/options", async (c) => {
  const options = await generateAuthenticationOptions({
    rpID: new URL(c.req.url).hostname,
    userVerification: "required",
  });
  const cookie = await auth.putChallenge(systemStore(c.env), "login", options.challenge, null);
  const maxAge = auth.CHALLENGE_TTL_MS / 1000;
  setCookie(c, auth.CHALLENGE_COOKIE, cookie, { ...auth.COOKIE_OPTIONS, maxAge });
  c.header("Cache-Control", "no-store");
  return c.json({ options });
});

/** Step 2: verify the assertion, then issue a new session and revoke any the browser held. */
authRoutes.post("/login", async (c) => {
  const store = systemStore(c.env);
  const challenge = await auth.takeChallenge(store, getCookie(c, auth.CHALLENGE_COOKIE), "login");
  deleteCookie(c, auth.CHALLENGE_COOKIE, auth.COOKIE_OPTIONS);
  if (!challenge) {
    await store.audit(null, "auth.login", "auth", "denied");
    return c.json({ error: "no_challenge" }, 400);
  }

  const body = await c.req.json().catch(() => null);
  const response = body?.credential as AuthenticationResponseJSON | undefined;
  const passkey = await store.passkeys.get(typeof response?.id === "string" ? response.id : "");
  const counter = passkey && (await verifyAssertion(c, passkey, response, challenge.challenge));
  if (!passkey || counter === null) {
    await store.audit(passkey?.user_id ?? null, "auth.login", "auth", "denied");
    return c.json({ error: "not_verified" }, 401);
  }

  // Rotation: a login never keeps a session ID the browser already had (no fixation).
  const previous = getCookie(c, auth.SESSION_COOKIE);
  const session = await auth.newSession(passkey.user_id);
  await store.sessions.login({
    passkeyId: passkey.id,
    counter,
    previousTokenHash: await auth.sha256(previous ?? ""),
    session: session.row,
    now: Date.now(),
  });
  const maxAge = auth.SESSION_ABSOLUTE_MS / 1000;
  setCookie(c, auth.SESSION_COOKIE, session.cookie, { ...auth.COOKIE_OPTIONS, maxAge });
  c.header("Cache-Control", "no-store");
  return c.json({ ok: true });
});

/**
 * Step-up, step 1: a challenge for one of the signed-in user's own passkeys. The account actions
 * (loosening a tool, and in M3-19 and M3-20 credential changes, export and deletion) need one.
 */
authRoutes.post("/step-up/options", async (c) => {
  const { userId } = c.var.session;
  const store = systemStore(c.env);
  const options = await generateAuthenticationOptions({
    rpID: new URL(c.req.url).hostname,
    userVerification: "required",
    allowCredentials: (await store.passkeys.ofUser(userId)).map((p) => ({
      id: p.id,
      transports: (p.transports?.split(",").filter(Boolean) ?? []) as AuthenticatorTransport[],
    })),
  });
  const cookie = await auth.putChallenge(store, "step_up", options.challenge, userId);
  const maxAge = auth.CHALLENGE_TTL_MS / 1000;
  setCookie(c, auth.CHALLENGE_COOKIE, cookie, { ...auth.COOKIE_OPTIONS, maxAge });
  c.header("Cache-Control", "no-store");
  return c.json({ options });
});

/**
 * Step-up, step 2: the assertion must come from a passkey of the session's user, for a challenge
 * issued to that user. It stamps this session only: another session of the same user, or a new
 * login, has to step up for itself.
 */
authRoutes.post("/step-up", async (c) => {
  const { id, userId } = c.var.session;
  const store = systemStore(c.env);
  const challenge = await auth.takeChallenge(store, getCookie(c, auth.CHALLENGE_COOKIE), "step_up");
  deleteCookie(c, auth.CHALLENGE_COOKIE, auth.COOKIE_OPTIONS);
  c.header("Cache-Control", "no-store");
  if (!challenge || challenge.user_id !== userId) {
    await store.audit(userId, "auth.step_up", "auth", "denied");
    return c.json({ error: "no_challenge" }, 400);
  }
  const body = await c.req.json().catch(() => null);
  const response = body?.credential as AuthenticationResponseJSON | undefined;
  const found = await store.passkeys.get(typeof response?.id === "string" ? response.id : "");
  const passkey = found?.user_id === userId ? found : null;
  const counter = passkey && (await verifyAssertion(c, passkey, response, challenge.challenge));
  if (!passkey || counter === null) {
    await store.audit(userId, "auth.step_up", "auth", "denied");
    return c.json({ error: "not_verified" }, 401);
  }
  const now = Date.now();
  await store.sessions.stepUp({ id, userId, passkeyId: passkey.id, counter, now });
  return c.json({ ok: true, expiresAt: now + auth.STEP_UP_MS });
});

type StoredPasskey = NonNullable<Awaited<ReturnType<SystemStore["passkeys"]["get"]>>>;

/**
 * Verifies an assertion by `passkey` over `challenge`, from this origin, with user verification
 * and a counter that moved on if it counts. The new counter, or `null` if it doesn't verify.
 */
export async function verifyAssertion(
  c: Context<AppEnv>,
  passkey: StoredPasskey,
  response: AuthenticationResponseJSON | undefined,
  challenge: string,
): Promise<number | null> {
  const url = new URL(c.req.url);
  const verification = await verifyAuthenticationResponse({
    response: response as AuthenticationResponseJSON,
    expectedChallenge: challenge,
    expectedOrigin: url.origin,
    expectedRPID: url.hostname,
    requireUserVerification: true,
    credential: {
      id: passkey.id,
      publicKey: new Uint8Array(passkey.public_key),
      counter: passkey.counter,
      transports: (passkey.transports?.split(",").filter(Boolean) ??
        []) as AuthenticatorTransport[],
    },
  }).catch(() => null);
  return verification?.verified ? verification.authenticationInfo.newCounter : null;
}

authRoutes.post("/logout", async (c) => {
  const { id, userId } = c.var.session;
  await systemStore(c.env).sessions.logout(id, userId, Date.now());
  deleteCookie(c, auth.SESSION_COOKIE, auth.COOKIE_OPTIONS);
  return c.json({ ok: true });
});

export const sessionRoutes = new Hono<AppEnv>();

/** The user's live sessions, newest first. IDs are row IDs, never the cookie or its hash. */
sessionRoutes.get("/", async (c) => {
  const { id, userId } = c.var.session;
  const now = Date.now();
  const results = await systemStore(c.env).sessions.list(userId, now, now - IDLE_MS);
  c.header("Cache-Control", "no-store");
  return c.json({
    sessions: results.map((s) => ({
      id: s.id,
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      expiresAt: s.expires_at,
      current: s.id === id,
    })),
  });
});

/** Revokes one of the user's own sessions. Another user's session ID is a 404. */
sessionRoutes.delete("/:id", async (c) => {
  const { id, userId } = c.var.session;
  const target = c.req.param("id");
  // If the audit fails, the revocation rolls back with it and the client can retry.
  if (!(await systemStore(c.env).sessions.revoke(target, userId, Date.now())))
    return c.json({ error: "not_found" }, 404);
  if (target === id) deleteCookie(c, auth.SESSION_COOKIE, auth.COOKIE_OPTIONS);
  return c.json({ ok: true });
});

/** Sign out everywhere: every session of this user, this one included. */
sessionRoutes.post("/revoke-all", async (c) => {
  const { userId } = c.var.session;
  await systemStore(c.env).sessions.revokeAll(userId, Date.now());
  deleteCookie(c, auth.SESSION_COOKIE, auth.COOKIE_OPTIONS);
  return c.json({ ok: true });
});
