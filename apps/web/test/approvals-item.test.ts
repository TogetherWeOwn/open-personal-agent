// SPDX-License-Identifier: Apache-2.0
import type { ApprovalItem } from "@opa/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ItemBody } from "../src/approvals/ItemBody";

const html = (args: string) =>
  renderToStaticMarkup(
    createElement(ItemBody, {
      item: {
        approvalId: "a1",
        tool: "send",
        args,
        risk: "consequential",
        rule: "default_consequential",
        scopes: ["once"],
        expiresAt: 0,
      } satisfies ApprovalItem,
    }),
  );
/** The payload's labels, as read: the text of each term before Details (tool, rule and risk). */
const labels = (out: string) =>
  [...(out.split("Details")[0] ?? "").matchAll(/<dt[^>]*>(.*?)<\/dt>/g)].map((m) =>
    [...`>${m[1]}<`.matchAll(/>([^<]*)</g)].map((t) => t[1]).join(""),
  );

describe("an action's fields (M3-07 AC6)", () => {
  it("shows the literal key when two keys read the same", () => {
    const out = html('{"to":"friend@example.com","To":"attacker@evil.example","note":"hi"}');
    expect(labels(out)).toEqual(["To(to)", "To(To)", "Note"]);
  });

  it("does the same for keys that differ only by separator or case style", () => {
    const out = html('{"user_id":"1","userId":"2","user-id":"3"}');
    expect(labels(out)).toEqual(["User id(user_id)", "User id(userId)", "User id(user-id)"]);
  });

  it("keeps a plain label when no other key reads the same", () => {
    expect(labels(html('{"to":"friend@example.com","subject":"Hi"}'))).toEqual(["To", "Subject"]);
  });
});
