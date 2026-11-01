// SPDX-License-Identifier: Apache-2.0
// The `DB` binding on Node: the subset of D1's API the app uses, over `node:sqlite`. It copies
// D1's observable behaviour where the app could notice: foreign keys on, booleans bound as 0/1,
// `undefined` rejected, blobs read back as arrays of bytes, and `batch` all-or-nothing.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

type Row = Record<string, unknown>;

export function openSqlite(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  return db;
}

function toInput(value: unknown): SQLInputValue {
  if (value === undefined) throw new TypeError("D1_TYPE_ERROR: Type 'undefined' not supported");
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value as SQLInputValue;
}

const fromOutput = (value: unknown) => (value instanceof Uint8Array ? Array.from(value) : value);

class Statement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): Statement {
    return new Statement(this.db, this.sql, values.map(toInput));
  }

  /** Runs the statement, with rows only if it returns any, as D1's `all()` and `run()` do. */
  execute() {
    const stmt = this.db.prepare(this.sql);
    if (stmt.columns().length > 0) {
      const rows = stmt.all(...this.params) as Row[];
      const results = rows.map((r) =>
        Object.fromEntries(Object.entries(r).map(([k, v]) => [k, fromOutput(v)])),
      );
      return { success: true, results, meta: { changes: 0, last_row_id: 0, duration: 0 } };
    }
    const { changes, lastInsertRowid } = stmt.run(...this.params);
    const meta = { changes: Number(changes), last_row_id: Number(lastInsertRowid), duration: 0 };
    return { success: true, results: [] as Row[], meta };
  }

  all = async () => this.execute();
  run = async () => this.execute();

  async first(column?: string): Promise<unknown> {
    const [row] = this.execute().results;
    if (!row) return null;
    if (column === undefined) return row;
    if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
    return row[column];
  }

  /** Arrays, not objects, so duplicate column names (joins) survive, as Drizzle needs. */
  async raw(options?: { columnNames?: boolean }): Promise<unknown[][]> {
    const stmt = this.db.prepare(this.sql);
    stmt.setReturnArrays(true);
    const rows = (stmt.all(...this.params) as unknown as unknown[][]).map((r) => r.map(fromOutput));
    return options?.columnNames ? [stmt.columns().map((c) => c.name), ...rows] : rows;
  }
}

/** A D1-compatible binding for `db`. */
export function sqliteD1(db: DatabaseSync): D1Database {
  const binding = {
    prepare: (sql: string) => new Statement(db, sql),
    async batch(statements: Statement[]) {
      db.exec("BEGIN");
      try {
        const results = statements.map((s) => s.execute());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(sql: string) {
      db.exec(sql);
      return { count: sql.split(";").filter((s) => s.trim()).length, duration: 0 };
    },
  };
  return binding as unknown as D1Database;
}
