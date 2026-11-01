// SPDX-License-Identifier: Apache-2.0
// Settings › Apps & tools (M3-19 AC1): the unseeded app lists the real built-in tools — the
// manifests from `@opa/tools-builtin` and the memory and task tools — with their risk classes.
import { describe, expect, it } from "vitest";
import { claim, freshDatabase } from "./helpers/app";

freshDatabase();

describe("built-in tool listing", () => {
  it("lists every built-in tool with its risk class", async () => {
    const { browser } = await claim();
    const { tools } = await browser
      .req("/api/settings/tools")
      .then((r) => r.json<{ tools: { name: string; riskClass: string }[] }>());
    expect(tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "web_fetch", riskClass: "read" }),
        expect.objectContaining({ name: "search_history", riskClass: "read" }),
        expect.objectContaining({ name: "create_artifact", riskClass: "write_reversible" }),
        expect.objectContaining({ name: "read_file", riskClass: "read" }),
        expect.objectContaining({ name: "remember", riskClass: "write_reversible" }),
        expect.objectContaining({ name: "recall", riskClass: "read" }),
        expect.objectContaining({ name: "forget", riskClass: "consequential" }),
        expect.objectContaining({ name: "task", riskClass: "write_reversible" }),
      ]),
    );
  });
});
