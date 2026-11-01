// SPDX-License-Identifier: Apache-2.0
// TWO-427 L-4 (M3-21 AC6): every reference from one user's row to another user-owned row is
// bound to `user_id`, by a composite foreign key or by migration 0011's triggers. The test finds
// the references in the schema itself, so a new one that isn't bound fails here.
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "./helpers/app";
import { type Seeded, seedBoth } from "./helpers/isolation";

interface Reference {
  table: string;
  column: string;
  parent: string;
  /** The parent's column it points at. */
  to: string;
}

const hasUserId = async (table: string) =>
  (await db.prepare(`PRAGMA table_info("${table}")`).all<{ name: string }>()).results.some(
    (c) => c.name === "user_id",
  );

/**
 * Every foreign key from a table with `user_id` to another such table, but `users` itself.
 * `composite` lists the ones that already carry `user_id` in the key.
 */
async function references() {
  const { results: tables } = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
    )
    .all<{ name: string }>();
  const single: Reference[] = [];
  const composite: string[] = [];
  for (const { name: table } of tables) {
    if (!(await hasUserId(table))) continue;
    const keys = await db
      .prepare(`PRAGMA foreign_key_list("${table}")`)
      .all<{ id: number; table: string; from: string; to: string }>();
    const byId = new Map<number, typeof keys.results>();
    for (const key of keys.results) byId.set(key.id, [...(byId.get(key.id) ?? []), key]);
    for (const parts of byId.values()) {
      const [first] = parts;
      if (!first || first.table === "users" || !(await hasUserId(first.table))) continue;
      if (parts.length > 1) {
        expect([table, parts.map((p) => p.from)]).toEqual([
          table,
          expect.arrayContaining(["user_id"]),
        ]);
        composite.push(`${table}.${parts.map((p) => p.from).join("+")}`);
      } else single.push({ table, column: first.from, parent: first.table, to: first.to });
    }
  }
  return { single, composite };
}

let a: Seeded;
let b: Seeded;

beforeAll(async () => {
  const migrations = (workerEnv as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
  await applyD1Migrations(db, migrations);
});

beforeEach(async () => {
  ({ a, b } = await seedBoth());
});

/** Points `user`'s first row in `ref.table` at `target`'s row in the parent. */
async function repoint(ref: Reference, user: Seeded, target: Seeded) {
  const parentId = await db
    .prepare(`SELECT "${ref.to}" AS id FROM "${ref.parent}" WHERE user_id = ? LIMIT 1`)
    .bind(target.id)
    .first<string>("id");
  const rowid = await db
    .prepare(`SELECT rowid AS r FROM "${ref.table}" WHERE user_id = ? ORDER BY rowid LIMIT 1`)
    .bind(user.id)
    .first<number>("r");
  // The harness seeds a row of every type for both users; a new one needs seeding there.
  expect([ref.table, ref.parent, parentId, rowid]).toEqual([
    ref.table,
    ref.parent,
    expect.any(String),
    expect.any(Number),
  ]);
  return db
    .prepare(`UPDATE "${ref.table}" SET "${ref.column}" = ? WHERE rowid = ?`)
    .bind(parentId, rowid)
    .run();
}

describe("a reference to another user-owned row", () => {
  it("is refused when it points at another user's row, on every reference in the schema", async () => {
    const { single, composite } = await references();
    expect(single.length).toBeGreaterThan(0);
    expect(composite).toEqual(expect.arrayContaining(["memory_links.memory_id+user_id"]));
    for (const ref of single) {
      const label = `${ref.table}.${ref.column} -> ${ref.parent}`;
      const error = await repoint(ref, a, b).then(
        () => "written",
        (e: Error) => e.message,
      );
      expect([label, error]).toEqual([label, expect.stringContaining("cross_user_reference")]);
      // The same write to the user's own row goes through, so it's the owner that was refused.
      expect([label, (await repoint(ref, a, a)).success]).toEqual([label, true]);
    }
  });

  it("is bound on insert as well as update", async () => {
    const { single } = await references();
    const { results } = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
      .all<{ name: string }>();
    const triggers = new Set(results.map((r) => r.name));
    for (const { table, column } of single) {
      for (const on of ["insert", "update"]) {
        const name = `${table}_${column}_owner_${on}`;
        expect([name, triggers.has(name)]).toEqual([name, true]);
      }
    }
    // One insert end to end: A's message in B's conversation.
    const insert = db
      .prepare(
        "INSERT INTO messages (id, user_id, conversation_id, seq, role, content) VALUES (?, ?, ?, 9, 'user', 'x')",
      )
      .bind(crypto.randomUUID(), a.id, b.conversation);
    await expect(insert.run()).rejects.toThrow("cross_user_reference");
  });

  it("can't follow its parent to another user", async () => {
    for (const [table, id] of [
      ["conversations", a.conversation],
      ["messages", a.message],
      ["model_providers", a.provider],
      ["secrets", a.secret],
    ] as const) {
      const move = db.prepare(`UPDATE "${table}" SET user_id = ? WHERE id = ?`).bind(b.id, id);
      await expect(move.run(), table).rejects.toThrow("cross_user_reference");
    }
  });
});
