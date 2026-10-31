// SPDX-License-Identifier: Apache-2.0
// Spike A: @simplewebauthn/server for the ceremony, our own session layer on D1 (ADR 0010 D2).
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

type Env = { DB: D1Database; RP_ID: string; ORIGIN: string };
type Vars = { userId: string; sessionHash: string };

const SESSION = "__Host-opa_session";
const CHALLENGE = "__Host-opa_webauthn";
const IDLE_MS = 30 * 864e5;
const ABSOLUTE_MS = 90 * 864e5;
const CHALLENGE_MS = 5 * 60e3;
const TOUCH_MS = 60e3; // write last_seen_at at most once a minute

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomId = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const sha256 = async (s: string) =>
  b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
const cookieOpts = { path: "/", secure: true, httpOnly: true, sameSite: "Lax" } as const;

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// Exact-Origin check on every state change; same-site is not enough.
app.use("*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.header("Origin") !== c.env.ORIGIN) {
    return c.json({ error: "bad_origin" }, 403);
  }
  await next();
});

async function putChallenge(c: { env: Env }, kind: "register" | "login", challenge: string, userId: string | null) {
  const id = randomId();
  await c.env.DB.prepare("INSERT INTO webauthn_challenges VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256(id), kind, challenge, userId, Date.now() + CHALLENGE_MS)
    .run();
  return id;
}

// Single use: DELETE ... RETURNING consumes the row atomically.
async function takeChallenge(env: Env, id: string | undefined, kind: string) {
  if (!id) return null;
  return env.DB.prepare(
    "DELETE FROM webauthn_challenges WHERE id_hash = ? AND kind = ? AND expires_at > ? RETURNING challenge, user_id",
  )
    .bind(await sha256(id), kind, Date.now())
    .first<{ challenge: string; user_id: string | null }>();
}

async function startSession(env: Env, userId: string) {
  const id = randomId();
  const now = Date.now();
  await env.DB.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").bind(await sha256(id), userId, now, now).run();
  return id;
}

// Spike only: /setup is gated by OPA_SETUP_TOKEN in M2-09.
app.post("/api/auth/register/options", async (c) => {
  const userId = crypto.randomUUID();
  const options = await generateRegistrationOptions({
    rpName: "Open Personal Agent",
    rpID: c.env.RP_ID,
    userName: "owner",
    userID: new TextEncoder().encode(userId),
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  setCookie(c, CHALLENGE, await putChallenge(c, "register", options.challenge, userId), {
    ...cookieOpts,
    maxAge: CHALLENGE_MS / 1000,
  });
  return c.json(options);
});

app.post("/api/auth/register/verify", async (c) => {
  const ch = await takeChallenge(c.env, getCookie(c, CHALLENGE), "register");
  deleteCookie(c, CHALLENGE, cookieOpts);
  if (!ch?.user_id) return c.json({ error: "no_challenge" }, 400);
  const v = await verifyRegistrationResponse({
    response: await c.req.json(),
    expectedChallenge: ch.challenge,
    expectedOrigin: c.env.ORIGIN,
    expectedRPID: c.env.RP_ID,
    requireUserVerification: true,
  }).catch(() => null);
  if (!v?.verified) return c.json({ error: "not_verified" }, 400);
  const { credential, credentialBackedUp } = v.registrationInfo;
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO users VALUES (?, ?)").bind(ch.user_id, now),
    c.env.DB.prepare("INSERT INTO passkeys VALUES (?, ?, ?, ?, ?, ?, ?, NULL)").bind(
      credential.id,
      ch.user_id,
      credential.publicKey,
      credential.counter,
      (credential.transports ?? []).join(","),
      credentialBackedUp ? 1 : 0,
      now,
    ),
  ]);
  setCookie(c, SESSION, await startSession(c.env, ch.user_id), { ...cookieOpts, maxAge: ABSOLUTE_MS / 1000 });
  return c.json({ ok: true });
});

app.post("/api/auth/login/options", async (c) => {
  const options = await generateAuthenticationOptions({ rpID: c.env.RP_ID, userVerification: "required" });
  setCookie(c, CHALLENGE, await putChallenge(c, "login", options.challenge, null), {
    ...cookieOpts,
    maxAge: CHALLENGE_MS / 1000,
  });
  return c.json(options);
});

app.post("/api/auth/login/verify", async (c) => {
  const ch = await takeChallenge(c.env, getCookie(c, CHALLENGE), "login");
  deleteCookie(c, CHALLENGE, cookieOpts);
  if (!ch) return c.json({ error: "no_challenge" }, 400);
  const body = await c.req.json<{ id: string }>();
  const pk = await c.env.DB.prepare("SELECT * FROM passkeys WHERE id = ?")
    .bind(body.id)
    .first<{ id: string; user_id: string; public_key: ArrayBuffer; counter: number; transports: string }>();
  if (!pk) return c.json({ error: "unknown_credential" }, 400);
  const v = await verifyAuthenticationResponse({
    // biome-ignore lint/suspicious/noExplicitAny: JSON from the browser
    response: body as any,
    expectedChallenge: ch.challenge,
    expectedOrigin: c.env.ORIGIN,
    expectedRPID: c.env.RP_ID,
    requireUserVerification: true,
    credential: {
      id: pk.id,
      publicKey: new Uint8Array(pk.public_key),
      counter: pk.counter,
      // biome-ignore lint/suspicious/noExplicitAny: stored as CSV
      transports: pk.transports.split(",").filter(Boolean) as any,
    },
  }).catch(() => null);
  if (!v?.verified) return c.json({ error: "not_verified" }, 400);
  await c.env.DB.prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?")
    .bind(v.authenticationInfo.newCounter, Date.now(), pk.id)
    .run();
  setCookie(c, SESSION, await startSession(c.env, pk.user_id), { ...cookieOpts, maxAge: ABSOLUTE_MS / 1000 });
  return c.json({ ok: true });
});

// Session guard: hashed lookup, 30 d idle, 90 d absolute, throttled sliding touch.
const auth = new Hono<{ Bindings: Env; Variables: Vars }>();
auth.use("*", async (c, next) => {
  const id = getCookie(c, SESSION);
  if (!id) return c.json({ error: "unauthenticated" }, 401);
  const hash = await sha256(id);
  const now = Date.now();
  const s = await c.env.DB.prepare(
    "SELECT user_id, last_seen_at FROM sessions WHERE id_hash = ? AND last_seen_at > ? AND created_at > ?",
  )
    .bind(hash, now - IDLE_MS, now - ABSOLUTE_MS)
    .first<{ user_id: string; last_seen_at: number }>();
  if (!s) return c.json({ error: "unauthenticated" }, 401);
  if (now - s.last_seen_at > TOUCH_MS) {
    c.executionCtx.waitUntil(
      c.env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?").bind(now, hash).run(),
    );
  }
  c.set("userId", s.user_id);
  c.set("sessionHash", hash);
  await next();
});
auth.get("/me", (c) => c.json({ userId: c.get("userId") }));
auth.post("/logout", async (c) => {
  await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(c.get("sessionHash")).run();
  deleteCookie(c, SESSION, cookieOpts);
  return c.json({ ok: true });
});
auth.post("/logout-everywhere", async (c) => {
  await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(c.get("userId")).run();
  deleteCookie(c, SESSION, cookieOpts);
  return c.json({ ok: true });
});
app.route("/api", auth);

export default app;
