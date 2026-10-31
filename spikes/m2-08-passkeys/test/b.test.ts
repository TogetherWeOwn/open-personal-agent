// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { getMigrations } from "better-auth/db/migration";
import { beforeAll, describe, expect, it } from "vitest";
import { authOptions } from "../b/src/auth";
import { Browser, ORIGIN } from "./client";
import { SoftPasskey } from "./softauthn";

// biome-ignore lint/suspicious/noExplicitAny: test bindings
const e = env as any;
beforeAll(async () => {
  const { runMigrations } = await getMigrations(authOptions(e));
  await runMigrations();
});

describe("spike B: better-auth + passkey plugin", () => {
  const key = new SoftPasskey("opa.test", ORIGIN);
  const br = new Browser();

  it("registers a passkey (passkey-first) and starts a session", async () => {
    const optsRes = await br.req("/api/auth/passkey/generate-register-options");
    expect(optsRes.status).toBe(200);
    const opts = await optsRes.json();
    const res = await br.req("/api/auth/passkey/verify-registration", {
      body: { response: await key.create(opts), createSession: true },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    console.log("B set-cookie:", br.lastSetCookie);
    expect((await br.req("/api/me")).status).toBe(200);
  });

  it("logs in with the passkey", async () => {
    const other = new Browser();
    const opts = await (await other.req("/api/auth/passkey/generate-authenticate-options")).json();
    const res = await other.req("/api/auth/passkey/verify-authentication", { body: { response: await key.get(opts) } });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await other.req("/api/me")).status).toBe(200);
  });

  // Finding: the plugin hard-codes requireUserVerification: false, so a UP-only assertion signs in.
  it("ACCEPTS an assertion without user verification", async () => {
    const other = new Browser();
    const opts = await (await other.req("/api/auth/passkey/generate-authenticate-options")).json();
    const res = await other.req("/api/auth/passkey/verify-authentication", {
      body: { response: await key.get(opts, ORIGIN, false) },
    });
    expect(res.status).toBe(200);
  });

  it("rejects a cross-origin write", async () => {
    const opts = await (await br.req("/api/auth/passkey/generate-authenticate-options")).json();
    const res = await br.req("/api/auth/passkey/verify-authentication", {
      body: { response: await key.get(opts) },
      origin: "https://evil.test",
    });
    expect(res.status).toBe(403);
  });
});

describe("spike B: storage probe", () => {
  it("dumps the session row and schema", async () => {
    const rows = await e.DB.prepare("SELECT token, expiresAt, ipAddress, userAgent FROM session LIMIT 1").all();
    console.log("B session row:", JSON.stringify(rows.results));
    const t = await e.DB.prepare("SELECT name, sql FROM sqlite_master WHERE type='table'").all();
    console.log("B tables:", t.results.map((r: { name: string }) => r.name).join(","));
    const u = await e.DB.prepare("SELECT id, email FROM user").all();
    console.log("B users:", JSON.stringify(u.results));
  });
});
