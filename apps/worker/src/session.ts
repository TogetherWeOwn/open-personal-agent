// SPDX-License-Identifier: Apache-2.0
// Passkey login, sessions and the route-auth guard (ADR 0010 D2). The guard denies by default:
// a route is reachable without a session only if it is on `PUBLIC_ROUTES`, so a new route that
// forgets to declare itself stays closed. test/routes.test.ts enumerates the route table.
import { systemStore } from "@opa/db/system";
import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import * as auth from "./auth";
import type { AppEnv } from "./env";

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
const IDLE_MS = 30 * 86_400_000;
/** `last_seen_at` is written at most this often, so reads don't each cost a D1 write. */
const TOUCH_MS = 60 * 60_000;

/**
 * Runs on every route after the claim guard. Every state change needs an exact Origin match:
 * same-site is never enough. Then every route not on the public list needs a live session.
 */
export const sessionGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method) && c.req.header("Origin") !== new URL(c.req.url).origin) {
    return c.json({ error: "bad_origin" }, 403);
  }
  // Hono answers HEAD with the GET handler, so the list's GET entries cover HEAD too.
  const method = c.req.method === "HEAD" ? "GET" : c.req.method;
  if (PUBLIC_ROUTES.has(`${method} ${c.req.path}`)) return next();
  const cookie = getCookie(c, auth.SESSION_COOKIE);
  if (!cookie) return c.json({ error: "unauthenticated" }, 401);
  const now = Date.now();
  const store = systemStore(c.env);
  const row = await store.sessions.find(await auth.sha256(cookie), now, now - IDLE_MS);
  if (!row) return c.json({ error: "unauthenticated" }, 401);
  if (now - row.last_seen_at > TOUCH_MS) await store.sessions.touch(row.id, now);
  c.set("session", { id: row.id, userId: row.user_id, scope: row.scope });
  return next();
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
  const url = new URL(c.req.url);
  const verification =
    passkey &&
    (await verifyAuthenticationResponse({
      response: response as AuthenticationResponseJSON,
      expectedChallenge: challenge.challenge,
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
    }).catch(() => null));
  if (!passkey || !verification?.verified) {
    await store.audit(passkey?.user_id ?? null, "auth.login", "auth", "denied");
    return c.json({ error: "not_verified" }, 401);
  }

  // Rotation: a login never keeps a session ID the browser already had (no fixation).
  const previous = getCookie(c, auth.SESSION_COOKIE);
  const session = await auth.newSession(passkey.user_id);
  await store.sessions.login({
    passkeyId: passkey.id,
    counter: verification.authenticationInfo.newCounter,
    previousTokenHash: await auth.sha256(previous ?? ""),
    session: session.row,
    now: Date.now(),
  });
  const maxAge = auth.SESSION_ABSOLUTE_MS / 1000;
  setCookie(c, auth.SESSION_COOKIE, session.cookie, { ...auth.COOKIE_OPTIONS, maxAge });
  c.header("Cache-Control", "no-store");
  return c.json({ ok: true });
});

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
