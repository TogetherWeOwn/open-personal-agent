// SPDX-License-Identifier: Apache-2.0
// Passkey login, session cookies, rotation, timeouts, logout, the session list and sign out
// everywhere (ADR 0010 D2).
import { systemStore } from "@opa/db/system";
import { CHALLENGE_COOKIE, SESSION_COOKIE, sha256 } from "@opa/server/auth";
import { describe, expect, it } from "vitest";
import { Browser, claim, count, db, env, freshDatabase, passkey } from "./helpers/app";

freshDatabase();

type Options = { options: { challenge: string } };
type SessionList = { sessions: { id: string; current: boolean }[] };
const DAY = 86_400_000;

async function login() {
  const { key, owner } = await claim();
  const br = new Browser();
  const res = await br.login(key);
  expect(res.status).toBe(200);
  return { br, key, owner, cookie: br.cookies.get(SESSION_COOKIE) as string };
}

describe("passkey login", () => {
  it("issues a hashed __Host- session with the right flags", async () => {
    const { br, owner, cookie } = await login();
    const set = br.setCookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(set).toMatch(/; Max-Age=7776000; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    expect(set).not.toMatch(/Domain=/i);
    expect(cookie).toMatch(/^[\w-]{43}$/); // 256 bits
    expect(await count("sessions", `token_hash = '${await sha256(cookie)}'`)).toBe(1);
    expect(await count("sessions", `token_hash = '${cookie}'`)).toBe(0);
    const me = await br.req("/api/me");
    expect(await me.json()).toEqual({ id: owner, displayName: "Owner", role: "owner" });
    expect(await count("audit_log", "action = 'auth.login' AND result = 'ok'")).toBe(1);
    expect(await db.prepare("SELECT counter FROM passkeys").first("counter")).toBe(1);
  });

  it("rejects an unknown passkey, a missing UV flag and a foreign origin", async () => {
    const { key } = await claim();
    expect((await new Browser().login(key, { uv: false })).status).toBe(401);
    expect((await new Browser().login(key, { origin: "https://evil.test" })).status).toBe(401);
    const stranger = passkey();
    await stranger.create({ challenge: "x" });
    expect((await new Browser().login(stranger)).status).toBe(401);
    expect(await count("sessions")).toBe(1); // only the claim's
    expect(await count("audit_log", "action = 'auth.login' AND result = 'denied'")).toBe(3);
  });

  it("rejects a cloned authenticator whose counter went backwards", async () => {
    const { key } = await login();
    key.counter = 0;
    expect((await new Browser().login(key)).status).toBe(401);
  });

  it("uses a challenge once", async () => {
    const { key } = await claim();
    const br = new Browser();
    const { options } = await (
      await br.req("/api/auth/login/options", { body: {} })
    ).json<Options>();
    const challenge = br.cookies.get(CHALLENGE_COOKIE) as string;
    const credential = await key.get(options);
    expect((await br.req("/api/auth/login", { body: { credential } })).status).toBe(200);
    br.cookies.set(CHALLENGE_COOKIE, challenge);
    const replay = await br.req("/api/auth/login", { body: { credential } });
    expect(await replay.json()).toEqual({ error: "no_challenge" });
    expect(await count("audit_log", "action = 'auth.login' AND result = 'denied'")).toBe(1);
  });

  it("purges expired challenges", async () => {
    await claim();
    await db
      .prepare(
        "INSERT INTO webauthn_challenges (id_hash, kind, challenge, expires_at) VALUES ('old', 'login', 'c', 1)",
      )
      .run();
    await new Browser().req("/api/auth/login/options", { body: {} });
    expect(await count("webauthn_challenges", "id_hash = 'old'")).toBe(0);
  });

  it("rotates: a login revokes the session the browser already held", async () => {
    const { br, key, cookie } = await login();
    expect((await br.login(key)).status).toBe(200);
    const fresh = br.cookies.get(SESSION_COOKIE) as string;
    expect(fresh).not.toBe(cookie);
    const stale = new Browser();
    stale.cookies.set(SESSION_COOKIE, cookie);
    expect((await stale.req("/api/me")).status).toBe(401);
    expect((await br.req("/api/me")).status).toBe(200);
  });
});

describe("the exact-Origin check", () => {
  it("rejects a state change from a sibling origin or with no Origin", async () => {
    const { br } = await login();
    for (const origin of ["https://evil.opa.test", "http://opa.test", "null", null]) {
      const res = await br.req("/api/auth/logout", { body: {}, origin });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "bad_origin" });
    }
    const res = await br.req("/api/auth/login/options", { body: {}, origin: "https://evil.test" });
    expect(res.status).toBe(403);
    expect((await br.req("/api/me")).status).toBe(200);
  });
});

