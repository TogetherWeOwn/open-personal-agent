// SPDX-License-Identifier: Apache-2.0
// The vault in the Worker: the env filter (M2-8+V4), fail-closed startup (V8) and the D1 store.
import {
  applyD1Migrations,
  createExecutionContext,
  type D1Migration,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { d1VaultStore } from "@opa/db/vault-store";
import { newSession, SESSION_COOKIE } from "@opa/server/auth";
import { decrypt, encrypt, rewrap, type UserScope, type Vault } from "@opa/vault";
import { beforeAll, describe, expect, it } from "vitest";
import { compose, type WorkerEnv } from "../src/compose";
import worker from "../src/index";
import { workerApp as app } from "../src/worker-app";

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
  const { cookie, row } = await newSession("u1");
  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
  )
    .bind(row.id, row.userId, row.tokenHash, row.expiresAt)
    .run();
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
      const health = await (await fetchWorker("/api/health", raw)).json();
      expect(health).toMatchObject({ secrets: { OPA_MASTER_KEY: false } });
    });
  }

  it("reports a bad PREV as degraded, never as a missing master key", async () => {
    for (const prev of ["not-base64!", KEY]) {
      const raw = { ...env, ...{ OPA_SESSION_SECRET: "s", OPA_SETUP_TOKEN: "t" } };
      Object.assign(raw, { OPA_MASTER_KEY: KEY, OPA_MASTER_KEY_PREV: prev });
      expect((await fetchWorker("/api/secrets/s1", raw, { method: "POST" })).status).toBe(503);
      const health = await (await fetchWorker("/api/health", raw)).json();
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
    const sealed = "SELECT ciphertext, iv, last4 FROM secrets WHERE id = 's1'";
    // Re-key writes last4 again from the plaintext (L-1), not the stored value.
    await env.DB.prepare("UPDATE secrets SET last4 = 'XXXX' WHERE id = 's1'").run();
    const before = await env.DB.prepare(sealed).first();
    expect(await rewrap(rotated, { caller: "test" })).toEqual({ rewrapped: 1, remaining: 0 });
    const versions = await env.DB.prepare("SELECT kek_version FROM user_keys").all();
    expect(versions.results).toEqual([{ kek_version: 2 }]);
    // Re-keyed: the secret was sealed again under the new DEK, with a fresh IV.
    const after = await env.DB.prepare(sealed).first();
    expect(after?.iv).not.toEqual(before?.iv);
    expect(after?.ciphertext).not.toEqual(before?.ciphertext);
    expect(after?.last4).toBe("trip");
    const current = (await compose({ ...env, OPA_MASTER_KEY: `2:${KEY}` })).VAULT as Vault;
    expect(await decrypt(current, scope, { ...input, caller: "test" })).toBe(
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
    const from = { userId: "u1", kekVersion: 1, wrappedDek: junk, iv: junk };
    const to = { ...from, kekVersion: 2 };
    const before = await d1VaultStore(env).userSecrets("u1");
    const change = { from, to, before, after: before };
    await expect(d1VaultStore(env).rekeyUser(change)).rejects.toThrow();
    const rows = await env.DB.prepare(
      "SELECT kek_version FROM user_keys WHERE user_id = 'u1' ORDER BY 1",
    ).all();
    expect(rows.results).toEqual([{ kek_version: 1 }, { kek_version: 2 }]);
    await env.DB.prepare("DELETE FROM user_keys WHERE user_id = 'u1' AND kek_version = 1").run();
  });

  it("re-keys a user in one batch: a failure mid-batch leaves everything as it was", async () => {
    const id = "u4";
    await env.DB.prepare(
      `INSERT INTO users (id, display_name, role) VALUES ('${id}', 'D', 'member')`,
    ).run();
    const old = (await compose({ ...env, OPA_MASTER_KEY: `2:${KEY}` })).VAULT as Vault;
    for (const secretId of ["s4", "s5"]) {
      const plaintext = `sk-${secretId}-0123456789abcdef`;
      await encrypt(old, scopeOf(id), { ...input, secretId, plaintext, caller: "test" });
    }
    const snapshot = async () => [
      (await env.DB.prepare(`SELECT * FROM user_keys WHERE user_id = '${id}'`).all()).results,
      (await env.DB.prepare(`SELECT * FROM secrets WHERE user_id = '${id}' ORDER BY id`).all())
        .results,
    ];
    const before = await snapshot();
    // Fail u4's batch (its DEK row and two secrets) after the DEK row and the first secret.
    // Other users' batches, u1's, go through.
    const failing = {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: (statements: D1PreparedStatement[]) =>
        env.DB.batch(
          statements.length !== 3
            ? statements
            : [
                ...statements.slice(0, 2),
                env.DB.prepare("SELECT * FROM no_such_table"),
                ...statements.slice(2),
              ],
        ),
    } as unknown as D1Database;
    const third = `3:${key()}`;
    const vault = (
      await compose({ ...env, DB: failing, OPA_MASTER_KEY: third, OPA_MASTER_KEY_PREV: `2:${KEY}` })
    ).VAULT as Vault;
    await expect(rewrap(vault, { caller: "test" })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    for (const secretId of ["s4", "s5"]) {
      expect(await decrypt(old, scopeOf(id), { ...input, secretId, caller: "test" })).toBe(
        `sk-${secretId}-0123456789abcdef`,
      );
    }
  });

  it("writes a secret and its audit row together, and never under a replaced DEK", async () => {
    const store = d1VaultStore(env);
    const [dek] = await store.userKeys("u1");
    const secret = { id: "s6", userId: "u1", purpose: "model_api_key", binding: "b", version: 1 };
    const row = { ...secret, ciphertext: new Uint8Array(16), iv: new Uint8Array(12), last4: null };
    const audit = {
      userId: "u1",
      action: "vault.encrypt",
      module: "stale",
      targetId: "s6",
      result: "ok",
      detail: null,
    } as const;
    if (!dek) throw new Error("no DEK");
    await expect(
      store.putSecret(row, { ...dek, iv: new Uint8Array(12).fill(7) }, audit),
    ).rejects.toThrow("secret not written");
    const written = async () => [
      await env.DB.prepare("SELECT count(*) AS n FROM secrets WHERE id = 's6'").first(),
      await env.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE module = 'stale'").first(),
    ];
    expect(await written()).toEqual([{ n: 0 }, { n: 0 }]);
    await store.putSecret(row, dek, audit);
    expect(await written()).toEqual([{ n: 1 }, { n: 1 }]);
  });
});
