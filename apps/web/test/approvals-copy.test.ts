// SPDX-License-Identifier: Apache-2.0
import type { ApprovalItem } from "@opa/core";
import { describe, expect, it } from "vitest";
import type { PendingBatch } from "../src/approvals/api";
import { INVISIBLE } from "../src/approvals/copy";
import { receiptText } from "../src/approvals/store";

const item = (approvalId: string, tool: string): ApprovalItem => ({
  approvalId,
  tool,
  args: "{}",
  risk: "consequential",
  rule: "default_consequential",
  scopes: ["once", "hour"],
  expiresAt: 0,
});

const batch: PendingBatch = {
  batchId: "b1",
  conversationId: "c1",
  conversationTitle: null,
  taskId: null,
  createdAt: 0,
  expiresAt: 0,
  items: [item("a1", "create_artifact"), item("a2", "web_fetch")],
};

describe("INVISIBLE", () => {
  it.each([
    ["a zero-width space", "\u200b"],
    ["a bidi override", "\u202e"],
    ["a combining grapheme joiner", "\u034f"],
    ["the Mongolian vowel separator", "\u180e"],
    ["a Hangul filler", "\u3164"],
    ["a Hangul choseong filler", "\u115f"],
    ["a variation selector", "\ufe0f"],
    ["a tag character", "\u{e0041}"],
    ["a supplementary variation selector", "\u{e0100}"],
  ])("finds %s", (_, ch) => {
    expect(`a${ch}b`.match(INVISIBLE)).toEqual([ch]);
  });

  it("leaves ordinary text alone", () => {
    expect("friend@example.com, Ünïcødé 漢字".match(INVISIBLE)).toBeNull();
  });
});

describe("receiptText", () => {
  it("names the one scope a batch was approved for", () => {
    const text = receiptText(
      batch,
      [
        { approvalId: "a1", decision: "approve", scope: "hour" },
        { approvalId: "a2", decision: "approve", scope: "hour" },
      ],
      0,
    );
    expect(text).toMatch(/^You approved 2 of 2 \(for 1 hour\) · /);
  });

  it("names each action's own scope when they differ", () => {
    const text = receiptText(
      batch,
      [
        { approvalId: "a1", decision: "approve", scope: "once" },
        { approvalId: "a2", decision: "approve", scope: "hour" },
      ],
      0,
    );
    expect(text).toMatch(/: Save a file \(just this once\), Fetch a page \(for 1 hour\)\.$/);
  });
});
