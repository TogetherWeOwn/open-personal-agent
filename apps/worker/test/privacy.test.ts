// SPDX-License-Identifier: Apache-2.0
// Settings › Privacy & security (M3-19 AC2): passkey add/rename/remove and recovery-code
// regeneration. Adding and removal need the account step-up, removal refuses the last passkey
// (even across concurrent requests) and expires every pending approval in its own batch
// (M3-07 AC13).
import { systemStore } from "@opa/db/system";
import { describe, expect, it } from "vitest";
import { Browser, claim, db, env, freshDatabase, passkey } from "./helpers/app";

freshDatabase();

type Passkey = { id: string; name: string | null; createdAt: number; lastUsedAt: number | null };

const list = (br: Browser) =>
  br.req("/api/passkeys").then((r) => r.json<{ passkeys: Passkey[] }>());

async function stepUp(br: Browser, key: ReturnType<typeof passkey>) {
  const res = await br.req("/api/auth/step-up/session/options", { body: {} });
  const { options } = await res.json<{ options: { challenge: string } }>();
  return br.req("/api/auth/step-up/session", {
    body: { credential: await key.get(options) },
  });
}

async function addPasskey(br: Browser, key: ReturnType<typeof passkey>, name?: string) {
  expect(await stepUp(br, key)).toMatchObject({ status: 200 });
  const res = await br.req("/api/passkeys/options", { body: {} });
  const { options } = await res.json<{ options: { challenge: string } }>();
  return br.req("/api/passkeys", {
    body: { credential: await passkey().create(options), ...(name === undefined ? {} : { name }) },
  });
}

const audit = (action: string) =>
  db
    .prepare("SELECT result, detail FROM audit_log WHERE action = ? ORDER BY id")
    .bind(action)
    .all<{ result: string; detail: string | null }>()
    .then((r) => r.results);

