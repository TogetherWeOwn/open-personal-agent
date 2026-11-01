// SPDX-License-Identifier: Apache-2.0
// Settings › Spending's API (M3-17 AC2, AC5): every limit with its default, changes checked by
// the assistant and audited, the monthly warning from the ledger, and the hard cap's state.
import { describe, expect, it } from "vitest";
import { Browser, claim, db, env, freshDatabase } from "./helpers/app";

freshDatabase();

type Body = {
  settings: Record<string, number | null>;
  defaults: Record<string, number | null>;
  executionLimits: Record<string, number>;
  monthMicroUsd: number;
  warning: number | null;
  hardCapReached: boolean;
};

const DEFAULTS = {
  taskBudgetMicroUsd: 500_000,
  dailyCapMicroUsd: 5_000_000,
  monthlyBudgetMicroUsd: 20_000_000,
  hardCapMicroUsd: null,
};

async function spent(owner: string, microUsd: number) {
  await db
    .prepare(
      "INSERT INTO usage (id, user_id, provider_id, model, cost_micro_usd, cost_source) VALUES (?, ?, 'openai', 'gpt-4.1', ?, 'estimated')",
    )
    .bind(crypto.randomUUID(), owner, microUsd)
    .run();
}

describe("spending settings", () => {
  it("shows every limit with its default and the read-only execution limits", async () => {
    const { browser } = await claim();
    const res = await browser.req("/api/settings/spending");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json<Body>();
    expect(body.settings).toEqual(DEFAULTS);
    expect(body.defaults).toEqual(DEFAULTS);
    expect(body.executionLimits).toEqual({
      callsPerMessage: 8,
      toolCallsPerMessage: 20,
      stepsPerTask: 200,
    });
    expect(body).toMatchObject({ monthMicroUsd: 0, warning: null, hardCapReached: false });
  });

  it("saves a valid change, audits old and new values, and refuses a bad one whole", async () => {
    const { browser, owner } = await claim();
    const put = (body: unknown) => browser.req("/api/settings/spending", { method: "PUT", body });
    const ok = await put({ taskBudgetMicroUsd: 100_000, hardCapMicroUsd: 30_000_000 });
    expect(ok.status).toBe(200);
    const bad = await put({ dailyCapMicroUsd: 1, taskBudgetMicroUsd: 200_000 });
    expect(bad.status).toBe(400);
    expect((await put({ hardCapMicroUsd: "lots" })).status).toBe(400);
    const { settings } = await (await browser.req("/api/settings/spending")).json<Body>();
    expect(settings).toEqual({
      ...DEFAULTS,
      taskBudgetMicroUsd: 100_000,
      hardCapMicroUsd: 30_000_000,
    });
    const audit = await db
      .prepare("SELECT detail FROM audit_log WHERE user_id = ? AND action = 'settings.spending'")
      .bind(owner)
      .all<{ detail: string }>();
    expect(audit.results.map((r) => JSON.parse(r.detail))).toEqual([
      {
        taskBudgetMicroUsd: { from: 500_000, to: 100_000 },
        hardCapMicroUsd: { from: null, to: 30_000_000 },
      },
    ]);
  });

  it("warns at 50, 80 and 100% of the monthly budget from the ledger", async () => {
    const { browser, owner } = await claim();
    const warning = async () =>
      (await (await browser.req("/api/settings/spending")).json<Body>()).warning;
    await spent(owner, 9_999_999);
    expect(await warning()).toBeNull();
    await spent(owner, 1);
    expect(await warning()).toBe(50);
    await spent(owner, 6_000_000);
    expect(await warning()).toBe(80);
    await spent(owner, 4_000_000);
    expect(await warning()).toBe(100);
  });

  it("reports the hard cap reached on the assistant's own counter", async () => {
    const { browser, owner } = await claim();
    await browser.req("/api/settings/spending", {
      method: "PUT",
      body: { hardCapMicroUsd: 10_000 },
    });
    const assistant = env.ASSISTANT.get(env.ASSISTANT.idFromName(`u:${owner}`)) as unknown as {
      reserveTaskCall(...a: unknown[]): Promise<unknown>;
      settleTaskCall(...a: unknown[]): Promise<void>;
    };
    await assistant.reserveTaskCall("k", "openai", "gpt-4.1", 2000, {});
    await assistant.settleTaskCall("k", "openai", "gpt-4.1", null);
    const body = await (await browser.req("/api/settings/spending")).json<Body>();
    expect(body.hardCapReached).toBe(true);
  });

  it("is for signed-in users only", async () => {
    await claim();
    expect((await new Browser().req("/api/settings/spending")).status).toBe(401);
    const put = await new Browser().req("/api/settings/spending", { method: "PUT", body: {} });
    expect(put.status).toBe(401);
  });
});
