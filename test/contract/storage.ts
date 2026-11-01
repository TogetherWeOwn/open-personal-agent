// SPDX-License-Identifier: Apache-2.0
// Contract tests for the storage bindings. The Worker project runs them against D1 and R2, the
// Node project against apps/node's SQLite and local-directory adapters (`selfhost-parity`).
// A relative path: this file sits outside every workspace package, and apps/node has no `@opa/db`.

import { describe, expect, it } from "vitest";
import { createRepository, scopeFromSession } from "../../packages/db/src/repository";

let tables = 0;

export function databaseContract(name: string, db: () => D1Database) {
  describe(`${name}: DB contract`, () => {
    // Each test gets its own table, so the contract never depends on order or schema.
    async function table() {
      const t = `contract_${++tables}_${Date.now()}`;
      const columns = "id INTEGER PRIMARY KEY, name TEXT, flag INTEGER, data BLOB";
      await db().prepare(`CREATE TABLE ${t} (${columns})`).run();
      return t;
    }

    it("runs, reads and reports changes", async () => {
      const t = await table();
      const run = await db().prepare(`INSERT INTO ${t} (name) VALUES (?)`).bind("a").run();
      expect(run.meta).toMatchObject({ changes: 1, last_row_id: 1 });
      expect((await db().prepare(`SELECT id, name FROM ${t}`).all()).results).toEqual([
        { id: 1, name: "a" },
      ]);
      const select = db().prepare(`SELECT name FROM ${t} WHERE id = ?`);
      expect(await select.bind(1).first("name")).toBe("a");
      expect(await select.bind(2).first()).toBeNull();
    });

    it("reports changes for writes that return rows, and none for reads", async () => {
      const t = await table();
      const insert = db().prepare(`INSERT INTO ${t} (name) VALUES ('a'), ('b') RETURNING id`);
      const inserted = await insert.run();
      expect([inserted.results, inserted.meta.changes, inserted.meta.last_row_id]).toEqual([
        [{ id: 1 }, { id: 2 }],
        2,
        2,
      ]);
      const updated = await db().prepare(`UPDATE ${t} SET name = 'c' RETURNING id`).all();
      expect(updated.meta.changes).toBe(2);
      expect((await db().prepare(`SELECT id FROM ${t}`).all()).meta.changes).toBe(0);
    });

    it("binds booleans as 0/1, reads blobs as byte arrays and rejects undefined", async () => {
      const t = await table();
      const insert = db().prepare(`INSERT INTO ${t} (flag, data) VALUES (?, ?)`);
      await insert.bind(true, new Uint8Array([1, 2, 255]).buffer).run();
      const row = await db().prepare(`SELECT flag, data FROM ${t}`).first();
      expect(row).toEqual({ flag: 1, data: [1, 2, 255] });
      await expect((async () => insert.bind(undefined, null).run())()).rejects.toThrow();
    });

    it("keeps duplicate column names in raw()", async () => {
      const t = await table();
      await db().prepare(`INSERT INTO ${t} (id, name) VALUES (1, 'x')`).run();
      const join = db().prepare(`SELECT a.name, b.name FROM ${t} a JOIN ${t} b ON a.id = b.id`);
      expect(await join.raw({ columnNames: true })).toEqual([
        ["name", "name"],
        ["x", "x"],
      ]);
    });

    it("applies a batch all or nothing and enforces foreign keys", async () => {
      const t = await table();
      const insert = db().prepare(`INSERT INTO ${t} (id, name) VALUES (?, ?)`);
      await expect(db().batch([insert.bind(1, "a"), insert.bind(1, "dup")])).rejects.toThrow();
      expect(await db().prepare(`SELECT count(*) AS n FROM ${t}`).first("n")).toBe(0);
      await db().prepare(`CREATE TABLE ${t}_child (parent INTEGER REFERENCES ${t}(id))`).run();
      const orphan = db().prepare(`INSERT INTO ${t}_child (parent) VALUES (42)`);
      await expect(orphan.run()).rejects.toThrow();
    });
  });
}

