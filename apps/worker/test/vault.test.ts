// SPDX-License-Identifier: Apache-2.0
// The vault in the Worker: the env filter (M2-8+V4), fail-closed startup (V8) and the D1 store.
import {
  applyD1Migrations,
  createExecutionContext,
  type D1Migration,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { decrypt, encrypt, rewrap, type UserScope, type Vault } from "@opa/vault";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/app";
import { newSession, SESSION_COOKIE } from "../src/auth";
import { compose, type WorkerEnv } from "../src/compose";
import worker from "../src/index";
import { d1VaultStore } from "../src/vault-store";

const env = workerEnv as unknown as WorkerEnv & { TEST_MIGRATIONS: D1Migration[] };
const key = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const KEY = key();
const PREV = key();
const MASTER_NAMES = ["OPA_MASTER_KEY", "OPA_MASTER_KEY_PREV"];
let session = "";

// A test route that reports what route handlers and middleware receive.
app.get("/api/test/env-keys", (c) => c.json(Object.keys(c.env)));

async function fetchWorker(path: string, bindings: WorkerEnv, init?: RequestInit) {
  const ctx = createExecutionContext();
  // Signed in, from the same origin, so the session guard (M2-10) lets the request through.
  const headers = { origin: "https://opa.test", cookie: `${SESSION_COOKIE}=${session}` };
  const request = new Request(`https://opa.test${path}`, { ...init, headers }) as Parameters<
    typeof worker.fetch
  >[0];
  const res = await worker.fetch(request, bindings, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const countSecrets = async () =>
  (await env.DB.prepare("SELECT count(*) AS n FROM secrets").first<{ n: number }>())?.n;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare(
    "INSERT INTO users (id, display_name, role) VALUES ('u1', 'A', 'owner')",
  ).run();
  // Claimed, so the claim guard (M2-09) lets requests reach the secret routes.
  await env.DB.prepare(
    "INSERT INTO setup_state (id, claimed_by_user_id, claimed_at) VALUES (1, 'u1', 0)",
  ).run();
  const { cookie, insert } = await newSession(env.DB, "u1");
  await insert.run();
  session = cookie;
});

describe("V4: the env filter", () => {
  it("gives the app no master key, only the vault", async () => {
    const raw = { ...env, OPA_MASTER_KEY: KEY, OPA_MASTER_KEY_PREV: `0${PREV}` };
    // An invalid PREV refuses to start; a valid one passes.
    expect((await compose(raw)).VAULT).toBeNull();
    const composed = await compose({
      ...env,
      OPA_MASTER_KEY: `2:${KEY}`,
      OPA_MASTER_KEY_PREV: PREV,
    });
    expect(composed.VAULT).not.toBeNull();
    for (const name of MASTER_NAMES) expect(composed).not.toHaveProperty(name);
    expect(JSON.stringify(Object.values(composed))).not.toContain(KEY);
  });

  it("keeps the keys out of what route handlers see", async () => {
    const res = await fetchWorker("/api/test/env-keys", {
      ...env,
      OPA_MASTER_KEY: `2:${KEY}`,
      OPA_MASTER_KEY_PREV: PREV,
    });
    const names: string[] = await res.json();
    expect(names).toContain("VAULT");
    expect(names).toContain("DB");
    for (const name of MASTER_NAMES) expect(names).not.toContain(name);
  });
});

describe("V8: fail closed at startup", () => {
  const short = btoa("k".repeat(16));
  for (const [label, value] of [
    ["missing", undefined],
    ["malformed", "not-base64!"],
    ["128-bit", short],
  ] as const) {
    it(`returns 503 on secret routes with a ${label} key, and stores nothing`, async () => {
      const raw = { ...env, ...(value === undefined ? {} : { OPA_MASTER_KEY: value }) };
      for (const path of ["/api/secrets", "/api/secrets/s1"]) {
        const res = await fetchWorker(path, raw, { method: "POST", body: "sk-canary" });
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: "vault_unavailable" });
      }
      expect(await countSecrets()).toBe(0);
      const health = await (await app.request("/api/health", {}, await compose(raw))).json();
      expect(health).toMatchObject({ secrets: { OPA_MASTER_KEY: false } });
    });
  }

  it("reports a bad PREV as degraded, never as a missing master key", async () => {
    for (const prev of ["not-base64!", KEY]) {
      const raw = { ...env, ...{ OPA_SESSION_SECRET: "s", OPA_SETUP_TOKEN: "t" } };
      Object.assign(raw, { OPA_MASTER_KEY: KEY, OPA_MASTER_KEY_PREV: prev });
      expect((await fetchWorker("/api/secrets/s1", raw, { method: "POST" })).status).toBe(503);
      const health = await (await app.request("/api/health", {}, await compose(raw))).json();
      const secrets = { OPA_MASTER_KEY: true, OPA_SESSION_SECRET: true, OPA_SETUP_TOKEN: true };
      expect(health).toMatchObject({ status: "degraded", checks: { vault: false }, secrets });
    }
  });

  it("lets secret routes through once the vault starts", async () => {
    const res = await fetchWorker("/api/secrets/s1", { ...env, OPA_MASTER_KEY: KEY });
    expect(res.status).toBe(404);
  });
});

