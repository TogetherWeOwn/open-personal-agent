// SPDX-License-Identifier: Apache-2.0
// The exports table and scope minting for the export Workflow (M3-20 AC1): a Workflow's authority
// comes from its exports row alone, another user's export is invisible, a finished row never moves
// again, and every item type the export walks lists its rows.
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { createRepository, isUniqueViolation, scopeFromSession } from "@opa/db/repository";
import { beforeAll, describe, expect, it } from "vitest";
import type { WorkerEnv } from "../src/compose";

const env = workerEnv as unknown as WorkerEnv & { TEST_MIGRATIONS: D1Migration[] };
const repo = createRepository(env);
const alice = repo.forUser(scopeFromSession({ userId: "alice" }));
const bob = repo.forUser(scopeFromSession({ userId: "bob" }));

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare(
    "INSERT INTO users (id, display_name, role) VALUES ('alice', 'A', 'owner'), ('bob', 'B', 'member')",
  ).run();
  await alice.createConversation("ca", "Alice's");
  await bob.createConversation("cb", "Bob's");
});

describe("export rows", () => {
  it("creates a running export; a duplicate instance or a bad id creates none", async () => {
    expect(
      await alice.exports.create({ id: "e1", workflowInstanceId: "exp-e1", expiresAt: 3600000 }),
    ).toBe(true);
    expect((await alice.exports.get("e1"))?.status).toBe("running");
    // The instance id is the Workflow's authority: it names one row, so a second fails.
    expect(
      await alice.exports.create({ id: "e1b", workflowInstanceId: "exp-e1", expiresAt: 3600000 }),
    ).toBe(false);
    expect(await alice.exports.get("e1b")).toBeUndefined();
    // Another user's export is invisible, and an unresolvable instance id is rejected.
    expect(await bob.exports.get("e1")).toBeUndefined();
    await expect(
      alice.exports.create({ id: "e9", workflowInstanceId: "x".repeat(129), expiresAt: 3600000 }),
    ).rejects.toThrow(/invalid instance id/);
    expect(await alice.exports.get("e9")).toBeUndefined();
  });

  it("rejects a second running export while one runs", async () => {
    // e1 above is still running: the partial unique index refuses a second `running` row.
    // D1 hides the violated constraint in the cause under drizzle's wrapper, so the test
    // reads it the way the route does.
    const raced = await alice.exports
      .create({ id: "e1b", workflowInstanceId: "exp-e1b", expiresAt: 3600000 })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(isUniqueViolation(raced)).toBe(true);
    expect(await alice.exports.get("e1b")).toBeUndefined();
  });

  it("mints the scope from the row's user_id, never from a claim about it", async () => {
    const minted = await repo.scopeForExport("exp-e1");
    expect(minted?.scope.userId).toBe("alice");
    expect(minted?.export.id).toBe("e1");
    // The minted scope really is Alice's authority, usable with forUser.
    expect((await repo.forUser(minted?.scope as never).exports.get("e1"))?.id).toBe("e1");
    // Nothing about the lookup can be steered: unknown or malformed instances mint nothing.
    expect(await repo.scopeForExport("exp-nope")).toBeNull();
    expect(await repo.scopeForExport("")).toBeNull();
    expect(await repo.scopeForExport("e1")).toBeNull();
    expect(await repo.scopeForExport("x".repeat(129))).toBeNull();
  });

  it("lists newest first, only the user's own", async () => {
    // Bob's export starts while Alice's e1 still runs: the one-running rule is per user.
    await bob.exports.create({ id: "e3", workflowInstanceId: "exp-e3", expiresAt: 3600000 });
    // e1's slot frees only when it finishes: one export runs at a time.
    await alice.exports.finishFailed("e1", "done");
    await alice.exports.create({ id: "e2", workflowInstanceId: "exp-e2", expiresAt: 3600000 });
    // `created_at` ticks in seconds; pin the order so the test asserts it, not the clock.
    await env.DB.batch([
      env.DB.prepare("UPDATE exports SET created_at = 1000 WHERE id = 'e1'"),
      env.DB.prepare("UPDATE exports SET created_at = 2000 WHERE id = 'e2'"),
    ]);
    expect((await alice.exports.list()).map((r) => r.id)).toEqual(["e2", "e1"]);
    expect((await bob.exports.list()).map((r) => r.id)).toEqual(["e3"]);
  });

  it("running finds the in-flight export, none once it finished", async () => {
    // e2 above still runs: finishing it frees Alice's slot for e4.
    await alice.exports.finishFailed("e2", "done");
    await alice.exports.create({ id: "e4", workflowInstanceId: "exp-e4", expiresAt: 3600000 });
    expect((await alice.exports.running())?.id).toBe("e4");
    expect((await bob.exports.running())?.id).toBe("e3");
    expect(await alice.exports.finishReady("e4", 12, 3000)).toBe(true);
    // A second running export now surfaces; a finished one never does.
    await alice.exports.create({ id: "e4b", workflowInstanceId: "exp-e4b", expiresAt: 3600000 });
    expect((await alice.exports.running())?.id).toBe("e4b");
    const done = (await alice.exports.list()).find((r) => r.id === "e4");
    expect(done?.status).toBe("ready");
    expect(done?.sizeBytes).toBe(12);
    expect(done?.readyAt).toBe(3000);
    expect(done?.expiresAt).toBe(3600000);
  });

  it("a finished export never moves again, and nobody finishes another's", async () => {
    // e4b above still runs: finishing it frees Alice's slot for e5.
    await alice.exports.finishFailed("e4b", "done");
    await alice.exports.create({ id: "e5", workflowInstanceId: "exp-e5", expiresAt: 3600000 });
    expect(await alice.exports.finishFailed("e5", "boom")).toBe(true);
    expect((await alice.exports.get("e5"))?.error).toBe("boom");
    // Terminal rows stay terminal, whatever the caller claims.
    expect(await alice.exports.finishReady("e5", 1, 4001)).toBe(false);
    expect(await alice.exports.finishFailed("e5", "again")).toBe(false);
    // Bob names Alice's rows and fails the user match, twice over; her own run stays running.
    await alice.exports.create({ id: "e6", workflowInstanceId: "exp-e6", expiresAt: 3600000 });
    expect(await bob.exports.finishReady("e5", 1, 4001)).toBe(false);
    expect(await bob.exports.finishFailed("e6", "smuggled")).toBe(false);
    expect((await alice.exports.get("e6"))?.status).toBe("running");
    await alice.exports.finishFailed("e6", "done");
  });

  it("refuses to ready a past-expiry row, leaving it running for the finish guard", async () => {
    // e6 above is finished: the slot is free for an export whose expiry the clock passes.
    await alice.exports.create({ id: "e6x", workflowInstanceId: "exp-e6x", expiresAt: 5000 });
    // The conditional update requires expiresAt > now: a late finish claims nothing, at or
    // past the boundary, and the row stays running for `export:finish` to expire.
    expect(await alice.exports.finishReady("e6x", 9, 5000)).toBe(false);
    expect(await alice.exports.finishReady("e6x", 9, 6000)).toBe(false);
    expect((await alice.exports.get("e6x"))?.status).toBe("running");
    // Before the expiry the same update still readies the row.
    expect(await alice.exports.finishReady("e6x", 9, 4999)).toBe(true);
    expect((await alice.exports.get("e6x"))?.status).toBe("ready");
  });

  it("keeps keys under the user's export prefix", async () => {
    expect(alice.exports.key("e1")).toBe("u/alice/exports/e1.zip");
    expect(alice.exports.stagedPrefix("e1")).toBe("u/alice/exports/e1/staged/");
    expect(alice.exports.stagedKey("e1", "conversations.json")).toBe(
      "u/alice/exports/e1/staged/conversations.json",
    );
    // Staged names are fixed filenames, never paths: separators become underscores.
    expect(alice.exports.stagedKey("e1", "../e2/staged/x")).toBe(
      "u/alice/exports/e1/staged/.._e2_staged_x",
    );
    expect(() => alice.exports.key("../bob/exports/e1")).toThrow(/invalid id/);
  });

  it("expires a running export and deletes its ZIP, never touching a finished row", async () => {
    // One export runs at a time: whatever an earlier test left running finishes first.
    const inFlight = await alice.exports.running();
    if (inFlight) await alice.exports.finishFailed(inFlight.id, "done");
    await alice.exports.create({ id: "e8", workflowInstanceId: "exp-e8", expiresAt: 3600000 });
    await env.FILES.put("u/alice/exports/e8.zip", "zip");
    expect(await alice.exports.finishExpired("e8")).toBe(true);
    expect((await alice.exports.get("e8"))?.status).toBe("expired");
    await alice.exports.removeZip("e8");
    expect(await env.FILES.get("u/alice/exports/e8.zip")).toBeNull();
    // A finished row never moves again, and another user's row is invisible.
    expect(await alice.exports.finishExpired("e8")).toBe(false);
    expect(await bob.exports.finishExpired("e8")).toBe(false);
    expect((await alice.exports.get("e8"))?.status).toBe("expired");
  });

  it("listPrefix enumerates staged keys in order, and nothing without a listing", async () => {
    const prefix = alice.exports.stagedPrefix("e7");
    await env.FILES.put(`${prefix}b.json`, "b");
    await env.FILES.put(`${prefix}a.json`, "a");
    await env.FILES.put("u/alice/files/not-staged", "x");
    expect(await alice.exports.listPrefix(prefix)).toEqual([
      { key: `${prefix}a.json`, size: 1 },
      { key: `${prefix}b.json`, size: 1 },
    ]);
    // Another user's directory is rejected, like getObject's foreign keys; Node has no
    // listing, so the walk sees none even for an own prefix.
    await expect(alice.exports.listPrefix(bob.exports.stagedPrefix("e7"))).rejects.toThrow(
      /invalid prefix/,
    );
    const noList = createRepository({ ...env, FILES: {} as never }).forUser(
      scopeFromSession({ userId: "alice" }),
    );
    expect(await noList.exports.listPrefix(prefix)).toEqual([]);
  });
});