describe("timeouts", () => {
  it("ends a session after 30 idle days", async () => {
    const { br } = await login();
    await db
      .prepare("UPDATE sessions SET last_seen_at = ?")
      .bind(Date.now() - 31 * DAY)
      .run();
    expect((await br.req("/api/me")).status).toBe(401);
  });

  it("answers an open socket's recheck by the same rules", async () => {
    const { br, owner } = await login();
    const id = (await db.prepare("SELECT id FROM sessions").first<string>("id")) as string;
    const live = () => systemStore(env).sessions.isLive(id, owner, Date.now());
    expect([await live(), await systemStore(env).sessions.isLive(id, "other", Date.now())]).toEqual(
      [true, false],
    );
    await db
      .prepare("UPDATE sessions SET last_seen_at = ?")
      .bind(Date.now() - 31 * DAY)
      .run();
    expect(await live()).toBe(false);
    expect((await br.req("/api/me")).status).toBe(401);
  });

  it("ends a session after 90 days however active", async () => {
    const { br } = await login();
    await db
      .prepare("UPDATE sessions SET expires_at = ?")
      .bind(Date.now() - 1)
      .run();
    expect((await br.req("/api/me")).status).toBe(401);
  });

  it("records activity at most hourly", async () => {
    const { br, cookie } = await login();
    const hash = await sha256(cookie);
    const seen = () =>
      db
        .prepare("SELECT last_seen_at FROM sessions WHERE token_hash = ?")
        .bind(hash)
        .first<number>("last_seen_at");
    await db
      .prepare("UPDATE sessions SET last_seen_at = ?")
      .bind(Date.now() - 2 * 3_600_000)
      .run();
    await br.req("/api/me");
    const touched = (await seen()) as number;
    expect(Date.now() - touched).toBeLessThan(60_000);
    await br.req("/api/me");
    expect(await seen()).toBe(touched);
  });
});

describe("logout and session management", () => {
  it("logs out: revokes the session and clears the cookie", async () => {
    const { br, cookie } = await login();
    const res = await br.req("/api/auth/logout", { body: {} });
    expect(res.status).toBe(200);
    expect(br.setCookies.join()).toMatch(new RegExp(`${SESSION_COOKIE}=; Max-Age=0`));
    const replay = new Browser();
    replay.cookies.set(SESSION_COOKIE, cookie);
    expect((await replay.req("/api/me")).status).toBe(401);
  });

  it("lists the user's sessions and revokes another one", async () => {
    const { br: laptop, key } = await login();
    const phone = new Browser();
    expect((await phone.login(key)).status).toBe(200);
    const list = await (await laptop.req("/api/sessions")).json<SessionList>();
    expect(list.sessions).toHaveLength(3); // the claim's, the laptop's and the phone's
    expect(list.sessions.filter((s) => s.current)).toHaveLength(1);
    const phoneId = (await db
      .prepare("SELECT id FROM sessions WHERE token_hash = ?")
      .bind(await sha256(phone.cookies.get(SESSION_COOKIE) as string))
      .first<string>("id")) as string;
    expect(JSON.stringify(list)).not.toContain(phone.cookies.get(SESSION_COOKIE));

    const res = await laptop.req(`/api/sessions/${phoneId}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await phone.req("/api/me")).status).toBe(401);
    expect((await laptop.req("/api/me")).status).toBe(200);
    expect((await laptop.req(`/api/sessions/${phoneId}`, { method: "DELETE" })).status).toBe(404);
  });

  it("revokes a session and audits it in one transaction", async () => {
    const { br } = await login();
    const current = (await db
      .prepare("SELECT id FROM sessions WHERE token_hash = ?")
      .bind(await sha256(br.cookies.get(SESSION_COOKIE) as string))
      .first<string>("id")) as string;
    await db
      .prepare(
        "CREATE TRIGGER fail_revoke_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'auth.session_revoke' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
      )
      .run();
    try {
      const failed = await br.req(`/api/sessions/${current}`, { method: "DELETE" });
      expect(failed.status).toBe(500);
      // The failed audit rolled the revocation back, so the session still works and can retry.
      expect(await count("sessions", `id = '${current}' AND revoked_at IS NULL`)).toBe(1);
    } finally {
      await db.prepare("DROP TRIGGER fail_revoke_audit").run();
    }
    const retry = await br.req(`/api/sessions/${current}`, { method: "DELETE" });
    expect(retry.status).toBe(200);
    expect(br.setCookies.join()).toMatch(new RegExp(`${SESSION_COOKIE}=; Max-Age=0`));
    expect(await count("audit_log", "action = 'auth.session_revoke' AND result = 'ok'")).toBe(1);
  });

  it("can't revoke another user's session", async () => {
    const { br } = await login();
    await db.batch([
      db.prepare("INSERT INTO users (id, display_name, role) VALUES ('u2', 'Other', 'member')"),
      db
        .prepare(
          "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ('s2', 'u2', 'h2', ?)",
        )
        .bind(Date.now() + DAY),
    ]);
    expect((await br.req("/api/sessions/s2", { method: "DELETE" })).status).toBe(404);
    expect(await count("audit_log", "action = 'auth.session_revoke' AND result = 'ok'")).toBe(0);
    expect(await count("sessions", "id = 's2' AND revoked_at IS NULL")).toBe(1);
    const list = await (await br.req("/api/sessions")).json<SessionList>();
    expect(list.sessions.map((s) => s.id)).not.toContain("s2");
  });

  it("signs out everywhere, this browser included", async () => {
    const { br, key } = await login();
    const other = new Browser();
    await other.login(key);
    expect((await br.req("/api/sessions/revoke-all", { body: {} })).status).toBe(200);
    expect(await count("sessions", "revoked_at IS NULL")).toBe(0);
    expect((await br.req("/api/me")).status).toBe(401);
    expect((await other.req("/api/me")).status).toBe(401);
    expect(await count("audit_log", "action = 'auth.sign_out_everywhere'")).toBe(1);
  });
});