export function blobStoreContract(name: string, bucket: () => R2Bucket) {
  describe(`${name}: FILES contract`, () => {
    it("stores, reads, overwrites and deletes an object", async () => {
      expect(await bucket().head("contract/a.txt")).toBeNull();
      expect(await bucket().get("contract/a.txt")).toBeNull();
      await bucket().put("contract/a.txt", "hello");
      // R2's etag for a single-part upload is the MD5 of the body.
      expect(await bucket().head("contract/a.txt")).toMatchObject({
        key: "contract/a.txt",
        size: 5,
        etag: "5d41402abc4b2a76b9719d911017c592",
      });
      expect(await (await bucket().get("contract/a.txt"))?.text()).toBe("hello");
      await bucket().put("contract/a.txt", new Uint8Array([0, 1, 2]));
      const bytes = await (await bucket().get("contract/a.txt"))?.arrayBuffer();
      expect([...new Uint8Array(bytes ?? new ArrayBuffer(0))]).toEqual([0, 1, 2]);
      await bucket().delete("contract/a.txt");
      expect(await bucket().head("contract/a.txt")).toBeNull();
    });

    it("keeps keys that look like paths apart", async () => {
      await bucket().put("contract/../x", "one");
      await bucket().put("x", "two");
      expect(await (await bucket().get("contract/../x"))?.text()).toBe("one");
      await bucket().delete(["contract/../x", "x"]);
      expect(await bucket().head("x")).toBeNull();
    });
  });
}

/**
 * The usage ledger's statements through the repository (M2-21), against a migrated database:
 * `chat.settle` and `usage.record` write priced rows; `usage.totals` and
 * `deployment.workersAiNeurons` read them back.
 */
export function usageLedgerContract(name: string, migrated: () => Promise<D1Database>) {
  describe(`${name}: usage ledger contract`, () => {
    it("writes priced and unpriced rows and sums them per model and cost source", async () => {
      const DB = await migrated();
      const userId = `ledger-${++tables}`;
      await DB.prepare("INSERT INTO users (id, display_name, role) VALUES (?, 'L', 'owner')")
        .bind(userId)
        .run();
      const stub = {} as never;
      const repo = createRepository({ DB, FILES: stub, ASSISTANT: stub });
      const { chat, usage } = repo.forUser(scopeFromSession({ userId }));
      const counts = { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 0 };
      const turn = (model: string, replyId: string) => ({
        conversationId: `c-${userId}`,
        turnId: "t",
        replyId,
        providerId: "workers-ai",
        model,
        reply: "Hi",
        usage: counts,
        called: true,
      });
      const before = Date.now() - 1;
      expect(await chat.open(`c-${userId}`, "Ledger")).toBe(true);
      for (const [model, replyId] of [
        ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", `r1-${userId}`],
        ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", `r2-${userId}`],
        ["@cf/unlisted", `r3-${userId}`],
      ] as const) {
        await chat.startTurn(`c-${userId}`, "Hello", replyId);
        await chat.settle(turn(model, replyId), "complete");
      }
      expect(await usage.totals(before)).toEqual([
        {
          providerId: "workers-ai",
          model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          costSource: "estimated",
          calls: 2,
          inputTokens: 2000,
          outputTokens: 1000,
          costMicroUsd: 2840,
          priceVerifiedAt: "2026-11-01",
        },
        {
          providerId: "workers-ai",
          model: "@cf/unlisted",
          costSource: null,
          calls: 1,
          inputTokens: 1000,
          outputTokens: 500,
          costMicroUsd: null,
          priceVerifiedAt: null,
        },
      ]);
      const neurons = repo.deployment.workersAiNeurons;
      expect(await neurons(before)).toBe(260);
      await usage.record({ providerId: "openai", model: "gpt-4.1-mini", usage: counts });
      expect((await usage.totals(before)).find((r) => r.providerId === "openai")).toMatchObject({
        calls: 1,
        costMicroUsd: 1200,
        costSource: "estimated",
      });
      const later = Date.now() + 1000;
      expect([await usage.totals(later), await neurons(later)]).toEqual([[], 0]);
    });
  });
}

/**
 * The memory store (M3-14a), against a migrated database: the hand-written FTS5 index and its
 * triggers, and `MemoryService`'s reads. Rows are inserted directly here; the service's
 * trust-gated writes have their own contract.
 */
