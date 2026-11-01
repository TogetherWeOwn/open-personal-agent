// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";
import {
  blobStoreContract,
  databaseContract,
  memoryContract,
  memoryGateContract,
  usageLedgerContract,
} from "../../../test/contract/storage";
import { localBlobStore } from "../src/blobs";
import { APP_ROUTES } from "../src/compose";
import { openSqlite, sqliteD1 } from "../src/d1";
import { migrate } from "../src/migrate";

const dir = mkdtempSync(join(tmpdir(), "opa-parity-"));
const sqlite = openSqlite(join(dir, "test.sqlite"));
afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

databaseContract("SQLite", () => sqliteD1(sqlite));
blobStoreContract("local files", () => localBlobStore(join(dir, "files")));
usageLedgerContract("SQLite", async () => {
  migrate(sqlite, join(import.meta.dirname, "../../../migrations"));
  return sqliteD1(sqlite);
});
memoryContract("SQLite", async () => {
  migrate(sqlite, join(import.meta.dirname, "../../../migrations"));
  return sqliteD1(sqlite);
});
memoryGateContract("SQLite", async () => {
  migrate(sqlite, join(import.meta.dirname, "../../../migrations"));
  return sqliteD1(sqlite);
});

describe("Node composition", () => {
  it("applies the same migrations as wrangler, once", () => {
    const migrations = join(import.meta.dirname, "../../../migrations");
    const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8"));
    const db = openSqlite(":memory:");
    expect(migrate(db, migrations)).toEqual(
      journal.entries.map((e: { tag: string }) => `${e.tag}.sql`),
    );
    expect(migrate(db, migrations)).toEqual([]);
    db.close();
  });

  it("routes the same paths to the app as wrangler.jsonc", () => {
    const config = unstable_readConfig({
      config: join(import.meta.dirname, "../../../wrangler.jsonc"),
    });
    expect(APP_ROUTES).toEqual(config.assets?.run_worker_first);
  });
});
