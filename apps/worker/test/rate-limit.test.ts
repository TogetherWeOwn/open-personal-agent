// SPDX-License-Identifier: Apache-2.0
// The coarse per-address limit on the routes that answer without a session (M2-22, security
// review M-2 and L-1), and the health detail only a signed-in user sees after the claim.
import { env as workerEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { Browser, claim, env, freshDatabase } from "./helpers/app";

const LIMITED = [
  ["GET", "/api/health"],
  ["GET", "/setup"],
  ["POST", "/setup/options"],
  ["POST", "/setup"],
  ["POST", "/api/auth/login/options"],
  ["POST", "/api/auth/login"],
  ["POST", "/api/auth/recover/options"],
  ["POST", "/api/auth/recover"],
] as const;

/** A binding that records any use and fails it, so a test sees whether a request reached it. */
function tripwire(name: string, touched: string[]) {
  return new Proxy({} as never, {
    get(_, prop) {
      touched.push(`${name}.${String(prop)}`);
      throw new Error(`${name} used`);
    },
  });
}

describe("the public rate limit", () => {
  it("answers 429 over the limit before any D1, R2 or Durable Object call", async () => {
    const touched: string[] = [];
    const keys: string[] = [];
    const over: Env = {
      ...env,
      DB: tripwire("DB", touched),
      FILES: tripwire("FILES", touched),
      ASSISTANT: tripwire("ASSISTANT", touched),
      PUBLIC_LIMIT: {
        limit: async ({ key }) => {
          keys.push(key);
          return { success: false };
        },
      },
    };
    const browser = new Browser(over, "203.0.113.9");
    for (const [method, path] of LIMITED) {
      const res = await browser.req(path, { method, body: method === "POST" ? {} : undefined });
      expect([path, res.status]).toEqual([path, 429]);
      expect(await res.json()).toEqual({ error: "rate_limited" });
      expect(res.headers.get("retry-after")).toBe("60");
    }
    expect(touched).toEqual([]);
    expect(new Set(keys)).toEqual(new Set(["203.0.113.9"]));
  });

  it("leaves other routes and a failing limiter alone", async () => {
    const deny: RateLimit = { limit: async () => ({ success: false }) };
    // Not on the list: the claim guard answers, so the request got past the limit.
    const me = await new Browser({ ...env, PUBLIC_LIMIT: deny }).req("/api/me");
    expect(await me.json()).toEqual({ error: "not_claimed" });
    const broken: RateLimit = { limit: async () => Promise.reject(new Error("down")) };
    const health = await new Browser({ ...env, PUBLIC_LIMIT: broken }).req("/api/health");
    expect(health.status).not.toBe(429);
  });

  it("counts each address on its own with the wrangler.jsonc binding", async () => {
    const real: Env = {
      ...env,
      PUBLIC_LIMIT: (workerEnv as unknown as Env).PUBLIC_LIMIT as RateLimit,
    };
    const a = new Browser(real, "198.51.100.1");
    const statuses = [];
    for (let i = 0; i < 31; i++) statuses.push((await a.req("/api/health")).status);
    expect(statuses.slice(0, 30)).not.toContain(429);
    expect(statuses[30]).toBe(429);
    expect((await new Browser(real, "198.51.100.2").req("/api/health")).status).not.toBe(429);
  });
});

describe("/api/health after the claim", () => {
  freshDatabase();

  it("gives the detail before the claim, then only the status unless signed in", async () => {
    const before = await (await new Browser().req("/api/health")).json();
    expect(before).toHaveProperty("checks");
    const { browser } = await claim();
    const anonymous = await new Browser().req("/api/health");
    expect(Object.keys(await anonymous.json())).toEqual(["status"]);
    expect(anonymous.headers.get("cache-control")).toBe("no-store");
    const signedIn = await (await browser.req("/api/health")).json();
    expect(signedIn).toHaveProperty("checks");
    expect(signedIn).toHaveProperty("secrets");
  });
});
