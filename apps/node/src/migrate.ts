// SPDX-License-Identifier: Apache-2.0
// Applies `migrations/*.sql` in order, the same files `wrangler d1 migrations apply` runs, and
// records each one in wrangler's `d1_migrations` table.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

/** Applies the pending migrations, each in its own transaction. Returns their names. */
export function migrate(db: DatabaseSync, dir: string): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`);
  const done = new Set(
    (db.prepare("SELECT name FROM d1_migrations").all() as { name: string }[]).map((r) => r.name),
  );
  const pending = readdirSync(dir)
    .filter((name) => name.endsWith(".sql") && !done.has(name))
    .sort();
  for (const name of pending) {
    db.exec("BEGIN");
    try {
      db.exec(readFileSync(join(dir, name), "utf8"));
      db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return pending;
}
