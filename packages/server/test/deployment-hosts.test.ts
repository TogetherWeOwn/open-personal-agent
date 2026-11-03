// SPDX-License-Identifier: Apache-2.0
// The deployment's own hostnames on Workers: parsing the request URL's host, recording it,
// and resolving the refusal list as `OPA_OWN_HOSTS` first plus the recorded set, so a store
// failure degrades to the env var alone instead of failing the turn.
import { type SqlDatabase, systemStore } from "@opa/db/system";
import { describe, expect, it } from "vitest";
import { hostnameOf, noteDeploymentHost, resolveOwnHosts } from "../src/deployment-hosts";

/** Just enough D1 to run the store: canned `deployment_hosts` rows, or a failed read. */
function fakeDb(rows: { hostname: string }[] = [], failReads = false) {
  const statements: { sql: string; values: unknown[] }[] = [];
  const statement = (sql: string) => {
    let values: unknown[] = [];
    return {
      bind(...v: unknown[]) {
        values = v;
        return this;
      },
      async run() {
        statements.push({ sql, values });
        return { meta: { changes: 1 } };
      },
      async first() {
        if (failReads) throw new Error("d1 down");
        return null;
      },
      async all() {
        if (failReads) throw new Error("d1 down");
        return { results: rows };
      },
    };
  };
  const db = {
    prepare: (sql: string) => statement(sql),
    async batch() {
      return [];
    },
  } as unknown as SqlDatabase;
  return { db, statements };
}

const envOf = (db: SqlDatabase, OPA_OWN_HOSTS?: string) => ({ DB: db, OPA_OWN_HOSTS });

describe("hostnameOf", () => {
  it("lowercases and strips trailing dots", () => {
    expect(hostnameOf("https://Example.COM./api/health")).toBe("example.com");
  });

  it("rejects what names no host", () => {
    expect(hostnameOf("not a url")).toBeNull();
    expect(hostnameOf("https://")).toBeNull();
    expect(hostnameOf(`https://${"a".repeat(254)}.test/`)).toBeNull();
  });
});

describe("noteDeploymentHost", () => {
  it("upserts the request URL's normalized host", async () => {
    const { db, statements } = fakeDb();
    await noteDeploymentHost(envOf(db), "https://Example.COM./setup", 1000);
    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toContain("deployment_hosts");
    expect(statements[0].sql).toContain("ON CONFLICT");
    expect(statements[0].values).toEqual(["example.com", 1000, 1000]);
  });

  it("writes nothing for a URL with no host", async () => {
    const { db, statements } = fakeDb();
    await noteDeploymentHost(envOf(db), "not a url", 1000);
    expect(statements).toHaveLength(0);
  });
});

describe("resolveOwnHosts", () => {
  it("reads the env var first, then the recorded set without repeating", async () => {
    const { db } = fakeDb([{ hostname: "b.example" }, { hostname: "c.example" }]);
    await expect(resolveOwnHosts(envOf(db, "B.example, a.example"))).resolves.toEqual([
      "B.example",
      "a.example",
      "c.example",
    ]);
  });

  it("resolves to the recorded set alone when the var is unset", async () => {
    const { db } = fakeDb([{ hostname: "opa.test" }]);
    await expect(resolveOwnHosts(envOf(db))).resolves.toEqual(["opa.test"]);
  });

  it("degrades to the env var alone when the store read fails", async () => {
    const { db } = fakeDb([], true);
    await expect(resolveOwnHosts(envOf(db, "fallback.example"))).resolves.toEqual([
      "fallback.example",
    ]);
    await expect(resolveOwnHosts(envOf(db))).resolves.toEqual([]);
  });
});

describe("sessions.touch hostname decoupling", () => {
  /** A D1 whose hostname write rejects (a table missing mid-deploy) while the touch succeeds. */
  function failingRecordDb() {
    const ran: string[] = [];
    const statement = (sql: string) => ({
      bind(..._values: unknown[]) {
        return this;
      },
      async run() {
        ran.push(sql);
        if (sql.includes("deployment_hosts")) throw new Error("no such table");
        return { meta: { changes: 1 } };
      },
      async first() {
        return null;
      },
      async all() {
        return { results: [] };
      },
    });
    const db = {
      prepare: (sql: string) => statement(sql),
      async batch() {
        return [];
      },
    } as unknown as SqlDatabase;
    return { db, ran };
  }

  it("still advances last_seen_at when the hostname write fails", async () => {
    const { db, ran } = failingRecordDb();
    await systemStore({ DB: db }).sessions.touch("s1", 7000, "new.example");
    expect(ran).toEqual([
      expect.stringContaining("UPDATE sessions"),
      expect.stringContaining("deployment_hosts"),
    ]);
  });
});
