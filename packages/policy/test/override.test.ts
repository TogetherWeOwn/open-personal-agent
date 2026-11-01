// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { loosens, RISK_CLASSES, type RiskClass, type ToolOverride } from "../src/index";

const SETTINGS: readonly (ToolOverride | null)[] = ["never", "ask", null, "auto"];

describe("loosens (M3-02 AC7)", () => {
  // Every (risk, from, to): true only for a change towards `auto` from where `from` stands.
  const table: Record<RiskClass, string[]> = {
    // No override runs a read already, so only leaving `never` or `ask` loosens it.
    read: ["never>ask", "never>null", "never>auto", "ask>null", "ask>auto"],
    // No override asks for a tainted reversible write, so `auto` is looser still.
    write_reversible: [
      "never>ask",
      "never>null",
      "never>auto",
      "ask>null",
      "ask>auto",
      "null>auto",
    ],
    // No override asks, as `ask` does.
    consequential: ["never>ask", "never>null", "never>auto", "ask>auto", "null>auto"],
    irreversible: ["never>ask", "never>null", "never>auto", "ask>auto", "null>auto"],
  };

  for (const risk of RISK_CLASSES) {
    it(`matches the table for ${risk}`, () => {
      const loosening: string[] = [];
      for (const from of SETTINGS)
        for (const to of SETTINGS) if (loosens(risk, from, to)) loosening.push(`${from}>${to}`);
      expect(loosening.sort()).toEqual([...table[risk]].sort());
    });
  }

  it("never counts an unchanged setting or any change towards never", () => {
    for (const risk of RISK_CLASSES)
      for (const from of SETTINGS) {
        expect(loosens(risk, from, from)).toBe(false);
        expect(loosens(risk, from, "never")).toBe(false);
      }
  });
});
