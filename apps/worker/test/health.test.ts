// SPDX-License-Identifier: Apache-2.0
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { exports, env as workerEnv } from "cloudflare:workers";
import { SCHEMA_VERSION } from "@opa/db";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import type { Health } from "../src/health";

const env = workerEnv as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };

const SECRETS = {
  OPA_MASTER_KEY: "test-master-key",
  OPA_SESSION_SECRET: "test-session-secret",
  OPA_SETUP_TOKEN: "test-setup-token",
};
const TABLES = [
  "audit_log",
  "conversations",
  "messages",
  "passkeys",
  "recovery_codes",
  "schema_version",
  "secrets",
  "sessions",
  "setup_state",
  "usage",
  "user_keys",
  "users",
];

async function health(bindings: Env = env): Promise<[number, Health]> {
  const res = await app.request("/api/health", {}, bindings);
  return [res.status, await res.json()];
}

// Runs first: the test database starts empty, as on a deploy whose migrations haven't run.
describe("an unmigrated deployment with no secrets", () => {
  it("reports setup_required with every check", async () => {
    const [status, body] = await health();
    expect(status).toBe(503);
    expect(body).toMatchObject({
      status: "setup_required",
      schema: { expected: SCHEMA_VERSION, applied: null, current: false },
      checks: { database: true, storage: true, durableObject: true, workflow: true },
      secrets: { OPA_MASTER_KEY: false, OPA_SESSION_SECRET: false, OPA_SETUP_TOKEN: false },
    });
    expect(typeof body.checks.ai).toBe("boolean");
  });

  it("serves the Finish setup page without an error or stack trace", async () => {
    const res = await exports.default.fetch("https://opa.test/setup");
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    const html = await res.text();
    expect(html).toContain("<h1>Finish setup</h1>");
    expect(html).toContain("npx wrangler d1 migrations apply DB --remote");
    for (const name of Object.keys(SECRETS)) {
      expect(html).toContain(`npx wrangler secret put ${name}`);
    }
    expect(html).not.toMatch(/Error|\bat .+:\d+:\d+/);
  });
});

describe("after migrations", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });

  it("creates every schema v0 table and records the version", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite_%' AND name != 'd1_migrations' ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(TABLES);
    const [, body] = await health();
    expect(body.schema).toEqual({
      expected: SCHEMA_VERSION,
      applied: SCHEMA_VERSION,
      current: true,
    });
  });

  it("still asks for the missing secrets, and only those", async () => {
    const [status, body] = await health({ ...env, OPA_SETUP_TOKEN: SECRETS.OPA_SETUP_TOKEN });
    expect(status).toBe(503);
    expect(body.status).toBe("setup_required");
    expect(body.secrets).toEqual({
      OPA_MASTER_KEY: false,
      OPA_SESSION_SECRET: false,
      OPA_SETUP_TOKEN: true,
    });
    const html = await (await exports.default.fetch("https://opa.test/setup")).text();
    expect(html).not.toContain("migrations apply");
    expect(html).toContain("npx wrangler secret put OPA_MASTER_KEY");
  });

  it("reports ok when configured and every binding answers", async () => {
    const ai = { run: async () => ({}) } as unknown as Ai;
    const [status, body] = await health({ ...env, ...SECRETS, AI: ai });
    expect(body.checks).toEqual({
      database: true,
      storage: true,
      durableObject: true,
      workflow: true,
      ai: true,
    });
    expect(body.status).toBe("ok");
    expect(status).toBe(200);
  });

  it("reports degraded, with no error detail, when a binding fails", async () => {
    const broken = {
      prepare() {
        throw new Error("secret-looking detail");
      },
    } as unknown as D1Database;
    const res = await app.request("/api/health", {}, { ...env, ...SECRETS, DB: broken });
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(JSON.parse(text)).toMatchObject({ status: "degraded", checks: { database: false } });
    expect(text).not.toContain("secret-looking detail");
  });

  it("never returns secret values", async () => {
    const [, body] = await health({ ...env, ...SECRETS });
    const text = JSON.stringify(body);
    for (const value of Object.values(SECRETS)) expect(text).not.toContain(value);
  });
});
