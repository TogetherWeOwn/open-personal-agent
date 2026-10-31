// SPDX-License-Identifier: Apache-2.0
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { Browser, ORIGIN } from "./client";
import { SoftPasskey } from "./softauthn";

// biome-ignore lint/suspicious/noExplicitAny: test bindings
const e = env as any;
beforeAll(() => applyD1Migrations(e.DB, e.MIGRATIONS));

describe("spike A: SimpleWebAuthn + own sessions", () => {
  const key = new SoftPasskey("opa.test", ORIGIN);
  const br = new Browser();

  it("registers a passkey and starts a session", async () => {
    const opts = await (await br.req("/api/auth/register/options", { body: {} })).json();
    expect(br.lastSetCookie[0]).toMatch(/^__Host-opa_webauthn=.*Path=\/; HttpOnly; Secure; SameSite=Lax/);
    const res = await br.req("/api/auth/register/verify", { body: await key.create(opts) });
    expect(res.status).toBe(200);
    expect(br.lastSetCookie.find((c) => c.startsWith("__Host-opa_session"))).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    expect((await br.req("/api/me")).status).toBe(200);
  });

  it("rejects a reused challenge", async () => {
    const opts = await (await br.req("/api/auth/login/options", { body: {} })).json();
    const cookie = br.jar.get("__Host-opa_webauthn");
    const assertion = await key.get(opts);
    expect((await br.req("/api/auth/login/verify", { body: assertion })).status).toBe(200);
    br.jar.set("__Host-opa_webauthn", cookie as string);
    expect((await br.req("/api/auth/login/verify", { body: assertion })).status).toBe(400);
  });

  it("rejects a cross-origin write and a wrong-origin assertion", async () => {
    expect((await br.req("/api/auth/login/options", { body: {}, origin: "https://evil.test" })).status).toBe(403);
    const opts = await (await br.req("/api/auth/login/options", { body: {} })).json();
    expect((await br.req("/api/auth/login/verify", { body: await key.get(opts, "https://evil.test") })).status).toBe(400);
  });

  it("rejects an assertion without user verification", async () => {
    const opts = await (await br.req("/api/auth/login/options", { body: {} })).json();
    expect((await br.req("/api/auth/login/verify", { body: await key.get(opts, ORIGIN, false) })).status).toBe(400);
  });

  it("logs in on a second browser, then signs out everywhere", async () => {
    const other = new Browser();
    const opts = await (await other.req("/api/auth/login/options", { body: {} })).json();
    expect((await other.req("/api/auth/login/verify", { body: await key.get(opts) })).status).toBe(200);
    expect((await other.req("/api/me")).status).toBe(200);
    expect((await br.req("/api/logout-everywhere", { body: {} })).status).toBe(200);
    expect((await other.req("/api/me")).status).toBe(401);
  });
});
