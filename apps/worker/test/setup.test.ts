// SPDX-License-Identifier: Apache-2.0
// R7 M2-2 (setup claim) and TWO-375 M2-12 (POST-only setup, recovery mode on rotation).
import { describe, expect, it } from "vitest";
import {
  base64url,
  CHALLENGE_COOKIE,
  hashRecoveryCode,
  newRecoveryCode,
  SESSION_COOKIE,
  sha256,
} from "../src/auth";
import type { Env } from "../src/env";
import { Browser, count, db, env, freshDatabase, passkey, TABLES, TOKEN } from "./helpers/app";

const ROTATED = "rotated-token-0123456789abcdefghijklm";
const rotated: Env = { ...env, OPA_SETUP_TOKEN: ROTATED };

type Options = { options: { challenge: string } };
type Result = { mode: string; recoveryCodes: string[] };

/** Two browsers both fetch options, then both finish at once. Returns the sorted statuses. */
async function race(token: string, bindings: Env): Promise<number[]> {
  const browsers = [new Browser(bindings), new Browser(bindings)];
  const opts = await Promise.all(
    browsers.map(async (br) => (await (await br.options(token)).json<Options>()).options),
  );
  const credentials = await Promise.all(opts.map((o) => passkey().create(o)));
  const results = await Promise.all(
    browsers.map((br, i) => br.req("/setup", { body: { token, credential: credentials[i] } })),
  );
  return results.map((r) => r.status).sort();
}

freshDatabase();

describe("before the claim", () => {
  it("answers 403 on every route except /setup and /api/health", async () => {
    const br = new Browser();
    for (const path of ["/api/nope", "/api/me", "/agents/x", "/hooks/y"]) {
      expect((await br.req(path)).status).toBe(403);
    }
    expect((await br.req("/api/nope", { body: {} })).status).toBe(403);
    expect((await br.req("/api/health")).status).not.toBe(403);
    expect(await (await br.req("/setup")).text()).toBe("spa");
  });

  it("rejects a cross-origin POST", async () => {
    const res = await new Browser().req("/setup/options", {
      body: { token: TOKEN },
      origin: "https://evil.opa.test",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "bad_origin" });
  });

  it("never accepts the token in a URL", async () => {
    const br = new Browser();
    expect((await br.req(`/setup?token=${TOKEN}`)).status).toBe(200);
    expect((await br.req(`/setup/options?token=${TOKEN}`, { body: {} })).status).toBe(403);
    expect(await count("setup_state")).toBe(0);
  });

  it("rejects and audits a wrong token", async () => {
    const res = await new Browser().options(`${TOKEN}x`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "invalid_token" });
    expect(await count("audit_log", "action = 'setup.token' AND result = 'denied'")).toBe(1);
  });

  it("stays closed while the setup token is shorter than 128 bits", async () => {
    const weak = { ...env, OPA_SETUP_TOKEN: "short" };
    expect((await new Browser(weak).options("short")).status).toBe(503);
    expect((await new Browser(weak).req("/setup")).status).toBe(403);
  });

  it("requires user verification and the right origin in the passkey response", async () => {
    expect((await new Browser().setup(TOKEN, { uv: false })).status).toBe(400);
    expect((await new Browser().setup(TOKEN, { origin: "https://evil.test" })).status).toBe(400);
    expect(await count("users")).toBe(0);
  });
});