describe("the D1 vault store", () => {
  // Stands in for the repository layer (M2-11), the only code that mints a UserScope.
  const scopeOf = (userId: string) => ({ userId }) as UserScope;
  const scope = scopeOf("u1");
  const input = {
    secretId: "s1",
    purpose: "model_api_key",
    binding: "openai|https://api.openai.com",
  } as const;

  it("round-trips, audits, and re-wraps through D1", async () => {
    const vault = (await compose({ ...env, OPA_MASTER_KEY: PREV })).VAULT as Vault;
    await encrypt(vault, scope, { ...input, plaintext: "sk-canary-d1-round-trip", caller: "test" });
    expect(await decrypt(vault, scope, { ...input, caller: "test" })).toBe(
      "sk-canary-d1-round-trip",
    );
    const audits = await env.DB.prepare(
      "SELECT user_id, action, module, target_id, result, detail FROM audit_log ORDER BY id",
    ).all();
    expect(audits.results).toEqual([
      {
        user_id: "u1",
        action: "vault.encrypt",
        module: "test",
        target_id: "s1",
        result: "ok",
        detail: "model_api_key",
      },
      {
        user_id: "u1",
        action: "vault.decrypt",
        module: "test",
        target_id: "s1",
        result: "ok",
        detail: "model_api_key",
      },
    ]);

    const rotated = (
      await compose({ ...env, OPA_MASTER_KEY: `2:${KEY}`, OPA_MASTER_KEY_PREV: PREV })
    ).VAULT as Vault;
    expect(await rewrap(rotated, { caller: "test" })).toEqual({ rewrapped: 1 });
    const versions = await env.DB.prepare("SELECT kek_version FROM user_keys").all();
    expect(versions.results).toEqual([{ kek_version: 2 }]);
    const after = (await compose({ ...env, OPA_MASTER_KEY: `2:${KEY}` })).VAULT as Vault;
    expect(await decrypt(after, scope, { ...input, caller: "test" })).toBe(
      "sk-canary-d1-round-trip",
    );
  });

  it("won't overwrite another user's secret with the same id", async () => {
    await env.DB.prepare(
      "INSERT INTO users (id, display_name, role) VALUES ('u2', 'B', 'member')",
    ).run();
    const vault = (await compose({ ...env, OPA_MASTER_KEY: `2:${KEY}` })).VAULT as Vault;
    await expect(
      encrypt(vault, scopeOf("u2"), { ...input, plaintext: "sk-other", caller: "test" }),
    ).rejects.toThrow("encrypt_failed");
    const row = await env.DB.prepare("SELECT user_id FROM secrets WHERE id = 's1'").first();
    expect(row).toEqual({ user_id: "u1" });
  });

  it("blocks old-epoch enrollment, and a conflicting re-wrap, in D1", async () => {
    await env.DB.prepare(
      "INSERT INTO users (id, display_name, role) VALUES ('u3', 'C', 'member')",
    ).run();
    const old = (await compose({ ...env, OPA_MASTER_KEY: PREV })).VAULT as Vault;
    await expect(
      encrypt(old, scopeOf("u3"), { ...input, plaintext: "sk-old", caller: "test" }),
    ).rejects.toThrow("encrypt_failed");
    const u3 = await env.DB.prepare(
      "SELECT count(*) AS n FROM user_keys WHERE user_id = 'u3'",
    ).first();
    expect(u3).toEqual({ n: 0 });

    const junk = new Uint8Array(12);
    await env.DB.prepare(
      "INSERT INTO user_keys (user_id, kek_version, wrapped_dek, iv) VALUES ('u1', 1, ?, ?)",
    )
      .bind(junk, junk)
      .run();
    const row = { userId: "u1", kekVersion: 2, wrappedDek: junk, iv: junk };
    await expect(d1VaultStore(env.DB).replaceUserKey(row, 1)).rejects.toThrow();
    const rows = await env.DB.prepare(
      "SELECT kek_version FROM user_keys WHERE user_id = 'u1' ORDER BY 1",
    ).all();
    expect(rows.results).toEqual([{ kek_version: 1 }, { kek_version: 2 }]);
  });
});
