// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { diffWords } from "../src/memory/MemoryDiff";

const marked = (parts: { text: string; change: string }[]) =>
  parts.map((p) => (p.change === "same" ? p.text : `[${p.change}:${p.text.trim()}]`)).join("");

describe("diffWords", () => {
  it("marks the words that changed and keeps the rest", () => {
    const { now, suggested } = diffWords("Sam lives in Leeds", "Sam lives in Paris");
    expect(marked(now)).toBe("Sam lives in [removed:Leeds]");
    expect(marked(suggested)).toBe("Sam lives in [added:Paris]");
  });

  it("handles insertions, deletions and empty text", () => {
    expect(marked(diffWords("Likes tea", "Likes green tea").suggested)).toBe(
      "Likes [added:green]tea",
    );
    expect(marked(diffWords("Likes green tea", "Likes tea").now)).toBe("Likes [removed:green]tea");
    expect(diffWords("", "New").suggested).toEqual([{ text: "New", change: "added" }]);
    expect(diffWords("Same", "Same").now).toEqual([{ text: "Same", change: "same" }]);
  });
});
