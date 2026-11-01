// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { type HistoryHit, searchHistoryTool } from "../src/index";
import { signal } from "./helpers";

const HIT: HistoryHit = {
  conversationId: "c9",
  conversationTitle: "Trips",
  messageId: "m1",
  role: "user",
  snippet: "Book the ferry\nto Kirkwall",
  createdAt: Date.UTC(2026, 9, 4, 12, 30),
};

describe("search_history (M3-08 AC2)", () => {
  it("formats the caller's matches and leaves them untrusted tool output", async () => {
    const searchHistory = vi.fn(async () => [HIT]);
    const out = await searchHistoryTool({ searchHistory }).execute({ query: "kirkwall" }, signal());
    expect(searchHistory).toHaveBeenCalledWith("kirkwall", 10);
    expect(out.ok).toBe(true);
    expect(out.content).toContain('1 match for "kirkwall"');
    expect(out.content).toContain('[2026-10-04] "Trips" (conversation c9) — User:');
    expect(out.content).toContain("Book the ferry to Kirkwall");
    // Earlier messages can quote outside content: no trusted context is claimed.
    expect(out.context).toBeUndefined();
  });

  it("clamps the limit and answers plainly when nothing matches", async () => {
    const searchHistory = vi.fn(async () => [] as HistoryHit[]);
    const out = await searchHistoryTool({ searchHistory }).execute(
      { query: "zzz", limit: 999 },
      signal(),
    );
    expect(searchHistory).toHaveBeenCalledWith("zzz", 25);
    expect(out).toMatchObject({ ok: true, context: { kind: "system" } });
    expect(out.content).toContain('contain "zzz"');
  });

  it("turns a failing search into a tool error", async () => {
    const out = await searchHistoryTool({
      searchHistory: async () => {
        throw new Error("db down");
      },
    }).execute({ query: "x" }, signal());
    expect(out).toMatchObject({ ok: false, context: { kind: "system" } });
  });
});
