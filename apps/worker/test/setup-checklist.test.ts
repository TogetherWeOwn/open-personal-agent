// SPDX-License-Identifier: Apache-2.0
// The setup checklist's API (M3-24 AC1, A-O2): a skipped onboarding step stays on the list until
// the user finishes it, wherever that happens, and Hide only takes the card off the chat.
import { describe, expect, it } from "vitest";
import { claim, freshDatabase } from "./helpers/app";

freshDatabase();

type Setup = { skipped: string[] | null; hidden: boolean };

async function signedIn() {
  const { browser } = await claim();
  const setup = async () =>
    (await (await browser.req("/api/settings")).json<{ setup: Setup }>()).setup;
  const post = (body: unknown) => browser.req("/api/settings/setup", { body });
  return { browser, setup, post };
}

describe("setup checklist", () => {
  it("has no list until a step is skipped, and keeps the skips in step order", async () => {
    const { setup, post } = await signedIn();
    expect(await setup()).toEqual({ skipped: null, hidden: false });
    // Finishing a step that was never skipped doesn't start a list.
    expect((await post({ done: "about" })).status).toBe(200);
    expect(await setup()).toEqual({ skipped: null, hidden: false });
    await post({ skip: "chat" });
    const res = await post({ skip: "about" });
    expect(await res.json()).toEqual({ skipped: ["about", "chat"], hidden: false });
    await post({ skip: "about" });
    expect((await setup()).skipped).toEqual(["about", "chat"]);
  });

  it("keeps an empty list once every skipped step is finished", async () => {
    const { setup, post } = await signedIn();
    await post({ skip: "safety" });
    await post({ done: "safety" });
    expect(await setup()).toEqual({ skipped: [], hidden: false });
  });

  it("refuses a step it doesn't know, and Claim and the model step can't be skipped", async () => {
    const { setup, post } = await signedIn();
    for (const body of [{ skip: "model" }, { skip: "claim" }, { done: 3 }, {}, null]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_setup" });
    }
    expect(await setup()).toEqual({ skipped: null, hidden: false });
  });

  it("finishes About you when the profile is saved", async () => {
    const { browser, setup, post } = await signedIn();
    await post({ skip: "about" });
    await post({ skip: "costs" });
    const body = { displayName: "Sam", about: "I garden." };
    expect((await browser.req("/api/settings/profile", { method: "PUT", body })).status).toBe(204);
    expect((await setup()).skipped).toEqual(["costs"]);
  });

  it("finishes Costs and limits when Spending is saved", async () => {
    const { browser, setup, post } = await signedIn();
    await post({ skip: "costs" });
    const body = { taskBudgetMicroUsd: 500_000 };
    expect((await browser.req("/api/settings/spending", { method: "PUT", body })).status).toBe(200);
    expect((await setup()).skipped).toEqual([]);
  });

  it("leaves a refused Spending save on the list", async () => {
    const { browser, setup, post } = await signedIn();
    await post({ skip: "costs" });
    const body = { dailyCapMicroUsd: 1 };
    expect((await browser.req("/api/settings/spending", { method: "PUT", body })).status).toBe(400);
    expect((await setup()).skipped).toEqual(["costs"]);
  });

  it("keeps every change when skips and finishes overlap", async () => {
    const { browser, setup, post } = await signedIn();
    await post({ skip: "about" });
    const profile = { displayName: "Sam", about: "I garden." };
    await Promise.all([
      post({ skip: "chat" }),
      post({ skip: "safety" }),
      browser.req("/api/settings/profile", { method: "PUT", body: profile }),
      post({ skip: "costs" }),
    ]);
    expect((await setup()).skipped).toEqual(["costs", "safety", "chat"]);
  });

  it("hides the card and shows it again without touching the list", async () => {
    const { setup, post } = await signedIn();
    await post({ skip: "chat" });
    await post({ hidden: true });
    expect(await setup()).toEqual({ skipped: ["chat"], hidden: true });
    await post({ hidden: false });
    expect(await setup()).toEqual({ skipped: ["chat"], hidden: false });
  });
});
