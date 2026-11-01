// SPDX-License-Identifier: Apache-2.0
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { exports, env as workerEnv } from "cloudflare:workers";
import { SCHEMA_VERSION } from "@opa/db";
import { app } from "@opa/server/app";
import { type Health, setupRequired } from "@opa/server/health";
import { beforeAll, describe, expect, it } from "vitest";
import { compose, type WorkerEnv } from "../src/compose";

const env = workerEnv as unknown as WorkerEnv & { TEST_MIGRATIONS: D1Migration[] };

const SECRETS = {
  OPA_MASTER_KEY: btoa("k".repeat(32)),
  OPA_SESSION_SECRET: "test-session-secret",
  OPA_SETUP_TOKEN: "test-setup-token",
};
const TABLES = `attachments audit_log conversations grants memories memories_fts memories_fts_config
  memories_fts_data memories_fts_docsize memories_fts_idx memory_links messages model_providers
  passkeys recovery_codes schema_version secrets sessions setup_state tasks tool_overrides usage
  used_setup_tokens user_keys user_settings users webauthn_challenges`.split(/\s+/);

async function health(bindings: WorkerEnv = env): Promise<[number, Health]> {
  const res = await app.request("/api/health", {}, await compose(bindings));
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
    expect(html).toContain("npx wrangler d1 migrations apply DB --local");
    for (const name of Object.keys(SECRETS)) {
      expect(html).toContain(`<pre><code>npx wrangler secret put ${name}</code></pre>`);
    }
    expect(html).toContain("crypto.getRandomValues(Buffer.alloc(32))");
    expect(html).toContain("Run it again for each secret");
    expect(html).not.toMatch(/Error|\bat .+:\d+:\d+/);
  });
});

const broken = {
  prepare() {
    throw new Error("secret-looking detail");
  },
} as unknown as D1Database;

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

  it("keeps audit rows when their user is deleted", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, display_name, role) VALUES ('u1', 'A', 'owner')"),
      env.DB.prepare(
        "INSERT INTO audit_log (user_id, action, module, result) VALUES ('u1', 'claim', 'test', 'ok')",
      ),
      env.DB.prepare("DELETE FROM users WHERE id = 'u1'"),
    ]);
    const row = await env.DB.prepare(
      "SELECT user_id FROM audit_log WHERE action = 'claim'",
    ).first();
    expect(row).toEqual({ user_id: null });
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
    expect(Object.values(body.checks)).toEqual([true, true, true, true, true, true]);
    expect(body.status).toBe("ok");
    expect(status).toBe(200);
    // Presence only: no secret value appears in the response.
    for (const value of Object.values(SECRETS)) expect(JSON.stringify(body)).not.toContain(value);
  });

  it("degrades for a missing capability unless the runtime declares it unavailable", async () => {
    const absent = { ...env, ...SECRETS, AI: undefined as unknown as Ai };
    expect((await health(absent))[1].status).toBe("degraded");
    // The Node root declares Workers AI and Workflows unavailable: reported, but not degrading.
    const node = { ...absent, TASK_WORKFLOW: undefined as unknown as Workflow };
    const [status, body] = await health({ ...node, UNAVAILABLE: ["workflow", "ai"] });
    expect([status, body.status]).toEqual([200, "ok"]);
    expect(body.checks).toMatchObject({ ai: false, workflow: false });
  });

  it("decides setup_required from the schema and secrets alone", async () => {
    const unreachable = {
      FILES: { head: () => Promise.reject(new Error("storage down")) } as unknown as R2Bucket,
      ASSISTANT: {} as WorkerEnv["ASSISTANT"],
    };
    expect(await setupRequired(await compose({ ...env, ...SECRETS, ...unreachable }))).toBe(false);
    expect(await setupRequired(await compose({ ...env, ...unreachable }))).toBe(true);
    expect(await setupRequired(await compose({ ...env, ...SECRETS, DB: broken }))).toBe(false);
  });

  it("reports degraded, with no error detail, when a binding fails", async () => {
    const res = await app.request(
      "/api/health",
      {},
      await compose({ ...env, ...SECRETS, DB: broken }),
    );
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(JSON.parse(text)).toMatchObject({ status: "degraded", checks: { database: false } });
    expect(text).not.toContain("secret-looking detail");
  });

  it("doesn't ask for migrations when the database is unreachable", async () => {
    const res = await app.request("/setup", {}, await compose({ ...env, DB: broken }));
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain("npx wrangler secret put OPA_SETUP_TOKEN");
    expect(html).not.toContain("migrations apply");
  });
});
