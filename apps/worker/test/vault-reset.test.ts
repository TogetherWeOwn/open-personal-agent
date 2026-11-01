// SPDX-License-Identifier: Apache-2.0
// Crypto review C-1: the rotation runner, and the explicit, stepped-up reset of a user whose DEK
// no key opens any more. Nothing resets on its own.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { d1VaultStore } from "@opa/db/vault-store";
import { credentialBinding } from "@opa/providers";
import { base64url } from "@opa/server/auth";
import type { SoftPasskey } from "@opa/server/test/softauthn";
import { createVault, decrypt, encrypt, type UserScope, type Vault } from "@opa/vault";
import { beforeEach, describe, expect, it } from "vitest";
import { compose, type WorkerEnv } from "../src/compose";
import type { Env } from "../src/env";
import worker from "../src/index";
import { Browser, claim, count, db, env, freshDatabase, sessionHeaders } from "./helpers/app";

freshDatabase();
beforeEach(async () => {
  // `freshDatabase` empties these through the cascade from `users`; the audit log it empties.
  await db.prepare("DELETE FROM user_keys").run();
});

const newKey = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const CANARY = "sk-canary-0123456789abcdefWXYZ";
const OPENAI = { kind: "openai-chat", providerId: "openai", baseUrl: "https://api.example.com/v1" };
const BINDING = credentialBinding(OPENAI.providerId, OPENAI.baseUrl);

const vaultOf = (masterKey: string, previousMasterKey?: string) =>
  createVault({ masterKey, previousMasterKey, store: d1VaultStore(env) });
const withVault = (vault: Vault): Env => ({ ...env, VAULT: vault, VAULT_STATUS: "ok" });
/** A second browser on the same session, against another deployment's keys. */
function as(browser: Browser, bindings: Env) {
  const other = new Browser(bindings);
  other.cookies = new Map(browser.cookies);
  return other;
}
const saveKey = (b: Browser) =>
  b.req("/api/settings/model", { method: "PUT", body: { ...OPENAI, model: "m", apiKey: CANARY } });
const rows = async () => [await count("user_keys"), await count("secrets")];

/** A step-up assertion for the vault reset, from `key`, in `b`'s challenge cookie. */
async function stepUp(b: Browser, key: SoftPasskey, opts: { uv?: boolean } = {}) {
  const res = await b.req("/api/auth/step-up/options", { body: { action: "vault.reset" } });
  expect(res.status).toBe(200);
  const { options } = await res.json<{
    options: { challenge: string; allowCredentials: { id: string }[] };
  }>();
  expect(options.allowCredentials.map((c) => c.id)).toEqual([base64url(key.credentialId)]);
  return key.get(options, opts);
}
const reset = (b: Browser, body: unknown) => b.req("/api/settings/vault/reset", { body });

/** The owner, signed in, with a model key saved under `masterKey`. */
async function ownerWithKey(masterKey: string) {
  const { browser, key, owner } = await claim();
  const b = as(browser, withVault(await vaultOf(masterKey)));
  await b.req("/api/settings/profile", {
    method: "PUT",
    body: { displayName: "Sam", about: "" },
  });
  expect((await saveKey(b)).status).toBe(200);
  return { browser, key, owner };
}

