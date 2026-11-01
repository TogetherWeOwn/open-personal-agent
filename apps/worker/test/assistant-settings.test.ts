// SPDX-License-Identifier: Apache-2.0
// Settings › Assistant (M3-09 AC3): the persisted "Show work" choice reads as the default,
// saves one of the three values and refuses anything else.
import { describe, expect, it } from "vitest";
import { claim, freshDatabase } from "./helpers/app";

freshDatabase();

describe("assistant settings", () => {
  it("reads the default, saves a choice and refuses anything else", async () => {
    const { browser } = await claim();
    expect(await (await browser.req("/api/settings/assistant")).json()).toEqual({
      showWork: "collapsed",
    });
    for (const showWork of ["hidden", "expanded"]) {
      const put = await browser.req("/api/settings/assistant", {
        method: "PUT",
        body: { showWork },
      });
      expect(await put.json()).toEqual({ showWork });
    }
    const bad = await browser.req("/api/settings/assistant", {
      method: "PUT",
      body: { showWork: "everything" },
    });
    expect(bad.status).toBe(400);
    expect(await (await browser.req("/api/settings/assistant")).json()).toEqual({
      showWork: "expanded",
    });
  });
});
