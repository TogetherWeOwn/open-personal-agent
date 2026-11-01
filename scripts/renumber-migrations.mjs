// SPDX-License-Identifier: Apache-2.0
// Rebases this branch's own D1 migrations onto the base branch's latest number, so authors stop
// chasing main by hand. Run at merge time: fetch main, run this, then merge or rebase
// and run it once more. It renumbers the branch's SQL and snapshot files, three-way-merges each
// snapshot onto main's latest snapshot (never just renames it, which would silently drop main's
// schema changes from the snapshot), rebuilds `meta/_journal.json` as base entries plus the
// renumbered ones, and fixes the hand-added `schema_version` INSERT and `SCHEMA_VERSION`.
// Usage: pnpm migrations:renumber [--base <ref>] [--no-fetch] [--dry-run] [--check]
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./lib/repo.mjs";

const MIGRATIONS_DIR = "migrations";
const JOURNAL_PATH = "migrations/meta/_journal.json";
const SCHEMA_VERSION_PATH = "packages/db/src/index.ts";
const SQL_FILE = /^(\d{4})_(.+)\.sql$/;
const SNAPSHOT_FILE = /^(\d{4})_snapshot\.json$/;
const INSERT_RE =
  /INSERT\s+INTO\s+`?schema_version`?\s*\(\s*`?version`?\s*\)\s*VALUES\s*\(\s*(\d+)\s*\)/gi;
const SCHEMA_VERSION_RE = /export const SCHEMA_VERSION = (\d+);/g;

export const pad = (n) => String(n).padStart(4, "0");
const snapshotPath = (n) => `migrations/meta/${pad(n)}_snapshot.json`;

/** Deep equality for JSON values, ignoring object key order. */
export function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]))
  );
}

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isSorted = (keys) => keys.every((k, i) => i === 0 || keys[i - 1] <= k);

/**
 * Three-way merge of JSON values: `ours` is the branch snapshot, `theirs` main's latest, `base`
 * the snapshot the branch migration was generated from. Unchanged sides win; objects merge key
 * by key; anything both sides changed incompatibly is reported in `conflicts` instead of guessed.
 */