describe("a master key that no longer opens a user's DEK", () => {
  it("is refused with vault_reset_required until a stepped-up reset, then a new key works", async () => {
    const { browser, key, owner } = await ownerWithKey(newKey());
    // The operator regenerated the master key under the same epoch.
    const regenerated = await vaultOf(newKey());
    const b = as(browser, withVault(regenerated));
    const res = await saveKey(b);
    expect([res.status, await res.json()]).toEqual([409, { error: "vault_reset_required" }]);
    const test = await b.req("/api/settings/model/test", { body: {} });
    expect([test.status, await test.json()]).toEqual([409, { error: "vault_reset_required" }]);
    expect(await (await b.req("/api/settings/vault")).json()).toEqual({ state: "reset_required" });
    expect(await rows()).toEqual([1, 1]);

    expect((await reset(b, { confirm: "reset", credential: await stepUp(b, key) })).status).toBe(
      204,
    );
    expect(await rows()).toEqual([0, 0]);
    const audit = await db
      .prepare("SELECT action, module, result FROM audit_log WHERE user_id = ? AND action = ?")
      .bind(owner, "vault.reset_user")
      .all();
    expect(audit.results).toEqual([
      { action: "vault.reset_user", module: "vault-reset", result: "ok" },
    ]);
    expect(await count("audit_log", "action = 'auth.step_up' AND result = 'ok'")).toBe(1);
    // The provider row stays, without its key, and the user enters it again.
    expect(await count("model_providers", "key_secret_id IS NULL")).toBe(1);
    expect((await saveKey(b)).status).toBe(200);
    expect(await (await b.req("/api/settings/vault")).json()).toEqual({ state: "ok" });
    const secretId = await db.prepare("SELECT id FROM secrets").first<string>("id");
    const ref = { secretId: secretId ?? "", purpose: "model_api_key", binding: BINDING } as const;
    const scope = { userId: owner } as UserScope;
    expect(await decrypt(regenerated, scope, { ...ref, caller: "test" })).toBe(CANARY);
  });

  it("is never reset without confirm and a fresh step-up of this user's own passkey", async () => {
    const { browser, key } = await ownerWithKey(newKey());
    const b = as(browser, withVault(await vaultOf(newKey())));
    const refused = async (body: unknown, status: number, error: string, from = b) => {
      const res = await reset(from, body);
      expect([res.status, await res.json()]).toEqual([status, { error }]);
      expect(await rows()).toEqual([1, 1]);
    };
    const credential = await stepUp(b, key);
    const challenge = b.cookies.get("__Host-opa_webauthn") ?? "";
    await refused({ credential }, 400, "confirm_required");
    await refused({ confirm: "reset" }, 401, "step_up_required");
    // The same assertion and challenge cookie again: the challenge was used up.
    b.cookies.set("__Host-opa_webauthn", challenge);
    await refused({ confirm: "reset", credential }, 401, "step_up_required");
    // A stale one.
    const late = await stepUp(b, key);
    await db.prepare("UPDATE webauthn_challenges SET expires_at = 0").run();
    await refused({ confirm: "reset", credential: late }, 401, "step_up_required");
    // A login challenge, and an assertion without user verification.
    const login = await b.req("/api/auth/login/options", { body: {} });
    const { options } = await login.json<{ options: { challenge: string } }>();
    await refused(
      { confirm: "reset", credential: await key.get(options) },
      401,
      "step_up_required",
    );
    await refused(
      { confirm: "reset", credential: await stepUp(b, key, { uv: false }) },
      401,
      "step_up_required",
    );
    // Another user's session, with the owner's challenge and assertion.
    await db
      .prepare("INSERT INTO users (id, display_name, role) VALUES ('u2', 'B', 'member')")
      .run();
    const other = new Browser(b.bindings);
    const owned = await stepUp(b, key);
    other.cookies = new Map(b.cookies);
    const [, session = ""] = (await sessionHeaders("u2")).cookie.split("=");
    other.cookies.set("__Host-opa_session", session);
    await refused({ confirm: "reset", credential: owned }, 401, "step_up_required", other);
    expect(await count("audit_log", "action = 'auth.step_up' AND result = 'denied'")).toBe(6);
  });

  it("refuses a reset while the DEK still opens", async () => {
    const masterKey = newKey();
    const { browser, key } = await ownerWithKey(masterKey);
    const b = as(browser, withVault(await vaultOf(masterKey)));
    const res = await reset(b, { confirm: "reset", credential: await stepUp(b, key) });
    expect([res.status, await res.json()]).toEqual([409, { error: "reset_not_required" }]);
    expect(await rows()).toEqual([1, 1]);
  });

  it("doesn't reset when PREV is missing for a moment: the rows wait for it", async () => {
    const key1 = newKey();
    const { browser, owner } = await ownerWithKey(key1);
    const key2 = `2:${newKey()}`;
    const b = as(browser, withVault(await vaultOf(key2)));
    expect((await saveKey(b)).status).toBe(409);
    const health = await (await b.req("/api/health")).json<{ vault: unknown }>();
    expect(health.vault).toEqual({ rotation: "none", orphanedRows: 2 });
    expect(await rows()).toEqual([1, 1]);
    // PREV is back: the saved key opens, and the user was never asked to lose it.
    const back = as(browser, withVault(await vaultOf(key2, key1)));
    expect(await (await back.req("/api/settings/vault")).json()).toEqual({ state: "ok" });
    const secretId = (await db.prepare("SELECT id FROM secrets").first<string>("id")) ?? "";
    const ref = { secretId, purpose: "model_api_key", binding: BINDING, caller: "test" } as const;
    expect(await decrypt(back.bindings.VAULT as Vault, { userId: owner } as UserScope, ref)).toBe(
      CANARY,
    );
  });
});

describe("the rotation runner", () => {
  it("1 → (2, PREV=1): the cron re-keys every user, health says delete PREV, all still decrypt", async () => {
    const key1 = newKey();
    const { browser, owner } = await claim();
    await db
      .prepare("INSERT INTO users (id, display_name, role) VALUES ('u2', 'B', 'member')")
      .run();
    const scopes = [owner, "u2"].map((userId) => ({ userId }) as UserScope);
    const ref = {
      secretId: "",
      purpose: "model_api_key",
      binding: BINDING,
      caller: "test",
    } as const;
    const v1 = await vaultOf(key1);
    for (const [i, scope] of scopes.entries()) {
      await encrypt(v1, scope, { ...ref, secretId: `s${i}`, plaintext: `${CANARY}${i}` });
    }

    const key2 = `2:${newKey()}`;
    const raw: WorkerEnv = { ...env, OPA_MASTER_KEY: key2, OPA_MASTER_KEY_PREV: key1 };
    const health = async (bindings: WorkerEnv) => {
      const res = await as(browser, await compose(bindings)).req("/api/health");
      return (await res.json<{ vault: unknown }>()).vault;
    };
    expect(await health(raw)).toEqual({ rotation: "pending", orphanedRows: 0 });

    const ctx = createExecutionContext();
    await worker.scheduled({} as ScheduledController, raw, ctx);
    await waitOnExecutionContext(ctx);
    expect(await count("user_keys", "kek_version = 2")).toBe(2);
    expect(await count("audit_log", "action = 'vault.rewrap'")).toBe(1);
    expect(await count("audit_log", "action = 'vault.retire_epoch'")).toBe(1);
    expect(await health(raw)).toEqual({
      rotation: "complete",
      orphanedRows: 0,
      action: "delete OPA_MASTER_KEY_PREV",
    });
    // A tick with nothing left to move writes nothing.
    const again = createExecutionContext();
    await worker.scheduled({} as ScheduledController, raw, again);
    await waitOnExecutionContext(again);
    expect(await count("audit_log", "action LIKE 'vault.re%'")).toBe(2);

    // The operator deletes PREV: every user still decrypts.
    const v2 = await vaultOf(key2);
    for (const [i, scope] of scopes.entries()) {
      expect(await decrypt(v2, scope, { ...ref, secretId: `s${i}` })).toBe(`${CANARY}${i}`);
    }
    expect(await health({ ...env, OPA_MASTER_KEY: key2 })).toEqual({
      rotation: "none",
      orphanedRows: 0,
    });
  });
});
