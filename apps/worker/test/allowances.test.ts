// SPDX-License-Identifier: Apache-2.0
// The reconciler's allowance warnings (M3-17 AC4, COST-5): meters from sources the app has,
// a warning at 70% of each, kept by the owner's assistant and shown to the owner only.
import {
  allowanceMeters,
  reconcileAllowances,
  WARNINGS_TTL_MS,
  warningsFor,
} from "@opa/server/allowances";
import { describe, expect, it } from "vitest";
import { Browser, claim, db, env, freshDatabase, sessionHeaders } from "./helpers/app";

freshDatabase();

type Body = { allowanceWarnings: { id: string; percent: number }[] };

describe("allowance meters", () => {
  it("reads D1's size, the stored files and today's neurons against Workers Paid", async () => {
    const { owner } = await claim();
    await db
      .prepare(
        "INSERT INTO usage (id, user_id, provider_id, model, neurons) VALUES ('n1', ?, 'workers-ai', 'm', 7100)",
      )
      .bind(owner)
      .run();
    const meters = await allowanceMeters(env);
    const byId = Object.fromEntries(meters.map((m) => [m.id, m]));
    expect(byId.d1_cap?.used).toBeGreaterThan(0); // the test database is not empty
    expect(byId.d1_cap?.limit).toBe(10_000_000_000);
    expect(byId.d1_storage?.limit).toBe(5_000_000_000);
    expect(byId.r2_storage).toMatchObject({ limit: 10_000_000_000, unit: "bytes" });
    expect(byId.workers_ai_neurons).toMatchObject({ used: 7100, limit: 10_000 });
  });

  it("counts every stored object, not only uploads, across pages of the listing", async () => {
    const before = (await allowanceMeters(env)).find((m) => m.id === "r2_storage")?.used ?? 0;
    // An offloaded step output and a saved file: neither has an attachment row.
    await env.FILES.put("u/x/task-outputs/abc", "x".repeat(1500));
    await env.FILES.put("u/x/files/f1", "y".repeat(500));
    const pages: number[] = [];
    const list = env.FILES.list.bind(env.FILES);
    const paged = {
      ...env,
      FILES: Object.assign(Object.create(env.FILES), {
        list: (o: R2ListOptions) => {
          pages.push(1);
          return list({ ...o, limit: 1 }); // one object a page, to cross pages
        },
      }),
    };
    const after = (await allowanceMeters(paged)).find((m) => m.id === "r2_storage")?.used ?? 0;
    expect(after - before).toBe(2000);
    expect(pages.length).toBeGreaterThan(1);
  });

  it("warns at 70% of any meter, never below", () => {
    const meter = (id: "d1_cap" | "r2_storage", used: number) => ({
      id,
      used,
      limit: 10_000_000_000,
      unit: "bytes" as const,
    });
    expect(
      warningsFor([meter("d1_cap", 6_999_999_999), meter("r2_storage", 7_000_000_000)]),
    ).toEqual([{ id: "r2_storage", percent: 70 }]);
  });
});

describe("the reconciler's warning", () => {
  it("reaches the owner's Spending data, and no one else's", async () => {
    const { browser, owner } = await claim();
    await db
      .prepare(
        "INSERT INTO usage (id, user_id, provider_id, model, neurons) VALUES ('n2', ?, 'workers-ai', 'm', 8000)",
      )
      .bind(owner)
      .run();
    await reconcileAllowances(env);
    const mine = await (await browser.req("/api/settings/spending")).json<Body>();
    expect(mine.allowanceWarnings).toEqual([{ id: "workers_ai_neurons", percent: 80 }]);
    await db
      .prepare("INSERT INTO users (id, display_name, role) VALUES ('m1', 'M', 'member')")
      .run();
    const member = new Browser();
    const { cookie } = await sessionHeaders("m1");
    member.cookies.set(...(cookie.split("=") as [string, string]));
    const theirs = await (await member.req("/api/settings/spending")).json<Body>();
    expect(theirs.allowanceWarnings).toEqual([]);
  });

  it("drops warnings once the reconciler hasn't run for an hour", async () => {
    const { browser, owner } = await claim();
    await db
      .prepare(
        "INSERT INTO usage (id, user_id, provider_id, model, neurons) VALUES ('n3', ?, 'workers-ai', 'm', 9000)",
      )
      .bind(owner)
      .run();
    await reconcileAllowances(env, Date.now() - WARNINGS_TTL_MS - 1);
    const body = await (await browser.req("/api/settings/spending")).json<Body>();
    expect(body.allowanceWarnings).toEqual([]);
  });

  it("does nothing before the claim", async () => {
    await expect(reconcileAllowances(env)).resolves.toBeUndefined();
  });
});