export function merge3(base, ours, theirs, path = "", conflicts = []) {
  if (deepEqual(ours, base)) return theirs;
  if (deepEqual(theirs, base) || deepEqual(ours, theirs)) return ours;
  if (!isPlainObject(base) || !isPlainObject(ours) || !isPlainObject(theirs)) {
    conflicts.push(path || "(root)");
    return ours;
  }
  const out = {};
  const keys = new Set([...Object.keys(theirs), ...Object.keys(ours), ...Object.keys(base)]);
  for (const key of keys) {
    const child = path ? `${path}.${key}` : key;
    const [inBase, inOurs, inTheirs] = [base, ours, theirs].map((o) => Object.hasOwn(o, key));
    if (!inOurs && !inTheirs) continue;
    if (!inOurs) {
      // Main added it, or the branch deleted it (kept only if main left it untouched).
      if (!inBase) out[key] = theirs[key];
      else if (!deepEqual(theirs[key], base[key])) conflicts.push(child);
      continue;
    }
    if (!inTheirs) {
      // The branch added it, or main deleted it (kept only if the branch left it untouched).
      if (!inBase) out[key] = ours[key];
      else if (!deepEqual(ours[key], base[key])) conflicts.push(child);
      continue;
    }
    if (!inBase) {
      // Both sides added the same key with different content (equal content returned above).
      conflicts.push(child);
      out[key] = ours[key];
      continue;
    }
    out[key] = merge3(base[key], ours[key], theirs[key], child, conflicts);
  }
  if (isSorted(Object.keys(ours)) && isSorted(Object.keys(theirs))) {
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
  return out;
}

/**
 * Rebases a branch snapshot onto main's latest: applies the diff (branchBase → ours) on top of
 * `theirs`, then re-links the chain (`id` stays ours, `prevId` becomes main's latest snapshot).
 * Throws listing every schema object both sides changed, which a human must regenerate instead.
 */
export function mergeSnapshot(branchBase, ours, theirs) {
  const strip = ({ id: _id, prevId: _prevId, ...rest }) => rest;
  const conflicts = [];
  const merged = merge3(strip(branchBase), strip(ours), strip(theirs), "", conflicts);
  if (conflicts.length > 0) {
    throw new Error(
      `snapshot conflicts with main at ${conflicts.join(", ")}: both sides changed the same ` +
        "schema object. Resolve it by regenerating the migration with " +
        "`pnpm --filter @opa/db generate` against merged main instead.",
    );
  }
  const out = {};
  for (const key of Object.keys(ours)) {
    if (key === "id") out.id = ours.id;
    else if (key === "prevId") out.prevId = theirs.id;
    else if (Object.hasOwn(merged, key)) out[key] = merged[key];
  }
  for (const key of Object.keys(merged)) if (!Object.hasOwn(out, key)) out[key] = merged[key];
  return out;
}

/** Rewrites the single hand-added `schema_version` INSERT, which must record `oldVersion`. */
export function rewriteSchemaVersionInsert(sql, oldVersion, newVersion, file) {
  const matches = [...sql.matchAll(INSERT_RE)];
  if (matches.length !== 1) {
    throw new Error(
      `${file}: expected exactly one INSERT INTO schema_version, found ${matches.length}; ` +
        "end the migration with one, by hand, then re-run.",
    );
  }
  const found = Number(matches[0][1]);
  if (found !== oldVersion) {
    throw new Error(
      `${file}: INSERT INTO schema_version records ${found}, not its number ${oldVersion}; ` +
        "fix it by hand, then re-run.",
    );
  }
  return sql.replace(INSERT_RE, (m) => m.replace(/\(\s*\d+\s*\)$/, `(${newVersion})`));
}

/** Rewrites the single `export const SCHEMA_VERSION = N;` in packages/db/src/index.ts. */
export function rewriteSchemaVersionConst(source, newVersion) {
  const matches = [...source.matchAll(SCHEMA_VERSION_RE)];
  if (matches.length !== 1) {
    throw new Error(
      `${SCHEMA_VERSION_PATH}: expected exactly one SCHEMA_VERSION export, found ${matches.length}.`,
    );
  }
  return source.replace(SCHEMA_VERSION_RE, `export const SCHEMA_VERSION = ${newVersion};`);
}

const defaultGit = (root) => ({
  fetch(remote, branch) {
    execFileSync("git", ["fetch", "--quiet", remote, branch], { cwd: root, stdio: "inherit" });
  },
  show(spec) {
    try {
      return execFileSync("git", ["show", spec], { cwd: root, encoding: "utf8" });
    } catch {
      return null;
    }
  },
});

const tryParseJson = (text) => {
  try {
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
};
const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Renumbers the branch's own migrations (tags the base journal does not have) to sit directly
 * after the base branch's latest. Computes the whole plan before writing, so any error leaves
 * the tree untouched. Returns { changed, actions, own } with one human line per action.
 */
export function renumberMigrations({
  // The repo root is this script's parent directory, so the caller's cwd does not matter.
  root = join(dirname(fileURLToPath(import.meta.url)), ".."),
  baseRef = "origin/main",
  fetch = true,
  dryRun = false,
  now = () => Date.now(),
  git = defaultGit(root),
  log = (line) => console.log(line),
} = {}) {
  const readLocal = (path) => {
    const abs = join(root, path);
    return existsSync(abs) ? readFileSync(abs, "utf8") : null;
  };
  const migrationsAbs = join(root, MIGRATIONS_DIR);
  if (!existsSync(migrationsAbs)) {
    throw new Error(`no ${MIGRATIONS_DIR}/ directory under ${root}; run from the repo root.`);
  }
  if (fetch && baseRef.includes("/")) {
    const [remote, ...rest] = baseRef.split("/");
    git.fetch(remote, rest.join("/"));
  }
  const showBase = (path) => git.show(`${baseRef}:${path}`);
  const baseJournal = tryParseJson(showBase(JOURNAL_PATH));
  if (!baseJournal || !Array.isArray(baseJournal.entries) || baseJournal.entries.length === 0) {
    throw new Error(`could not read ${JOURNAL_PATH} from ${baseRef}; fetch it first.`);
  }
  for (const entry of baseJournal.entries) {
    if (!entry.tag?.startsWith(`${pad(entry.idx)}_`)) {
      throw new Error(`${baseRef}:${JOURNAL_PATH}: entry ${entry.tag} has idx ${entry.idx}.`);
    }
  }
  const baseTags = new Set(baseJournal.entries.map((e) => e.tag));
  const baseMax = Math.max(...baseJournal.entries.map((e) => e.idx));

  // Local state: SQL files, snapshots by number and by id, and the journal's `when` per tag.
  const localSql = readdirSync(migrationsAbs)
    .flatMap((name) => {
      const m = SQL_FILE.exec(name);
      return m ? [{ number: Number(m[1]), name: m[2], tag: `${m[1]}_${m[2]}`, file: name }] : [];
    })
    .sort((a, b) => a.number - b.number || a.name.localeCompare(b.name));
  const localSnapshots = new Map(); // number -> { path, text, json }
  const snapshotsById = new Map();
  const metaAbs = join(migrationsAbs, "meta");
  for (const name of existsSync(metaAbs) ? readdirSync(metaAbs) : []) {
    const m = SNAPSHOT_FILE.exec(name);
    if (!m) continue;
    const path = snapshotPath(Number(m[1]));
    const text = readLocal(path);
    const json = tryParseJson(text);
    if (json) {
      localSnapshots.set(Number(m[1]), { path, text, json });
      if (json.id) snapshotsById.set(json.id, json);
    }
  }
  const localJournal = tryParseJson(readLocal(JOURNAL_PATH));
  const localEntryByTag = new Map((localJournal?.entries ?? []).map((e) => [e.tag, e]));

  const own = localSql.filter((f) => !baseTags.has(f.tag));
  if (own.length === 0) {
    log(`migrations:renumber: no branch migrations vs ${baseRef}; nothing to do.`);
    return { changed: false, actions: [], own: [] };
  }
  if (new Set(own.map((f) => f.number)).size !== own.length) {
    throw new Error("branch migrations share a number; give each its own number first.");
  }

  const baseSnapshot = (n) => {
    const json = tryParseJson(showBase(snapshotPath(n)));
    if (!json) throw new Error(`could not read ${snapshotPath(n)} from ${baseRef}.`);
    return json;
  };
  // The snapshot a branch migration was generated from, found via its prevId chain link.
  const findById = (id) => {
    if (snapshotsById.has(id)) return snapshotsById.get(id);
    for (let n = 0; n <= baseMax; n += 1) {
      const json = baseSnapshot(n);
      snapshotsById.set(json.id, json);
      if (json.id === id) return json;
    }
    return null;
  };

  const writes = new Map(); // path -> text
  const deletes = new Set();
  const actions = [];
  const writeIfChanged = (path, text, action) => {
    if (readLocal(path) !== text) {
      writes.set(path, text);
      if (action) actions.push(action);
    }
  };

  let newPrev = baseSnapshot(baseMax);
  let prevOurs = null;
  const newEntries = [];
  own.forEach((migration, i) => {
    const target = baseMax + 1 + i;
    const newTag = `${pad(target)}_${migration.name}`;
    const sqlPath = `migrations/${migration.file}`;
    const sql = readLocal(sqlPath);
    let snapshot = localSnapshots.get(migration.number)?.json ?? null;
    const duplicated = localSql.some((f) => f.number === migration.number && baseTags.has(f.tag));
    if (snapshot && duplicated && snapshot.id === baseSnapshot(migration.number).id) {
      // A merge kept main's snapshot in the shared slot; recover ours from the merge stages.
      snapshot =
        [2, 3]
          .map((stage) => tryParseJson(git.show(`:${stage}:${snapshotPath(migration.number)}`)))
          .find((j) => j && j.id !== snapshot.id) ?? null;
      if (!snapshot) {
        throw new Error(
          `${snapshotPath(migration.number)} on disk is main's, and the branch snapshot was ` +
            "not found in the git index. Restore yours (e.g. from the pre-merge commit) and re-run.",
        );
      }
    }
    if (!snapshot)
      throw new Error(`missing ${snapshotPath(migration.number)} for ${migration.tag}.`);
    if (snapshot.id === newPrev.id) {
      throw new Error(`${migration.tag}: snapshot id collides with ${baseRef}'s; regenerate it.`);
    }
    let branchBase;
    if (prevOurs) {
      if (snapshot.prevId !== prevOurs.id) {
        throw new Error(
          `${migration.tag}: snapshot prevId does not chain from the previous branch migration.`,
        );
      }
      branchBase = prevOurs;
    } else {
      branchBase = findById(snapshot.prevId);
      if (!branchBase) {
        throw new Error(
          `${migration.tag}: cannot find the snapshot its prevId points to, locally or on ${baseRef}.`,
        );
      }
    }
    const merged = mergeSnapshot(branchBase, snapshot, newPrev);
    writeIfChanged(
      snapshotPath(target),
      jsonText(merged),
      duplicated || target !== migration.number
        ? `snapshot ${pad(migration.number)} -> ${pad(target)} (rebased onto ${pad(baseMax)})`
        : `snapshot ${pad(target)} (rebased onto ${pad(baseMax)})`,
    );
    if (target !== migration.number && !duplicated) deletes.add(snapshotPath(migration.number));
    writeIfChanged(
      `migrations/${newTag}.sql`,
      rewriteSchemaVersionInsert(sql, migration.number, target, sqlPath),
      `${migration.tag}.sql -> ${newTag}.sql (schema_version ${target})`,
    );
    if (target !== migration.number) deletes.add(sqlPath);
    const local = localEntryByTag.get(migration.tag);
    newEntries.push({
      idx: target,
      version: local?.version ?? baseJournal.entries[baseJournal.entries.length - 1].version,
      when: local?.when ?? now(),
      tag: newTag,
      breakpoints: local?.breakpoints ?? true,
    });
    prevOurs = snapshot;
    newPrev = merged;
  });

  // Main's own files must all be present and untouched: restore any a merge resolution dropped,
  // including a base snapshot whose slot the branch's colliding snapshot was moved out of above.
  for (const entry of baseJournal.entries) {
    for (const path of [`migrations/${entry.tag}.sql`, snapshotPath(entry.idx)]) {
      if (writes.has(path)) continue;
      const baseText = showBase(path);
      if (baseText === null) throw new Error(`could not read ${path} from ${baseRef}.`);
      const localText = readLocal(path);
      if (localText === baseText) {
        deletes.delete(path);
        continue;
      }
      const slotWasOwn = path.includes("/meta/") && own.some((f) => f.number === entry.idx);
      if (localText === null || slotWasOwn) {
        writes.set(path, baseText);
        deletes.delete(path);
        actions.push(`restored ${path} from ${baseRef}`);
      } else {
        throw new Error(`${path} differs from ${baseRef}; applied migrations are never edited.`);
      }
    }
  }

  writeIfChanged(
    JOURNAL_PATH,
    jsonText({ ...baseJournal, entries: [...baseJournal.entries, ...newEntries] }),
    `journal rebuilt: ${baseJournal.entries.length} from ${baseRef} + ${newEntries.length} branch`,
  );
  const versionSource = readLocal(SCHEMA_VERSION_PATH);
  if (versionSource === null) throw new Error(`missing ${SCHEMA_VERSION_PATH}.`);
  writeIfChanged(
    SCHEMA_VERSION_PATH,
    rewriteSchemaVersionConst(versionSource, baseMax + own.length),
    `SCHEMA_VERSION -> ${baseMax + own.length}`,
  );

  const changed = writes.size > 0 || deletes.size > 0;
  for (const path of deletes) actions.push(`removed ${path}`);
  if (changed && !dryRun) {
    for (const [path, text] of writes) writeFileSync(join(root, path), text);
    for (const path of deletes) if (!writes.has(path)) rmSync(join(root, path), { force: true });
  }
  log(
    changed
      ? `migrations:renumber${dryRun ? " (dry run)" : ""}: ${actions.length} change(s) vs ${baseRef}`
      : `migrations:renumber: already renumbered onto ${baseRef}; nothing to do.`,
  );
  for (const action of actions) log(`  ${action}`);
  if (changed && !dryRun) log("Review the diff, run the tests, then commit.");
  return { changed, actions, own: own.map((f) => f.tag) };
}

/** Parses CLI flags; throws on anything unknown so typos never silently renumber. */
export function parseArgs(argv) {
  const opts = { baseRef: "origin/main", fetch: true, dryRun: false, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base") {
      i += 1;
      if (argv[i] === undefined) throw new Error("--base needs a ref, e.g. --base origin/main");
      opts.baseRef = argv[i];
    } else if (arg === "--no-fetch") opts.fetch = false;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--check") opts.check = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

if (isMain(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const { changed } = renumberMigrations({
      ...opts,
      dryRun: opts.dryRun || opts.check,
    });
    if (opts.check && changed) process.exitCode = 1;
  } catch (error) {
    console.error(`migrations:renumber: ${error.message}`);
    process.exitCode = 1;
    if (/unknown argument|--base needs/.test(error.message)) {
      console.error(
        "Usage: pnpm migrations:renumber [--base <ref>] [--no-fetch] [--dry-run] [--check]",
      );
    }
  }
}
