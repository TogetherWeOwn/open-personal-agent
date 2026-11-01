// SPDX-License-Identifier: Apache-2.0
// Onboarding's sample approval card (m3-ux §3.12): fixed content, shown with the real card so the
// user meets it before it matters. It is never sent anywhere, so its ids name no real batch.
import type { PendingBatch } from "./api";

const DAY_MS = 86_400_000;

export function sampleBatch(now = Date.now()): PendingBatch {
  const expiresAt = now + DAY_MS;
  return {
    batchId: "sample",
    conversationId: "sample",
    conversationTitle: null,
    taskId: null,
    createdAt: now,
    expiresAt,
    items: [
      {
        approvalId: "appr_sample",
        tool: "send_email",
        args: JSON.stringify({
          to: "sam@example.com",
          subject: "Dinner on Friday",
          body: "Hi Sam, here's the recipe I mentioned. See you at 7!",
        }),
        target: "sam@example.com",
        risk: "consequential",
        rule: "floor_tainted_egress",
        taint: { kind: "web", label: "a recipe blog" },
        scopes: ["once"],
        expiresAt,
      },
    ],
  };
}
