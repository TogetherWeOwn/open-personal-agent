// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  mergeSnapshot,
  pad,
  parseArgs,
  renumberMigrations,
  rewriteSchemaVersionInsert,
} from "../renumber-migrations.mjs";

const col = (name, type = "text") => ({
  name,
  type,
  primaryKey: false,
  notNull: true,
  autoincrement: false,
});
const table = (name, columns) => ({
  name,
  columns: Object.fromEntries(columns.map((c) => [c.name, c])),
  indexes: {},
  foreignKeys: {},
  compositePrimaryKeys: {},
  uniqueConstraints: {},
  checkConstraints: {},
});
const snapshot = (id, prevId, tables) => ({
  version: "6",
  dialect: "sqlite",
  id,
  prevId,
  tables,
  views: {},
  enums: {},
  _meta: { schemas: {}, tables: {}, columns: {} },
  internal: { indexes: {} },
});
const users = (...extra) => table("users", [col("id"), col("name"), ...extra]);
const sqlFor = (version, body = "SELECT 1;") =>
  `${body}--> statement-breakpoint\n` +
  `-- Hand-added: record the schema version this migration brings the database to.\n` +
  `INSERT INTO \`schema_version\` (\`version\`) VALUES (${version});\n`;
const entry = (idx, name, when = 100 + idx) => ({
  idx,
  version: "6",
  when,
  tag: `${pad(idx)}_${name}`,
  breakpoints: true,
});
const journal = (entries) => ({ version: "7", dialect: "sqlite", entries });

// Fork point: 0000_base, 0001_users. Main then adds 0002_bar (users.email) and 0003_baz.
const S0 = snapshot("id-0", "00000000-0000-0000-0000-000000000000", {});
const S1 = snapshot("id-1", "id-0", { users: users() });
const S2_BAR = snapshot("id-2bar", "id-1", { users: users(col("email")) });
const S3_BAZ = snapshot("id-3baz", "id-2bar", {
  baz: table("baz", [col("id")]),
  users: users(col("email")),
});
// The branch, forked at 0001, adds users.about and a foo table as its 0002.
const S2_FOO = snapshot("id-2foo", "id-1", {
  foo: table("foo", [col("id")]),
  users: users(col("about")),
});

const BASE_FILES = {
  "migrations/0000_base.sql": sqlFor(0),
  "migrations/0001_users.sql": sqlFor(1),
  "migrations/0002_bar.sql": sqlFor(2),
  "migrations/0003_baz.sql": sqlFor(3),
  "migrations/meta/0000_snapshot.json": `${JSON.stringify(S0, null, 2)}\n`,
  "migrations/meta/0001_snapshot.json": `${JSON.stringify(S1, null, 2)}\n`,
  "migrations/meta/0002_snapshot.json": `${JSON.stringify(S2_BAR, null, 2)}\n`,
  "migrations/meta/0003_snapshot.json": `${JSON.stringify(S3_BAZ, null, 2)}\n`,
  "migrations/meta/_journal.json": `${JSON.stringify(
    journal([entry(0, "base"), entry(1, "users"), entry(2, "bar"), entry(3, "baz")]),
    null,
    2,
  )}\n`,
};

const fakeGit = (files = BASE_FILES) => ({
  fetch: () => {
    throw new Error("fetch must be disabled in tests");
  },
  show: (spec) => {
    const prefix = "origin/main:";
    return spec.startsWith(prefix) ? (files[spec.slice(prefix.length)] ?? null) : null;
  },
});