export function memoryContract(name: string, migrated: () => Promise<D1Database>) {
  describe(`${name}: memory contract`, () => {
    async function user() {
      const DB = await migrated();
      const userId = `memory-${++tables}-${Date.now()}`;
      await DB.prepare("INSERT INTO users (id, display_name, role) VALUES (?, 'M', 'owner')")
        .bind(userId)
        .run();
      const stub = {} as never;
      const repo = createRepository({ DB, FILES: stub, ASSISTANT: stub });
      const { memory } = repo.forUser(scopeFromSession({ userId }));
      const insert = async (text: string, status = "active") => {
        const id = crypto.randomUUID();
        await DB.prepare(
          `INSERT INTO memories (id, user_id, kind, text, trust, status, op, source)
           VALUES (?, ?, 'fact', ?, 'user', ?, 'create', 'chat')`,
        )
          .bind(id, userId, text, status)
          .run();
        return id;
      };
      return { DB, userId, memory, insert };
    }
    /** Index entries for `word`, every user's: the index itself, not the service's filter. */
    const indexed = async (DB: D1Database, word: string) =>
      DB.prepare("SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH ?")
        .bind(`"${word}"`)
        .first("n");

    it("finds the user's current memories by word, prefix and without accents", async () => {
      const a = await user();
      const b = await user();
      const id = await a.insert("I'm vegetarian and love the café on Main St");
      await a.insert("Vegetarian guests eat free", "proposed");
      await a.insert("Was vegetarian once", "superseded");
      await b.insert("Vegetarian too");
      const texts = async (q: string) => (await a.memory.search(q)).map((m) => m.text);
      expect(await texts("VEGETARIAN")).toEqual(["I'm vegetarian and love the café on Main St"]);
      expect(await texts("veg cafe")).toHaveLength(1);
      expect(await texts("vegetarian lisbon")).toEqual([]);
      expect(await texts("cafe\u0301")).toHaveLength(1); // a decomposed accent
      const decomposed = await a.insert("Sent her re\u0301sume\u0301");
      expect((await a.memory.search("résumé")).map((m) => m.id)).toEqual([decomposed]);
      expect((await a.memory.search("re\u0301sume\u0301")).map((m) => m.id)).toEqual([decomposed]);
      expect(await texts('") OR * NEAR(')).toEqual([]); // FTS5 syntax is never passed through
      expect(await texts("")).toEqual([]);
      expect((await a.memory.list()).map((m) => m.id)).toEqual([decomposed, id]);
      expect(await a.memory.get(id)).toMatchObject({ id, trust: "user", source: "chat" });
      expect(await b.memory.get(id)).toBeUndefined();
    });

    it("ranks by relevance and caps the results", async () => {
      const { memory, insert } = await user();
      await insert("tea");
      await insert("tea and more tea, green tea");
      await insert("coffee, not tea, with a long tail of other words");
      expect((await memory.search("tea")).map((m) => m.text)).toEqual([
        "tea and more tea, green tea",
        "tea",
        "coffee, not tea, with a long tail of other words",
      ]);
      expect(await memory.search("tea", 1)).toHaveLength(1);
    });

    it("keeps the index in step with inserts, text changes, deletes and deleting the user", async () => {
      const { DB, userId, insert } = await user();
      const id = await insert("Collects xylophones");
      expect(await indexed(DB, "xylophones")).toBe(1);
      await DB.prepare("UPDATE memories SET text = 'Collects kazoos' WHERE id = ?").bind(id).run();
      expect([await indexed(DB, "xylophones"), await indexed(DB, "kazoos")]).toEqual([0, 1]);
      await DB.prepare("UPDATE memories SET status = 'superseded' WHERE id = ?").bind(id).run();
      expect(await indexed(DB, "kazoos")).toBe(1);
      await DB.prepare("DELETE FROM memories WHERE id = ?").bind(id).run();
      expect(await indexed(DB, "kazoos")).toBe(0);
      await insert("Plays the theremin");
      await DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
      expect(await indexed(DB, "theremin")).toBe(0);
      expect(
        await DB.prepare(
          "INSERT INTO memories_fts (memories_fts) VALUES ('integrity-check')",
        ).run(),
      ).toMatchObject({ success: true });
    });

    it("links memories only within one user", async () => {
      const a = await user();
      const b = await user();
      const [old, next, theirs] = [
        await a.insert("Old"),
        await a.insert("New"),
        await b.insert("B"),
      ];
      const link = a.DB.prepare(
        "INSERT INTO memory_links (memory_id, target_id, user_id) VALUES (?, ?, ?)",
      );
      await link.bind(next, old, a.userId).run();
      for (const args of [
        [next, theirs, a.userId],
        [theirs, old, a.userId],
        [next, old, b.userId],
      ]) {
        await expect((async () => link.bind(...args).run())()).rejects.toThrow();
      }
      await a.DB.prepare("DELETE FROM memories WHERE id = ?").bind(old).run();
      const left = await a.DB.prepare("SELECT count(*) AS n FROM memory_links WHERE memory_id = ?")
        .bind(next)
        .first("n");
      expect(left).toBe(0);
    });
  });
}
