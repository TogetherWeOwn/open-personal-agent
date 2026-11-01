// SPDX-License-Identifier: Apache-2.0
// Settings › Apps & tools copy (M3-19 AC1, m3-ux §3.9): every risk class has a plain-words
// label, and nothing here may name a builder.
import { describe, expect, it } from "vitest";
import { riskClassLabel } from "../src/settings/tool-copy";

describe("riskClassLabel", () => {
  it("covers every risk class in plain words", () => {
    expect(riskClassLabel).toEqual({
      read: "Reads only",
      write_reversible: "Changes things you can undo",
      consequential: "Sends things out",
      irreversible: "Can't be undone",
    });
  });
});