describe("export item listings", () => {
  it("lists every task row, oldest first, only the user's own", async () => {
    await alice.tasks.create({
      id: "xt1",
      conversationId: "ca",
      workflowInstanceId: "xinst-1",
      kind: "turn",
      mode: "background" as const,
    });
    await bob.tasks.create({
      id: "xt2",
      conversationId: "cb",
      workflowInstanceId: "xinst-2",
      kind: "turn",
      mode: "background" as const,
    });
    expect((await alice.tasks.listForExport()).map((r) => r.id)).toContain("xt1");
    expect((await alice.tasks.listForExport()).map((r) => r.id)).not.toContain("xt2");
    expect((await bob.tasks.listForExport()).map((r) => r.id)).toEqual(["xt2"]);
  });

  it("lists every attachment row with its message, only the user's own", async () => {
    await alice.attachments.create({
      id: "xa1",
      name: "f.txt",
      mediaType: "text/plain",
      kind: "text",
      sizeBytes: 3,
    });
    const rows = await alice.attachments.list();
    expect(rows.find((r) => r.id === "xa1")).toMatchObject({
      name: "f.txt",
      conversationId: null,
      messageId: null,
    });
    expect(await bob.attachments.list()).toEqual([]);
  });

  it("lists every ledger row, oldest first, only the user's own", async () => {
    await alice.usage.record({
      providerId: "p",
      model: "m",
      usage: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 0 },
    });
    const rows = await alice.usage.list();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ providerId: "p", model: "m" });
    expect(await bob.usage.list()).toEqual([]);
  });

  it("lists every memory row and proposal for the export, whatever the status", async () => {
    await env.DB.batch([
      // An active memory with its superseded predecessor, a pending proposal and an
      // expired one: the live listings show only the active row and the pending proposal.
      env.DB.prepare(
        "INSERT INTO memories (id, user_id, kind, text, trust, status, op, source, created_at) VALUES ('mm-old', 'alice', 'fact', 'old', 'user', 'superseded', 'create', 'chat', 1000)",
      ),
      env.DB.prepare(
        "INSERT INTO memories (id, user_id, kind, text, trust, status, op, source, created_at) VALUES ('mm-new', 'alice', 'fact', 'new', 'user', 'active', 'update', 'chat', 4000)",
      ),
      env.DB.prepare(
        "INSERT INTO memories (id, user_id, kind, text, trust, status, op, source, created_at, expires_at) VALUES ('mm-prop', 'alice', 'fact', 'maybe', 'user', 'proposed', 'create', 'chat', 3000, 9999999999999)",
      ),
      env.DB.prepare(
        "INSERT INTO memories (id, user_id, kind, text, trust, status, op, source, created_at, expires_at) VALUES ('mm-stale', 'alice', 'fact', 'stale', 'user', 'proposed', 'create', 'chat', 2000, 1)",
      ),
      env.DB.prepare(
        "INSERT INTO memories (id, user_id, kind, text, trust, status, op, source) VALUES ('mm-bob', 'bob', 'fact', 'his', 'user', 'active', 'create', 'chat')",
      ),
    ]);
    expect((await alice.memory.list()).map((r) => r.id)).toEqual(["mm-new"]);
    expect((await alice.memory.proposals()).map((r) => r.id)).toEqual(["mm-prop"]);
    // The export's listings carry every row with its status, and every proposal.
    expect((await alice.memory.all()).map((r) => `${r.id}:${r.status}`)).toEqual([
      "mm-new:active",
      "mm-prop:proposed",
      "mm-stale:proposed",
      "mm-old:superseded",
    ]);
    expect((await alice.memory.allProposals()).map((r) => r.id)).toEqual(["mm-prop", "mm-stale"]);
    expect((await bob.memory.all()).map((r) => r.id)).toEqual(["mm-bob"]);
  });

  it("lists the user's own audit trail, oldest first; deployment rows belong to nobody", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO audit_log (user_id, action, module, result) VALUES ('alice', 'a1', 'm', 'ok')",
      ),
      env.DB.prepare(
        "INSERT INTO audit_log (user_id, action, module, result) VALUES (NULL, 'a0', 'm', 'ok')",
      ),
      env.DB.prepare(
        "INSERT INTO audit_log (user_id, action, module, result) VALUES ('bob', 'b1', 'm', 'denied')",
      ),
    ]);
    expect((await alice.audit.list()).map((r) => r.action)).toEqual(["a1"]);
    expect((await bob.audit.list()).map((r) => r.action)).toEqual(["b1"]);
  });
});