/** Writes a repo root whose branch forked at 0001; `own` lists its extra migrations. */
function setup({ own = [{ number: 2, name: "foo", snap: S2_FOO, when: 200 }], extra = {} } = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "opa-renumber-"));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write("migrations/0000_base.sql", BASE_FILES["migrations/0000_base.sql"]);
  write("migrations/0001_users.sql", BASE_FILES["migrations/0001_users.sql"]);
  write("migrations/meta/0000_snapshot.json", BASE_FILES["migrations/meta/0000_snapshot.json"]);
  write("migrations/meta/0001_snapshot.json", BASE_FILES["migrations/meta/0001_snapshot.json"]);
  const entries = [entry(0, "base"), entry(1, "users")];
  for (const o of own) {
    write(`migrations/${pad(o.number)}_${o.name}.sql`, sqlFor(o.number, o.body));
    write(`migrations/meta/${pad(o.number)}_snapshot.json`, `${JSON.stringify(o.snap, null, 2)}\n`);
    entries.push(entry(o.number, o.name, o.when));
  }
  write("migrations/meta/_journal.json", `${JSON.stringify(journal(entries), null, 2)}\n`);
  const latest = own.length ? own[own.length - 1].number : 1;
  write("packages/db/src/index.ts", `export const SCHEMA_VERSION = ${latest};\n`);
  for (const [rel, text] of Object.entries(extra)) write(rel, text);
  const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
  const exists = (rel) => fs.existsSync(path.join(root, rel));
  const run = (opts = {}) =>
    renumberMigrations({ root, fetch: false, git: fakeGit(), log: () => {}, ...opts });
  return { root, read, exists, run };
}

