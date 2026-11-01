// SPDX-License-Identifier: Apache-2.0
// Retention settings (COST-10, M3-18 AC1): defaults, validation, audit, and the memory-inbox expiry.
import { createRepository, scopeFromSession } from "@opa/db/repository";
import { DAY_MS } from "@opa/db/retention";
import { describe, expect, it } from "vitest";
import { claim, count, db, env, freshDatabase } from "./helpers/app";

freshDatabase();

const repo = createRepository(env);
/** A write from a tainted context becomes a suggestion (R7 M3-8). */
const tainted = { via: "assistant", tainted: true, userAsserted: false } as const;

describe("retention settings", () => {
  it("shows the defaults, saves a change with an audit row, and refuses out-of-range days", async () => {
    const { browser } = await claim();
    const res = await browser.req("/api/settings/retention");
    expect(await res.json()).toMatchObject({
      messageDays: null,
      toolOutputDays: 30,
      memoryInboxDays: 14,
      defaults: { messageDays: null, toolOutputDays: 30, memoryInboxDays: 14 },
    });

    const put = (body: unknown) => browser.req("/api/settings/retention", { method: "PUT", body });
    const saved = await put({ messageDays: 90, toolOutputDays: null });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      messageDays: 90,
      toolOutputDays: null,
      memoryInboxDays: 14,
    });
    const audit = await db
      .prepare("SELECT detail FROM audit_log WHERE action = 'settings.retention'")
      .first<string>("detail");
    expect(JSON.parse(audit as string)).toEqual({
      from: { messageDays: null, toolOutputDays: 30, memoryInboxDays: 14 },
      to: { messageDays: 90, toolOutputDays: null, memoryInboxDays: 14 },
    });

    for (const body of [
      { messageDays: 3 },
      { messageDays: 1.5 },
      { memoryInboxDays: null },
      { memoryInboxDays: 91 },
      { toolOutputDays: "30" },
    ]) {
      expect((await put(body)).status).toBe(400);
    }
    expect(
      (await (await browser.req("/api/settings/retention")).json<{ messageDays: number }>())
        .messageDays,
    ).toBe(90);
    expect(await count("audit_log", "action = 'settings.retention'")).toBe(1);
  });

  it("dates memory suggestions by the inbox setting, now and after a change", async () => {
    const { browser, owner } = await claim();
    const memory = repo.forUser(scopeFromSession({ userId: owner })).memory;
    await memory.create(tainted, "likes tea", "fact", { source: "chat" });
    // Days until expiry; created_at comes from D1's clock and the first date from the Worker's.
    const days = async () => {
      const r = await db
        .prepare("SELECT created_at AS c, expires_at AS e FROM memories WHERE status = 'proposed'")
        .first<{ c: number; e: number }>();
      return ((r?.e ?? 0) - (r?.c ?? 0)) / DAY_MS;
    };
    expect(await days()).toBeCloseTo(14, 5);

    await browser.req("/api/settings/retention", { method: "PUT", body: { memoryInboxDays: 3 } });
    expect(await days()).toBe(3);
  });
});
