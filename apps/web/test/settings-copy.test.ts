// SPDX-License-Identifier: Apache-2.0
// Settings › Apps & tools copy (M3-19 AC1, m3-ux §3.9): every risk class has a plain-words
// label, and nothing here may name a builder.
import { describe, expect, it } from "vitest";
import { riskClassLabel, toolError } from "../src/settings/tool-copy";

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

describe("toolError", () => {
  it("names no fields: the floors, gone tools and bad choices in this page's words", () => {
    expect(toolError(new Error("floor_irreversible"))).toMatch(/can't be undone/);
    expect(toolError(new Error("not_found"))).toMatch(/Reload the page/);
    expect(toolError(new Error("invalid_override"))).toMatch(/isn't available/);
    expect(toolError(new Error("step_up_required"))).toMatch(/passkey/);
    expect(toolError(new Error("bogus_code"))).toMatch(/Try again/);
  });

  it("treats a dismissed passkey prompt as not confirmed, not a failure", () => {
    for (const name of ["NotAllowedError", "AbortError"]) {
      const e = new Error("dismissed");
      e.name = name;
      expect(toolError(e)).toMatch(/wasn't confirmed/);
    }
  });
});
