// SPDX-License-Identifier: Apache-2.0
// Passkey login, sessions and the route-auth guard (ADR 0010 D2). The guard denies by default:
// a route is reachable without a session only if it is on `PUBLIC_ROUTES`, so a new route that
// forgets to declare itself stays closed. test/routes.test.ts enumerates the route table.
import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { type Context, Hono, type MiddlewareHandler } from "hono";
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
  const row = await c.env.DB.prepare(
    `SELECT id, user_id, last_seen_at FROM sessions
     WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ? AND last_seen_at > ?`,
  )
    .bind(await auth.sha256(cookie), now, now - IDLE_MS)
    .first<{ id: string; user_id: string; last_seen_at: number }>();
  if (!row) return c.json({ error: "unauthenticated" }, 401);
  if (now - row.last_seen_at > TOUCH_MS) {
    await c.env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?")
      .bind(now, row.id)
      .run();
  }
  c.set("session", { id: row.id, userId: row.user_id });
  return next();
};

function audit(c: Context<AppEnv>, userId: string | null, action: string, result: string) {
  return c.env.DB.prepare(
    "INSERT INTO audit_log (user_id, action, module, result) VALUES (?, ?, 'auth', ?)",
  ).bind(userId, action, result);
}

export const authRoutes = new Hono<AppEnv>();

/** Step 1: a challenge for any of the user's discoverable passkeys. */
authRoutes.post("/login/options", async (c) => {
  const options = await generateAuthenticationOptions({
    rpID: new URL(c.req.url).hostname,
    userVerification: "required",
  });
  const cookie = await auth.putChallenge(c.env.DB, "login", options.challenge, null);
  const maxAge = auth.CHALLENGE_TTL_MS / 1000;
  setCookie(c, auth.CHALLENGE_COOKIE, cookie, { ...auth.COOKIE_OPTIONS, maxAge });
  c.header("Cache-Control", "no-store");
  return c.json({ options });
});

/** Step 2: verify the assertion, then issue a new session and revoke any the browser held. */
authRoutes.post("/login", async (c) => {
  const db = c.env.DB;
  const challenge = await auth.takeChallenge(db, getCookie(c, auth.CHALLENGE_COOKIE), "login");
  deleteCookie(c, auth.CHALLENGE_COOKIE, auth.COOKIE_OPTIONS);
  if (!challenge) {
    await audit(c, null, "auth.login", "denied").run();
    return c.json({ error: "no_challenge" }, 400);
  }

  const body = await c.req.json().catch(() => null);
  const response = body?.credential as AuthenticationResponseJSON | undefined;
  const passkey = await db
    .prepare("SELECT id, user_id, public_key, counter, transports FROM passkeys WHERE id = ?")
    .bind(typeof response?.id === "string" ? response.id : "")
    .first<{
      id: string;
      user_id: string;
      public_key: ArrayBuffer | number[];
      counter: number;
      transports: string | null;
    }>();
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
    await audit(c, passkey?.user_id ?? null, "auth.login", "denied").run();
    return c.json({ error: "not_verified" }, 401);
  }

  // Rotation: a login never keeps a session ID the browser already had (no fixation).
  const previous = getCookie(c, auth.SESSION_COOKIE);
  const session = await auth.newSession(db, passkey.user_id);
  const now = Date.now();
  await db.batch([
    db
      .prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?")
      .bind(verification.authenticationInfo.newCounter, now, passkey.id),
    db
      .prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
      .bind(now, await auth.sha256(previous ?? "")),
    session.insert,
    audit(c, passkey.user_id, "auth.login", "ok"),
  ]);
  const maxAge = auth.SESSION_ABSOLUTE_MS / 1000;
  setCookie(c, auth.SESSION_COOKIE, session.cookie, { ...auth.COOKIE_OPTIONS, maxAge });
  c.header("Cache-Control", "no-store");
  return c.json({ ok: true });
});

authRoutes.post("/logout", async (c) => {
  const { id, userId } = c.var.session;
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?").bind(Date.now(), id),
    audit(c, userId, "auth.logout", "ok"),
  ]);
  deleteCookie(c, auth.SESSION_COOKIE, auth.COOKIE_OPTIONS);
  return c.json({ ok: true });
});

export const sessionRoutes = new Hono<AppEnv>();

/** The user's live sessions, newest first. IDs are row IDs, never the cookie or its hash. */
sessionRoutes.get("/", async (c) => {
  const { id, userId } = c.var.session;
  const now = Date.now();
  const { results } = await c.env.DB.prepare(
    `SELECT id, created_at, last_seen_at, expires_at FROM sessions
     WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? AND last_seen_at > ?
     ORDER BY created_at DESC`,
  )
    .bind(userId, now, now - IDLE_MS)
    .all<{ id: string; created_at: number; last_seen_at: number; expires_at: number }>();
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
  const update = await c.env.DB.prepare(
    "UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
  )
    .bind(Date.now(), target, userId)
    .run();
  const revoked = update.meta.changes > 0;
  await audit(c, userId, "auth.session_revoke", revoked ? "ok" : "denied").run();
  if (!revoked) return c.json({ error: "not_found" }, 404);
  if (target === id) deleteCookie(c, auth.SESSION_COOKIE, auth.COOKIE_OPTIONS);
  return c.json({ ok: true });
});

/** Sign out everywhere: every session of this user, this one included. */
sessionRoutes.post("/revoke-all", async (c) => {
  const { userId } = c.var.session;
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
    ).bind(Date.now(), userId),
    audit(c, userId, "auth.sign_out_everywhere", "ok"),
  ]);
  deleteCookie(c, auth.SESSION_COOKIE, auth.COOKIE_OPTIONS);
  return c.json({ ok: true });
});
