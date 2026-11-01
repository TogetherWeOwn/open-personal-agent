// SPDX-License-Identifier: Apache-2.0
// Crypto review C-1 on Node: the scheduled tick runs a pending rotation, and a reset deletes a
// user's DEK and secrets in one SQLite batch, as on Workers.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { d1VaultStore } from "@opa/db/vault-store";
import { createVault, decrypt, encrypt, resetUser, type UserScope } from "@opa/vault";
import { afterAll, describe, expect, it } from "vitest";
import { createNodeApp, type NodeApp } from "../src/compose";
import { sqliteD1 } from "../src/d1";

const root = join(import.meta.dirname, "../../..");
const dataDir = mkdtempSync(join(tmpdir(), "opa-rotation-"));
mkdirSync(join(dataDir, "web"));
const apps: NodeApp[] = [];
afterAll(() => {
  for (const app of apps) app.db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const newKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
/** The Node app over the shared data dir, with these master keys. */
function nodeApp(keys: Record<string, string>) {
  const app = createNodeApp({
    dataDir,
    migrationsDir: join(root, "migrations"),
    assetsDir: join(dataDir, "web"),
    vars: { OPA_SESSION_SECRET: "s", OPA_SETUP_TOKEN: "t", ...keys },
  });
  apps.push(app);
  return { app, store: d1VaultStore({ DB: sqliteD1(app.db) }) };
}
const ref = {
  purpose: "model_api_key",
  binding: "openai|https://x.test/v1",
  caller: "test",
} as const;
const health = async (app: NodeApp) =>
  (
    (await (await app.fetch(new Request("http://localhost/api/health"))).json()) as {
      vault: unknown;
    }
  ).vault;

describe("the vault on Node", () => {
  it("rotates on the scheduled tick, then decrypts with PREV removed", async () => {
    const key1 = newKey();
    const first = nodeApp({ OPA_MASTER_KEY: key1 });
    first.app.db.exec(
      "INSERT INTO users (id, display_name, role) VALUES ('a', 'A', 'owner'), ('b', 'B', 'member')",
    );
    const v1 = await createVault({ masterKey: key1, store: first.store });
    for (const userId of ["a", "b"]) {
      await encrypt(v1, { userId } as UserScope, { ...ref, secretId: userId, plaintext: userId });
    }

    const key2 = `2:${newKey()}`;
    const { app } = nodeApp({ OPA_MASTER_KEY: key2, OPA_MASTER_KEY_PREV: key1 });
    expect(await health(app)).toEqual({ rotation: "pending", orphanedRows: 0 });
    await app.scheduled();
    // The same tick records the database's size (M3-18 AC2).
    const d1 = app.db.prepare("SELECT amount FROM meters WHERE meter = 'd1_bytes'").get();
    expect((d1 as { amount: number }).amount).toBeGreaterThan(0);
    expect(await health(app)).toEqual({
      rotation: "complete",
      orphanedRows: 0,
      action: "delete OPA_MASTER_KEY_PREV",
    });
    const after = nodeApp({ OPA_MASTER_KEY: key2 });
    const v2 = await createVault({ masterKey: key2, store: after.store });
    for (const userId of ["a", "b"]) {
      expect(await decrypt(v2, { userId } as UserScope, { ...ref, secretId: userId })).toBe(userId);
    }
  });

  it("resets one user in one batch when no key opens their DEK", async () => {
    const { app, store } = nodeApp({ OPA_MASTER_KEY: `2:${newKey()}` });
    const regenerated = await createVault({ masterKey: `2:${newKey()}`, store });
    await resetUser(regenerated, { userId: "a" } as UserScope, { caller: "test" });
    const left = (sql: string) => (app.db.prepare(sql).get() as { n: number }).n;
    expect(left("SELECT count(*) AS n FROM user_keys WHERE user_id = 'a'")).toBe(0);
    expect(left("SELECT count(*) AS n FROM secrets WHERE user_id = 'a'")).toBe(0);
    expect(left("SELECT count(*) AS n FROM secrets WHERE user_id = 'b'")).toBe(1);
    expect(left("SELECT count(*) AS n FROM audit_log WHERE action = 'vault.reset_user'")).toBe(1);
  });
});