describe("renumberMigrations", () => {
  it("renumbers a colliding branch migration onto main's latest, merging the snapshot", () => {
    const t = setup();
    const result = t.run();
    expect(result.changed).toBe(true);
    expect(t.exists("migrations/0002_foo.sql")).toBe(false);
    expect(t.read("migrations/0004_foo.sql")).toContain("VALUES (4);");
    // Main's files are restored so migrations/ is complete on its own.
    expect(t.read("migrations/0002_bar.sql")).toContain("VALUES (2);");
    expect(t.read("migrations/0003_baz.sql")).toContain("VALUES (3);");
    expect(t.read("migrations/meta/0002_snapshot.json")).toContain('"id-2bar"');
    const snap = JSON.parse(t.read("migrations/meta/0004_snapshot.json"));
    expect(snap.id).toBe("id-2foo");
    expect(snap.prevId).toBe("id-3baz");
    expect(Object.keys(snap.tables)).toEqual(["baz", "foo", "users"]);
    // Both sides' columns survive: main's email and the branch's about.
    expect(Object.keys(snap.tables.users.columns)).toEqual(["id", "name", "email", "about"]);
    const entries = JSON.parse(t.read("migrations/meta/_journal.json")).entries;
    expect(entries.map((e) => e.tag)).toEqual([
      "0000_base",
      "0001_users",
      "0002_bar",
      "0003_baz",
      "0004_foo",
    ]);
    expect(entries[4]).toMatchObject({ idx: 4, when: 200 });
    expect(t.read("packages/db/src/index.ts")).toBe("export const SCHEMA_VERSION = 4;\n");
  });

  it("is idempotent: a second run changes nothing", () => {
    const t = setup();
    t.run();
    const before = t.read("migrations/meta/0004_snapshot.json");
    expect(t.run().changed).toBe(false);
    expect(t.read("migrations/meta/0004_snapshot.json")).toBe(before);
  });

  it("does nothing when the branch has no migrations of its own", () => {
    const t = setup({ own: [] });
    expect(t.run()).toEqual({ changed: false, actions: [], own: [] });
    expect(t.read("packages/db/src/index.ts")).toBe("export const SCHEMA_VERSION = 1;\n");
  });

  it("repairs a dropped base file even with no branch migrations", () => {
    const t = setup({ own: [] });
    fs.rmSync(path.join(t.root, "migrations/0001_users.sql"));
    const result = t.run();
    expect(result.changed).toBe(true);
    expect(t.read("migrations/0001_users.sql")).toContain("VALUES (1);");
    // The unmerged base entries stay unclaimed: journal and SCHEMA_VERSION are untouched.
    expect(JSON.parse(t.read("migrations/meta/_journal.json")).entries).toHaveLength(2);
    expect(t.read("packages/db/src/index.ts")).toBe("export const SCHEMA_VERSION = 1;\n");
    expect(t.exists("migrations/0002_bar.sql")).toBe(false);
  });

  it("renumbers several branch migrations consecutively, preserving their chain", () => {
    const qux = snapshot("id-3qux", "id-2foo", {
      foo: table("foo", [col("id"), col("label")]),
      users: users(col("about")),
    });
    const t = setup({
      own: [
        { number: 2, name: "foo", snap: S2_FOO, when: 200 },
        { number: 3, name: "qux", snap: qux, when: 201 },
      ],
    });
    t.run();
    expect(t.read("migrations/0004_foo.sql")).toContain("VALUES (4);");
    expect(t.read("migrations/0005_qux.sql")).toContain("VALUES (5);");
    const snap5 = JSON.parse(t.read("migrations/meta/0005_snapshot.json"));
    expect(snap5.prevId).toBe("id-2foo");
    expect(Object.keys(snap5.tables.foo.columns)).toEqual(["id", "label"]);
    expect(Object.keys(snap5.tables.users.columns)).toEqual(["id", "name", "email", "about"]);
    expect(t.read("packages/db/src/index.ts")).toBe("export const SCHEMA_VERSION = 5;\n");
  });

  it("fixes an already-merged tree where the snapshot slot kept the branch's copy", () => {
    const t = setup({
      extra: {
        "migrations/0002_bar.sql": BASE_FILES["migrations/0002_bar.sql"],
        "migrations/0003_baz.sql": BASE_FILES["migrations/0003_baz.sql"],
        "migrations/meta/0003_snapshot.json": BASE_FILES["migrations/meta/0003_snapshot.json"],
      },
    });
    t.run();
    expect(t.read("migrations/0004_foo.sql")).toContain("VALUES (4);");
    expect(t.read("migrations/meta/0002_snapshot.json")).toContain('"id-2bar"');
    expect(JSON.parse(t.read("migrations/meta/_journal.json")).entries).toHaveLength(5);
  });

  it("aborts without writing when both sides changed the same column", () => {
    const conflicting = snapshot("id-2foo", "id-1", {
      users: table("users", [col("id"), col("name", "integer")]),
    });
    const baseChanged = snapshot("id-2bar", "id-1", {
      users: table("users", [col("id"), col("name", "blob")]),
    });
    const files = {
      ...BASE_FILES,
      "migrations/meta/0002_snapshot.json": `${JSON.stringify(baseChanged, null, 2)}\n`,
      "migrations/meta/0003_snapshot.json": `${JSON.stringify(
        snapshot("id-3baz", "id-2bar", baseChanged.tables),
        null,
        2,
      )}\n`,
    };
    const t = setup({ own: [{ number: 2, name: "foo", snap: conflicting, when: 200 }] });
    const before = t.read("migrations/meta/_journal.json");
    expect(() =>
      renumberMigrations({
        root: t.root,
        fetch: false,
        git: fakeGit(files),
        log: () => {},
      }),
    ).toThrow(/tables\.users\.columns\.name\.type/);
    expect(t.exists("migrations/0004_foo.sql")).toBe(false);
    expect(t.read("migrations/meta/_journal.json")).toBe(before);
  });

  it("dry-run reports the plan without writing", () => {
    const t = setup();
    expect(t.run({ dryRun: true }).changed).toBe(true);
    expect(t.exists("migrations/0004_foo.sql")).toBe(false);
    expect(t.exists("migrations/0002_foo.sql")).toBe(true);
  });

  it("refuses to touch an applied migration that differs from the base", () => {
    const t = setup({ extra: { "migrations/0001_users.sql": "SELECT edited;\n" } });
    expect(() => t.run()).toThrow(/0001_users/);
  });

  it("aborts when a branch migration rebuilds a table main changed", () => {
    const body =
      "CREATE TABLE `__new_users` (`id` text, `name` text, `about` text);--> statement-breakpoint\n" +
      "INSERT INTO `__new_users` SELECT `id`, `name`, `about` FROM `users`;--> statement-breakpoint\n" +
      "DROP TABLE `users`;--> statement-breakpoint\n" +
      "ALTER TABLE `__new_users` RENAME TO `users`;";
    const t = setup({ own: [{ number: 2, name: "foo", snap: S2_FOO, when: 200, body }] });
    expect(() => t.run()).toThrow(/rebuilds table\(s\) users/);
    expect(t.exists("migrations/0004_foo.sql")).toBe(false);
  });

  it("aborts when a local file shares main's tag but not its content", () => {
    const t = setup({
      own: [],
      extra: { "migrations/0002_bar.sql": sqlFor(2, "ALTER TABLE `other` ADD `x` text;") },
    });
    expect(() => t.run()).toThrow(/0002_bar exists on origin\/main with different content/);
  });

  it("compares snapshots by content, so reformatting does not loop --check", () => {
    const t = setup();
    t.run();
    const snapPath = path.join(t.root, "migrations/meta/0004_snapshot.json");
    // Same JSON, different text (as after `pnpm format`).
    fs.writeFileSync(snapPath, JSON.stringify(JSON.parse(fs.readFileSync(snapPath, "utf8"))));
    expect(t.run().changed).toBe(false);
  });

  it("does not try to fetch a local stacked base", () => {
    const t = setup();
    const fetches = [];
    const git = {
      fetch: (...args) => fetches.push(args),
      remotes: () => ["origin"],
      show: (spec) => BASE_FILES[spec.slice("feat/base:".length)] ?? null,
    };
    renumberMigrations({ root: t.root, baseRef: "feat/base", git, log: () => {} });
    expect(fetches).toEqual([]);
    expect(t.read("migrations/0004_foo.sql")).toContain("VALUES (4);");
  });
});