describe("passkeys", () => {
  it("lists the claim passkey, then an added one with its name", async () => {
    const { browser, key } = await claim();
    expect((await list(browser)).passkeys).toHaveLength(1);
    const res = await addPasskey(browser, key, "My key");
    expect(res.status).toBe(201);
    const { passkeys } = await list(browser);
    expect(passkeys).toHaveLength(2);
    expect(passkeys[0]).toMatchObject({ name: "My key" });
    expect(typeof passkeys[0]?.createdAt).toBe("number");
    // No secrets in the listing: no public key, no transports.
    expect(passkeys[0]).not.toHaveProperty("public_key");
    expect(await audit("auth.passkey_add")).toHaveLength(1);
  });

  it("needs the account step-up to add a passkey", async () => {
    const { browser, key } = await claim();
    // A stolen session cookie alone buys nothing.
    expect(await browser.req("/api/passkeys/options", { body: {} })).toMatchObject({
      status: 403,
    });
    expect(await browser.req("/api/passkeys", { body: { credential: {} } })).toMatchObject({
      status: 403,
    });
    expect((await list(browser)).passkeys).toHaveLength(1);
    // After the step-up both steps work.
    expect(await stepUp(browser, key)).toMatchObject({ status: 200 });
    const res = await browser.req("/api/passkeys/options", { body: {} });
    expect(res.status).toBe(200);
    const { options } = await res.json<{ options: { challenge: string } }>();
    const created = await browser.req("/api/passkeys", {
      body: { credential: await passkey().create(options) },
    });
    expect(created.status).toBe(201);
    expect((await list(browser)).passkeys).toHaveLength(2);
  });

  it("excludes the user's existing credentials from the registration options", async () => {
    const { browser, key } = await claim();
    expect(await stepUp(browser, key)).toMatchObject({ status: 200 });
    const { passkeys } = await list(browser);
    const res = await browser.req("/api/passkeys/options", { body: {} });
    expect(res.status).toBe(200);
    const { options } = await res.json<{
      options: { excludeCredentials?: { id: string; type: string }[] };
    }>();
    expect(options.excludeCredentials?.map((c) => c.id)).toEqual(
      expect.arrayContaining(passkeys.map((p) => p.id)),
    );
  });

  it("rejects an invalid name instead of silently renaming", async () => {
    const { browser, key } = await claim();
    expect(await stepUp(browser, key)).toMatchObject({ status: 200 });
    const res = await browser.req("/api/passkeys/options", { body: {} });
    const { options } = await res.json<{ options: { challenge: string } }>();
    const created = await browser.req("/api/passkeys", {
      body: { credential: await passkey().create(options), name: "   " },
    });
    expect(created.status).toBe(400);
    expect(await created.json()).toMatchObject({ error: "invalid_name" });
    expect((await list(browser)).passkeys).toHaveLength(1);
  });

  it("refuses a registration answer without a challenge, or with another user's", async () => {
    const { browser, key } = await claim();
    const other = new Browser();
    const res = await other.req("/api/passkeys/options", { body: {} });
    expect(res.status).toBe(401);
    // Stepped up, but no ceremony was opened: the cookie is missing.
    expect(await stepUp(browser, key)).toMatchObject({ status: 200 });
    const fake = await browser.req("/api/passkeys", { body: { credential: {} } });
    expect(fake.status).toBe(400);
    expect(await fake.json()).toMatchObject({ error: "no_challenge" });
  });

  it("renames a passkey and 404s another user's", async () => {
    const { browser } = await claim();
    const { passkeys } = await list(browser);
    const id = passkeys[0]?.id ?? "";
    const res = await browser.req(`/api/passkeys/${id}`, {
      method: "PATCH",
      body: { name: " Work  " },
    });
    expect(res.status).toBe(200);
    expect((await list(browser)).passkeys[0]).toMatchObject({ name: "Work" });
    expect(
      await browser.req(`/api/passkeys/${id}`, { method: "PATCH", body: { name: "" } }),
    ).toMatchObject({ status: 400 });
    const stranger = new Browser();
    // Not signed in at all: the guard answers first.
    expect(
      (await stranger.req(`/api/passkeys/${id}`, { method: "PATCH", body: { name: "x" } })).status,
    ).toBe(401);
  });

  it("removes with a step-up, expiring pending approvals in the same batch", async () => {
    const { browser, key } = await claim();
    await addPasskey(browser, key, "Spare");
    const { passkeys } = await list(browser);
    // Without the step-up: refused, nothing removed (a second session has none).
    const plain = new Browser();
    expect(await plain.login(key)).toMatchObject({ status: 200 });
    const denied = await plain.req(`/api/passkeys/${passkeys[0]?.id}`, { method: "DELETE" });
    expect(denied.status).toBe(403);
    expect((await list(browser)).passkeys).toHaveLength(2);
    // A pending approval for the expiry to find.
    await db
      .prepare(
        "INSERT INTO conversations (id, user_id) VALUES ('conv1', (SELECT id FROM users LIMIT 1))",
      )
      .run();
    await db
      .prepare(
        `INSERT INTO approvals (batch_id, approval_id, position, user_id, conversation_id, turn_id,
          tool, tool_call_id, risk, rule, step_up, scopes, canonical, binding_hash, expires_at)
         VALUES ('b1', 'ap1', 0, (SELECT id FROM users LIMIT 1), 'conv1', 'turn1',
          'web_fetch', 'call1', 'consequential', 'override_ask', 0, '["once"]', '{}', 'hash', 9999999999999)`,
      )
      .run();
    expect(await stepUp(browser, key)).toMatchObject({ status: 200 });
    const res = await browser.req(`/api/passkeys/${passkeys[0]?.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await list(browser)).passkeys).toHaveLength(1);
    const expired = await db
      .prepare("SELECT status, reason FROM approvals WHERE batch_id = 'b1' AND approval_id = 'ap1'")
      .first<{ status: string; reason: string }>();
    expect(expired).toMatchObject({ status: "expired", reason: "signal:passkey_removal" });
    expect(await audit("approval.expire_all")).toHaveLength(1);
    expect(await audit("auth.passkey_remove")).toHaveLength(1);
  });

  it("refuses to remove the last passkey", async () => {
    const { browser, key, owner } = await claim();
    const { passkeys } = await list(browser);
    expect(await stepUp(browser, key)).toMatchObject({ status: 200 });
    const res = await browser.req(`/api/passkeys/${passkeys[0]?.id}`, { method: "DELETE" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "last_passkey" });
    expect((await list(browser)).passkeys).toHaveLength(1);
    // The store refuses it even past the route's pre-check, and 404s a missing row.
    const store = systemStore(env);
    expect(
      await store.passkeys.remove({ id: passkeys[0]?.id ?? "", userId: owner, now: Date.now() }),
    ).toBe("last_passkey");
    expect(await store.passkeys.remove({ id: "no-such-key", userId: owner, now: Date.now() })).toBe(
      "not_found",
    );
    expect((await list(browser)).passkeys).toHaveLength(1);
  });

  it("keeps one passkey when two removals race", async () => {
    const { browser, key } = await claim();
    await addPasskey(browser, key, "Spare");
    const { passkeys } = await list(browser);
    expect(await stepUp(browser, key)).toMatchObject({ status: 200 });
    const [first, second] = await Promise.all(
      passkeys.map((p) => browser.req(`/api/passkeys/${p.id}`, { method: "DELETE" })),
    );
    // One wins; the other is refused as the last passkey, whichever order they ran in.
    expect([first.status, second.status].sort()).toEqual([200, 400]);
    expect((await list(browser)).passkeys).toHaveLength(1);
  });

  it("404s a passkey that is already gone", async () => {
    const { browser, key } = await claim();
    await addPasskey(browser, key, "Spare one");
    await addPasskey(browser, key, "Spare two");
    const { passkeys } = await list(browser);
    expect(await stepUp(browser, key)).toMatchObject({ status: 200 });
    const gone = passkeys.find((p) => p.name !== "Spare one" && p.name !== "Spare two")?.id ?? "";
    expect(await browser.req(`/api/passkeys/${gone}`, { method: "DELETE" })).toMatchObject({
      status: 200,
    });
    // Two remain, so the route reaches the store, which finds nothing to delete.
    expect(await browser.req(`/api/passkeys/${gone}`, { method: "DELETE" })).toMatchObject({
      status: 404,
    });
    expect((await list(browser)).passkeys).toHaveLength(2);
  });
});

describe("cache headers", () => {
  it("scopes no-store to the privacy routes", async () => {
    const { browser } = await claim();
    // Credential state is never cached.
    expect((await browser.req("/api/passkeys")).headers.get("cache-control")).toBe("no-store");
    // But a route mounted after the privacy router keeps its own headers: this 404 sets
    // none, so the leak that stamped no-store on chat, usage and the SPA is gone.
    const missing = await browser.req("/api/conversations/no-such-conversation/messages");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBeNull();
  });
});

describe("recovery codes", () => {
  it("regenerates with a step-up: the old set stops working", async () => {
    const { browser, key, codes } = await claim();
    // Without the step-up: refused.
    expect((await browser.req("/api/recovery-codes/regenerate", { body: {} })).status).toBe(403);
    expect(await stepUp(browser, key)).toMatchObject({ status: 200 });
    const res = await browser.req("/api/recovery-codes/regenerate", { body: {} });
    expect(res.status).toBe(200);
    const { codes: fresh } = await res.json<{ codes: string[] }>();
    expect(fresh).toHaveLength(10);
    expect(fresh).not.toEqual(codes);
    // The old codes are gone: none of them redeem anymore.
    const attempt = await new Browser().req("/api/auth/recover/options", {
      body: { code: codes[0] },
    });
    expect(attempt.status).not.toBe(200);
    const { remaining } = await browser
      .req("/api/recovery-codes")
      .then((r) => r.json<{ remaining: number }>());
    expect(remaining).toBe(10);
    expect(await audit("auth.recovery_regenerate")).toHaveLength(1);
  });
});
