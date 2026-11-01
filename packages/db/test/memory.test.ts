// SPDX-License-Identifier: Apache-2.0
// MemoryService's pure parts. The rest runs against D1 and SQLite in the memory contract
// (test/contract/storage.ts).
import { describe, expect, it } from "vitest";
import { ftsQuery } from "../src/memory";

describe("ftsQuery", () => {
  it("quotes each word, so FTS5 syntax in the input is never an operator", () => {
    expect(ftsQuery("Sam's café")).toBe('"Sam"* "s"* "café"*');
    expect(ftsQuery('") OR NEAR(x *')).toBe('"OR"* "NEAR"* "x"*');
    expect(ftsQuery("re\u0301sume\u0301")).toBe('"résumé"*');
    expect(ftsQuery(" - ")).toBeNull();
    expect(ftsQuery("a ".repeat(40))?.split(" ")).toHaveLength(16);
  });
});
