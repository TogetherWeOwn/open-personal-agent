// SPDX-License-Identifier: Apache-2.0
import { max } from "drizzle-orm";
import { type AnyD1Database, type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export * from "./schema";

/** The schema version this build expects: the version the newest migration records. */
export const SCHEMA_VERSION = 10;

export type Db = DrizzleD1Database<typeof schema>;

export function openD1(d1: AnyD1Database): Db {
  return drizzle(d1, { schema });
}

/**
 * The applied schema version, or `null` when the database has no migrations yet.
 * Any other database error is rethrown so callers can tell "unmigrated" from "unreachable".
 */
export async function readSchemaVersion(db: Db): Promise<number | null> {
  try {
    const [row] = await db
      .select({ version: max(schema.schemaVersion.version) })
      .from(schema.schemaVersion);
    return row?.version ?? null;
  } catch (error) {
    if (/no such table/i.test(String((error as Error)?.cause ?? error))) return null;
    throw error;
  }
}
