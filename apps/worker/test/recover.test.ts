// SPDX-License-Identifier: Apache-2.0
// Redeeming a recovery code (M2-10b): single use, no oracle, rate limit, no lockout, audit.

import { ADDRESS_LIMIT } from "@opa/server/recover";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { Browser, claim, count, db, env, freshDatabase, passkey } from "./helpers/app";

freshDatabase();

type Options = { options: { challenge: string } };
type Recovered = { recoveryCodes: string[] };

/** Runs both steps with `code` and a new passkey; `second` is the code step 2 sends. */
async function recover(br: Browser, code: unknown, second: unknown = code) {
  const res = await br.req("/api/auth/recover/options", { body: { code } });
  if (res.status !== 200) return res;
  const credential = await passkey().create((await res.json<Options>()).options);
  return br.req("/api/auth/recover", { body: { code: second, credential } });
}

const audits = (result: string) =>
  count("audit_log", `action = 'recovery.code' AND result = '${result}'`);

/** A D1 binding that records every statement the app prepares. */
function recording(): { env: Env; queries: string[] } {
  const queries: string[] = [];
  const prepare = (q: string) => queries.push(q) && db.prepare(q);
  const DB = { prepare, batch: (s: D1PreparedStatement[]) => db.batch(s) } as D1Database;
  return { env: { ...env, DB }, queries };
}

describe("before the claim", () => {
  it("fails closed: 403, and nothing is read or written", async () => {
    const res = await new Browser().req("/api/auth/recover/options", { body: { code: "x" } });
    expect([res.status, await res.json()]).toEqual([403, { error: "not_claimed" }]);
    expect(await count("audit_log")).toBe(0);
  });
});