describe("the claim", () => {
  it("creates the owner, a passkey, recovery codes and a session, all hashed", async () => {
    const br = new Browser();
    const res = await br.setup(TOKEN);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { mode, recoveryCodes } = await res.json<Result>();
    expect(mode).toBe("claim");
    expect(new Set(recoveryCodes).size).toBe(10);
    for (const code of recoveryCodes) expect(code).toMatch(/^([a-z2-7]{5}-){5}[a-z2-7]$/);

    const owner = await db.prepare("SELECT id FROM users WHERE role = 'owner'").first<string>("id");
    expect(await db.prepare("SELECT * FROM setup_state").first()).toMatchObject({
      claim_token_hash: await sha256(TOKEN),
      claimed_by_user_id: owner,
    });
    expect(await count("passkeys", `user_id = '${owner}'`)).toBe(1);
    const stored = await db.prepare("SELECT code_hash FROM recovery_codes").all();
    expect(stored.results.map((r) => r.code_hash).sort()).toEqual(
      (await Promise.all(recoveryCodes.map(hashRecoveryCode))).sort(),
    );

    const cookie = br.setCookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(cookie).toMatch(/; Max-Age=7776000; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    const sessionId = br.cookies.get(SESSION_COOKIE) as string;
    expect(await db.prepare("SELECT * FROM sessions").first()).toMatchObject({
      user_id: owner,
      token_hash: await sha256(sessionId),
    });

    // No plaintext token, session ID or recovery code anywhere in the database.
    const dump = JSON.stringify(
      await Promise.all(
        TABLES.split(" ").map(async (t) => (await db.prepare(`SELECT * FROM ${t}`).all()).results),
      ),
    );
    for (const secret of [TOKEN, sessionId, ...recoveryCodes]) expect(dump).not.toContain(secret);
    expect(await count("audit_log", "action = 'setup.claim'")).toBe(1);
  });

  it("works once: afterwards /setup is 403 and other routes open", async () => {
    const br = new Browser();
    expect((await br.setup(TOKEN)).status).toBe(200);
    expect((await br.req("/setup")).status).toBe(403);
    const again = await br.options(TOKEN);
    expect(again.status).toBe(403);
    expect(await again.json()).toEqual({ error: "already_claimed" });
    expect((await br.req("/api/nope")).status).toBe(404);
  });

  it("lets exactly one of two concurrent claims win", async () => {
    expect(await race(TOKEN, env)).toEqual([200, 409]);
    expect(await count("users")).toBe(1);
    expect(await count("passkeys")).toBe(1);
  });

  it("consumes the challenge on the first attempt, even a failed one", async () => {
    const br = new Browser();
    const { options } = await (await br.options(TOKEN)).json<Options>();
    const cookie = br.cookies.get(CHALLENGE_COOKIE) as string;
    const key = passkey();
    const bad = await key.create(options, { uv: false });
    expect((await br.req("/setup", { body: { token: TOKEN, credential: bad } })).status).toBe(400);
    br.cookies.set(CHALLENGE_COOKIE, cookie);
    const res = await br.req("/setup", {
      body: { token: TOKEN, credential: await key.create(options) },
    });
    expect(await res.json()).toEqual({ error: "no_challenge" });
  });
});

describe("recovery after the token rotates", () => {
  it("replaces passkeys and codes, revokes sessions and keeps data", async () => {
    const first = new Browser();
    const old = await (await first.setup(TOKEN)).json<Result>();
    const owner = await db.prepare("SELECT id FROM users").first<string>("id");
    await db
      .prepare("INSERT INTO conversations (id, user_id, title) VALUES ('c1', ?, 'kept')")
      .bind(owner)
      .run();

    // The old token no longer opens anything; the new one opens recovery.
    expect((await new Browser(rotated).options(TOKEN)).status).toBe(403);
    expect((await new Browser(rotated).req("/setup")).status).toBe(200);

    const br = new Browser(rotated);
    const key = passkey();
    const res = await br.setup(ROTATED, { key });
    expect(res.status).toBe(200);
    const { mode, recoveryCodes } = await res.json<Result>();
    expect(mode).toBe("recovery");

    const passkeys = await db.prepare("SELECT id, user_id FROM passkeys").all();
    expect(passkeys.results).toEqual([{ id: base64url(key.credentialId), user_id: owner }]);
    const codes = (await db.prepare("SELECT code_hash FROM recovery_codes").all()).results;
    expect(codes.map((r) => r.code_hash).sort()).toEqual(
      (await Promise.all(recoveryCodes.map(hashRecoveryCode))).sort(),
    );
    const oldHashes = await Promise.all(old.recoveryCodes.map(hashRecoveryCode));
    for (const row of codes) expect(oldHashes).not.toContain(row.code_hash);

    const sessions = await db.prepare("SELECT token_hash, revoked_at FROM sessions").all();
    expect(sessions.results).toEqual(
      expect.arrayContaining([
        {
          token_hash: await sha256(first.cookies.get(SESSION_COOKIE) ?? ""),
          revoked_at: expect.any(Number),
        },
        { token_hash: await sha256(br.cookies.get(SESSION_COOKIE) ?? ""), revoked_at: null },
      ]),
    );
    expect(await count("users", `id = '${owner}'`)).toBe(1);
    expect(await count("conversations", "title = 'kept'")).toBe(1);
    expect(await count("setup_state", `claim_token_hash = '${await sha256(ROTATED)}'`)).toBe(1);
    expect(await count("audit_log", "action = 'setup.recovery'")).toBe(1);

    // Recovery is single-use for this token.
    expect((await br.options(ROTATED)).status).toBe(403);
    expect((await br.req("/setup")).status).toBe(403);
  });

  it("lets exactly one of two concurrent recoveries win", async () => {
    expect((await new Browser().setup(TOKEN)).status).toBe(200);
    expect(await race(ROTATED, rotated)).toEqual([200, 409]);
    expect(await count("passkeys")).toBe(1);
    expect(await count("recovery_codes")).toBe(10);
  });
});

it("hashes a recovery code the same however it is typed", async () => {
  const code = newRecoveryCode();
  const typed = ` ${code.toUpperCase().replaceAll("-", " ")} `;
  expect(await hashRecoveryCode(typed)).toBe(await hashRecoveryCode(code));
});