describe("mergeSnapshot", () => {
  it("keeps a branch deletion while accepting main's unrelated addition", () => {
    const base = snapshot("b", "root", { old: table("old", [col("id")]), users: users() });
    const ours = snapshot("o", "b", { users: users() });
    const theirs = snapshot("t", "b", { old: table("old", [col("id")]), users: users(col("x")) });
    const merged = mergeSnapshot(base, ours, theirs);
    expect(Object.keys(merged.tables)).toEqual(["users"]);
    expect(Object.keys(merged.tables.users.columns)).toEqual(["id", "name", "x"]);
    expect(merged).toMatchObject({ id: "o", prevId: "t" });
  });

  it("keeps main's deletion of a table the branch left untouched", () => {
    const base = snapshot("b", "root", { old: table("old", [col("id")]), users: users() });
    const ours = snapshot("o", "b", { old: table("old", [col("id")]), users: users(col("y")) });
    const theirs = snapshot("t", "b", { users: users() });
    const merged = mergeSnapshot(base, ours, theirs);
    expect(Object.keys(merged.tables)).toEqual(["users"]);
    expect(Object.keys(merged.tables.users.columns)).toEqual(["id", "name", "y"]);
  });
});

describe("rewriteSchemaVersionInsert and parseArgs", () => {
  it("rewrites only the version value", () => {
    expect(rewriteSchemaVersionInsert(sqlFor(2), 2, 7, "x.sql")).toContain("VALUES (7);");
  });

  it("errors when the INSERT is missing or records another version", () => {
    expect(() => rewriteSchemaVersionInsert("SELECT 1;\n", 2, 7, "x.sql")).toThrow(/exactly one/);
    expect(() => rewriteSchemaVersionInsert(sqlFor(3), 2, 7, "x.sql")).toThrow(/records 3/);
  });

  it("parses flags and rejects unknown ones", () => {
    expect(parseArgs(["--base", "origin/dev", "--no-fetch", "--check"])).toEqual({
      baseRef: "origin/dev",
      fetch: false,
      dryRun: false,
      check: true,
    });
    expect(() => parseArgs(["--wat"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--base"])).toThrow(/--base needs/);
  });
});