describe("a recovery code", () => {
  it("signs in with a new passkey once and replaces every other credential", async () => {
    const { key, browser: old, codes } = await claim();
    const br = new Browser();
    const res = await recover(br, codes[0]);
    expect([res.status, res.headers.get("Cache-Control")]).toEqual([200, "no-store"]);
    const { recoveryCodes } = await res.json<Recovered>();
    expect(recoveryCodes).toHaveLength(10);
    expect(recoveryCodes.filter((c) => codes.includes(c))).toEqual([]);
    expect((await br.req("/api/me")).status).toBe(200);
    expect((await old.req("/api/me")).status).toBe(401);
    // Whoever else held a passkey or a code from the old set is out with this redemption.
    expect(await count("passkeys")).toBe(1);
    expect((await new Browser().login(key)).status).not.toBe(200);
    expect(await count("recovery_codes", "used_at IS NULL")).toBe(10);
    expect((await recover(new Browser(), codes[1])).status).toBe(403);
    // One for each step; the matched attempts don't count as denied.
    expect([await audits("allowed"), await audits("denied")]).toEqual([2, 1]);
    expect(await audits("redeemed")).toBe(1);

    expect((await recover(new Browser(), codes[0])).status).toBe(403);
    expect((await recover(new Browser(), recoveryCodes[0])).status).toBe(200);
    expect(await count("passkeys")).toBe(1);
  });

  it("ignores case, spaces and dashes", async () => {
    const { codes } = await claim();
    const typed = ` ${codes[3]?.toUpperCase().replaceAll("-", " ")} `;
    expect((await recover(new Browser(), typed)).status).toBe(200);
  });

  it("needs the same code in both steps, a verified passkey and the exact Origin", async () => {
    const { codes } = await claim();
    const res = await recover(new Browser(), codes[0], codes[1]);
    expect([res.status, await res.json()]).toEqual([400, { error: "no_challenge" }]);
    const br = new Browser();
    await br.req("/api/auth/recover/options", { body: { code: codes[0] } });
    const body = { code: codes[0], credential: {} };
    expect((await br.req("/api/auth/recover", { body })).status).toBe(400);
    const origin = "https://evil.opa.test";
    expect((await br.req("/api/auth/recover/options", { body, origin })).status).toBe(403);
    expect(await count("recovery_codes", "used_at IS NOT NULL")).toBe(0);
  });

  it("wins once when two browsers race with it", async () => {
    const { codes } = await claim();
    const browsers = [new Browser(), new Browser()];
    const opts = await Promise.all(
      browsers.map(async (br) => {
        const res = await br.req("/api/auth/recover/options", { body: { code: codes[0] } });
        return (await res.json<Options>()).options;
      }),
    );
    const credentials = await Promise.all(opts.map((o) => passkey().create(o)));
    const results = await Promise.all(
      browsers.map((br, i) =>
        br.req("/api/auth/recover", { body: { code: codes[0], credential: credentials[i] } }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 403]);
    expect(await count("passkeys")).toBe(1);
    expect(await count("sessions", "revoked_at IS NULL")).toBe(1);
  });

  it("wins once when two browsers race with two different codes", async () => {
    const { codes } = await claim();
    const browsers = [new Browser(), new Browser()];
    const opts = await Promise.all(
      browsers.map(async (br, i) => {
        const res = await br.req("/api/auth/recover/options", { body: { code: codes[i] } });
        return (await res.json<Options>()).options;
      }),
    );
    const credentials = await Promise.all(opts.map((o) => passkey().create(o)));
    const results = await Promise.all(
      browsers.map((br, i) =>
        br.req("/api/auth/recover", { body: { code: codes[i], credential: credentials[i] } }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 403]);
    expect(await count("passkeys")).toBe(1);
    expect(await count("recovery_codes", "used_at IS NULL")).toBe(10);
    expect(await count("sessions", "revoked_at IS NULL")).toBe(1);
  });

  it("refuses a wrong, used or malformed code the same way, by the same queries", async () => {
    const { codes } = await claim();
    expect((await recover(new Browser(), codes[0])).status).toBe(200);
    const wrong = codes[1]?.replace(/^./, (ch) => (ch === "a" ? "b" : "a"));
    const answers = [];
    const traces = [];
    for (const [i, code] of [wrong, codes[0], "", "!!", 42, null, "x".repeat(10_000)].entries()) {
      const { env: recorded, queries } = recording();
      const res = await new Browser(recorded, `198.51.100.${i}`).req("/api/auth/recover/options", {
        body: { code },
      });
      answers.push([res.status, await res.text()]);
      traces.push(queries);
    }
    for (const answer of answers) expect(answer).toEqual([403, '{"error":"invalid_code"}']);
    expect(traces[0]).toContainEqual(expect.stringContaining("FROM recovery_codes"));
    for (const trace of traces) expect(trace).toEqual(traces[0]);
    expect(await audits("denied")).toBe(7);
    // The audit row holds a keyed hash of the address, never the address.
    const details = await db.prepare("SELECT detail FROM audit_log WHERE result = 'denied'").all();
    expect(JSON.stringify(details.results)).not.toContain("198.51.100");
  });
});

describe("the rate limits", () => {
  it(`stop an address after ${ADDRESS_LIMIT} wrong codes, even with a right one`, async () => {
    const { codes } = await claim();
    for (let i = 0; i < ADDRESS_LIMIT; i++) {
      expect((await recover(new Browser(env, "192.0.2.1"), "wrong")).status).toBe(403);
    }
    const res = await recover(new Browser(env, "192.0.2.1"), codes[0]);
    expect([res.status, await res.json()]).toEqual([429, { error: "rate_limited" }]);
    expect(await audits("limited")).toBe(1);
    // Another address isn't affected, and the window passes.
    const res2 = await recover(new Browser(env, "192.0.2.2"), codes[1]);
    expect(res2.status).toBe(200);
    const { recoveryCodes } = await res2.json<Recovered>();
    await db.prepare("UPDATE audit_log SET created_at = created_at - 16 * 60000").run();
    expect((await recover(new Browser(env, "192.0.2.1"), recoveryCodes[0])).status).toBe(200);
  });

  it("hold under parallel requests from one address", async () => {
    await claim();
    const br = () => new Browser(env, "192.0.2.3");
    const body = { code: "wrong" };
    const results = await Promise.all(
      Array.from({ length: 40 }, () => br().req("/api/auth/recover/options", { body })),
    );
    const statuses = results.map((r) => r.status);
    expect([
      statuses.filter((s) => s === 403).length,
      statuses.filter((s) => s === 429).length,
    ]).toEqual([ADDRESS_LIMIT, 40 - ADDRESS_LIMIT]);
    expect(await audits("denied")).toBe(ADDRESS_LIMIT);
  });

  it("never lock the owner out: a valid code redeems after any number of wrong ones", async () => {
    const { codes } = await claim();
    // 60 wrong codes, 5 from each of 12 addresses: each one is at its limit, none is over it.
    for (let i = 0; i < 60; i++) {
      const ip = `203.0.113.${i % 12}`;
      expect((await recover(new Browser(env, ip), "wrong")).status).toBe(403);
    }
    expect((await recover(new Browser(env, "192.0.2.9"), codes[0])).status).toBe(200);
  });

  it("key the address on OPA_CLIENT_IP_HEADER when it is set", async () => {
    const { codes } = await claim();
    const proxied = { ...env, OPA_CLIENT_IP_HEADER: "X-Real-IP" };
    // Without X-Real-IP these share one bucket, whatever CF-Connecting-IP they send.
    for (let i = 0; i < ADDRESS_LIMIT; i++) {
      expect((await recover(new Browser(proxied, `203.0.113.${i}`), "wrong")).status).toBe(403);
    }
    expect((await recover(new Browser(proxied, "203.0.113.99"), codes[0])).status).toBe(429);
  });
});
